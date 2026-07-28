// ToolSocketNB.js — Non-blocking transport layer for ToolSocket.
//
// API-CONFORMANT: socket.post/get/io/emit(route, body, callback, binaryData), handler
// signatures (route, body, res, binaryData, messageBundle), event-style (body, binaryData),
// and res.send(body, binaryData) all behave exactly like the original library.
// Only the WebSocket wire exchange between two NB-enhanced endpoints changes.
//
// Features:
//  - Application-level chunking: binaries > chunkSize are sent as tid-tagged <=4MB chunks
//    (single-binary ToolSocket frames), reassembled transparently at the receiver.
//    Fixes head-of-line blocking, the 100MiB ws maxPayload cliff, and the interleaving
//    corruption of the legacy frameCount protocol (chunks carry transfer IDs).
//  - Strict priority scheduler per connection:
//      class 0: protocol control (ping/pong/res/meta/__tsnb)
//      class 1: JSON / text messages                      <- always first
//      class 2: htm html js css csv dat xml woff webp
//      class 3: jpeg jpg gif png svg ttf otf pdf
//      class 4: 3dt fbx glb map mp4 obj wasm webm zip (also default for unknown binary)
//      class 5: rad radc splat ply pvs pvz                <- sent only when nothing else queued
//    Formats live in CLASS_FORMATS (class -> [extensions]), the single editable
//    source of truth; EXT_CLASS is the derived flat lookup. To add a format:
//    CLASS_FORMATS[5].push('gsplat'); rebuildExtIndex();
//  - Non-blocking sends: zero-copy subarray slicing, per-chunk lazy framing (one <=4MB
//    memcpy per event-loop turn), pacing via ws send-completion callback + bufferedAmount
//    watermark (browser fallback: bufferedAmount polling), incremental SHA-256.
//  - Backpressure API: 'backpressure' events (high/low watermarks), getBackpressure(),
//    pauseSends(minClass)/resumeSends(), flushQueued(minClass) (aborts transfers cleanly),
//    drained() promise.
//  - Auto-reconnect with exponential backoff for outgoing sockets (queue survives).
//  - Optional streaming relay hook: a proxy can forward chunks as they arrive (cut-through)
//    instead of store-and-forward, keeping proxy memory ~chunk-sized per transfer.
//  - Capability handshake (__tsnb/hello): falls back to legacy single-frame sends when the
//    peer does not run this layer.
//    The hello body also carries this process's current hold state (ph/ps fields), so
//    late joiners and reconnecting peers learn an active hold immediately.
//  - Process-wide backpressure (Node only): ONE registry per process (global Symbol) that
//    every enhanced socket of every instance joins. When aggregate pressure (scheduler
//    queued bytes + socket send buffers, or process RSS) crosses the high watermark, all
//    NB-capable peers receive an ADVISORY __tsnb/hold for class-5 requests; release follows
//    4:1 watermark hysteresis + a minimum hold time, and resume callbacks fire with
//    per-client jitter. Nothing is dropped or gated by the library itself.
//    Server side: NB.pressure.{configure,state,hold,on}. Client side: ts.onHoldChange(cb),
//    ts.isHeld(), and the 'holdChange' event.
//  - Transfer robustness: receiver partial-transfer GC is INACTIVITY-based (an actively
//    receiving transfer is never collected); a receiver that gives up sends __tsnb/abort
//    upstream so the sender fails fast; relay proxies route receiver-originated aborts
//    upstream via their ack-return map; a sender receiving an abort releases unacked
//    capacity and flushes that transfer's queued frames (NBScheduler.dropByTid).
//
// Internal protocol routes (all class 0, invisible to applications):
//   __tsnb/hello  capability + chunk size + current hold state (ph: 0|1, ps: sequence)
//   __tsnb/begin  transfer start (tid, size, count, meta)      __tsnb/c    one chunk
//   __tsnb/end    transfer complete                            __tsnb/ack  cumulative ack
//   __tsnb/abort  cancel a transfer (either direction)
//   __tsnb/hold   advisory backpressure signal { h: 0|1, s: sequence, c: class }
//
// Changelog:
//   2.1.2-nb.1  initial layer (chunking, priority, flow control, reconnect, relay)
//   2.1.2-nb.2  process-wide backpressure hold/resume mechanism
//   2.1.2-nb.3  inactivity-based receiver GC; abort fail-fast + upstream routing through
//               relays; sender-side abort cancellation with queued-frame flush
//   2.1.2-nb.4  file-format table restructured as CLASS_FORMATS (class -> [formats]),
//               with EXT_CLASS derived; rebuildExtIndex() for runtime additions

const TS = require('./index.js');
const ToolSocketMessage = require('./ToolSocketMessage.js');
const MessageBundle = require('./MessageBundle.js');
const ToolSocketResponse = require('./ToolSocketResponse.js');
const { generateUniqueId, isBrowser } = require('./utilities.js');
const { MESSAGE_BUNDLE_SCHEMA } = require('./schemas.js');

let nodeCrypto = null;
if (!isBrowser) { try { nodeCrypto = require('crypto'); } catch (_e) { /* no integrity */ } }
const nowMs = (!isBrowser && typeof process !== 'undefined' && process.hrtime)
    ? () => Number(process.hrtime.bigint()) / 1e6   // sub-ms precision for rate/RTT estimation
    : () => Date.now();
// setImmediate is a Node-only global (browsers throw ReferenceError). The
// fallback must be a MACROTASK (setTimeout 0), not queueMicrotask/Promise:
// the scheduler pump yields between frames so incoming messages and socket
// events get processed during a long drain — a microtask would run before
// I/O and starve them.
const defer = (typeof setImmediate === 'function') ? setImmediate : (fn) => setTimeout(fn, 0);

const MB = 1024 * 1024;
// ---------------------------------------------------------------------------
// Priority class -> file formats. THE single editable source of truth: to add a
// format later, push it into the right class array (at load time, or at runtime
// followed by rebuildExtIndex()). Classes 0 and 1 are not extension-driven:
//   class 0 = protocol control (__tsnb routes, ping/pong/res/meta)
//   class 1 = JSON / text payloads (no binary attached)
const CLASS_FORMATS = {
    2: ['htm', 'html', 'js', 'css', 'csv', 'dat', 'xml', 'woff', 'webp'],
    3: ['jpeg', 'jpg', 'gif', 'png', 'svg', 'ttf', 'otf', 'pdf'],
    4: ['3dt', 'fbx', 'glb', 'map', 'mp4', 'ms4', 'obj', 'wasm', 'webm', 'zip'], // also DEFAULTS.defaultBinaryClass for unknown types
    5: ['rad', 'radc', 'splat', 'ply', 'pvs', 'pvz']                      // bulk: sent only when nothing else is queued
};
// Derived flat lookup (extension -> class). Kept reference-stable so code holding
// EXT_CLASS keeps working; rebuilt in place from CLASS_FORMATS.
const EXT_CLASS = {};
function rebuildExtIndex() {
    for (const k of Object.keys(EXT_CLASS)) delete EXT_CLASS[k];
    for (const [cls, exts] of Object.entries(CLASS_FORMATS)) {
        for (const e of exts) EXT_CLASS[String(e).toLowerCase()] = Number(cls);
    }
    return EXT_CLASS;
}
rebuildExtIndex();
const NUM_CLASSES = 6;

const DEFAULTS = {
    chunkSize: 256 * 1024,       // hard-capped at 4MB below; 256KB = 4x fewer chunks than 64KB (less per-chunk
                                 // scheduler/framing CPU on the legacy-fallback path), ~4ms preemption @1Gbit /
                                 // ~40ms @100Mbit — realtime still preempts bulk at chunk boundaries
    ackWindow: 4,                // INITIAL chunks in flight per transfer (0 = flood/disable flow control)
    adaptiveWindow: true,        // grow/shrink the per-transfer window from measured ack RTT + delivery rate
    latencyBudgetMs: 250,        // adaptive cap: keep in-flight <= bandwidth x this budget (bounds JSON delay)
    rttFloorMs: 20,              // treat measured ack RTT below this as this (sizes windows sanely on LAN paths)
    maxWindowBytes: 8 * MB,      // adaptive window ceiling per transfer
    maxUnackedBytes: 32 * MB,    // global sent-but-unacked safety cap across ALL transfers on this socket
    lowWater: 256 * 1024,        // send next item only when ws bufferedAmount is below this
    backpressureHigh: 32 * MB,   // 'backpressure' {level:'high'} above this many queued bytes
    backpressureLow: 8 * MB,     // 'backpressure' {level:'low'} once drained below this
    maxQueuedBytes: 512 * MB,    // 'queueOverflow' warning event above this
    defaultBinaryClass: 4,
    ackEvery: 2,                 // receiver sends one cumulative ack per N chunks (acks are cumulative)
    maxTransferBytes: 2 * 1024 * MB, // receiver refuses transfers larger than this (preallocation guard)
    helloTimeoutMs: 3000,        // peer capability handshake timeout -> legacy fallback
    transferTimeoutMs: 120000,   // GC for stale partial transfers at the receiver
    integrity: false,            // end-to-end sha256 (Node only); off by default — wss/TCP cover the wire,
                                 // and structural checks (tid/seq/count/length) still catch protocol bugs.
                                 // Turn on during development of transport changes.
    reconnect: true,             // auto-reconnect outgoing sockets
    holdResumeJitterMs: 2000,    // client-side random delay before the resume(false) callback fires (herd control)
    maxPayload: 16 * MB,         // ws frame cap: chunks are <=4MB, so 16MB is a guard rail
    relay: null                  // optional (env) => enhancedTargetSocket for streaming relay
};

function extToClass(s) {
    if (typeof s !== 'string' || !s) return null;
    const lower = s.toLowerCase();
    if (EXT_CLASS[lower] !== undefined) return EXT_CLASS[lower]; // bare extension, e.g. body.type='rad'
    const m = /\.([a-z0-9]{1,5})(?:[?#].*)?$/.exec(lower);
    return m && EXT_CLASS[m[1]] !== undefined ? EXT_CLASS[m[1]] : null;
}

function classifyEnvelope(msg, hasBinary, defaultBinaryClass) {
    const route = msg.r || '';
    if (route.startsWith('__tsnb')) return 0;
    if (msg.m === 'ping' || msg.m === 'beat' || msg.m === 'meta') return 0;
    if (!hasBinary) return msg.m === 'res' ? 0 : 1; // JSON & text: top priority
    const b = msg.b;
    if (b && typeof b === 'object') {
        if (Number.isInteger(b.priority) && b.priority >= 1 && b.priority <= 5) return b.priority;
        for (const key of ['type', 'name', 'fileId', 'filename', 'file', 'path', 'url']) {
            const cls = extToClass(b[key]);
            if (cls !== null) return cls;
        }
    }
    const cls = extToClass(route);
    return cls !== null ? cls : defaultBinaryClass;
}

/** Strict-priority, watermark-paced, per-connection send scheduler. */
class NBScheduler {
    constructor(ts, opts) {
        this.ts = ts;
        this.opts = opts;
        this.queues = Array.from({ length: NUM_CLASSES }, () => []);
        this.queuedBytes = 0;
        this.queuedByClass = new Array(NUM_CLASSES).fill(0);
        this.pausedMinClass = Infinity;
        this.draining = false;
        this.bpHigh = false;
        this.overflowWarned = false;
    }

    enqueue(item) { // {cls, size, build:()=>frame|frames[], tid?, kind?}
        this.queues[item.cls].push(item);
        this.queuedBytes += item.size;
        this.queuedByClass[item.cls] += item.size;
        if (!this.bpHigh && this.queuedBytes > this.opts.backpressureHigh) {
            this.bpHigh = true;
            this.ts.triggerEvent('backpressure', { level: 'high', ...this.stats() });
        }
        if (!this.overflowWarned && this.queuedBytes > this.opts.maxQueuedBytes) {
            this.overflowWarned = true;
            this.ts.triggerEvent('queueOverflow', this.stats());
        }
        this.pump();
    }

    /** Remove every queued frame belonging to transfer `tid` from all priority queues,
     *  correcting the byte counters. Called when a transfer is aborted so a cancelled
     *  transfer cannot keep occupying scheduler capacity. O(total queued frames). */
    dropByTid(tid) {
        for (let cl = 0; cl < NUM_CLASSES; cl++) {
            const q = this.queues[cl];
            for (let i = q.length - 1; i >= 0; i--) {
                if (q[i].tid === tid) {
                    this.queuedBytes -= q[i].size;
                    this.queuedByClass[cl] -= q[i].size;
                    q.splice(i, 1);
                }
            }
        }
        this.maybeLow();
    }

    dequeue() {
        for (let c = 0; c < NUM_CLASSES; c++) {
            if (c >= this.pausedMinClass) break; // classes >= pausedMinClass are gated
            if (this.queues[c].length) return this.queues[c].shift();
        }
        return null;
    }

    hasWork() {
        for (let c = 0; c < NUM_CLASSES; c++) {
            if (c >= this.pausedMinClass) break;
            if (this.queues[c].length) return true;
        }
        return false;
    }

    pump() {
        if (this.draining) return;
        this.draining = true;
        const step = () => {
            const sock = this.ts.socket;
            if (!sock || this.ts.readyState !== 1 /* OPEN */) {
                this.draining = false; // resumes via 'open' listener
                return;
            }
            if (sock.bufferedAmount > this.opts.lowWater) {
                setTimeout(step, 4); // wait for the socket to drain a bit
                return;
            }
            const item = this.dequeue();
            if (!item) {
                this.draining = false;
                this.maybeLow();
                return;
            }
            this.queuedBytes -= item.size;
            this.queuedByClass[item.cls] -= item.size;
            let frames;
            try {
                frames = item.build(); // lazy framing: at most one chunkSize memcpy per turn
            } catch (e) {
                console.warn('ToolSocketNB: frame build failed, skipping item', e);
                defer(step);
                return;
            }
            if (!Array.isArray(frames)) frames = [frames];
            this.maybeLow();
            if (!isBrowser) {
                let pending = frames.length;
                const next = () => { if (--pending === 0) defer(step); };
                for (const f of frames) {
                    try { sock.send(f, next); } catch (_e) { next(); }
                }
            } else {
                for (const f of frames) { try { sock.send(f); } catch (_e) { /* closed */ } }
                setTimeout(step, 0); // browsers: pace via bufferedAmount check above
            }
        };
        defer(step);
    }

    maybeLow() {
        if (this.bpHigh && this.queuedBytes < this.opts.backpressureLow) {
            this.bpHigh = false;
            this.overflowWarned = false;
            this.ts.triggerEvent('backpressure', { level: 'low', ...this.stats() });
        }
    }

    flush(minClass) {
        const removed = [];
        for (let c = Math.max(0, minClass); c < NUM_CLASSES; c++) {
            for (const item of this.queues[c]) {
                this.queuedBytes -= item.size;
                this.queuedByClass[c] -= item.size;
                removed.push(item);
            }
            this.queues[c] = [];
        }
        this.maybeLow();
        return removed;
    }

    stats() {
        const sock = this.ts.socket;
        return {
            queuedBytes: this.queuedBytes,
            queuedByClass: this.queuedByClass.slice(),
            bufferedAmount: sock ? (sock.bufferedAmount || 0) : 0,
            paused: this.pausedMinClass !== Infinity ? this.pausedMinClass : false
        };
    }
}

/**
 * Enhances a ToolSocket (outgoing or server-side incoming) with the NB transport.
 * Safe to call once per socket; returns the same socket.
 */
// ---------------------------------------------------------------------------
// Process-wide backpressure registry (Node only). ONE registry per Node process,
// shared by every enhanced socket of every NBServer / client instance, anchored
// on a global Symbol so duplicate module loads still share state.
// When aggregate pressure crosses the high watermark, all NB-capable peers are
// told to hold class-5 REQUESTS (advisory: the signal fires the peer's
// onHoldChange(true) callback; nothing is dropped or blocked by the library).
const PRESSURE_SYM = Symbol.for('toolsocketnb.pressure.v1');
function getPressure() {
    if (isBrowser) return null; // browsers receive holds; only Node processes measure/emit them
    const g = globalThis;
    if (!g[PRESSURE_SYM]) g[PRESSURE_SYM] = createPressure();
    return g[PRESSURE_SYM];
}
function createPressure() {
    const os = require('os');
    const cfg = {
        enabled: true,
        holdClass: 5,          // advisory: which class peers should stop REQUESTING
        highBytes: 128 * MB,   // hold when aggregate queued+buffered exceeds this...
        lowBytes: 32 * MB,     // ...resume only when it falls below this (4:1 hysteresis)
        rssHighFrac: 0.75,     // or when process RSS exceeds this fraction of os.totalmem()
        rssLowFrac: 0.65,
        sampleMs: 250,
        minHoldMs: 2000        // never release a hold faster than this (flap guard)
    };
    const P = { cfg, held: false, seq: 0, manual: null, entries: new Set(),
                listeners: new Set(), timer: null, heldSince: 0, last: { aggBytes: 0, rss: 0 } };
    function emit(ev) { for (const cb of P.listeners) { try { cb(ev); } catch (_e) { /* listener error */ } } }
    function broadcast() {
        for (const e of P.entries) { try { if (e.ready()) e.sendHold(P.held, P.seq); } catch (_e) { /* socket race */ } }
    }
    function setHeld(h, reason) {
        if (P.held === h) return;
        P.held = h; P.seq++;
        if (h) P.heldSince = Date.now();
        broadcast();
        emit({ held: h, seq: P.seq, reason, aggBytes: P.last.aggBytes, rss: P.last.rss });
    }
    function sample() {
        if (!cfg.enabled && P.manual === null) return;
        let agg = 0;
        for (const e of P.entries) { try { agg += e.bytes(); } catch (_e) { /* closing socket */ } }
        const rss = process.memoryUsage().rss, total = os.totalmem();
        P.last = { aggBytes: agg, rss };
        let want;
        if (P.manual !== null) want = P.manual;
        else if (!P.held) want = (agg > cfg.highBytes) || (rss > total * cfg.rssHighFrac);
        else want = !((agg < cfg.lowBytes) && (rss < total * cfg.rssLowFrac));
        if (want && !P.held) setHeld(true, P.manual === true ? 'manual' : (agg > cfg.highBytes ? 'bytes' : 'rss'));
        else if (!want && P.held && (P.manual === false || Date.now() - P.heldSince >= cfg.minHoldMs)) {
            setHeld(false, P.manual === false ? 'manual' : 'recovered');
        }
    }
    function restartTimer() {
        if (P.timer) { clearInterval(P.timer); P.timer = null; }
        if (P.entries.size > 0) {
            P.timer = setInterval(sample, cfg.sampleMs);
            if (P.timer.unref) P.timer.unref(); // never keeps a finished process alive
        }
    }
    P._register = e => { P.entries.add(e); restartTimer(); };
    P._unregister = e => { P.entries.delete(e); restartTimer(); };
    P._sample = sample;
    P.api = {
        configure(o) { Object.assign(cfg, o || {}); restartTimer(); return P.api; },
        state() { return { held: P.held, seq: P.seq, manual: P.manual, aggBytes: P.last.aggBytes,
                           rss: P.last.rss, sockets: P.entries.size, config: { ...cfg } }; },
        hold(v) { P.manual = (v === null || v === undefined) ? null : !!v; sample(); return P.api; },
        on(cb) { P.listeners.add(cb); return () => P.listeners.delete(cb); }
    };
    return P;
}

function enhance(ts, userOpts = {}) {
    if (ts.__nb) return ts;
    const opts = { ...DEFAULTS, ...userOpts };
    opts.chunkSize = Math.min(opts.chunkSize, 4 * MB); // per spec: chunks never bigger than 4MB
    const nb = {
        opts,
        peer: 'unknown',           // 'unknown' | true | false
        pendingLarge: [],          // large sends held until the capability handshake settles
        transfers: new Map(),      // tid -> reassembly state (receiver side)
        sending: new Map(),        // tid -> ack-windowed sender state
        relayed: new Map(),        // tid -> {target, cls} (streaming relay, source side)
        relayBack: new Map(),      // tid -> source socket (streaming relay, target side: routes acks upstream)
        stats: { chunksSent: 0, chunksReceived: 0, transfersSent: 0, transfersReceived: 0, transfersRelayed: 0, legacySends: 0 }
    };
    ts.__nb = nb;
    const sched = new NBScheduler(ts, opts);
    nb.sched = sched;

    // ---------- process-wide pressure: remote-hold state + client callback API ----------
    nb.remoteHold = { held: false, seq: -1, resumeTimer: null };
    nb.holdCbs = new Set();
    const fireHold = h => {
        ts.triggerEvent('holdChange', { held: h });
        for (const cb of nb.holdCbs) { try { cb(h); } catch (_e) { /* app callback error */ } }
    };
    const applyRemoteHold = (held, seq) => {
        const rh = nb.remoteHold;
        if (typeof seq === 'number') { if (seq <= rh.seq) return; rh.seq = seq; } // stale/out-of-order
        if (held) {
            if (rh.resumeTimer) { clearTimeout(rh.resumeTimer); rh.resumeTimer = null; }
            if (!rh.held) { rh.held = true; fireHold(true); }
        } else {
            if (!rh.held || rh.resumeTimer) return;
            const mySeq = rh.seq;
            const t = setTimeout(() => {           // jittered resume: avoid a client herd
                rh.resumeTimer = null;
                if (rh.seq !== mySeq) return;      // superseded by a newer hold
                rh.held = false; fireHold(false);
            }, Math.random() * opts.holdResumeJitterMs);
            if (t.unref) t.unref();
            rh.resumeTimer = t;
        }
    };
    /** Register cb(held:boolean); returns an unsubscribe function. Advisory signal:
     *  true  -> the peer process is under pressure, stop REQUESTING class-5 content.
     *  false -> pressure cleared (delivered with per-client jitter), requests may resume. */
    ts.onHoldChange = cb => { nb.holdCbs.add(cb); return () => nb.holdCbs.delete(cb); };
    ts.isHeld = () => nb.remoteHold.held;
    ts.addEventListener('__tsnb/hold', body => {
        if (body && typeof body.h !== 'undefined') applyRemoteHold(body.h === 1, body.s);
    });
    ts.addEventListener('open', () => { nb.remoteHold.seq = -1; }); // new connection = new hold epoch
    nb._applyRemoteHold = applyRemoteHold;

    const mkMsg = (method, route, body, id = null) =>
        new ToolSocketMessage(ts.origin, ts.networkId, method, route, body, id);
    const frameFor = (message, bin) =>
        bin ? new MessageBundle(message, bin).toBinary() : JSON.stringify(message);
    const sendInternal = (route, body, bin, cls) => {
        sched.enqueue({
            cls, size: (bin ? bin.length : 0) + 64, tid: body && body.t,
            kind: route, build: () => frameFor(mkMsg('io', route, body), bin || null)
        });
    };

    // ---------- outgoing path: override send() (all API methods funnel through it) ----------
    ts.send = function (messageBundle, callback) {
        if (callback) {
            messageBundle.message.id = generateUniqueId(8);
            ts.responseCallbacks[messageBundle.message.id] = callback;
        }
        ts.triggerEvent('send', messageBundle);
        routeOut(messageBundle);
    };

    function routeOut(bundle) {
        let bin = bundle.binaryData;
        if (bin instanceof ArrayBuffer) bin = new Uint8Array(bin);
        const cls = classifyEnvelope(bundle.message, !!bin, opts.defaultBinaryClass);

        if (bin && !Array.isArray(bin) && bin.length > opts.chunkSize) {
            if (nb.peer === 'unknown') { nb.pendingLarge.push({ bundle, cls }); return; }
            if (nb.peer === true) { sendChunked(bundle, bin, cls); return; }
            nb.stats.legacySends++; // legacy peer: single big frame (still prioritized)
        }
        if (Array.isArray(bin)) {
            // Legacy frameCount transfer: keep it, but send header+frames as ONE atomic queue
            // item so the scheduler can never interleave another frame into it (fixes exp3).
            const size = bin.reduce((a, b) => a + b.length, 0);
            sched.enqueue({
                cls, size,
                build: () => {
                    bundle.message.frameCount = bin.length;
                    return [JSON.stringify(bundle.message), ...bin];
                }
            });
            return;
        }
        sched.enqueue({
            cls, size: bin ? bin.length + 128 : 200,
            build: () => bin ? bundle.toBinary() : JSON.stringify(bundle.message)
        });
    }

    function sendChunked(bundle, bin, cls) {
        const tid = generateUniqueId(12);
        const total = Math.ceil(bin.length / opts.chunkSize);
        const m = bundle.message;
        const env = { o: m.o, n: m.n, m: m.m, r: m.r, b: m.b, i: m.i, s: m.s };
        const st = {
            tid, bin, cls, total,
            next: 0,                 // next chunk index to enqueue
            acked: 0,                // acked up to (exclusive)
            endSent: false,
            windowChunks: Math.max(2, opts.ackWindow || 2), // adaptive: grows/shrinks from measurements
            sentAt: new Map(),       // chunk index -> send timestamp (for ack RTT samples)
            ackLog: [],              // recent {t, b} ack events (delivery-rate estimation)
            rttMinMs: Infinity,      // propagation-delay estimate (min observed ack RTT)
            hash: (opts.integrity && nodeCrypto) ? nodeCrypto.createHash('sha256') : null,
            lastProgress: Date.now()
        };
        nb.sending.set(tid, st);
        nb.stats.transfersSent++;
        ts.triggerEvent('nbTransfer', { phase: 'queued', tid, bytes: bin.length, chunks: total, cls });
        sendInternal('__tsnb/begin', { t: tid, c: total, z: bin.length, e: env }, null, cls);
        fillWindow(st);
    }

    nb.unackedBytes = 0;

    /** Enqueue chunks up to the per-transfer (adaptive) window and global unacked budget. */
    function fillWindow(st) {
        // Strict priority also governs window allocation: only the highest active class on
        // this socket gets its full (adaptive) window. Lower classes trickle at the minimum
        // window, otherwise their queueing-inflated RTT measurements would grow their windows
        // and let them out-compete higher classes on a shared bottleneck.
        let topCls = st.cls;
        for (const other of nb.sending.values()) { if (other.cls < topCls) topCls = other.cls; }
        const adaptive = st.cls > topCls ? 2 : st.windowChunks;
        const window = opts.ackWindow > 0 ? adaptive : Infinity;
        const budget = opts.ackWindow > 0 ? opts.maxUnackedBytes : Infinity;
        while (st.next < st.total && st.next < st.acked + window &&
               (nb.unackedBytes === 0 || nb.unackedBytes + Math.min(opts.chunkSize, st.bin.length - st.next * opts.chunkSize) <= budget)) {
            const q = st.next++;
            const sub = st.bin.subarray(q * opts.chunkSize, Math.min((q + 1) * opts.chunkSize, st.bin.length)); // zero-copy
            nb.unackedBytes += sub.length;
            st.unacked = (st.unacked || 0) + sub.length;
            sched.enqueue({
                cls: st.cls, size: sub.length, tid: st.tid, kind: 'chunk',
                build: () => {
                    if (st.hash) st.hash.update(sub); // incremental: <= chunkSize of hashing per turn
                    st.sentAt.set(q, nowMs());        // ack RTT sample start
                    nb.stats.chunksSent++;
                    return frameFor(mkMsg('io', '__tsnb/c', { t: st.tid, q }), sub);
                }
            });
        }
        const doneCondition = opts.ackWindow > 0 ? (st.acked >= st.total) : (st.next >= st.total);
        if (doneCondition && !st.endSent) {
            st.endSent = true;
            const h = st.hash ? st.hash.digest('hex') : null;
            sched.enqueue({
                cls: st.cls, size: 64, tid: st.tid, kind: 'end',
                build: () => frameFor(mkMsg('io', '__tsnb/end', { t: st.tid, h }), null)
            });
            nb.sending.delete(st.tid);
            ts.triggerEvent('nbTransfer', {
                phase: 'sent', tid: st.tid, bytes: st.bin.length,
                windowChunks: st.windowChunks, rttMinMs: st.rttMinMs === Infinity ? null : Math.round(st.rttMinMs)
            });
        }
    }

    ts.addEventListener('__tsnb/ack', body => {
        const src = nb.relayBack.get(body.t);
        if (src && src.__nb) { src.__nb.forward('__tsnb/ack', body, null, 0); return; } // end-to-end ack through relay
        const st = nb.sending.get(body.t);
        if (!st) return;
        const now = nowMs();
        const sentAt = st.sentAt.get(body.q);
        if (sentAt !== undefined) st.rttMinMs = Math.min(st.rttMinMs, now - sentAt);
        let released = 0;
        if (body.q + 1 > st.acked) { // acks are cumulative: q means "received through q"
            const toExcl = Math.min(body.q + 1, st.total);
            released = Math.min(toExcl * opts.chunkSize, st.bin.length) - st.acked * opts.chunkSize;
            for (let i = st.acked; i < toExcl; i++) st.sentAt.delete(i);
            nb.unackedBytes = Math.max(0, nb.unackedBytes - released);
            st.unacked = Math.max(0, (st.unacked || 0) - released);
            st.acked = toExcl;
            st.lastProgress = Date.now();
        }
        if (opts.adaptiveWindow && opts.ackWindow > 0 && released > 0) {
            st.ackLog.push({ t: now, b: released });
            if (st.ackLog.length > 24) st.ackLog.shift();
            const span = st.ackLog[st.ackLog.length - 1].t - st.ackLog[0].t;
            if (st.ackLog.length >= 4 && span > 20 && st.rttMinMs < Infinity) {
                const bytes = st.ackLog.slice(1).reduce((a, e) => a + e.b, 0); // rate between first and last ack
                const bwBytesPerMs = bytes / span;                             // measured delivery rate
                const effRtt = Math.max(st.rttMinMs, opts.rttFloorMs);
                const target = Math.min(
                    2 * bwBytesPerMs * effRtt,               // ~2x BDP: enough to saturate the path
                    bwBytesPerMs * opts.latencyBudgetMs,     // JSON latency budget: in-flight drains within budget
                    opts.maxWindowBytes
                );
                st.windowChunks = Math.max(opts.ackEvery + 1, Math.ceil(target / opts.chunkSize) + (opts.ackEvery - 1));
            }
        }
        refillAll();
    });

    /** Refill windows for all active transfers, highest priority class first. */
    function refillAll() {
        const active = [...nb.sending.values()].sort((a, b) => a.cls - b.cls);
        for (const st of active) fillWindow(st);
    }

    // ---------- incoming path ----------
    ts.addEventListener('__tsnb/hello', (body) => {
        clearTimeout(nb.helloTimer);
        const firstConfirm = nb.peer !== true;
        if (firstConfirm) {
            nb.peer = true;
            const pending = nb.pendingLarge; nb.pendingLarge = [];
            for (const p of pending) sendChunked(p.bundle, p.bundle.binaryData, p.cls);
        }
        // peer's hello carries ITS process's hold state (late joiners / reconnects)
        if (body && typeof body.ph !== 'undefined') nb._applyRemoteHold(body.ph === 1, body.ps);
        // and if OUR process is held, make sure this newly confirmed peer knows
        if (firstConfirm) {
            const Pn = getPressure();
            if (Pn && Pn.held) sendInternal('__tsnb/hold', { h: 1, s: Pn.seq, c: Pn.cfg.holdClass }, null, 0);
        }
    });

    ts.addEventListener('__tsnb/begin', body => {
        const env = body.e;
        if (opts.relay) { // streaming relay (cut-through): forward without reassembly
            let target = null;
            try { target = opts.relay(env); } catch (_e) { /* fall through */ }
            if (target && target.__nb && target.__nb.peer === true) {
                const cls = classifyEnvelope(env, true, opts.defaultBinaryClass);
                nb.relayed.set(body.t, { target, cls });
                target.__nb.relayBack.set(body.t, ts); // route the final receiver's acks upstream
                nb.stats.transfersRelayed++;
                target.__nb.forward('__tsnb/begin', body, null, cls);
                ts.triggerEvent('nbRelay', { phase: 'begin', tid: body.t, bytes: body.z, env });
                return;
            }
        }
        if (body.z > opts.maxTransferBytes) {
            sendInternal('__tsnb/abort', { t: body.t }, null, 0);
            ts.triggerEvent('nbTransfer', { phase: 'failed', tid: body.t, reason: 'tooLarge', bytes: body.z });
            ts.triggerEvent('droppedMessage', env);
            return;
        }
        nb.transfers.set(body.t, {
            env, total: body.c, z: body.z,
            out: new Uint8Array(body.z),   // preallocated: chunks are written in place on arrival
            offset: 0, got: 0, nextSeq: 0, pending: new Map(), hashValid: true, lastAt: Date.now(),
            hash: (opts.integrity && nodeCrypto) ? nodeCrypto.createHash('sha256') : null,
            startedAt: Date.now()
        });
    });

    ts.addEventListener('__tsnb/c', (body, bin) => {
        const rel = nb.relayed.get(body.t);
        if (rel) { rel.target.__nb.forward('__tsnb/c', body, bin, rel.cls); return; } // zero-copy ref
        const st = nb.transfers.get(body.t);
        if (!st || body.q < st.nextSeq) return;
        nb.stats.chunksReceived++;
        const write = b => {
            st.out.set(b, st.offset);      // one copy, spread over the transfer (no final concat)
            st.lastAt = Date.now();        // activity: an in-progress transfer is never GC'd
            st.offset += b.length;
            st.got++; st.nextSeq++;
            if (st.hash) st.hash.update(b);
        };
        if (body.q === st.nextSeq) {
            write(bin);
            while (st.pending.has(st.nextSeq)) { // drain any out-of-order stragglers
                const seq = st.nextSeq;
                const b = st.pending.get(seq);
                st.pending.delete(seq);
                write(b);
            }
        } else {
            st.pending.set(body.q, bin);   // should not happen on a single TCP path; tolerated
        }
        if ((body.q + 1) % opts.ackEvery === 0 || body.q + 1 === st.total) {
            sendInternal('__tsnb/ack', { t: body.t, q: body.q }, null, 0); // cumulative flow-control credit
        }
    });

    ts.addEventListener('__tsnb/end', body => {
        const rel = nb.relayed.get(body.t);
        if (rel) {
            rel.target.__nb.forward('__tsnb/end', body, null, rel.cls);
            nb.relayed.delete(body.t);
            const rt = setTimeout(() => rel.target.__nb.relayBack.delete(body.t), 30000); // keep ack path open until drained
            if (rt.unref) rt.unref();
            ts.triggerEvent('nbRelay', { phase: 'end', tid: body.t });
            return;
        }
        const st = nb.transfers.get(body.t);
        if (!st) return;
        nb.transfers.delete(body.t);
        if (st.got !== st.total || st.offset !== st.z) {
            ts.triggerEvent('nbTransfer', { phase: 'failed', tid: body.t, reason: 'incomplete', got: st.got, total: st.total });
            ts.triggerEvent('droppedMessage', st.env);
            return;
        }
        let hashOk = null;
        if (st.hash && st.hashValid && body.h) hashOk = st.hash.digest('hex') === body.h;
        if (hashOk === false) {
            ts.triggerEvent('nbTransfer', { phase: 'failed', tid: body.t, reason: 'integrity' });
            ts.triggerEvent('droppedMessage', st.env);
            return;
        }
        nb.stats.transfersReceived++;
        ts.triggerEvent('nbTransfer', { phase: 'complete', tid: body.t, bytes: st.z, ms: Date.now() - st.startedAt, hashOk });
        dispatch(st.env, st.out); // already assembled in place
    });

    ts.addEventListener('__tsnb/abort', body => {
        const rel = nb.relayed.get(body.t);
        if (rel) { // downstream: source -> target
            rel.target.__nb.forward('__tsnb/abort', body, null, 0);
            nb.relayed.delete(body.t);
        }
        const src = nb.relayBack.get(body.t);
        if (src && src.__nb) { // upstream: receiver-originated abort back to the sender
            src.__nb.forward('__tsnb/abort', body, null, 0);
            nb.relayBack.delete(body.t);
        }
        const snd = nb.sending.get(body.t);
        if (snd) { // we are the sender: cancel, flush queued frames, release capacity
            nb.unackedBytes = Math.max(0, nb.unackedBytes - (snd.unacked || 0));
            nb.sending.delete(body.t);
            if (sched.dropByTid) sched.dropByTid(body.t);
        }
        nb.transfers.delete(body.t);
        ts.triggerEvent('nbTransfer', { phase: 'aborted', tid: body.t });
    });

    nb.forward = sendInternal; // used by streaming relay on the target socket

    /** Re-dispatch a reassembled message through the standard ToolSocket API surface. */
    function dispatch(env, binary) {
        const message = new ToolSocketMessage(env.o, env.n, env.m, env.r, env.b, env.i !== undefined ? env.i : null);
        message.s = env.s !== undefined ? env.s : null;
        if (!MESSAGE_BUNDLE_SCHEMA.validate(message)) {
            ts.triggerEvent('droppedMessage', message);
            return;
        }
        const bundle = new MessageBundle(message, binary);
        const responseObject = message.id ? new ToolSocketResponse(ts, message) : null;
        ts.triggerEvent(message.method, message.route, message.body, responseObject, binary, bundle);
    }

    // ---------- handshake, reconnect, lifecycle ----------
    const sendHello = () => {
        const Pn = getPressure();
        const body = { v: 1, cs: opts.chunkSize };
        if (Pn) { body.ph = Pn.held ? 1 : 0; body.ps = Pn.seq; }
        sendInternal('__tsnb/hello', body, null, 0);
    };
    const armHelloTimeout = () => {
        clearTimeout(nb.helloTimer);
        nb.helloTimer = setTimeout(() => {
            if (nb.peer === 'unknown') {
                nb.peer = false; // legacy peer: fall back to original single-frame sends
                const pending = nb.pendingLarge; nb.pendingLarge = [];
                for (const p of pending) routeOut(p.bundle);
            }
        }, opts.helloTimeoutMs);
        if (nb.helloTimer.unref) nb.helloTimer.unref(); // never keep the process alive
    };
    sendHello();
    armHelloTimeout();
    const tuneSocket = () => { // low-latency TCP + no compression surprises
        try { if (ts.socket && ts.socket._socket && ts.socket._socket.setNoDelay) ts.socket._socket.setNoDelay(true); } catch (_e) { /* browser */ }
    };
    tuneSocket();
    ts.addEventListener('open', () => { nb.reconnectDelay = 500; sendHello(); armHelloTimeout(); tuneSocket(); sched.pump(); });

    // enroll in the process-wide pressure registry (Node only)
    {
        const Pn = getPressure();
        if (Pn) {
            const entry = {
                bytes: () => sched.queuedBytes + ((ts.socket && ts.socket.bufferedAmount) || 0),
                ready: () => nb.peer === true && ts.readyState === 1,
                sendHold: (h, sq) => sendInternal('__tsnb/hold', { h: h ? 1 : 0, s: sq, c: Pn.cfg.holdClass }, null, 0)
            };
            Pn._register(entry);
            ts.addEventListener('close', () => { if (!(opts.reconnect && ts.url)) Pn._unregister(entry); });
        }
    }

    if (opts.reconnect && ts.url) {
        nb.reconnectDelay = 500;
        const origClose = ts.close.bind(ts);
        ts.close = () => { nb.userClosed = true; origClose(); };
        ts.addEventListener('close', () => {
            for (const id of Object.keys(ts.responseCallbacks)) delete ts.responseCallbacks[id]; // no leaks
            if (nb.userClosed) return;
            const delay = nb.reconnectDelay;
            nb.reconnectDelay = Math.min(nb.reconnectDelay * 2, 15000);
            ts.triggerEvent('nbReconnect', { inMs: delay });
            const t = setTimeout(() => {
                if (!nb.userClosed && ts.readyState === 3 /* CLOSED */) {
                    try { ts.connect(ts.url, ts.networkId, ts.origin); } catch (_e) { /* retried on next close */ }
                }
            }, delay);
            if (t.unref) t.unref(); // reconnects shouldn't keep an exiting process alive
        });
    }

    const gc = setInterval(() => {
        const now = Date.now();
        for (const [tid, st] of nb.transfers) {
            if (now - (st.lastAt || st.startedAt) > opts.transferTimeoutMs) {
                nb.transfers.delete(tid);
                sendInternal('__tsnb/abort', { t: tid }, null, 0); // fail fast at the sender too
                ts.triggerEvent('nbTransfer', { phase: 'failed', tid, reason: 'timeout' });
            }
        }
        for (const [tid, st] of nb.sending) { // ack stall (e.g. receiver vanished mid-transfer)
            if (now - st.lastProgress > opts.transferTimeoutMs) {
                nb.unackedBytes = Math.max(0, nb.unackedBytes - (st.unacked || 0));
                nb.sending.delete(tid);
                sendInternal('__tsnb/abort', { t: tid }, null, 0);
                ts.triggerEvent('nbTransfer', { phase: 'failed', tid, reason: 'ackTimeout' });
            }
        }
    }, 10000);
    if (gc.unref) gc.unref();

    // ---------- public backpressure / flow-control API ----------
    ts.getBackpressure = () => sched.stats();
    /** Fan-out fast path: enqueue an already-serialized JSON message (class 1).
     *  Build the string once with NB.prepare() and send it to many sockets. */
    ts.sendPrepared = (str) => sched.enqueue({ cls: 1, size: str.length + 64, build: () => str });
    ts.pauseSends = (minClass = 2) => { sched.pausedMinClass = minClass; };           // "close the buffer" (JSON keeps flowing by default)
    ts.resumeSends = () => { sched.pausedMinClass = Infinity; sched.pump(); };        // "open the buffer"
    ts.flushQueued = (minClass = 2) => {                                              // discard queued classes >= minClass, abort their transfers
        const removed = sched.flush(minClass);
        const tids = new Set(removed.filter(i => i.tid && i.kind === 'chunk').map(i => i.tid));
        let withheldBytes = 0;
        for (const [tid, st] of nb.sending) {                                          // also cancel ack-withheld remainders
            if (st.cls >= minClass) {
                tids.add(tid);
                withheldBytes += Math.max(0, st.bin.length - st.next * opts.chunkSize);
                nb.unackedBytes = Math.max(0, nb.unackedBytes - (st.unacked || 0));
                nb.sending.delete(tid);
            }
        }
        refillAll();
        for (const tid of tids) {
            sendInternal('__tsnb/abort', { t: tid }, null, 0);
            ts.triggerEvent('transferCancelled', { tid });
        }
        const queuedBytes = removed.reduce((a, i) => a + i.size, 0);
        return { items: removed.length, bytes: queuedBytes + withheldBytes, transfersAborted: tids.size };
    };
    ts.drained = () => new Promise(resolve => {
        const check = () => {
            const empty = sched.queuedBytes === 0 && (!ts.socket || (ts.socket.bufferedAmount || 0) === 0);
            if (empty) resolve(); else setTimeout(check, 10);
        };
        check();
    });
    ts.nbStats = () => ({ ...nb.stats, peer: nb.peer, activeTransfers: nb.transfers.size, relaying: nb.relayed.size });

    return ts;
}

/** Drop-in ToolSocket.Server replacement: sets a sane maxPayload and enhances every connection. */
class NBServer {
    constructor(wsOptions, origin, nbOpts = {}) {
        const merged = { maxPayload: nbOpts.maxPayload || DEFAULTS.maxPayload, perMessageDeflate: false, ...wsOptions };
        this.inner = new TS.Server(merged, origin);
        this.inner.addEventListener('connection', sock => enhance(sock, nbOpts));
        this.on = this.inner.addEventListener.bind(this.inner);
        this.addEventListener = this.on;
        this.close = () => this.inner.close();
        Object.defineProperty(this, 'sockets', { get: () => this.inner.sockets });
    }
}

/** Drop-in client factory: sets maxPayload on the ws and enhances the socket. */
function connect(url, networkId, origin, nbOpts = {}) {
    const ts = new TS(url instanceof URL ? url : new URL(url), networkId, origin,
        { maxPayload: nbOpts.maxPayload || DEFAULTS.maxPayload, perMessageDeflate: false, ...(nbOpts.wsOptions || {}) });
    return enhance(ts, nbOpts);
}

/** Serialize a message once for use with socket.sendPrepared() across many sockets. */
function prepare(method, route, body, origin, networkId) {
    return JSON.stringify(new ToolSocketMessage(origin, networkId, method, route, body, null));
}

module.exports = { enhance, NBServer, connect, prepare, CLASS_FORMATS, rebuildExtIndex, EXT_CLASS, DEFAULTS,
    get pressure() { const P = getPressure(); return P ? P.api : null; } };
