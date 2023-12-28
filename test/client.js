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
    assert.equal(!!clientDoc.pingIv._destroyed, false);

    clientDoc.ws.close();
    await sleep(100);
    assert.equal(!!clientDoc.pingIv._destroyed, true);

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
    assert.equal(clientBDoc.rater.rate() | 0, 1);
    for (const i of Array(5).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc.rater.rate() | 0, 2);
    for (const i of Array(20).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc.rater.rate() | 0, 8);
    for (const i of Array(50).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc.rater.rate() | 0, 23);
    for (const i of Array(5).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc.rater.rate() | 0, 18);
    for (const i of Array(1).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientBDoc.rater.rate() | 0, 2);
    for (const i of Array(1).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(4000);
    assert.equal(clientBDoc.rater.rate() | 0, 0);
    for (const i of Array(1).keys()) {
      clientADoc.sync(c => c.numbers.push(i));
    }
    await sleep(1000);
    assert.equal(clientADoc.numbers.length, 85);
    assert.equal(clientBDoc.numbers.length, 85);
  });

  await test('server race', async _ => {
    const rand = random();
    const clientADoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`, noCache: true});
    clientADoc.sync(c => c.numbers = []);
    await sleep(100);

    // underdog racing team
    setTimeout(async _ => {
      for (const i of Array(5).keys()) {
        await sync(`/counters/${rand}`, c => c.numbers.push(i));
        await sleep(20)
      }
    });

    // incumbent racing team
    for (const i of Array(5).keys()) {
      await sync(`/counters/${rand}`, c => c.numbers.push(i));
      await sleep(20)
    }

    const clientBDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`, noCache: true});
    await sleep(1000);
    assert.equal(clientBDoc.numbers.length, 10);
  });

  await test('ping timeout reconnect', async _ => {
    const rand = random();
    let clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    await sleep(100);
    let didReconnect = false;
    clientDoc.ws.addEventListener('open', _ => {
      didReconnect = true;
    });
    clientDoc.lastPingResponse = Date.now() - 30000;
    await sleep(1100);
    assert.equal(didReconnect, true);
  });

  await test('ping graceful throttle', async _ => {
    const rand = random();
    let clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    await sleep(100);
    let didReconnect = false;
    clientDoc.ws.addEventListener('open', _ => {
      didReconnect = true;
    });
    clientDoc.lastPingResponse = Date.now() - 30000;
    global.document = { visibilityState: 'hidden' };
    await sleep(1100);
    assert.equal(didReconnect, false);
    global.document.visibilityState = 'visible';
    await sleep(1100);
    assert.equal(didReconnect, false);
    assert(clientDoc.lastPingResponse > Date.now() - 2000, true);
    delete global.document;
  });

  await test('ping timeout parameter', async _ => {
    let clientDoc1 = await Syncable.client({url: `ws://localhost:${port}/counters/${random()}`});
    assert.equal(clientDoc1.pingTimeoutMs, 20000);
    let clientDoc2 = await Syncable.client({url: `ws://localhost:${port}/counters/${random()}`, pingTimeoutMs: 1500 });
    assert.equal(clientDoc2.pingTimeoutMs, 1500);
  });

  await test('vue3', async _ => {
    const { reactive, watch } = require('vue');
    const store = reactive({
      thingy: {
        foo: 'bar',
        count: 0,
        nested: {
          here: true,
        }
      },
      otherThingy: 'foo',
      syncalbeThingy: {},
    });


    let watchCount = 0;
    watch(
      () => store,
      (newVal, oldVal) => {
        watchCount++;
        if (watchCount == 7) {
          assert.equal(newVal.syncalbeThingy.count, 43);
          assert.equal(newVal.syncalbeThingy.otherStuff.bob, 'ross');
        }
      },
      { deep: true },
    );

    store.thingy = {};
    await sleep(1);

    const sd = await Syncable.client({url: `ws://localhost:${port}/counters/${random()}`});
    function afterSyncHandler(doc) {
      this.syncalbeThingy = doc;
    }
    sd.onAfterSync(afterSyncHandler.bind(store));

    store.syncalbeThingy = sd.doc;
    await sleep(10);

    sd.sync(d => d.count = 42);
    await sleep(10);

    sd.sync(d => d.count = 43);
    await sleep(10);

    store.thingy = {
      foo: 'bar',
      count: 32,
      nested: {
        here: true,
      },
    };
    await sleep(10);

    store.thingy.nested.here = false;
    await sleep(10);

    sd.sync(d => {
      d.count = 43;
      d.otherStuff = { bob: 'ross' };
    });
    await sleep(10);

    assert.equal(store.thingy.nested.here, false);
    assert.equal(sd.doc.count, 43);
    assert.equal(store.syncalbeThingy.count, 43);
    assert.equal(store.syncalbeThingy.otherStuff.bob, 'ross');

    sd.sync(d => {
      d.count = 40;
      d.otherStuff = false;
    });
    await sleep(1);

    assert.equal(store.syncalbeThingy.count, 40);
    assert.equal(store.syncalbeThingy.otherStuff, false);

    assert.equal(watchCount, 8);
  });

  await test('pending sort', async _ => {
    const rand = random();
    const clientDoc = await Syncable.client({url: `ws://localhost:${port}/counters/${rand}`});
    clientDoc.sync(c => c.count = 100);
    await sleep(100);
    const serverDoc = await Syncable.load(`/counters/${rand}`, template);
    assert.equal(clientDoc.count, 100);
    assert.equal(serverDoc.count, 100);

    clientDoc.pendingChanges = [
      {'diff': [{ op:'replace', path: '/count', value: 102 }], ts: Date.now() + 100046 },
      {'diff': [{ op:'replace', path: '/count', value: 101 }], ts: Date.now() + 100045 },
    ];

    clientDoc.applyPendingChanges();
    assert.equal(clientDoc.count, 102);
  });
});


async function setup() {

  let db = {};

  Syncable.init({
    redis: process.env.REDIS ? 'localhost' : null,
    reader: key => db[key],
    writer: async (key, data) => {
      await sleep(10);  // simulate disk latency
      db[key] = data
    }
  });

  const app = express();
  const { sync, handler } = Syncable(template);
  app.get('/counters/:id', handler);
  app.get('/prefix/counters/:id', handler);
  const server = await app.listen();
  return { sync, server };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function random() {
  return Math.random().toString(36).slice(2);
}
