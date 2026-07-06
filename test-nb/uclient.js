// client.js — emulates web-browser ToolSocket clients (wire-identical protocol via the same library).
// env: SPEC="A1:9201,A2:9202" (name:throttlePort), KIND=A|B, SEED, T0, WINDOW_MS, DEADLINE (epoch ms)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ToolSocket = require(process.env.LIB || '../src/index.js');

const LOGDIR = process.env.LOGDIR ? (path.isAbsolute(process.env.LOGDIR)?process.env.LOGDIR:path.join(__dirname,process.env.LOGDIR)) : path.join(__dirname, 'logs');
const KIND = process.env.KIND;
const SEED = parseInt(process.env.SEED || '1', 10);
const T0 = parseInt(process.env.T0, 10);
const WINDOW_MS = parseInt(process.env.WINDOW_MS || '90000', 10);
const DEADLINE = parseInt(process.env.DEADLINE, 10);
const NMSG = parseInt(process.env.NMSG || '200', 10);
const EXPECT_JSON = 19 * NMSG;
const EXPECT_FILES = KIND === 'B' ? 3 : 0;

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const specs = process.env.SPEC.split(',').map(s => {
    const [name, port] = s.split(':');
    return { name, port: parseInt(port, 10) };
});

const states = [];

for (const { name, port } of specs) {
    const rand = mulberry32(SEED + name.charCodeAt(0) * 1000 + parseInt(name.slice(1), 10));
    const sock = new ToolSocket(new URL(`ws://127.0.0.1:${port}`), 'testnet', 'web');
    const st = {
        name, sock,
        jsonReceived: 0, perFrom: new Map(), latencies: [], latBuckets: new Map(),
        files: [], dropped: 0, closes: 0, opens: 0, done: false
    };
    states.push(st);

    sock.on('open', () => {
        st.opens++;
        sock.io('/hello', { name, kind: KIND });
    });
    sock.on('close', () => { st.closes++; });
    sock.on('droppedMessage', () => { st.dropped++; });

    sock.on('/json', body => {
        st.jsonReceived++;
        if (!st.perFrom.has(body.from)) st.perFrom.set(body.from, new Set());
        st.perFrom.get(body.from).add(body.seq);
        const lat = Date.now() - body.sentAt;
        st.latencies.push(lat);
        // 5-second buckets relative to T0 for the time series
        const bucket = Math.floor((Date.now() - T0) / 5000);
        if (!st.latBuckets.has(bucket)) st.latBuckets.set(bucket, { n: 0, sum: 0, max: 0 });
        const b = st.latBuckets.get(bucket);
        b.n++; b.sum += lat; b.max = Math.max(b.max, lat);
    });

    if (KIND === 'B') {
        sock.on('/file', (body, binaryData) => {
            const receivedAt = Date.now();
            const hash = crypto.createHash('sha256').update(binaryData).digest('hex');
            st.files.push({
                fileId: body.fileId, size: body.size, gotBytes: binaryData ? binaryData.length : 0,
                sha256ok: hash === body.sha256, transferMs: receivedAt - body.sentAt
            });
            console.log(`[${name}] file ${body.fileId} ${(body.size / 1e6).toFixed(1)}MB in ${((receivedAt - body.sentAt) / 1000).toFixed(1)}s hashOK=${hash === body.sha256}`);
        });
    }

    // schedule 200 JSON sends at random times within the window
    const pad = 'x'.repeat(180);
    for (let seq = 0; seq < NMSG; seq++) {
        const at = T0 + Math.floor(rand() * WINDOW_MS);
        setTimeout(() => {
            sock.io('/json', { from: name, seq, sentAt: Date.now(), pad });
        }, Math.max(0, at - Date.now()));
    }
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(st, complete) {
    const lat = st.latencies.slice().sort((a, b) => a - b);
    const perFrom = {};
    for (const [f, s] of st.perFrom) perFrom[f] = s.size;
    const buckets = {};
    for (const [k, v] of st.latBuckets) buckets[k] = { n: v.n, mean: Math.round(v.sum / v.n), max: v.max };
    return {
        name: st.name, kind: KIND, complete,
        jsonReceived: st.jsonReceived, expectedJson: EXPECT_JSON,
        sendersSeen: st.perFrom.size, perFrom,
        latMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), p99: percentile(lat, 0.99), max: lat[lat.length - 1] || null },
        latBuckets: buckets,
        files: st.files, dropped: st.dropped, closes: st.closes, opens: st.opens
    };
}

const checker = setInterval(() => {
    let allDone = true;
    for (const st of states) {
        st.done = st.jsonReceived >= EXPECT_JSON && st.files.length >= EXPECT_FILES;
        if (!st.done) allDone = false;
    }
    const timedOut = Date.now() > DEADLINE;
    if (allDone || timedOut) {
        clearInterval(checker);
        for (const st of states) {
            fs.writeFileSync(path.join(LOGDIR, `${st.name}.summary.json`),
                JSON.stringify(summarize(st, st.done), null, 2));
        }
        process.exit(allDone ? 0 : 2);
    }
}, 1000);
