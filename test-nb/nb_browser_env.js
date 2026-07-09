// Browser-environment regression test: evaluates the BUILT browser bundle in a
// simulated browser global scope — window present, setImmediate ABSENT (like
// Safari/WebKit) — and exercises the NB scheduler's send pump, which crashed
// with "ReferenceError: Can't find variable: setImmediate" on iOS Safari.
// Run: npm run build:browser && node test-nb/nb_browser_env.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bundlePath = path.join(__dirname, '..', 'dist', 'toolsocket.browser.js');
if (!fs.existsSync(bundlePath)) {
    console.error('bundle missing — run: npm run build:browser');
    process.exit(2);
}

// minimal browser-like WebSocket: captures sends, reports readyState OPEN
class FakeWebSocket {
    constructor() {
        this.readyState = 1; // OPEN
        this.bufferedAmount = 0;
        this.sent = [];
        this.listeners = {};
        setTimeout(() => this.emit('open', {}), 0);
    }
    addEventListener(t, cb) { (this.listeners[t] = this.listeners[t] || []).push(cb); }
    emit(t, ev) { for (const cb of this.listeners[t] || []) cb(ev); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close', {}); }
}
FakeWebSocket.prototype.OPEN = 1;

// browser-like sandbox: window exists, setImmediate does NOT (Safari), timers do
const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Array, Object, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL, URLSearchParams, Error, RegExp,
    WebSocket: FakeWebSocket,
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } },
};
sandbox.location = { href: 'http://localhost:8000/', host: 'localhost:8000', hostname: 'localhost', protocol: 'http:', port: '8000' };
sandbox.addEventListener = () => {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
if ('setImmediate' in sandbox) delete sandbox.setImmediate;

vm.createContext(sandbox);
let fails = 0;
const check = (n, ok, x) => { fails += ok ? 0 : 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`); };

try {
    vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), sandbox, { filename: 'toolsocket.browser.js' });
    check('bundle evaluates in browser scope without setImmediate', true);
} catch (e) {
    check('bundle evaluates in browser scope without setImmediate', false, e.message);
    process.exit(1);
}

vm.runInContext(`
    var results = { errors: [] };
    try {
        var ts = new ToolSocket(new URL('ws://localhost:1'), 'net', 'web');
        ToolSocket.NB.enhance(ts, { reconnect: false });
        // small JSON + a binary big enough to force the chunked path (2 chunks)
        ts.io('/bench', { hello: 1 });
        ts.io('/file', { name: 'x.dat' }, null, new Uint8Array(96 * 1024));
    } catch (e) { results.errors.push(e.message); }
`, sandbox);

setTimeout(() => {
    const r = sandbox.results;
    check('enhanced socket sends without ReferenceError', r.errors.length === 0, r.errors.join('; '));
    // the pump runs on deferred macrotasks; frames must actually leave the socket
    const ws = sandbox.__lastWs;
    vm.runInContext('results.sentCount = (function(){ return window.__sentCount; })()', sandbox);
    // count sends across all fake sockets created
    let sent = 0;
    // FakeWebSocket instances live in Node scope via constructor above
    sent = FakeWebSocket.lastInstance ? FakeWebSocket.lastInstance.sent.length : -1;
    check('scheduler pump drained frames via macrotask fallback', sent >= 3, sent + ' frames sent (hello + begin/chunk frames)');
    console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
    process.exit(fails === 0 ? 0 : 1);
}, 300);

// track last instance for assertions
const origSend = FakeWebSocket.prototype.send;
FakeWebSocket.prototype.send = function (d) { FakeWebSocket.lastInstance = this; return origSend.call(this, d); };
