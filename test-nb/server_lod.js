// server_lod.js — on-demand LOD file server (NB). Clients request via '/req' (routed by
// the proxy to this server only); each request is answered with a class-5 '.rad' payload
// addressed to the requesting client (the proxy's relay hook forwards chunks cut-through).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NB = require('../src/ToolSocketNB.js');

const LOGDIR = process.env.LOGDIR ? (path.isAbsolute(process.env.LOGDIR) ? process.env.LOGDIR : path.join(__dirname, process.env.LOGDIR)) : path.join(__dirname, 'logs_lod');
const PORT = parseInt(process.env.PORT || '9199', 10);

const sock = NB.connect(`ws://127.0.0.1:${PORT}`, 'testnet', 'server', { maxUnackedBytes: 64 * 1024 * 1024 });

// 32 MB random pool; each response is a slice (offset varies) -> unique-ish, no per-request CPU
const POOL = crypto.randomBytes(32 * 1e6);

let jsonCount = 0, reqCount = 0, sentBytes = 0, holdsSeen = [];
const received = new Map();

sock.on('open', () => { console.log('[server-lod] connected'); sock.io('/hello', { name: 'server', kind: 'server' }); });
sock.on('/json', body => {
    jsonCount++;
    if (!received.has(body.from)) received.set(body.from, new Set());
    received.get(body.from).add(body.seq);
});
sock.onHoldChange(h => holdsSeen.push({ t: Date.now(), held: h }));
let txFailed = 0, txAborted = 0;
sock.on('nbTransfer', e => { if (e.phase === 'failed') txFailed++; if (e.phase === 'aborted') txAborted++; }); // advisory; server app takes no action (per design)

sock.on('/req', body => {
    reqCount++;
    const size = Math.max(1e6, Math.min(20e6, body.size | 0));
    const off = (reqCount * 977 * 1024) % (POOL.length - size);
    const slice = POOL.subarray(off, off + size);
    const sha256 = crypto.createHash('sha256').update(slice).digest('hex');
    sentBytes += size;
    sock.io('/file', { to: body.from, fileId: `${body.from}-r${body.reqId}`, reqId: body.reqId,
                       size, sha256, sentAt: Date.now(), type: 'rad' },
            null, slice);
});

function shutdown() {
    fs.writeFileSync(path.join(LOGDIR, 'server.summary.json'), JSON.stringify({
        jsonCount, reqCount, sentBytes, sendersSeen: received.size, holdsSeen, txFailed, txAborted
    }));
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log('[server-lod] ready (pool 32MB, class-5 responses)');
