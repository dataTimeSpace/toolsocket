// client_lod.js — batched A/B clients for the request-driven full-horizon test.
// A: JSON only. B: JSON + an on-demand LOD loop: request the next class-5 file as soon
// as the previous one arrives — UNLESS the peer signalled hold. This is the client-side
// backpressure implementation: onHoldChange(true) pauses the request loop, (false)
// resumes it (the library delivers the resume with per-client jitter).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NB = require('../src/ToolSocketNB.js');

const LOGDIR = process.env.LOGDIR ? (path.isAbsolute(process.env.LOGDIR) ? process.env.LOGDIR : path.join(__dirname, process.env.LOGDIR)) : path.join(__dirname, 'logs_lod');
const KIND = process.env.KIND;
const SEED = parseInt(process.env.SEED || '1', 10);
const T0 = parseInt(process.env.T0, 10);
const WINDOW_MS = parseInt(process.env.WINDOW_MS || '60000', 10);
const DEADLINE = parseInt(process.env.DEADLINE, 10);
const NMSG = parseInt(process.env.NMSG || '100', 10);
const WINDOW_END = T0 + WINDOW_MS;

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const specs = process.env.SPEC.split(',').map(x => { const [name, port] = x.split(':'); return { name, port: parseInt(port, 10) }; });
const states = [];
const pad = 'x'.repeat(180);

for (const { name, port } of specs) {
    const rand = mulberry32(SEED + name.charCodeAt(0) * 1000 + parseInt(name.slice(1), 10));
    const sock = NB.connect(`ws://127.0.0.1:${port}`, 'testnet', 'web', { holdResumeJitterMs: 2000 });
    const st = { name, sock, jsonReceived: 0, latencies: [], files: [], bytes: 0, badHash: 0,
                 reqId: 0, inFlight: false, held: false, holdEvents: [], heldMs: 0, heldSince: 0,
                 reqBlockedByHold: 0, dropped: 0, opens: 0, closes: 0 };
    states.push(st);

    sock.on('open', () => { st.opens++; sock.io('/hello', { name, kind: KIND }); });
    sock.on('close', () => { st.closes++; });
    sock.on('droppedMessage', () => { st.dropped++; });
    sock.on('/json', body => { st.jsonReceived++; st.latencies.push(Date.now() - body.sentAt); });

    if (KIND === 'B') {
        // ------- client-side backpressure implementation -------
        sock.onHoldChange(held => {
            st.held = held;
            st.holdEvents.push({ t: Date.now() - T0, held });
            if (held) st.heldSince = Date.now();
            else { st.heldMs += Date.now() - st.heldSince; requestNext(st); }
        });
        const requestNext = (s) => {
            if (s.inFlight) return;
            if (Date.now() > WINDOW_END) return;                 // horizon closed: stop initiating
            if (s.held) { s.reqBlockedByHold++; return; }        // HOLD: do not request class-5
            s.inFlight = true;
            s.reqId++;
            const size = Math.floor(5e6 + rand() * 10e6);        // 5-15 MB LOD tile
            s.sock.io('/req', { from: s.name, reqId: s.reqId, size });
        };
        st.requestNext = requestNext;
        sock.on('nbTransfer', e => { // transfer died (timeout/abort): free the slot, try again
            if (e.phase === 'failed' || e.phase === 'aborted') {
                if (st.inFlight) { st.failed = (st.failed || 0) + 1; st.inFlight = false; requestNext(st); }
            }
        });
        sock.on('/file', (body, bin) => {
            const ok = bin && bin.length === body.size &&
                crypto.createHash('sha256').update(bin).digest('hex') === body.sha256;
            if (!ok) st.badHash++;
            st.files.push({ reqId: body.reqId, size: body.size, ms: Date.now() - body.sentAt, ok });
            st.bytes += body.size;
            st.inFlight = false;
            requestNext(st);
        });
        // kick off once connected + settled
        const kickAt = T0 + Math.floor(rand() * 5000);
        const kick = setInterval(() => {
            if (Date.now() >= kickAt) { clearInterval(kick); requestNext(st); }
        }, 200);
    }

    for (let seq = 0; seq < NMSG; seq++) {
        const at = T0 + Math.floor(rand() * WINDOW_MS);
        setTimeout(() => {
            try {
                sock.io('/json', { from: name, seq, sentAt: Date.now(), pad });
            } catch (e) {
                console.warn('unable to call io json', e);
            }
        }, Math.max(0, at - Date.now()));
    }
}

function pct(v, p) { return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null; }
function summarize(st) {
    const lat = st.latencies.slice().sort((a, b) => a - b);
    if (st.held && st.heldSince) st.heldMs += Date.now() - st.heldSince;
    return {
        name: st.name, kind: KIND, jsonReceived: st.jsonReceived,
        lat: { p50: pct(lat, .5), p95: pct(lat, .95), p99: pct(lat, .99), max: lat[lat.length - 1] || null },
        filesGot: st.files.length, filesOk: st.files.filter(f => f.ok).length, bytes: st.bytes, failed: st.failed || 0,
        fileMs: st.files.map(f => f.ms),
        holdEvents: st.holdEvents, heldMs: Math.round(st.heldMs), reqBlockedByHold: st.reqBlockedByHold,
        dropped: st.dropped, opens: st.opens, closes: st.closes
    };
}

const checker = setInterval(() => {
    const pastWindow = Date.now() > WINDOW_END;
    const drained = states.every(st => !st.inFlight);
    if ((pastWindow && drained) || Date.now() > DEADLINE) {
        clearInterval(checker);
        for (const st of states) fs.writeFileSync(path.join(LOGDIR, `${st.name}.summary.json`), JSON.stringify(summarize(st)));
        process.exit(0);
    }
}, 1000);
process.on('SIGTERM', () => {
    for (const st of states) {
        try {
            fs.writeFileSync(path.join(LOGDIR, `${st.name}.summary.json`), JSON.stringify(summarize(st)));
        } catch (e) {
            console.error('unable to persist on terminate', e);
        }
    }
    process.exit(0);
});
