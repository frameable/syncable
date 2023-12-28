const suite = require('./index');
const assert = require('assert');
const express = require('express');

const Rater = require('../rater');

suite('rater', async test => {

  await test('basic', async _ => {

    const rater = new Rater(10, 100);

    for (const i of Array(10).keys()) {
      rater.increment();
    }

    assert.equal(rater.rate(), 100);
    await sleep(100);
    assert.equal(rater.rate(), 50);

  });

  await test('zero state', async _ => {
    const rater = new Rater();
    assert.equal(rater.rate(), 0);
  });

  await test('sustained', async _ => {

    const rater = new Rater(10, 100);

    for (const i of Array(3).keys()) {
      for (const i of Array(10).keys()) {
        rater.increment();
      }
      assert.equal(rater.rate(), 100);
      await sleep(100);
    }
  });

  await test('choppy', async _ => {

    const rater = new Rater(10, 100);

    for (const i of Array(3).keys()) {
      for (const i of Array(10).keys()) {
        rater.increment();
      }
      await sleep(100);
      assert.equal(rater.rate(), 50);
      await sleep(100);
    }
  });

  await test('reap', async _ => {

    const rater = new Rater(3, 100);

    for (const i of Array(10).keys()) {
      for (const i of Array(10).keys()) {
        rater.increment();
      }
      assert(Object.keys(rater.buckets).length <= 4);
      await sleep(100);
    }
  });

});

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
