const EventEmitter = require('node:events');

const subscribers = {};
const streams = {};
const xreaders = {};

class Local extends EventEmitter {
  constructor() {
    super();
    this.instanceId = Math.random().toString(36).slice(2);
  }
  publish(channel, data) {
    for (const [subscriber, fn] of subscribers[channel] || []) {
      subscriber.emit('message', channel, data);
      fn(null, 1);
    }
  }
  subscribe(channel, fn) {
    subscribers[channel] ||= [];
    subscribers[channel].push([this, fn]);
  }
  xread() {
    const args = [...arguments].reverse();
    let [minId, key, STREAMS, ms, block] = args;
    if (minId == '$') minId = Date.now();

    const messages = streams[key]?.filter(m => m[0] > minId);
    if (messages?.length) {
      return [[key, messages]];
    }

    if (block) {
      return new Promise(resolve => {
        xreaders[key] ||= [];
        xreaders[key].push({
          minId,
          instanceId: this.instanceId,
          fn: resolve,
        });
      });
    } else {
      return null;
    }
  }
  xadd(key, messageId, field, value) {
    if (messageId == '*') messageId = Date.now();
    streams[key] ||= [];
    streams[key].push([messageId, [field, value]]);
    setTimeout(_ => {
      for (const r of xreaders[key] || []) {
        if (r.instanceId != this.instanceId) {
          r.fn(['key', [messageId, [field, value]]]);
        }
      }
    }, 10);
  }
}

module.exports = Local;
