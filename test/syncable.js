const suite = require('./index');
const assert = require('assert');
const express = require('express');
const Auto = require('pigeon').auto;

const syncable = require('../index');

suite('syncable', async test => {

  await test('auth test', async _ => {

    let db = {};

    syncable.initialize({
      reader: key => db[key],
      writer: (key, data) => db[key] = data,
      validator: (ws, req, data) => {
        return !req.query.a;
      }
    });

    const template = { count: 0 };
    const handler = syncable(template);

    const app = express();
    app.get('/counters/:id', handler);
    const server = await app.listen();
    const port = server.address().port;

    let isADenied = 0;
    let isBDenied = 0;

    const rand = random();
    const counterA = await syncable.client({url: `ws://localhost:${port}/counters/my-counter-${rand}?a=1`});
    const counterB = await syncable.client({url: `ws://localhost:${port}/counters/my-counter-${rand}?b=1`});

    counterA.on('rejected', _ => isADenied = 1);
    counterB.on('rejected', _ => isBDenied = 1);

    counterA.sync(c => c.count++);
    counterB.sync(c => c.count++);

    await sleep(100);

    assert.equal(isADenied, 1);
    assert.equal(isBDenied, 0);

    server.close();
  });

  await test('write timing', async _ => {

    let db = {};
    let writes = 0;
    const t0 = Date.now();

    syncable.initialize({
      window: 1000,
      reader: key => db[key],
      writer: (key, data) => {
        writes += 1;
        db[key] = data;
      },
    });

    const doc = await syncable.load('/xdoc');

    await sleep(100);
    assert.equal(writes, 1, 'zeroth write');
    doc.sync(d => d.key = 1);

    await sleep(100);
    assert.equal(writes, 1, 'write delayed');
    assert.equal(doc.key, 1, 'data in doc');

    await sleep(1000);
    assert.equal(writes, 2, 'first write happened');
    doc.sync(d => d.key = 2);

    await sleep(100);
    assert.equal(writes, 2, 'second write delayed');
    assert.equal(doc.key, 2, 'second data in doc');

    await sleep(1000);
    assert.equal(writes, 3, 'second write happened');
  });

  await test('read catch up', async _ => {

    let db = {};
    let writes = 0;
    const t0 = Date.now();

    syncable.initialize({
      window: 1000,
      reader: key => db[key],
      writer: (key, data) => {
        writes += 1;
        db[key] = data;
      },
    });

    let doc = await syncable.load('/zdoc');

    await sleep(100);
    assert.equal(writes, 1, 'zeroth write');
    doc = await doc.sync(d => { d.key = 1 });

    syncable.unload('/zdoc');
    doc = await syncable.load('/zdoc');
    //await sleep(100);
    assert.equal(doc.key, 1);
  });

  await test('backfill', async _ => {

    let db = {};

    syncable.initialize({
      reader: key => db[key],
      writer: (key, data) => db[key] = data,
    });

    const template = { propOne: true };
    let doc = await syncable.load('tdoc', template);

    template.propTwo = true;
    syncable.unload('tdoc');
    doc = await syncable.load('tdoc', template);
    assert.equal(doc.propTwo, true);
  });
});

function random() {
  return Math.random().toString(36).slice(2);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
