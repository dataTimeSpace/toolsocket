// Browser bundle entry: the classic ToolSocket API plus the NB layer exposed
// as ToolSocket.NB, so browser clients can enhance their sockets:
//   const socket = new ToolSocket(url, networkId, 'web');
//   ToolSocket.NB.enhance(socket, { reconnect: false });
// Built with: npm run build:browser (esbuild IIFE, global name ToolSocket).
const ToolSocket = require('./index.js');
const NB = require('./ToolSocketNB.js');

ToolSocket.NB = NB;

module.exports = ToolSocket;
