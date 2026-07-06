// server.js — the Node.js collector/file server.
// Connects to the proxy (through the 1 Gbit/s throttle) as a ToolSocket client.
// - Collects every /json message forwarded by the proxy.
// - Sends 3 binary files (random 5-100 MB, random content) to each B client at random times.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ToolSocket = require(process.env.LIB || '../src/index.js');

const LOGDIR = process.env.LOGDIR ? (path.isAbsolute(process.env.LOGDIR)?process.env.LOGDIR:path.join(__dirname,process.env.LOGDIR)) : path.join(__dirname, 'logs');
const SEED = parseInt(process.env.SEED || '42', 10);
const T0 = parseInt(process.env.T0, 10);           // epoch ms when send window opens
const WINDOW_MS = parseInt(process.env.WINDOW_MS || '90000', 10);
const PORT = parseInt(process.env.PORT || '9199', 10);
const FMIN = parseFloat(process.env.FILE_MIN_MB || '5');
const FMAX = parseFloat(process.env.FILE_MAX_MB || '100');

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(SEED);

const sock = new ToolSocket(new URL(`ws://127.0.0.1:${PORT}`), 'testnet', 'server');

const received = new Map(); // from -> Set(seq)
let jsonCount = 0;
const fileLog = [];
let dropped = 0;
const closes = [];

sock.on('open', () => {
    console.log('[server] connected to proxy');
    sock.io('/hello', { name: 'server', kind: 'server' });
});
sock.on('droppedMessage', () => { dropped++; });
sock.on('close', () => { closes.push(Date.now()); console.log('[server] connection to proxy CLOSED'); });

sock.on('/json', body => {
    jsonCount++;
    if (!received.has(body.from)) received.set(body.from, new Set());
    received.get(body.from).add(body.seq);
});

// Build the file schedule: 3 files per B client, sizes uniform 5-100 MB (decimal MB),
// send times uniform across the window.
const schedule = [];
for (let i = 1; i <= 10; i++) {
    for (let j = 0; j < 3; j++) {
        schedule.push({
            to: `B${i}`,
            fileId: `B${i}-f${j}`,
            size: Math.floor((FMIN + rand() * (FMAX - FMIN)) * 1e6),
            at: Math.floor(rand() * WINDOW_MS)
        });
    }
}
schedule.sort((a, b) => a.at - b.at);
fs.writeFileSync(path.join(LOGDIR, 'server.schedule.json'), JSON.stringify(schedule, null, 2));

function sendFile(entry) {
    const genStart = Date.now();
    const buf = crypto.randomBytes(entry.size);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const genMs = Date.now() - genStart;
    const sentAt = Date.now();
    sock.io('/file', { to: entry.to, fileId: entry.fileId, size: entry.size, sha256, sentAt }, null, new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    fileLog.push({ ...entry, sha256, sentAt, genMs, bufferedAfterSend: sock.socket.bufferedAmount || 0 });
    console.log(`[server] sent ${entry.fileId} (${(entry.size / 1e6).toFixed(1)} MB) to ${entry.to}`);
}

for (const entry of schedule) {
    const delay = Math.max(0, T0 + entry.at - Date.now());
    setTimeout(() => sendFile(entry), delay);
}

function shutdown() {
    const perClient = {};
    let missingTotal = 0;
    for (const [from, seqs] of received) {
        const missing = [];
        for (let s = 0; s < parseInt(process.env.NMSG || '200', 10); s++) if (!seqs.has(s)) missing.push(s);
        missingTotal += missing.length;
        perClient[from] = { received: seqs.size, missing };
    }
    fs.writeFileSync(path.join(LOGDIR, 'server.summary.json'), JSON.stringify({
        jsonCount, sendersSeen: received.size, perClient, missingTotal,
        filesSent: fileLog, dropped, closes
    }, null, 2));
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
