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
//   dead detection  = "I have unacked frames, the oldest is older than the deadline, AND
//                     nothing at all arrived on this transport for just as long". An inbound
//                     frame proves the transport alive: on a slow link the peer's acks queue
//                     behind its own bulk data, and killing a transport that is visibly
//                     delivering would only restart the transfer. A true half-open transport
//                     delivers nothing, and a one-way black hole is noticed by the end that
//                     receives nothing. The exemption is BOUNDED (stallInboundGraceMs, the old
//                     liveness deadline): inbound traffic proves the transport, not that OUR
//                     direction is being processed, so it may postpone a stall, never cancel it.
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
//   a refused frame = a working transport can still refuse ONE frame. A WebSocket-aware
//                     middlebox that terminates TLS may drop a frame and keep the flow: the
//                     receiver then sees a hole, never delivers or acks past it, and reports it
//                     (`__ts/ack {w, g}`); the sender resends from the watermark on the SAME
//                     transport. A frame that is refused every time — reported missing
//                     poisonGaps times, or still the oldest unacked frame after
//                     poisonMigrations working transports (MTU black hole) — is given up
//                     LOUDLY: an 'undeliverable' event names the message, `__ts/skip {q}` tells
//                     the peer to stop waiting for it, and the stream continues. The
//                     alternative is every later message stuck behind it, silently, forever.
//   numbers without  = the SENDER is authoritative for what it can still supply. Whenever a
//   a frame            peer watermark is applied (gap report, migration handshake) and the
//                     oldest retained frame is not w+1, the numbers in between have no frame
//                     (given up, or stamped and never written) and the receiver is told to
//                     move on (`__ts/skip {to}`). This is re-evaluated every time, so a skip
//                     lost with its transport heals itself, and the receiver can never wait
//                     for a frame that does not exist.
//   multi-frame      = a legacy frameCount transfer (JSON header + N raw frames under ONE
//   transfers          number) is acknowledged when its LAST raw frame arrived, not at the
//                     header: a cut in the middle resends the whole unit, and a raw frame
//                     lost on a live transport shows up as a hole at the next sequenced frame
//                     (string, or an enveloped binary message — it carries its own number).
//                     While the unit arrives the receiver reports PROGRESS (`__ts/ack {w, p}`)
//                     so a long transfer on a slow link is not mistaken for a dead transport.
//                     Only with a v2 peer; a v1 sender gets its ack at the header as before.
//   versions         = the handshake carries `v`. Holes are handled strictly only with a peer
//                     that speaks v2 (it resends on a gap report and sends skips); with a v1
//                     session peer the receiver stays lenient, exactly like v1 itself.
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
    retainMaxBytes: 64 * 1024 * 1024, // retained window cap: exceeding it counts as a stall
    // while a hole persists the receiver repeats its report this often, so a gap report or a
    // skip lost in transit heals on the same transport
    gapRemindMs: 1000,
    stallInboundGraceMs: 16000,   // inbound traffic postpones a stall at most this long
    // a frame is given up as undeliverable when the peer reported it missing this often (the
    // first loss plus every resend pass that failed to fill the hole) while later frames arrived...
    poisonGaps: 3,
    // ...or when it is still the oldest unacked frame after this many completed migrations
    // (each one a proven round trip on a fresh transport)
    poisonMigrations: 5
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
        /** session protocol version the peer announced in the handshake (1 = no `v` key) */
        this.peerVersion = 1;
        /** client: migrations this end completed; server: the highest value the client reported */
        this.completed = 0;
        this.peerCompleted = 0;

        this.tx = {
            seq: 0,            // last sequence number stamped
            lastStamped: null, // sequence of the most recently stamped message (read right after build)
            retained: [],      // [{seq, frame, at}] in write order, not yet acked by the peer
            bytes: 0,
            acked: 0,          // highest sequence the peer has acknowledged
            suspect: null,     // {seq, gaps, carries}: failed deliveries of the current oldest frame
            progress: null     // last progress count the peer reported for the unit it is receiving
        };
        this.rx = {
            lastDelivered: 0,  // highest contiguous sequence delivered to the application
            sinceAck: 0,
            ackTimer: null,
            skipBinary: 0,     // legacy frameCount transfer: raw frames to drop after a dropped header
            gapAt: null,       // watermark at which a hole was last reported to the peer
            gapFirst: 0,       // lowest out-of-order sequence seen behind that hole
            pending: null,     // {q, got}: multi-frame transfer whose header arrived, raw frames still coming
            dropPartial: false, // the owner must discard its half-assembled multi-frame buffer
            ackNext: false,    // ack the next delivery at once (first frame on a fresh transport)
            lastInboundAt: 0,  // any frame at all arrived on the current transport: it is alive
            gapTimer: null     // repeats the gap report while the hole persists
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
     * Takes back the number stamp() just assigned because its frame could not be built
     * (serialization threw). Building is synchronous, so nothing else was stamped since.
     * A number that is never written would be a hole the receiver waits on.
     * @param {Object} [message] - the envelope that was stamped
     */
    unstampLast(message) {
        if (this.tx.lastStamped !== null && this.tx.lastStamped === this.tx.seq) {
            this.tx.seq--;
        }
        this.tx.lastStamped = null;
        if (message && typeof message === 'object') {
            delete message.q;
        }
    }

    /** Holes are handled strictly only with a peer that resends on a gap report and sends skips. */
    strict() {
        return this.peerVersion >= 2;
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
            // The peer has not drained a window this large in a very long time: dead or wedged.
            // Deferred: retain() runs inside a write, and the stall handler replaces the
            // transport — that must never happen between retaining a frame and writing it.
            if (!this.overflowPending) {
                this.overflowPending = true;
                Promise.resolve().then(() => {
                    this.overflowPending = false;
                    if (!this.disposed && this.tx.bytes > this.opts.retainMaxBytes) {
                        this.io.onStall('retained-window-full');
                    }
                });
            }
            if (wasEmpty) {
                this.armStallTimer();
            }
            return;
        }
        if (wasEmpty) {
            this.armStallTimer();
        }
    }

    /**
     * The peer delivered everything up to and including `w`.
     * @param {number} w
     * @param {?number} [progress] - raw frames the peer has received of the multi-frame unit
     *     right above `w`: the transport is moving although the watermark cannot yet
     */
    onAck(w, progress) {
        if (typeof w !== 'number' || w < this.tx.acked) {
            return; // stale or reordered ack
        }
        if (w > this.tx.acked) {
            this.tx.progress = null;
        }
        if (typeof progress === 'number' && progress !== this.tx.progress) {
            this.tx.progress = progress;
            const now = Date.now();
            for (const entry of this.tx.retained) {
                entry.at = now; // measure the stall deadline from the last sign of progress
            }
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
        this.tx.suspect = null;
        this.tx.progress = null;
        this.clearStallTimer();
    }

    /**
     * The server handed this end a FRESH session (it no longer had ours): numbering starts
     * over in both directions and nothing half-received on the old session may leak into it.
     * @param {number} peerVersion - what the fresh server-side session announced (1 if nothing)
     */
    resetStreams(peerVersion) {
        this.releaseRetained();
        this.tx.seq = 0;
        this.tx.acked = 0;
        this.tx.lastStamped = null;
        this.rx.lastDelivered = 0;
        this.rx.sinceAck = 0;
        this.rx.skipBinary = 0;
        this.rx.gapAt = null;
        this.rx.gapFirst = 0;
        this._clearGapReminder();
        this.rx.pending = null;
        this.rx.dropPartial = false;
        this.rx.ackNext = false;
        this.completed = 0;
        this.peerCompleted = 0;
        this.peerVersion = peerVersion >= 2 ? peerVersion : 1;
    }

    // ---------- outgoing: a frame that will not arrive ----------
    //
    // Two ways a working transport can refuse ONE frame: a WebSocket-aware middlebox drops
    // it and lets the rest through (the peer reports a hole), or the path stalls on it every
    // time (MTU black hole, inspection that wedges on the payload) so every successor dies on
    // the same frame. Either way the evidence is counted against the current oldest unacked
    // frame only, and any progress of the watermark past it clears the count.

    /**
     * Highest sequence above the peer's watermark `w` that this end holds NO frame for — given
     * up earlier, or stamped and never written. The receiver must be told to move past these
     * (it would wait forever otherwise), and they must never be blamed on a retained frame.
     * @param {number} w - the peer's watermark, already applied with onAck
     * @return {?number} skip target, or null when the oldest retained frame is exactly w+1
     */
    unheldAbove(w) {
        const first = this.tx.retained.length ? this.tx.retained[0].seq : this.tx.seq + 1;
        return first > w + 1 ? first - 1 : null;
    }

    _suspect(seq) {
        if (!this.tx.suspect || this.tx.suspect.seq !== seq) {
            this.tx.suspect = { seq, gaps: 0, carries: 0 };
        }
        return this.tx.suspect;
    }

    /**
     * The peer reports a hole right above `w` while later frames reached it.
     * @param {number} w - the peer's watermark
     * @param {boolean} [reminder] - a timed repeat of an earlier report: resend, but it is no
     *     new evidence against the frame (no resend pass is known to have failed)
     * @return {?{seq: number, frames: Array, reason: string, attempts: number}|boolean}
     *     false = stale report, ignore; null = resend from `w` (after skipping what
     *     unheldAbove reports); object = give up on that frame
     */
    noteGap(w, reminder) {
        if (typeof w !== 'number' || w < this.tx.acked) {
            return false;
        }
        this.onAck(w);
        const oldest = this.tx.retained[0];
        if (!oldest || oldest.seq !== w + 1) {
            // the missing number is one we hold no frame for: nothing to blame, the caller
            // tells the peer to skip it (unheldAbove) and resends what it does hold
            return null;
        }
        if (reminder) {
            return null;
        }
        const suspect = this._suspect(oldest.seq);
        suspect.gaps++;
        if (suspect.gaps >= this.opts.poisonGaps) {
            return this.giveUp(oldest.seq, 'dropped-in-transit', suspect.gaps);
        }
        return null;
    }

    /**
     * A migration completed (the handshake made the round trip on a fresh transport) and the
     * peer's watermark was applied. Whatever is still the oldest retained frame has now
     * failed to arrive on one more working transport.
     * @return {?{seq: number, frames: Array, reason: string, attempts: number}}
     */
    noteCarried() {
        const oldest = this.tx.retained[0];
        if (!oldest || oldest.seq !== this.tx.acked + 1) {
            return null; // nothing retained, or the frame the peer waits for is not one we hold
        }
        const suspect = this._suspect(oldest.seq);
        suspect.carries++;
        if (suspect.carries >= this.opts.poisonMigrations) {
            return this.giveUp(oldest.seq, 'stalls-every-transport', suspect.carries);
        }
        return null;
    }

    /**
     * Stops retaining every frame stamped `seq` (a legacy header and its raw frames share
     * one number, so the unit goes as a whole).
     */
    giveUp(seq, reason, attempts) {
        const frames = [];
        this.tx.retained = this.tx.retained.filter(entry => {
            if (entry.seq !== seq) {
                return true;
            }
            frames.push(entry.frame);
            this.tx.bytes -= frameSize(entry.frame);
            return false;
        });
        this.tx.suspect = null;
        if (this.tx.retained.length === 0) {
            this.tx.bytes = 0;
            this.clearStallTimer();
        }
        return { seq, frames, reason, attempts };
    }

    /** Any frame arrived on the current transport (called for every raw inbound frame). */
    noteInbound() {
        this.rx.lastInboundAt = Date.now();
    }

    /** Milliseconds until a stall may be declared: both the oldest frame and the silence must be old enough. */
    _stallDue() {
        const now = Date.now();
        const deadline = this.deadline();
        const age = now - this.tx.retained[0].at;
        const ageDue = deadline - age;
        const graceDue = this.opts.stallInboundGraceMs - age;
        if (graceDue <= 0) {
            return ageDue; // unacked for this long: inbound traffic no longer excuses it
        }
        return Math.min(Math.max(ageDue, deadline - (now - this.rx.lastInboundAt)), Math.max(graceDue, ageDue));
    }

    armStallTimer() {
        this.clearStallTimer();
        if (!this.active() || this.tx.retained.length === 0) {
            return;
        }
        this.stallTimer = unref(setTimeout(() => {
            this.stallTimer = null;
            if (!this.active() || this.tx.retained.length === 0) {
                return;
            }
            if (this._stallDue() <= 0) {
                this.io.onStall('ack-timeout');
            } else {
                this.armStallTimer();
            }
        }, Math.max(0, this._stallDue())));
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
     * @return {boolean} true to deliver; false to drop (a duplicate, or out of order behind a
     *     hole — that one is resent in order)
     */
    onInbound(message) {
        const q = message.q;
        if (typeof q !== 'number') {
            return true;
        }
        delete message.q; // hop-local: never forwarded by a relay
        this.rx.sinceAck++;
        const rawFrames = (typeof message.f === 'number' && message.f > 0) ? message.f : 0;
        if (q <= this.rx.lastDelivered) {
            this.scheduleAck(); // re-assert the watermark: the peer is behind on our acks
            if (rawFrames) {
                this.rx.skipBinary = rawFrames; // drop this duplicate header's raw frames too
            }
            return false;
        }
        if (q !== this.rx.lastDelivered + 1) {
            // Frames went missing while the transport kept flowing. TCP/TLS cannot do that,
            // but a WebSocket-aware middlebox that terminates TLS (zero-trust broker, WAF)
            // can drop a single frame — and a raw frame lost out of a multi-frame transfer
            // shows up here too, because that transfer was never acked (see `pending`).
            if (this.rx.pending) {
                this.rx.pending = null;
                this.rx.dropPartial = true; // the half-assembled transfer comes again as a whole
            }
            if (!this.strict()) {
                // a v1 session peer neither resends on a gap report nor sends skips: waiting
                // would wedge the stream, so behave exactly like v1 — log, deliver, move on
                console.warn(`ToolSocket session: sequence gap ${this.rx.lastDelivered} -> ${q}`);
                return this._accept(q, rawFrames);
            }
            // Never deliver out of order and never move the watermark past the hole — that
            // would acknowledge what never arrived and the sender would release it. Report
            // the hole; the sender resends from the watermark (go-back-N), so this frame
            // comes again, in order.
            if (rawFrames) {
                this.rx.skipBinary = rawFrames; // its raw frames come again with it
            }
            this.reportGap(q);
            return false;
        }
        return this._accept(q, rawFrames);
    }

    /**
     * In-order frame `q`: a plain frame is delivered and acked; the header of a multi-frame
     * transfer is only noted — the unit counts as delivered when its last raw frame arrived
     * (completeGroup), so a cut in the middle makes the sender resend all of it.
     */
    _accept(q, rawFrames) {
        if (rawFrames && this.strict()) {
            if (this.rx.pending) {
                this.rx.dropPartial = true; // the same header again: restart its buffer
            }
            this.rx.pending = { q, got: 0 };
            return true;
        }
        // (a v1 sender has no use for a deferred ack — it would only see its header unacked
        // for the whole transfer and migrate — so its unit is acked at the header, as in v1)
        this.rx.pending = null;
        this._delivered(q);
        return true;
    }

    _delivered(q) {
        this.rx.lastDelivered = q;
        this.rx.gapAt = null;
        this._clearGapReminder();
        if (this.rx.ackNext) {
            // first delivery on a fresh transport: tell the sender at once that its resend
            // arrived, so one more cut right after cannot count as another failed delivery
            this.rx.ackNext = false;
            this.sendAck();
        } else {
            this.scheduleAck();
        }
    }

    /**
     * One more raw frame of the pending unit arrived. Reported to the sender with the next
     * (coalesced) ack so it can tell a long transfer from a dead transport.
     */
    unitProgress() {
        if (!this.rx.pending) {
            return;
        }
        this.rx.pending.got++;
        this.rx.sinceAck++;
        this.scheduleAck();
    }

    /** The sequence of the multi-frame unit being received, or null. */
    pendingSeq() {
        return this.rx.pending ? this.rx.pending.q : null;
    }

    /** The unit being received is broken (a raw frame of it never came): forget it. */
    abandonPending() {
        this.rx.pending = null;
    }

    /** The last raw frame of the pending multi-frame transfer arrived: now it is delivered. */
    completeGroup() {
        const pending = this.rx.pending;
        if (!pending) {
            return;
        }
        this.rx.pending = null;
        this._delivered(pending.q);
    }

    /**
     * True once after the session layer abandoned a half-received multi-frame transfer; the
     * owner must then discard its partial buffer (the next binary frame is NOT part of it).
     * @return {boolean}
     */
    takePartialDrop() {
        const drop = this.rx.dropPartial;
        this.rx.dropPartial = false;
        return drop;
    }

    /** A fresh transport was attached: whatever was half-received on the old one is void. */
    onTransportAttached() {
        if (this.rx.pending) {
            this.rx.pending = null;
            this.rx.dropPartial = true;
        }
        this.rx.skipBinary = 0;
        this.rx.ackNext = true;
    }

    /**
     * Tells the sender at once that the frame right above the watermark is missing. Every
     * out-of-order frame behind one hole lands here, so only two moments are reported: the
     * hole's discovery, and a frame already seen behind it coming round AGAIN — a whole
     * resend pass went by and the missing frame still did not arrive. Counting passes rather
     * than time keeps the evidence honest on a slow link, where the first resend may simply
     * not have arrived yet.
     * @param {number} q - the out-of-order sequence that exposed the hole
     */
    reportGap(q) {
        const w = this.rx.lastDelivered;
        if (this.rx.gapAt === w && q > this.rx.gapFirst) {
            return; // further frames of the same pass
        }
        if (this.rx.gapAt !== w) {
            console.warn(`ToolSocket session: frame ${w + 1} missing (got ${q}); asking the peer to resend`);
        }
        this.rx.gapAt = w;
        this.rx.gapFirst = q;
        if (this.rx.ackTimer) {
            clearTimeout(this.rx.ackTimer);
            this.rx.ackTimer = null;
        }
        this.rx.sinceAck = 0;
        this.io.sendControl('__ts/ack', { w, g: 1 });
        this._armGapReminder();
    }

    /**
     * A gap report (or the skip that answers it) can itself be lost, and then nothing else
     * would ever repeat it: frames behind the hole are dropped silently, and while the peer
     * keeps sending, its stall detector sees a lively transport. So the report is repeated
     * while the hole persists, marked `g: 2` — a reminder, not evidence of a failed resend.
     */
    _armGapReminder() {
        this._clearGapReminder();
        this.rx.gapTimer = unref(setTimeout(() => {
            this.rx.gapTimer = null;
            if (!this.active() || this.rx.gapAt === null || this.rx.gapAt !== this.rx.lastDelivered) {
                return;
            }
            this.io.sendControl('__ts/ack', { w: this.rx.lastDelivered, g: 2 });
            this._armGapReminder();
        }, this.opts.gapRemindMs));
    }

    _clearGapReminder() {
        if (this.rx.gapTimer) {
            clearTimeout(this.rx.gapTimer);
            this.rx.gapTimer = null;
        }
    }

    /**
     * The sender holds no frame for any number up to `to` (it gave them up and told its
     * application, or never wrote them): stop waiting for them. Frames with those numbers
     * that did arrive were written before this control frame on the same ordered transport,
     * so they were processed already and `to` is then at or below the watermark.
     * @param {number} to
     */
    onSkip(to) {
        if (typeof to !== 'number' || to <= this.rx.lastDelivered) {
            return;
        }
        console.warn(`ToolSocket session: peer holds no frame for ${this.rx.lastDelivered + 1}..${to}; continuing without`);
        if (this.rx.pending) {
            this.rx.pending = null;
            this.rx.dropPartial = true;
        }
        this.rx.lastDelivered = to;
        this.rx.gapAt = null;
        this._clearGapReminder();
        this.sendAck();
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
        const body = { w: this.rx.lastDelivered };
        if (this.rx.pending) {
            body.p = this.rx.pending.got;
        }
        this.io.sendControl('__ts/ack', body);
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
        this._clearGapReminder();
        if (this.rx.ackTimer) {
            clearTimeout(this.rx.ackTimer);
            this.rx.ackTimer = null;
        }
        this.tx.retained = [];
        this.tx.bytes = 0;
    }
}

SessionStream.DEFAULTS = DEFAULTS;
/** session protocol version announced in the handshake (`v`); 1 = the first session build, which sent none */
SessionStream.VERSION = 2;
SessionStream.secureId = secureId;

module.exports = SessionStream;
