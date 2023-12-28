const Pigeon = require('pigeon')
Pigeon.configure({
  strict: false,
});


const Auto = Pigeon.auto

const ReconnectingWebSocket = require('reconnecting-websocket').default || require('reconnecting-websocket');
const WebSocket = require('isomorphic-ws');
const Rater = require('./rater');

const instances = {};
const windowSize = 10;
const meta = new WeakMap();

const isNode =  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

const isTestRun = isNode && process.env.IS_TEST_RUN;

class Syncable {
  constructor({url, onMessage, pingTimeoutMs, onInvalidError, resolve, reject}) {
    this.connectionTimeout = setTimeout(_ => {
      reject(`There was a problem initializing syncable [60s timeout]`);
    }, 60 * 1000);
    this.ws = new ReconnectingWebSocket(url, [], { WebSocket });
    this.doc = {};
    this.onMessage = onMessage;
    this.rater = new Rater(3);
    this.pingTimeoutMs = pingTimeoutMs || 20000;

    const handler = {
      get: function(target, prop) {
        if (prop in target.doc) {
          return target.doc[prop];
        } else if (prop == 'timestamp') {
          return target.timestamp.bind(target);
        } else if (prop == 'onAfterSync') {
          return target.onAfterSync.bind(target);
        } else {
          return Reflect.get(...arguments);
        }
      },

      set: function(obj, prop, value) {
        if (prop == 'doc') {
          obj.doc = value;
          return true;
        }

        if (isTestRun) {
          // allow punching into these slots of the instance from tests
          if (prop == 'lastPingResponse') {
            obj.lastPingResponse = value;
            return true;
          }

          if (prop == 'pendingChanges') {
            obj.pendingChanges = value;
            return true;
          }
        }

        throw new Error(`please call sync to change this document`);
      },
    }

    this.getPendingChangesDelay = (rate) => {
      return (
        rate === null ? 3000 :
        rate <= 1 ? 100 :
        rate <= 2 ? 1000 :
        rate <= 5 ? 2000 :
        rate <= 10 ? 3000 : 5000
      );
    }

    this.applyPendingChanges = (directCall) => {
      if (this.pendingChanges.length) {
        const catonatedDiffs = this.pendingChanges
          .sort((a, b) => a.ts - b.ts)
          .map(c => c.diff).flat()
        const changes = Object.assign(this.pendingChanges[0], { diff: catonatedDiffs });
        for (const k in this.doc) this.doc[k] = _clone(this.doc[k]);
        this.doc = Auto.applyChangesInPlace(Auto.alias(this.doc), changes);
        if (this.afterSyncHandler) {
          this.afterSyncHandler(this.doc);
        }
      }

      this.pendingChanges = [];

      const rate = this.rater.rate();
      const delay = this.getPendingChangesDelay(rate);

      if (directCall) return;
      setTimeout(this.applyPendingChanges, delay);
    };

    this.ws.onopen = () => {
      clearInterval(this.pingIv);
      this.isOpen = true;
      this.pendingChanges = [];
      this.applyPendingChanges();
    };

    this.ws.onerror = err => {
      console.warn(err);
    };

    this.ws.onclose = () => {
      clearInterval(this.pingIv);
    }

    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);

      if (this.onMessage) {
        try {
          this.onMessage(message);
        } catch (e) {
          console.warn("trouble with onMessage handler", e);
        }
      }

      if (message.action == 'init') {
        this.doc = Auto.load(message.doc);
        clearInterval(this.pingIv);
        clearTimeout(this.connectionTimeout);
        resolve(instances[url]);
        // start pinging after the server has done the work to give us a doc
        // and installed its side of the ping handler
        this.ping()

        setTimeout(_ => {
          clearInterval(this.pingIv);
          this.pingIv = setInterval(this.ping.bind(this), 5000);
        }, 60 * 1000);

        this.pingIv = setInterval(this.ping.bind(this), 1000);
      } else if (message.error == 'invalid_error') {
        if (onInvalidError) onInvalidError();
      } else if (message.action == 'change') {
        this.rater.increment();
        this.pendingChanges.push(message.data.changes);
      } else if (message.serverTime) {
        const { serverTime, clientTime } = message;
        this.lastPingResponse = Date.now();
        const latency = Date.now() - clientTime;
        const delta = clientTime - serverTime + latency / 2;
        const { deltas } = meta.get(this);
        deltas.push(delta);
        deltas.length > windowSize && deltas.shift();
        meta.get(this).delta = [].concat(deltas).sort((a,b) => a - b)[deltas.length/2|0];

        // most recent websocket with timestamps is the winning timestamper
        Auto.setTimestamp(this.timestamp.bind(this));

        // resolve to syncable() caller after we have a doc and also our clock
        // is in good shape
        if (resolve && this.doc) resolve(instances[url]);
      } else if (message.action == 'snapshot') {
        try {
          const { crc, ts } = message;
          const rewindable = Auto.clone(this.doc);
          Auto.rewindChanges(rewindable, ts);
          const myCrc = Auto.crc(rewindable);
          if (myCrc != crc) {
            console.log(`CRC mismatch: ${myCrc} ${crc}`);
            // this.ws.reconnect();
          }
        } catch (e) {
          console.log(`snapshot crc error: ${e}`);
        }
      }
    };

    instances[url] = new Proxy(this, handler);
    meta.set(this, { deltas: [], delta: 0 });
    return instances[url];
  }

  timestamp() {
    return Math.floor(Date.now() - meta.get(this).delta);
  }

  ping() {

    // if we're backgrounded, last ping response may be bogus
    if (typeof document != 'undefined' && document.visibilityState == 'hidden') {
      this.lastPingResponse = false;
    }

    if (this.lastPingResponse && ((Date.now() - this.lastPingResponse) > this.pingTimeoutMs)) {
      console.log('took too long for ping response');
      this.lastPingResponse = false;
      this.ws.reconnect();
    } else {
      this.ws.send(JSON.stringify({ action: 'time', data: Date.now() }));
    }
  }

  onAfterSync(afterSyncHandler) {
    this.afterSyncHandler = afterSyncHandler;
  }

  sync(fn) {
    if (this.ws.readyState === 3) {
      console.warn("can't sync before open");
      this.ws.reconnect();
    } else if(this.ws.readyState !== 1) {
      console.warn("websocket is not open, queueing messages");
    }
    const directCall = true;
    this.applyPendingChanges(directCall);
    const newDoc = Auto.change(this.doc, fn);
    const changes = Auto.getChanges(this.doc, newDoc);
    if (!changes.diff.length) {
      return null;
    }
    this.doc = newDoc;
    if (this.afterSyncHandler) {
      this.afterSyncHandler(newDoc);
    }
    this.ws.send(JSON.stringify({ action: 'change', data: {changes} }));
  }
}

async function syncable({url, onMessage, pingTimeoutMs, onInvalidError, noCache}) {
  return new Promise((resolve, reject) => {
    if (!instances[url] || noCache) {
      new Syncable({url, onMessage, pingTimeoutMs, onInvalidError, resolve, reject});
    } else {
      resolve(instances[url]);
    }
  });
}

const _clone = x => JSON.parse(JSON.stringify(x));

module.exports = syncable;
