const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: './client.js',
  mode: 'development',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'client.js',
    libraryTarget: 'umd',
    globalObject: 'this',
    library: 'Syncable'
  }
};
