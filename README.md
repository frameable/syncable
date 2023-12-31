# Syncable

Synchronize JSON data structures across servers and clients over WebSockets and Redis

```javascript
// server.js

const app = express();
app.get('/documents/:id', syncable.handle());
```

```javascript
// client.js

let doc = await syncable.client({url: `wss://localhost/documents/my-document`});
doc = doc.sync(d => d.title = 'New title');
```

## Introduction

Syncable is a framework for synchronizing JSON data structures across many servers and many clients, to facilitate collaborative real-time web applications.  On the server, install a syncable route handler for each type of document you wish to service.  In the browser, use the syncable client to make a websocket connection and get back a document.  Once you have the document on the client or server, call its `sync` method to make changes, and those changes will propagate to all other servers and clients, via Redis streams, and WebSockets.

## How it works

Syncable documents consist of snapshots and change events.  At any time, the current state of a document can be derived from its latest snapshot and any subsequent changes.  Snapshots are stored in persistent storage, and changes are temporarily queued in Redis streams.  By default, snapshots are taken within 30 seconds after each change.  Change events live in Redis only until they've been incorporated into a snapshot, after which point may be removed.

Underlying documents are based on [Pigeon](https://github.com/frameable/pigeon), which itself is heavily inspired by [Automerge](https://github.com/automerge/automerge).  When a client changes a document, a JSON Patch style diff is generated, and propagated to all other servers and clients who have that document loaded.  Even when changes arrive in a different order, the result is deterministic.

## Performance and scalability

Syncable scales across many backend servers and up to hundreds or thousands of simultaneous clients per document.  In lower-volume settings, each change is broadcast and applied individually, but as volume increases, changes are batched and applied in bulk.  For example, if changes are happening at a rate of 1 per second, then they will be applied without delay. 
 However, once changes are arriving at 10 per second, then the changes will be queued for 3 seconds, and then applied together as a batch.

## Client API

#### syncable.client(options)

Load a live syncable document from the server.  Options include:

- `url` - WebSocket url to a document where a syncable handler is listening.


```javascript
let doc = await syncable.client({ url: `wss://localhost/documents/my-document` })
```

### doc.sync(fn)

Make a change to the document and sync that change to all other servers and clients.

```javascript
let doc = await syncable.client({ url });
doc = await doc.sync(d => d.title = 'My title');

console.log(doc);
// { title: "My title" }
```

### doc.on(eventName, handler)

Add an event handler function for a given event.  Emitted events include:

- `initialized` - Document has been loaded from the server and is ready for consumption.
- `changed` - Document has been changed, either by us or by another client.
- `rejected` - Our change has been rejected by the server by the validator function.
- `connected` - WebSocket connection has been established.
- `reconnecting` - WebSocket is reconnecting, possibly after a ping timeout or other network event.
- `closed` - WebSocket connection has been closed.
- `error` - WebSocket error has occurred.


## Server API

#### syncable.initialize(options)

Configure and initialize the syncable library.  All properties are optional:

- `writer` - Function to override writing document snapshots to persistent storage.  By default, snapshots are written to Redis, but use this function if you prefer to write somewhere else such as S3, Postgres, local disk, etc.  Snapshot writes are debounced, occurring as often as every 30 seconds by default following a change. See the `window` option to configure the timing.  Function takes `key` and `data` parameters.

  ```javascript
  function writer(key, data) {
    redis.set(key, data);
  }

- `reader` - Function to override reading document snapshots from persistent storage.  This is the reciprocal of the `writer` function above.  Takes a `key` parameter and returns data that was written by `writer`.

  ```javascript
  function reader(key) {
    return await redis.get(key);
  }
  ```

- `validator` - Function to validate incoming changes.  Useful for example to ensure the user has permissions to make the specified modification, or that the change is to an appropriate part of the document.

  ```javascript
  function validator(ws, req, { changes }) {
    if (!req.session.isAdmin && changes.diff.filter(d => d.path.match('/settings')).length) {
      return false;
    } else {
      return true;
    }
  }
  ```

- `window` - Minimum number of milliseconds between subsequent writes to persistent storage.  Intermediate document changes will be queued in Redis streams at least until the next write.  Defaults to `30_000` (30 seconds).

- `redis` - Configuration to be passed to `ioredis`.

#### syncable.load(key)

Load the document with the given key.  Document will be retrieved from memory if it has already been loaded.  Otherwise, it will be fetched from persistent storage with `reader`, and have any subsequent queued changes applied.  Returns the loaded document.

```javascript
let doc = await syncable.load('/documents/my-document');
```

#### syncable.unload(key)

Unload the document from memory.  Any next call to `load` will fetch from persistent storage.

#### doc.sync(fn)

Make a change to the document and sync that change to all other servers and clients.

```javascript
let doc = await syncable.load('/documents/my-document');
doc = await doc.sync(d => d.title = 'My title');

console.log(doc);
// { title: "My title" }
```

## License

The MIT License

Copyright (c) 2023 Frameable Inc, David Chester, Doug Brunton, Logan Bell, Daniel Dyssegaard Kallick

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


