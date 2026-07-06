// nb_pressure.js — tests the process-wide backpressure hold/resume mechanism.
// Parent process: two NBServer instances (proves the registry aggregates across instances).
// Child process: NB clients (own registry) + one legacy raw-ToolSocket client.
//
// Covers: organic detection (queued bytes cross high watermark) -> hold callback(true),
// drain -> jittered resume callback(false); manual hold()/release; late joiner during a
// hold learns it via the hello handshake on a DIFFERENT server instance; legacy peers
// are unaffected; NB.pressure.on('change') events fire with reasons.
const { fork } = require('child_process');
const path = require('path');

const PORT1 = 9601, PORT2 = 9602;

if (process.argv[2] === 'child') {
    // ---------------- child: clients ----------------
    const NB = require('../src/ToolSocketNB.js');
    const TS = require('../src/index.js');
    const evs = [];
    const c1 = NB.connect(`ws://127.0.0.1:${PORT1}`, 'testnet', 'web', { holdResumeJitterMs: 60, reconnect: false });
    c1.onHoldChange(h => { evs.push(h); process.send({ ev: 'hold1', v: h, isHeld: c1.isHeld() }); });
    c1.on('open', () => process.send({ ev: 'c1open' }));
    c1.on('/json', b => process.send({ ev: 'c1json', seq: b.seq }));

    let c2 = null, legacy = null;
    process.on('message', m => {
        if (m.cmd === 'connectLate') {
            c2 = NB.connect(`ws://127.0.0.1:${PORT2}`, 'testnet', 'web', { holdResumeJitterMs: 60, reconnect: false });
            c2.onHoldChange(h => process.send({ ev: 'hold2', v: h }));
            c2.on('open', () => process.send({ ev: 'c2open' }));
        }
        if (m.cmd === 'connectLegacy') {
            legacy = new TS(new URL(`ws://127.0.0.1:${PORT1}`), 'testnet', 'web');
            legacy.on('open', () => legacy.io('/ping', { x: 1 }));
            legacy.on('/pong', () => process.send({ ev: 'legacyPong' }));
        }
        if (m.cmd === 'exit') process.exit(0);
    });
    setTimeout(() => process.exit(1), 30000);
    return;
}

// ---------------- parent: servers + orchestration ----------------
const NB = require('../src/ToolSocketNB.js');
const crypto = require('crypto');

// tiny thresholds so the test triggers without hitting real limits; RSS trigger disabled
NB.pressure.configure({ highBytes: 1.5e6, lowBytes: 0.3e6, sampleMs: 40, minHoldMs: 150, rssHighFrac: 10, rssLowFrac: 9 });
const changes = [];
NB.pressure.on(ev => changes.push(ev));

// big initial window so queued bytes can exceed the high watermark while class 5 is gated
const srv1 = new NB.NBServer({ port: PORT1 }, 'server', { ackWindow: 64 });
const srv2 = new NB.NBServer({ port: PORT2 }, 'server', { ackWindow: 64 });

let sock1 = null;
srv1.on('connection', s => {
    if (!sock1) sock1 = s;
    s.on('/ping', () => s.io('/pong', { ok: 1 })); // legacy echo
});
srv2.on('connection', () => {});

const child = fork(__filename, ['child'], { cwd: __dirname });
const got = [];
child.on('message', m => { got.push(m); step(m); });

const fail = msg => { console.error('FAIL:', msg, '\nevents:', JSON.stringify(got)); child.kill(); process.exit(1); };
const t = setTimeout(() => fail('timeout'), 25000);

let phase = 'connect';
function step(m) {
    if (phase === 'connect' && m.ev === 'c1open') {
        phase = 'organicHold';
        setTimeout(() => {
            // gate class 5 on the server-side socket, then queue a 4 MB .rad:
            // chunks fill the send window but cannot dequeue -> queued bytes cross the watermark
            sock1.pauseSends(5);
            sock1.io('/file', { name: 'x.rad', type: 'rad' }, null, new Uint8Array(crypto.randomBytes(4 * 1e6)));
        }, 300); // give the hello handshake time to settle
    }
    if (phase === 'organicHold' && m.ev === 'hold1' && m.v === true) {
        if (!m.isHeld) fail('isHeld() false during hold');
        if (NB.pressure.state().held !== true) fail('server state not held');
        phase = 'lateJoiner';
        child.send({ cmd: 'connectLate' }); // connects to srv2 DURING the hold
    }
    if (phase === 'lateJoiner' && m.ev === 'hold2' && m.v === true) {
        phase = 'organicResume';
        sock1.resumeSends(); // drain: transfer completes, aggregate falls below low watermark
    }
    if (phase === 'organicResume' && m.ev === 'hold1' && m.v === false) {
        const h2f = got.find(x => x.ev === 'hold2' && x.v === false);
        const proceed = () => {
            phase = 'manual';
            NB.pressure.hold(true);
        };
        if (h2f) proceed(); else { const w = setInterval(() => { if (got.find(x => x.ev === 'hold2' && x.v === false)) { clearInterval(w); proceed(); } }, 20); }
    }
    if (phase === 'manual' && m.ev === 'hold1' && m.v === true) {
        phase = 'manualRelease';
        setTimeout(() => NB.pressure.hold(false), 100);
    }
    if (phase === 'manualRelease' && m.ev === 'hold1' && m.v === false) {
        NB.pressure.hold(null); // back to automatic
        phase = 'legacy';
        child.send({ cmd: 'connectLegacy' });
    }
    if (phase === 'legacy' && m.ev === 'legacyPong') {
        // final assertions
        const seq1 = got.filter(x => x.ev === 'hold1').map(x => x.v);
        const expect = [true, false, true, false];
        if (JSON.stringify(seq1) !== JSON.stringify(expect)) fail(`hold1 sequence ${JSON.stringify(seq1)} != ${JSON.stringify(expect)}`);
        if (!got.find(x => x.ev === 'hold2' && x.v === true)) fail('late joiner never learned the hold');
        if (changes.length < 4) fail(`expected >=4 change events, got ${changes.length}`);
        if (!changes.find(c => c.reason === 'bytes')) fail('no bytes-reason change event');
        if (!changes.find(c => c.reason === 'manual')) fail('no manual-reason change event');
        if (NB.pressure.state().sockets < 3) fail(`registry has ${NB.pressure.state().sockets} sockets, expected >=3`);
        clearTimeout(t);
        console.log('PASS  hold1 sequence:', JSON.stringify(seq1),
            '\nPASS  late joiner held on connect (via srv2 hello)',
            '\nPASS  legacy client served normally during/after holds',
            '\nPASS  change events:', changes.map(c => `${c.held ? 'HOLD' : 'RESUME'}(${c.reason})`).join(' -> '),
            '\nPASS  registry sockets:', NB.pressure.state().sockets);
        child.send({ cmd: 'exit' });
        setTimeout(() => { srv1.inner.close(); srv2.inner.close(); process.exit(0); }, 200);
    }
}
