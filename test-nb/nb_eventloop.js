// nb_eventloop.js — measures event-loop stalls on SENDER and RECEIVER while a 100MB
// class-5 binary moves through the NB layer (loopback, full SHA-256 integrity on).
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const NB = require('../src/ToolSocketNB.js');

const eldRx = monitorEventLoopDelay({ resolution: 5 }); eldRx.enable();
const eldTx = monitorEventLoopDelay({ resolution: 5 }); // same process; we phase-split by resetting

const srv = new NB.NBServer({ port: 9481 }, 'server');
let tDone;
srv.on('connection', s => {
    s.on('/file', (body, bin) => {   // app handler gets the fully reassembled buffer
        console.log(`receiver: got ${bin.length} bytes; event-loop max stall during transfer+reassembly: ${Math.round(eldRx.max / 1e6)}ms`);
        tDone = true;
    });
});

const cli = NB.connect('ws://127.0.0.1:9481', 'testnet', 'web');
cli.on('open', () => {
    const buf = new Uint8Array(crypto.randomBytes(100 * 1e6));
    eldRx.reset(); eldTx.enable(); eldTx.reset();
    const t0 = Date.now();
    cli.io('/file', { name: 'x.rad', type: 'rad' }, null, buf);
    // heartbeat on the SENDER: how late do 10ms timers fire while 100MB streams out?
    let worstJitter = 0, last = Date.now();
    const hb = setInterval(() => { const n = Date.now(); worstJitter = Math.max(worstJitter, n - last - 10); last = n; }, 10);
    const chk = setInterval(() => {
        if (!tDone) return;
        clearInterval(chk); clearInterval(hb);
        console.log(`sender: 100MB sent+hashed in ${((Date.now() - t0) / 1000).toFixed(1)}s; event-loop max stall: ${Math.round(eldTx.max / 1e6)}ms; worst 10ms-timer jitter: ${worstJitter}ms`);
        process.exit(0);
    }, 20);
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);
