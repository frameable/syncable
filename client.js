const Pigeon = require('pigeon');
Pigeon.configure({ strict: false });
const Auto = Pigeon.auto

const ReconnectingWebSocket = require('reconnecting-websocket').default || require('reconnecting-websocket');
const WebSocket = require('isomorphic-ws');
const Rater = require('./rater');

const instances = {};

const isNode =  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

const isTestRun = isNode && process.env.IS_TEST_RUN;

class Transport {

  constructor({ _parent, pingTimeoutMs, resolve, reject, url }) {
    this.ws = new ReconnectingWebSocket(url, [], { WebSocket });
    this.id = Math.random().toString(36).slice(2);
    this.rater = new Rater(3);
    this.pingTimeoutMs = pingTimeoutMs || 20000;
    this.url = url;
    this._resolve = resolve;
    this._parent = _parent;
    this.deltas = [];

    this.connectionTimeout = setTimeout(_ => {
      reject(`There was a problem initializing syncable [60s timeout]`);
    }, 60 * 1000);

    this.initialize();
  }

  initialize() {

    this.ws.onopen = () => {
      this.emit('connected');
      clearInterval(this.pingIv);
      this.isOpen = true;
      this.pendingChanges = [];
      this.applyPendingChanges();
    };

    this.ws.onerror = error => {
      this.emit('error', { error });
      console.warn(error);
    };

    this.ws.onclose = () => {
      this.emit('closed');
      clearInterval(this.pingIv);
    }

    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);

      this.emit('message', { message });

      if (message.action == 'init') {
        this.setDoc(Auto.load(message.doc));
        clearInterval(this.pingIv);
        clearTimeout(this.connectionTimeout);
        this._resolve(instances[this.url]);
        // start pinging after the server has done the work to give us a doc
        // and installed its side of the ping handler
        this.ping()

        this.emit('initialized');

        setTimeout(_ => {
          clearInterval(this.pingIv);
          this.pingIv = setInterval(this.ping.bind(this), 5000);
        }, 60 * 1000);

        this.pingIv = setInterval(this.ping.bind(this), 1000);
      } else if (message.error == 'rejected') {
        this.emit('rejected', { message });
      } else if (message.action == 'change') {
        this.rater.increment();
        this.pendingChanges.push(message.data.changes);
      } else if (message.serverTime) {
        const { serverTime, clientTime } = message;
        this.lastPingResponse = Date.now();
        const windowSize = 10;
        const latency = Date.now() - clientTime;
        const delta = clientTime - serverTime + latency / 2;
        const { deltas } = this;
        deltas.push(delta);
        deltas.length > windowSize && deltas.shift();
        this.delta = [].concat(deltas).sort((a,b) => a - b)[deltas.length/2|0];

        // most recent websocket with timestamps is the winning timestamper
        Auto.setTimestamp(this.timestamp.bind(this));

        // resolve to syncable() caller after we have a doc and also our clock
        // is in good shape
        if (this._resolve && this.doc) this._resolve(instances[this.url]);
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
    }
    this.setDoc(null);
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

  applyPendingChanges(directCall) {
    if (this.pendingChanges.length) {
      const catonatedDiffs = this.pendingChanges
        .sort((a, b) => a.ts - b.ts)
        .map(c => c.diff).flat()
      const changes = Object.assign(this.pendingChanges[0], { diff: catonatedDiffs });
      for (const k in this.doc) this.doc[k] = _clone(this.doc[k]);
      this.setDoc(Auto.applyChangesInPlace(Auto.alias(this.doc), changes));
      this.emit('changed', { changes })
    }

    this.pendingChanges = [];

    const rate = this.rater.rate();
    const delay = this.getPendingChangesDelay(rate);

    if (directCall) return;
    setTimeout(_ => this.applyPendingChanges(), delay);
  }

  ping() {
    // if we're backgrounded, last ping response may be bogus
    if (typeof document != 'undefined' && document.visibilityState == 'hidden') {
      this.lastPingResponse = false;
    }

    if (this.lastPingResponse && ((Date.now() - this.lastPingResponse) > this.pingTimeoutMs)) {
      console.log('took too long for ping response');
      this.lastPingResponse = false;
      this.emit('reconnecting');
      this.ws.reconnect();
    } else {
      this.ws.send(JSON.stringify({ action: 'time', data: Date.now() }));
    }
  }

  timestamp() {
    return Math.floor(Date.now() - this.delta);
  }

  emit() {
    this._parent.emit(...arguments);
  }

  setDoc(doc) {
    this.doc = doc;
    Object.assign(this._parent, doc);
    for (const prop of Object.keys(this._parent)) {
      if (!(prop in doc)) {
        delete this._parent[prop];
      }
    }
  }

}

class Syncable extends EventTarget {

  constructor(options) {
    super();

    Object.defineProperty(this, '_transport', { value: new Transport({ ...options, _parent: this}) });

    instances[options.url] = this;
  }

  sync(fn) {
    const transport = this._transport;
    if (transport.ws.readyState === 3) {
      console.warn("can't sync before open");
      transport.ws.reconnect();
      this.emit('reconnecting');
    } else if (transport.ws.readyState !== 1) {
      console.warn("websocket is not open, queueing messages");
    }
    const directCall = true;
    transport.applyPendingChanges(directCall);
    const newDoc = Auto.change(this._transport.doc, fn);
    const changes = Auto.getChanges(this._transport.doc, newDoc);
    if (!changes.diff.length) {
      return null;
    }
    transport.setDoc(newDoc);
    this.emit('changed', { changes });
    transport.ws.send(JSON.stringify({ action: 'change', data: { changes } }));
  }

  on(eventName, handler) {
    this.addEventListener(eventName, e => handler(e.detail));
  }

  emit(eventName, data) {
    this.dispatchEvent(new CustomEvent(eventName, { detail: data }));
  }
}

async function syncable({ url, pingTimeoutMs, noCache }) {
  return new Promise((resolve, reject) => {
    if (!instances[url] || noCache) {
      new Syncable({url, pingTimeoutMs, resolve, reject});
    } else {
      resolve(instances[url]);
    }
  });
}

const _clone = x => JSON.parse(JSON.stringify(x));

module.exports = syncable;
