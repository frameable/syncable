const suite = require('./index');
const assert = require('assert');
const express = require('express');

const Syncable = require('../index');

const template = {};

suite('client', async test => {

  const { server, sync } = await setup();
  const port = server.address().port;

  await test('ping interval clearing', async _ => {
    const rand = random();
    let clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    clientDoc.sync(c => c.count = 100);
    assert.equal(!!clientDoc._transport.pingIv._destroyed, false);

    clientDoc._transport.ws.close();
    await sleep(100);
    assert.equal(!!clientDoc._transport.pingIv._destroyed, true);

  });

  await test('roundtrip', async _ => {
    const rand = random();
    const clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    clientDoc.sync(c => c.count = 100);
    await sleep(100);
    const serverDoc = await Syncable.load(`/counters/${rand}`, template);
    assert.equal(clientDoc.count, 100);
    assert.equal(serverDoc.count, 100);
  });

  await test('key formatter', async _ => {
    assert.strictEqual(Syncable._config.keyFormatter, undefined);
    Syncable._config.keyFormatter = x => x.replace(/^\/prefix/, '');
    const rand = random();
    const clientDoc = await Syncable.client({url: `ws://localhost:${port}/prefix/counters/${rand}`});
    clientDoc.sync(c => c.count = 100);
    await sleep(100);
    const serverDoc = await Syncable.load(`/counters/${rand}`, template);
    assert.equal(clientDoc.count, 100);
    assert.equal(serverDoc.count, 100);
    delete Syncable._config.keyFormatter;
  });

  await test('noop', async _ => {
    const rand = random();
    const clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    const r1 = clientDoc.sync(c => c.count = 100);
    assert(r1 === undefined);
    await sleep(100);
    const r2 = clientDoc.sync(c => c.count = 100);
    assert(r2 === null);
    await sleep(100);
    const serverDoc = await Syncable.load(`/counters/${rand}`, template);
    assert.equal(clientDoc.count, 100);
    assert.equal(serverDoc.count, 100);
  });

  await test('relay', async _ => {
    const rand = random();
    const clientADoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    clientADoc.sync(c => c.count = 100);
    await sleep(100);
    const serverDoc = await Syncable.load(`/counters/${rand}`, template);
    const clientBDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    assert.equal(clientADoc.count, 100);
    assert.equal(clientBDoc.count, 100);
    assert.equal(serverDoc.count, 100);
  });

  await test('batch updates', async _ => {
    const rand = random();
    const clientADoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`, noCache: true});
    clientADoc.sync(c => c.numbers = []);
    await sleep(100);
    const clientBDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`, noCache: true});
    for (const i of Array(2).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc._transport.rater.rate() | 0, 1);
    for (const i of Array(5).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc._transport.rater.rate() | 0, 2);
    for (const i of Array(20).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc._transport.rater.rate() | 0, 8);
    for (const i of Array(50).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc._transport.rater.rate() | 0, 23);
    for (const i of Array(5).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc._transport.rater.rate() | 0, 18);
    for (const i of Array(1).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc._transport.rater.rate() | 0, 2);
    for (const i of Array(1).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(4000);
    assert.equal(clientBDoc._transport.rater.rate() | 0, 0);
    for (const i of Array(1).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientADoc.numbers.length, 85);
    assert.equal(clientBDoc.numbers.length, 85);
  });

  await test('server race', async _ => {
    const rand = random();
    let serverDoc = await Syncable.load(`/counters/${rand}`, { numbers: [] });

    // underdog racing team
    setTimeout(async _ => {
      for (const i of Array(5).keys()) {
        serverDoc.sync(c => c.numbers.push(i));
        await sleep(100)
      }
    });

    // incumbent racing team
    for (const i of Array(5).keys()) {
      serverDoc.sync(c => c.numbers.push(i));
      await sleep(100)
    }

    const clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`, noCache: true});
    await sleep(1000);

    assert.equal(serverDoc.numbers.length, 10);
    assert.equal(clientDoc.numbers.length, 10);

  });

  await test('ping timeout reconnect', async _ => {
    const rand = random();
    let clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    await sleep(100);
    let didReconnect = false;
    clientDoc._transport.ws.addEventListener('open', _ => {
      didReconnect = true;
    });
    clientDoc._transport.lastPingResponse = Date.now() - 30000;
    await sleep(1100);
    assert.equal(didReconnect, true);
  });

  await test('ping graceful throttle', async _ => {
    const rand = random();
    let clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    await sleep(100);
    let didReconnect = false;
    clientDoc._transport.ws.addEventListener('open', _ => {
      didReconnect = true;
    });
    clientDoc._transport.lastPingResponse = Date.now() - 30000;
    global.document = { visibilityState: 'hidden' };
    await sleep(1100);
    assert.equal(didReconnect, false);
    global.document.visibilityState = 'visible';
    await sleep(1100);
    assert.equal(didReconnect, false);
    assert(clientDoc._transport.lastPingResponse > Date.now() - 2000, true);
    delete global.document;
  });

  await test('ping timeout parameter', async _ => {
    let clientDoc1 = await Syncable.client({url: `ws://localhost:${port}/counters/${random()}`});
    assert.equal(clientDoc1._transport.pingTimeoutMs, 20000);
    let clientDoc2 = await Syncable.client({url: `ws://localhost:${port}/counters/${random()}`, pingTimeoutMs: 1500 });
    assert.equal(clientDoc2._transport.pingTimeoutMs, 1500);
  });

  await test('vue3', async _ => {
    const { reactive, watch } = require('vue');
    const store = reactive({
      userId: 'user-1',
      sharedState: {
        seed: 294381,
        turnId: 0,
        instance: {
          startTime: '2024-01-01'
        }
      },
    });


    let watchCount = 0;
    watch(_ => store, (_ => watchCount++), { deep: true });

    const doc = await Syncable.client({url: `ws://localhost:${port}/state/${random()}`});

    doc.on('changed', _ => {
      store.sharedState = _clone(doc);
    });

    doc.sync(d => Object.assign(d, store.sharedState));
    await sleep(10);

    doc.sync(d => d.turnId = 42);
    await sleep(10);

    assert.equal(store.sharedState.turnId, 42);
    assert.equal(store.userId, 'user-1');
    assert.equal(watchCount, 2);
  });

  await test('pending sort', async _ => {
    const rand = random();
    const clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    clientDoc.sync(c => c.count = 100);
    await sleep(100);
    const serverDoc = await Syncable.load(`/counters/${rand}`, template);
    assert.equal(clientDoc.count, 100);
    assert.equal(serverDoc.count, 100);

    clientDoc._transport.pendingChanges = [
      {'diff': [{ op:'replace', path: '/count', value: 102 }], ts: Date.now() + 100046 },
      {'diff': [{ op:'replace', path: '/count', value: 101 }], ts: Date.now() + 100045 },
    ];

    clientDoc._transport.applyPendingChanges();
    assert.equal(clientDoc.count, 102);
  });
});


async function setup() {

  let db = {};

  Syncable.initialize({
    redis: process.env.REDIS ? 'localhost' : null,
    reader: key => db[key],
    writer: async (key, data) => {
      await sleep(10);  // simulate disk latency
      db[key] = data
    }
  });

  const app = express();
  const handler = Syncable(template);
  app.get('/state/:id', handler);
  app.get('/counters/:id', handler);
  app.get('/prefix/counters/:id', handler);
  const server = await app.listen();
  return { server };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function random() {
  return Math.random().toString(36).slice(2);
}

function _clone(o) {
  return JSON.parse(JSON.stringify(o));
}
