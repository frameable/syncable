const Auto = require('pigeon').auto;
const WebSocket = require('ws');
const wss = new WebSocket.Server({ noServer: true });
const Redis = require('ioredis');
const fs = require('fs-promise');
const mkdirp = require('mkdirp');
const { backfill } = require('./helpers');
const Local = require('./local');

const connections = new WeakMap;
const docs = {};
const streams = {};
const loads = {};

const config = {
  reader: reader,
  writer: writer,
  redis: null,
  channel: '',
  window: 5 * 1000,
  validator: validator,
};

function prevWindowTs(ts=Date.now()) {
  return ((ts / config.window | 0) - 1) * config.window;
}

let subscriber;
let publisher;

let CHANNEL;
let Bus;

const handlers = {};
function on(event, handler) {
  handlers[event] = handler;
}

function serialize(doc) {
  return Auto.save(doc);
}

function initialize(args={}) {

  for (const k of Object.keys(args)) {
    if (k in args) {
      config[k] = args[k];
    }
  }

  CHANNEL = config.channel || `syncable:${process.env.NODE_ENV}`;

  Bus = config.redis ? Redis : Local;

  subscriber = new Bus(config.redis);
  publisher = new Bus(config.redis);

  subscriber.on('message', async (channel, message) => {
    const { key, action } = JSON.parse(message);
    if (!key) return;

    if (action == 'SYNCABLE_UNLOAD') {
      return _unload(key, false);
    }

    if (action == 'SYNCABLE_UNLOAD_PREFIX') {
      return _unloadByPrefix(key);
    }

  });

  subscriber.subscribe(CHANNEL, (err, count) => {
    if (err) throw new Error(err);
  });
}

function publish({ key, action }) {
  const message = JSON.stringify({ key, action });
  publisher.publish(CHANNEL, message);
}

function broadcast(key, data, exclude) {
  for (const c of wss.clients) {
    if (connections.get(c).key != key) continue;
    if (c.readyState !== WebSocket.OPEN) continue;
    if (exclude && exclude(c)) continue;
    try {
      c.send(data);
    } catch (e) {
      console.warn("trouble broadcasting over websocket", e);
    }
  }
}

async function _syncDoc(key, doc, fn) {
  const changeDoc = Auto.change(doc, fn);
  const changes = Auto.getChanges(doc, changeDoc);
  if (!changes.diff.length) {
    return Promise.resolve(doc);
  }
  docs[key] = changeDoc;
  broadcast(
    key,
    JSON.stringify({ action: 'change', data: { changes } }),
  );
  const stream = _getStream(key);
  stream.xadd(key, '*', 'message', JSON.stringify({ action: 'change', data: { changes } }));
  write({ key, doc: docs[key] });
  return Promise.resolve(docs[key]);
}

const syncable = (template = {}) => {
  const pendingHandlers = new Map();
  const eventHandlers = {};
  const _id = Math.random().toString(36).slice(2);

  const handler = (req, res, next) => {

    if (req.headers.upgrade !== 'websocket') {
      return res.send("please connect via WebSocket");
    }

    wss.handleUpgrade(req, req.socket, { length: 0 }, async ws => {
      const pending = pendingHandlers.get(_id);
      if (pending) {
        eventHandlers[req.route.path] = {};
        for (const name of Object.keys(pending)) {
          eventHandlers[req.route.path][name] = pending[name];
        }
      }

      await handleConnect(ws, req);
    });
  };

  handler.on = (eventName, eventHandler) => {
    let pending = pendingHandlers.get(_id);
    if (pending) {
      if (pending[eventName]) {
        pending[eventName].push(eventHandler);
      } else {
        pending[eventName] = [ eventHandler ];
      }
    } else {
      pending = {};
      pending[eventName] = [ eventHandler ];
    }
    pendingHandlers.set(_id, pending);
  };

  async function handleConnect (ws, req) {

    const defaultKey = req.baseUrl + req.path;
    const key = config.keyFormatter ? config.keyFormatter(defaultKey) : defaultKey;

    connections.set(ws, { key });

    if (eventHandlers[req.route.path] && ('initialize' in eventHandlers[req.route.path])) {
      for (const h of eventHandlers[req.route.path].initialize) {
        await h(ws, req);
      }
    }

    let fromTemplate = template;
    if (typeof template == 'function') {
      fromTemplate = template(req);
    }

    await load(key, fromTemplate);

    ws.send(JSON.stringify({
      action: 'init',
      doc: Auto.save(docs[key])
    }));

    ws.on('message', async data => {
      const message = JSON.parse(data);

      if (message.action == 'time') {
        return ws.send(JSON.stringify({ serverTime: Date.now(), clientTime: message.data }));
      }

      if (message.action !== 'change') return;
      const doc = docs[key];
      if (!doc) {
        console.log(`no doc for key ${key}`);
        return;
      }

      const validated = await config.validator(ws, req, message.data);
      if (!validated) {
        return ws.send(JSON.stringify({ error: 'rejected', message }));
      }

      const changeTs = message.data.changes.ts;
      const twoSnapshotsAgoTime =
        ((Date.now() / config.window | 0) * config.window) - config.window;

      if (twoSnapshotsAgoTime > changeTs) {
        console.log("rejecting too old stale change", changeTs, twoSnapshotsAgoTime)
        ws.send(JSON.stringify({ error: 'stale_change', snapshotTime: twoSnapshotsAgoTime, changeTs }));
        return;
      }

      docs[key] = Auto.applyChangesInPlace(doc, message.data.changes);
      write({ key, doc: docs[key] });
      broadcast(key, data, c => c == ws);
      const stream = _getStream(key);
      stream.xadd(key, '*', 'message', data);
    });


    if (eventHandlers[req.route.path] && ('connection' in eventHandlers[req.route.path])) {
      for (const h of eventHandlers[req.route.path].connection) {
        await h(ws, req);
      }
    }
  }

  async function sync(key, fn) {
    docs[key] = await _syncDoc(key, docs[key], fn);
    return docs[key];
  }

  return handler;
}

async function load(key, template = {}) {

  // return from memory if we've loaded already
  if (docs[key]) return docs[key];

  const stream = _getStream(key);

  // if multiple concurrent load requests arrive, handle them together
  loads[key] ||= new Promise(async (resolve, reject) => {

    try {
      var data = await config.reader(key);
    } catch(e) {
      reject(e);
    }

    if (data) {
      // if we've data then load and backfill it
      doc = Auto.load(data);
      doc = await _syncDoc(key, doc, d => backfill(d, template));
    } else {
      // if it's a new doc then start with the template and do our initial write
      doc = Auto.from(template);
      write({ key, doc });
    }

    docs[key] = doc;
    let minId = Auto.getHistory(docs[key]).slice(-1)[0]?.ts;

    // catch up with any changes in the stream not yet persisted
    const response = await stream.xread('STREAMS', key, minId - config.window);

    if (response) {
      const [ [ _name, entries ] ] = response;
      for (const [ messageId, [ MESSAGE, message ] ] of entries || []) {
        _handleMessage(message);
        minId = messageId;
      }
    }

    // listen for changes going forward
    setTimeout(async _ => {
      let cursor = '$';
      while (stream) {
        const [ [ _name, entries ] ] = await stream.xread('BLOCK', 0, 'STREAMS', key, cursor);
        for (const [ messageId, [ MESSAGE, message ] ] of entries || []) {
          _handleMessage(message);
        }
        cursor = entries.slice(-1)[0][0];
      }
    })

    async function _handleMessage(data) {
      const { data: { changes } } = JSON.parse(data);

      if (!changes) {
        console.warn("bad message", data);
        return;
      }

      const doc = docs[key];
      docs[key] = Auto.applyChangesInPlace(doc, changes);
      broadcast(key, JSON.stringify({ action: 'change', data: { changes } }));
    }

    docs[key] = doc;
    resolve(proxy(key, docs[key]));

  });

  return loads[key];
}

function unload(key) {
  publish({ key, action: 'SYNCABLE_UNLOAD' });
}

function unloadByPrefix(prefix) {
  publish({ key: prefix, action: 'SYNCABLE_UNLOAD_PREFIX' });
}

function _unload(key) {
  if (handlers.unload) handlers.unload(docs[key]);
  delete loads[key];
  delete docs[key];
}

function _unloadByPrefix(prefix) {
  if (!(prefix && prefix.length)) return;
  for (const key of Object.keys(docs)) {
    if (key.startsWith(prefix)) {
      _unload(key);
    }
  }
}

async function write({ key, doc }) {

  write._tv ||= {};
  write._last ||= {};

  write._last[key] ||= -Infinity;

  if (write._last[key] < Date.now() - config.window) {
    write._last[key] = Date.now();
    const data = Auto.save(doc);
    config.writer(key, data);
  } else {
    const delay = Math.max(0, write._last[key] + config.window - Date.now());
    write._tv[key] ||= setTimeout(async _ => {
      delete write._tv[key];
      try {
        write._last[key] = Date.now();
        const data = Auto.save(doc);
        await config.writer(key, data);
      } catch(e) {
        console.warn("write failed, retrying once next window", e);
        write._tv[key] ||= setTimeout(_ => {
          delete write._tv[key];
          write._last[key] = Date.now();
          const data = Auto.save(doc);
          config.writer(key, data);
        }, config.window);
      }
    }, delay);
  }
}

async function find(finder) {
  const keys = await finder(Object.keys(docs));
  return keys;
}

async function reader(key) {
  const handle = _getStream(key);
  const data = await handle.get(`syncable-${key}`);
  return data;
}

async function writer(key, data) {
  const handle = _getStream(key);
  return handle.set(`syncable-${key}`, data);
}

async function validator(ws, req) {
  return true;
}

function applyChanges(doc, changes) {
  return Auto.applyChanges(doc, changes);
}

function _getStream(key) {
  if (streams[key]) return streams[key];
  streams[key] =  new Bus(config.redis);
  return streams[key];
}

function proxy(key) {
  const handler = {
    get: function(target, prop) {
      const doc = docs[key];
      if (prop in doc) {
        return doc[prop];
      } else if (prop == 'sync') {
        return async function sync(fn) {
          const s = await _syncDoc(key, doc, fn)
          docs[key] = s
        }
      } else {
        return Reflect.get(...arguments);
      }
    },
    set: function(obj, prop, value) {
      throw new Error(`please call sync to change this document`);
    }
  }

  return new Proxy(doc, handler);
}

syncable.initialize = initialize;
syncable.client = require('./client');
syncable.load = load;
syncable.unload = unload;
syncable.unloadByPrefix = unloadByPrefix;
syncable.find = find;
syncable.wss = wss;
syncable.serialize = serialize;
syncable.on = on;
syncable.Auto = Auto;
syncable._config = config;
syncable.handle = syncable;

module.exports = syncable;
