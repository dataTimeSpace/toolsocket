// repro_stall2.js — scaled repro: 30 concurrent class-5 transfers through a relay proxy,
// tight shared maxUnackedBytes at the server, client-facing sockets duty-cycled
// (75% paused) to emulate slow throttled links. Watches for tail stalls.
const NB = require('../src/ToolSocketNB.js');
const crypto = require('crypto');

const PORT = 9781;
const N = 30, FILE = 4e6;
const T0 = Date.now();
const L = [];
const log = (who, ev, x = {}) => L.push({ t: Date.now() - T0, who, ev, ...x });

const clients = new Map();
let serverSock = null;
const relay = env => (env && env.r === '/file' && env.b && env.b.to) ? clients.get(env.b.to) : null;
const prx = new NB.NBServer({ port: PORT }, 'proxy', { relay });
prx.on('connection', s => {
    s.on('/hello', b => { if (b.kind === 'server') serverSock = s; else clients.set(b.name, s); });
    s.on('/req', b => serverSock && serverSock.io('/req', b));
});

const srv = NB.connect(`ws://127.0.0.1:${PORT}`, 'testnet', 'server', { maxUnackedBytes: 8e6 });
const POOL = crypto.randomBytes(8e6);
let ends = 0;
srv.on('open', () => srv.io('/hello', { name: 'server', kind: 'server' }));
srv.on('/req', b => {
    const slice = POOL.subarray(0, FILE);
    const sha = crypto.createHash('sha256').update(slice).digest('hex');
    srv.io('/file', { to: b.from, fileId: b.from, reqId: 1, size: FILE, sha256: sha, sentAt: Date.now(), type: 'rad' }, null, slice);
});
srv.on('nbTransfer', e => { if (e.phase === 'sent') ends++; if (e.phase === 'failed') log('server', 'tx:failed', { reason: e.reason }); });

let delivered = 0, gc = 0;
const mk = name => {
    const c = NB.connect(`ws://127.0.0.1:${PORT}`, 'testnet', 'web', { transferTimeoutMs: 3000 });
    c.on('open', () => c.io('/hello', { name, kind: 'B' }));
    c.on('/file', () => { delivered++; log(name, 'DELIVERED'); });
    c.on('nbTransfer', e => { if (e.phase === 'failed') { gc++; log(name, 'rx:failed', { reason: e.reason }); } });
    return c;
};
const cs = []; for (let i = 1; i <= N; i++) cs.push(mk('B' + i));

setTimeout(() => {
    for (const c of cs) { const n = 'B' + (cs.indexOf(c) + 1); c.io('/req', { from: n, reqId: 1, size: FILE }); }
    // duty-cycle the client-facing sockets: 300ms paused / 100ms open (slow effective drain)
    let open = false;
    const duty = setInterval(() => {
        open = !open;
        for (const [, s] of clients) { if (open) s.resumeSends(); else s.pauseSends(5); }
    }, open ? 100 : 300);
    setTimeout(() => { clearInterval(duty); for (const [, s] of clients) s.resumeSends(); log('proxy', 'duty:off'); }, 20000);
}, 1200);

const mon = setInterval(() => {
    const bp = srv.getBackpressure ? srv.getBackpressure() : {};
    log('mon', 'srv', { queued: bp.queuedBytes, delivered, ends, gc });
}, 2000);

setTimeout(() => {
    clearInterval(mon);
    console.log('--- monitor samples ---');
    for (const e of L.filter(x => x.who === 'mon')) console.log(`${String(e.t).padStart(6)}ms queued=${e.queued} delivered=${e.delivered}/${N} serverSent=${e.ends} clientGC=${e.gc}`);
    console.log('--- failures ---');
    for (const e of L.filter(x => x.ev.includes('failed'))) console.log(e);
    console.log(`\nVERDICT: delivered=${delivered}/${N}  clientGC=${gc}  serverSentComplete=${ends}`);
    process.exit(0);
}, 35000);
