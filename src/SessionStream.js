// SessionStream — the reliable session layer behind every ToolSocket.
//
// PROBLEM: a WebSocket cut without FIN (firewall idle-drop, NAT reaper, cellular handoff)
// stays readyState OPEN for a long time. Frames written into it leave the process at once
// (ws.send hands them to the kernel), so bufferedAmount reads zero, the kernel retransmits
// silently for minutes, and when the socket is finally torn down every frame in its send
// window is gone. Nothing above the socket ever learns which messages were lost.
//
// MECHANISM: WebSocket guarantees in-order delivery within one connection, so one number is
// enough. Every frame written to the wire gets a per-connection monotonic sequence `q`
// (assigned at WRITE time — the NB scheduler reorders by priority class, so an enqueue-time
// number would go out non-monotonic). The receiver periodically reports the highest
// contiguous sequence it delivered (`__ts/ack {w}`, coalesced: one tiny frame covers
// hundreds of messages). The sender retains every frame until the watermark passes it.
//
//   dead detection  = "I have unacked frames and the oldest is older than migrateAfterMs"
//                     (rate-adaptive: idle links raise no alarm; the 5s ping keeps a
//                     sequenced frame flowing each way so a dead link is noticed even when
//                     the application is quiet)
//   recovery        = the CLIENT dials a fresh WebSocket that names the session in its URL
//                     (?tsm=<session>&tsg=<generation>&tsw=<my watermark>); the server
//                     re-binds the SAME IncomingToolSocket instance to it, both ends resend
//                     everything above the other's watermark in sequence order, and the
//                     receiver drops anything at or below what it already delivered — so
//                     duplicates vanish and order survives even if the old, merely-slow
//                     socket delivers stragglers later.
//
// The application never sees any of this: no 'close'/'open' round trip, the same ToolSocket /
// IncomingToolSocket instance, subscriptions and response callbacks intact. A genuine
// departure (no successor within graceMs) surfaces the normal 'close' exactly as before.
//
// COMPATIBILITY: capability is negotiated per connection (`__ts/session` meta frame after
// open, answered by `__ts/session-ack`). A peer that never answers is legacy: no retention,
// no migration, the existing liveness watchdog handles it. Old peers ignore the extra
// envelope key (the schema validator only examines keys it knows) and the unknown meta
// route. Sequence numbers are strictly hop-local: they are stamped at write time and
// stripped before dispatch, so a relay (proxy, edge-agent) can never forward one.
//
// This class owns the state and the pure logic (numbering, retention, watermark, dedupe,
// timers). ToolSocket owns the I/O and calls in through the small `io` interface given to
// the constructor.

const { generateUniqueId } = require('./utilities.js');

let nodeCrypto = null;
try {
    nodeCrypto = require('crypto');
} catch (_e) {
    nodeCrypto = null; // browser bundle: external
}

const DEFAULTS = {
    enabled: true,
    ackIntervalMs: 100,           // coalesce watermark acks to at most one per interval...
    ackEveryFrames: 32,           // ...or ack immediately after this many sequenced frames
    migrateAfterMs: 1000,         // FLOOR of the stall deadline: oldest unacked frame older than this
                                  // => transport presumed dead (on a fast link this is the deadline)
    migrateAfterMaxMs: 8000,      // CAP of the adaptive deadline on a slow-but-alive link
    migrateSlackMs: 200,          // added to the adaptive estimate (ack coalescing + scheduling)
    sessionTimeoutMs: 5000,       // no session-ack from the peer within this => legacy peer
    graceMs: 16000,               // server keeps a session alive this long waiting for a successor
    migrateMaxMs: 16000,          // client gives up migrating after this long => real close
    migrateRetryMs: 400,          // first retry delay while migrating (doubles, capped)
    migrateAckMs: 3000,           // a successor transport must be adopted (session-ack) within this
    retainMaxBytes: 64 * 1024 * 1024 // retained window cap: exceeding it counts as a stall
};

/**
 * A session id is a bearer credential (whoever presents it can adopt the session), so
 * it must be unguessable: 128 bits of real randomness where available.
 * @param {number} length - number of alphanumeric characters
 * @return {string}
 */
function secureId(length) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let bytes = null;
    if (nodeCrypto && nodeCrypto.randomBytes) {
        bytes = nodeCrypto.randomBytes(length);
    } else if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) {
        bytes = new Uint8Array(length);
        globalThis.crypto.getRandomValues(bytes);
    }
    if (!bytes) {
        return generateUniqueId(length);
    }
    let id = '';
    for (let i = 0; i < length; i++) {
        id += alphabet[bytes[i] % alphabet.length];
    }
    return id;
}

/**
 * Byte size of a frame as it will sit in the retained window.
 * @param {string|Uint8Array|ArrayBuffer} frame
 * @return {number}
 */
function frameSize(frame) {
    if (typeof frame === 'string') {
        return frame.length; // close enough (UTF-16 units) for a memory cap
    }
    return frame.byteLength || frame.length || 0;
}

function unref(timer) {
    if (timer && timer.unref) {
        timer.unref();
    }
    return timer;
}

class SessionStream {
    /**
     * @param {Object} io - callbacks into the owning ToolSocket
     * @param {function(string, Object):void} io.sendControl - write an unsequenced meta frame now
     * @param {function(string):void} io.onStall - the transport is presumed dead (reason string)
     * @param {?Object} [options] - overrides for DEFAULTS
     */
    constructor(io, options) {
        this.io = io;
        this.opts = Object.assign({}, DEFAULTS, options || {});

        /** session id; a client mints its own, a server-side socket adopts the client's */
        this.id = secureId(32);
        /** bumped on every migration; a successor must present the current value or higher */
        this.gen = 0;
        /** 'unknown' until the peer answers the session handshake, then true, or false (legacy) */
        this.peer = 'unknown';
        this.userClosed = false;
        /**
         * The peer ended the session through ITS toolsocket API (it sent __ts/bye before
         * closing). Only then is a transport close final. A close frame arriving on its own —
         * clean code or not — proves nothing: a firewall or zero-trust proxy can tear a flow
         * down "cleanly" on the peer's behalf, and that is exactly the case to migrate through.
         */
        this.peerClosed = false;
        this.migrating = false;
        this.serverSide = false;

        this.tx = {
            seq: 0,            // last sequence number stamped
            lastStamped: null, // sequence of the most recently stamped message (read right after build)
            retained: [],      // [{seq, frame, at}] in write order, not yet acked by the peer
            bytes: 0,
            acked: 0           // highest sequence the peer has acknowledged
        };
        this.rx = {
            lastDelivered: 0,  // highest contiguous sequence delivered to the application
            sinceAck: 0,
            ackTimer: null,
            skipBinary: 0      // legacy frameCount transfer: raw frames to drop after a duplicate header
        };

        /**
         * Observed write->ack latency (Jacobson/Karels smoothing, like TCP's RTO). The stall
         * deadline adapts to it: a queueing-heavy but alive link (zero-trust tunnel under
         * load, a 3s delay wave) raises the deadline instead of triggering a migration on
         * every frame, while a fast link keeps the 1s floor.
         */
        this.rtt = { srtt: null, rttvar: null, samples: 0 };

        this.stallTimer = null;
        this.peerTimer = null;
        this.graceTimer = null;
        this.disposed = false;
    }

    /**
     * Current stall deadline: max(floor, srtt + 4*rttvar + slack), capped.
     * @return {number} milliseconds
     */
    deadline() {
        const o = this.opts;
        if (this.rtt.srtt === null) {
            return o.migrateAfterMs;
        }
        const adaptive = this.rtt.srtt + 4 * this.rtt.rttvar + o.migrateSlackMs;
        return Math.min(o.migrateAfterMaxMs, Math.max(o.migrateAfterMs, adaptive));
    }

    _sampleRtt(sample) {
        if (!(sample >= 0)) {
            return;
        }
        const r = this.rtt;
        if (r.srtt === null) {
            r.srtt = sample;
            r.rttvar = sample / 2;
        } else {
            r.rttvar = 0.75 * r.rttvar + 0.25 * Math.abs(r.srtt - sample);
            r.srtt = 0.875 * r.srtt + 0.125 * sample;
        }
        r.samples++;
    }

    // ---------- capability ----------

    /** Sequencing/retention are active until the peer proves legacy or the user closed. */
    active() {
        return this.opts.enabled && this.peer !== false && !this.userClosed && !this.disposed;
    }

    /**
     * Called after this end announced its session: if no answer arrives in time the peer is
     * treated as legacy and the retained window is released. A late answer flips it back.
     */
    armPeerTimeout() {
        this.clearPeerTimeout();
        this.peerTimer = unref(setTimeout(() => {
            this.peerTimer = null;
            if (this.peer === 'unknown') {
                this.markLegacy();
            }
        }, this.opts.sessionTimeoutMs));
    }

    clearPeerTimeout() {
        if (this.peerTimer) {
            clearTimeout(this.peerTimer);
            this.peerTimer = null;
        }
    }

    markCapable() {
        this.clearPeerTimeout();
        this.peer = true;
    }

    markLegacy() {
        this.clearPeerTimeout();
        this.peer = false;
        this.releaseRetained();
    }

    // ---------- outgoing: numbering + retention ----------

    /**
     * Assigns the next sequence number to an envelope. Must be called immediately before the
     * frame is built and written, so the wire order is the sequence order.
     * @param {Object} message - a ToolSocketMessage (or plain envelope) about to be serialized
     * @return {?number} the sequence assigned, or null when sequencing is off
     */
    stamp(message) {
        if (!this.active()) {
            this.tx.lastStamped = null;
            return null;
        }
        const q = ++this.tx.seq;
        message.q = q;
        this.tx.lastStamped = q;
        return q;
    }

    /**
     * Records a frame that was just written under a sequence number, until the peer acks it.
     * Several frames may share one number (legacy frameCount header + its raw frames).
     * @param {string|Uint8Array|ArrayBuffer} frame
     * @param {?number} seq
     */
    retain(frame, seq) {
        if (seq === null || seq === undefined || !this.active()) {
            return;
        }
        const wasEmpty = this.tx.retained.length === 0;
        this.tx.retained.push({ seq, frame, at: Date.now() });
        this.tx.bytes += frameSize(frame);
        if (this.tx.bytes > this.opts.retainMaxBytes) {
            // the peer has not drained a window this large in a very long time: dead or wedged
            this.io.onStall('retained-window-full');
            return;
        }
        if (wasEmpty) {
            this.armStallTimer();
        }
    }

    /**
     * The peer delivered everything up to and including `w`.
     * @param {number} w
     */
    onAck(w) {
        if (typeof w !== 'number' || w < this.tx.acked) {
            return; // stale or reordered ack
        }
        this.tx.acked = w;
        const retained = this.tx.retained;
        let dropped = 0;
        while (dropped < retained.length && retained[dropped].seq <= w) {
            this.tx.bytes -= frameSize(retained[dropped].frame);
            dropped++;
        }
        if (dropped > 0) {
            // write->ack latency of the newest frame this ack covers: one ack interval plus
            // the round trip, which is what the stall deadline must stay comfortably above
            this._sampleRtt(Date.now() - retained[dropped - 1].at);
            retained.splice(0, dropped);
        }
        if (retained.length === 0) {
            this.tx.bytes = 0;
            this.clearStallTimer();
        } else {
            this.armStallTimer(); // progress was made: measure the new oldest from now
        }
    }

    /** Frames retained above the peer's watermark, in sequence order (for resend). */
    retainedAbove(w) {
        return this.tx.retained.filter(entry => entry.seq > w).map(entry => entry.frame);
    }

    releaseRetained() {
        this.tx.retained = [];
        this.tx.bytes = 0;
        this.clearStallTimer();
    }

    armStallTimer() {
        this.clearStallTimer();
        if (!this.active() || this.tx.retained.length === 0) {
            return;
        }
        const oldest = this.tx.retained[0];
        const due = Math.max(0, this.deadline() - (Date.now() - oldest.at));
        this.stallTimer = unref(setTimeout(() => {
            this.stallTimer = null;
            if (!this.active() || this.tx.retained.length === 0) {
                return;
            }
            const age = Date.now() - this.tx.retained[0].at;
            if (age >= this.deadline()) {
                this.io.onStall('ack-timeout');
            } else {
                this.armStallTimer();
            }
        }, due));
    }

    clearStallTimer() {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = null;
        }
    }

    /** Stop measuring while no transport is attached (migration in progress / grace). */
    suspendStallTimer() {
        this.clearStallTimer();
    }

    /** A transport is attached again: retained frames are fresh from now. */
    resumeStallTimer() {
        const now = Date.now();
        for (const entry of this.tx.retained) {
            entry.at = now;
        }
        this.armStallTimer();
    }

    // ---------- incoming: dedupe + watermark ----------

    /**
     * Decides what to do with an inbound envelope. Unsequenced frames (legacy peers, control
     * frames) always pass. Sequenced frames are delivered exactly once, in order.
     * @param {Object} message - parsed envelope; `q` is consumed and removed
     * @return {boolean} true to deliver, false to drop as a duplicate
     */
    onInbound(message) {
        const q = message.q;
        if (typeof q !== 'number') {
            return true;
        }
        delete message.q; // hop-local: never forwarded by a relay
        this.rx.sinceAck++;
        if (q <= this.rx.lastDelivered) {
            this.scheduleAck(); // re-assert the watermark: the peer is behind on our acks
            if (message.f !== null && message.f !== undefined) {
                this.rx.skipBinary = message.f; // drop this duplicate header's raw frames too
            }
            return false;
        }
        if (q !== this.rx.lastDelivered + 1) {
            // A gap cannot happen on an in-order transport with a correct resend. Never stall
            // the stream over it: deliver and move the watermark.
            console.warn(`ToolSocket session: sequence gap ${this.rx.lastDelivered} -> ${q}`);
        }
        this.rx.lastDelivered = q;
        this.scheduleAck();
        return true;
    }

    /**
     * Raw binary frames that follow a duplicate legacy frameCount header must be dropped.
     * @return {boolean} true when the frame was consumed by the skip
     */
    consumeSkippedBinary() {
        if (this.rx.skipBinary > 0) {
            this.rx.skipBinary--;
            return true;
        }
        return false;
    }

    scheduleAck() {
        if (!this.active()) {
            return;
        }
        if (this.rx.sinceAck >= this.opts.ackEveryFrames) {
            this.sendAck();
            return;
        }
        if (this.rx.ackTimer) {
            return;
        }
        this.rx.ackTimer = unref(setTimeout(() => {
            this.rx.ackTimer = null;
            this.sendAck();
        }, this.opts.ackIntervalMs));
    }

    sendAck() {
        if (this.rx.ackTimer) {
            clearTimeout(this.rx.ackTimer);
            this.rx.ackTimer = null;
        }
        this.rx.sinceAck = 0;
        this.io.sendControl('__ts/ack', { w: this.rx.lastDelivered });
    }

    // ---------- grace (server side) ----------

    armGrace(onExpire) {
        this.clearGrace();
        this.graceTimer = unref(setTimeout(() => {
            this.graceTimer = null;
            onExpire();
        }, this.opts.graceMs));
    }

    clearGrace() {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
    }

    inGrace() {
        return this.graceTimer !== null;
    }

    // ---------- teardown ----------

    dispose() {
        this.disposed = true;
        this.clearPeerTimeout();
        this.clearStallTimer();
        this.clearGrace();
        if (this.rx.ackTimer) {
            clearTimeout(this.rx.ackTimer);
            this.rx.ackTimer = null;
        }
        this.tx.retained = [];
        this.tx.bytes = 0;
    }
}

SessionStream.DEFAULTS = DEFAULTS;
SessionStream.secureId = secureId;

module.exports = SessionStream;
