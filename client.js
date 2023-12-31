const Pigeon = require('pigeon');
Pigeon.configure({ strict: false });
const Auto = Pigeon.auto

const ReconnectingWebSocket = require('reconnecting-websocket').default || require('reconnecting-websocket');
const WebSocket = require('isomorphic-ws');
const Rater = require('./rater');

const proxies = {};
const docs = new WeakMap();
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
    this.id = Math.random().toString(36).slice(2);
    this.onMessage = onMessage;
    this.onInvalidError = onInvalidError;
    this.rater = new Rater(3);
    this.pingTimeoutMs = pingTimeoutMs || 20000;
    this.url = url;
    this._resolve = resolve;

    const handler = {
      get: function(target, prop, receiver) {
        const doc = docs.get(target.proxy);
        if (prop == '_instance') {
          return meta.get(target.proxy)._instance;
        }
        if (prop in doc) {
          return doc[prop];
        } else {
          return Reflect.get(...arguments);
        }
      },

      ownKeys(target) {
        const doc = docs.get(target);
        return Object.keys(doc);
      },

      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true };
      },

      set: function(obj, prop, value) {
        throw new Error(`please call sync to change this document (setting ${prop})`);
      },
    };

    this.initialize();

    this.proxy = new Proxy(this, handler);
    proxies[url] = this.proxy;

    meta.set(this.proxy, { deltas: [], delta: 0, _instance: this });
    docs.set(this.proxy, { _init: 'proxy' });

    return this.proxy;
  }

  getPendingChangesDelay(rate) {
    const MAX_DELAY = 2000;
    return (
      rate === null ? MAX_DELAY :
      rate <= 1 ? 100 :
      rate <= 5 ? 500 :
      rate <= 10 ? 1000 : MAX_DELAY
    );
  }

  initialize() {

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
        docs.set(this.proxy, Auto.load(message.doc));
        clearInterval(this.pingIv);
        clearTimeout(this.connectionTimeout);
        this._resolve(proxies[this.url]);
        // start pinging after the server has done the work to give us a doc
        // and installed its side of the ping handler
        this.ping()

        setTimeout(_ => {
          clearInterval(this.pingIv);
          this.pingIv = setInterval(this.ping.bind(this), 5000);
        }, 60 * 1000);

        this.pingIv = setInterval(this.ping.bind(this), 1000);
      } else if (message.error == 'invalid_error') {
        if (this.onInvalidError) this.onInvalidError();
      } else if (message.action == 'change') {
        this.rater.increment();
        this.pendingChanges.push(message.data.changes);
      } else if (message.serverTime) {
        const { serverTime, clientTime } = message;
        this.lastPingResponse = Date.now();
        const windowSize = 10;
        const latency = Date.now() - clientTime;
        const delta = clientTime - serverTime + latency / 2;
        const { deltas } = meta.get(this.proxy);
        deltas.push(delta);
        deltas.length > windowSize && deltas.shift();
        meta.get(this.proxy).delta = [].concat(deltas).sort((a,b) => a - b)[deltas.length/2|0];

        // most recent websocket with timestamps is the winning timestamper
        Auto.setTimestamp(this.timestamp.bind(this));

        // resolve to syncable() caller after we have a doc and also our clock
        // is in good shape
        if (this._resolve && docs.get(this.proxy)) this._resolve(proxies[this.url]);
      } else if (message.action == 'snapshot') {
        try {
          const { crc, ts } = message;
          const rewindable = Auto.clone(docs.get(this.proxy));
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

    this.applyPendingChanges = (directCall) => {
      if (this.pendingChanges.length) {
        const catonatedDiffs = this.pendingChanges
          .sort((a, b) => a.ts - b.ts)
          .map(c => c.diff).flat()
        const changes = Object.assign(this.pendingChanges[0], { diff: catonatedDiffs });
        const doc = docs.get(this.proxy);
        for (const k in doc) doc[k] = _clone(doc[k]);
        docs.set(this.proxy, Auto.applyChangesInPlace(Auto.alias(doc), changes));
        if (this.afterSyncHandler) {
          this.afterSyncHandler(docs.get(this.proxy));
        }
      }

      this.pendingChanges = [];

      const rate = this.rater.rate();
      const delay = this.getPendingChangesDelay(rate);

      if (directCall) return;
      setTimeout(this.applyPendingChanges, delay);
    };

    this.ping = () => {

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

    this.onAfterSync = (afterSyncHandler) => {
      this.afterSyncHandler = afterSyncHandler;
    }

    this.timestamp = () => {
      return Math.floor(Date.now() - meta.get(this.proxy).delta);
    }

  }

  sync(fn) {
    const { _instance } = meta.get(this);
    if (_instance.ws.readyState === 3) {
      console.warn("can't sync before open");
      _instance.ws.reconnect();
    } else if (_instance.ws.readyState !== 1) {
      console.warn("websocket is not open, queueing messages");
    }
    const directCall = true;
    _instance.applyPendingChanges(directCall);
    const newDoc = Auto.change(docs.get(this.proxy), fn);
    const changes = Auto.getChanges(docs.get(this.proxy), newDoc);
    if (!changes.diff.length) {
      return null;
    }
    docs.set(this.proxy, newDoc);
    if (this.afterSyncHandler) {
      this.afterSyncHandler(newDoc);
    }
    this.ws.send(JSON.stringify({ action: 'change', data: { changes } }));
  }
}

async function syncable({ url, onMessage, pingTimeoutMs, onInvalidError, noCache }) {
  return new Promise((resolve, reject) => {
    if (!proxies[url] || noCache) {
      new Syncable({url, onMessage, pingTimeoutMs, onInvalidError, resolve, reject});
    } else {
      resolve(proxies[url]);
    }
  });
}

const _clone = x => JSON.parse(JSON.stringify(x));

module.exports = syncable;
