const express = require('express');
const syncable = require('../index');

const app = express();

app.use(express.static('dist'));

syncable.initialize({ redis: 'localhost' });

app.get('/', (req, res) => {
  res.send(`
    <!doctype html>
    <div id="status"></div>
    <h1>Hello, World!</h1>
    <script src="/syncable.js"> </script>
    <script type="module">
      window.doc = await Syncable({ url: 'wss://dev.metamap.studio/documents/my-document' });
      setInterval(_ => doc.sync(d => d.message = Math.random().toString(36).slice(2)), 2000);
      doc.on('changed', _ => {
        console.log("CHANGE");
        document.querySelector('h1').innerText = doc.message
      });
      doc.on('initialized', _ => {
        console.log("INITIALIZED");
      });
      doc.on('connected', _ => {
        console.log("CONNECTED");
      });
      doc.on('reconnecting', _ => {
        console.log("RECONNECTING");
      });
      doc.on('closed', _ => {
        console.log("CLOSED");
      });
    </script>
  `)
});

app.get('/documents/:id', syncable());


app.listen(3012);
