// index.nbshim.js - substituted for src/index.js when running the ORIGINAL test suite
// against the ToolSocketNB layer (see jest.nb.config.json). Tests are unmodified.
const Orig = require('../src/index.js'); // '../src/...' bypasses the jest name mapper
const { enhance } = require('./ToolSocketNB.js');

class NBToolSocket extends Orig {
    constructor(...args) { super(...args); enhance(this); }
}
class NBToolSocketServer extends Orig.Server {
    constructor(...args) {
        super(...args);
        this.addEventListener('connection', socket => enhance(socket));
    }
}
NBToolSocket.Server = NBToolSocketServer;
module.exports = NBToolSocket;
