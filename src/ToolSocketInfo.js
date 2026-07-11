/**
 * ToolSocketInfo — live info reporting for a server-side ToolSocket connection.
 *
 * This module is ONLY loaded when IncomingToolSocket.info(true, callback) is called
 * for the first time — the info API is server side only; client sockets do not expose
 * it. While info mode is off, none of this code is loaded or executed and the
 * ToolSocket hot paths carry zero extra work: observation happens exclusively through
 * ToolSocket's event system, whose triggerEvent() early-returns with no listeners.
 *
 * Reporting model: data is collected continuously while enabled. A single 1 Hz ticker
 * rolls per-second buckets, and every 5th tick a report is pushed to the callback:
 *   {
 *     type:      'info'
 *     timestamp: number  — Date.now() at the moment the report is pushed
 *     data: {
 *       networkLatency: {  — round trips of WebSocket protocol-level ping/pong frames
 *         currentMs: number  — round trip time of the most recent ping/pong
 *         averageMs: number  — average over samples since the last report
 *         minMs:     number  — fastest sample since the last report
 *         maxMs:     number  — slowest sample since the last report
 *         samples:   number  — how many pings were measured since the last report
 *       } | null             — null if no ping completed since the last report
 *       appLatency: {        — round trips of application-level ToolSocket ping messages
 *         (same fields as networkLatency)
 *       } | null
 *       transport: {
 *         averageBytesPerSecond: number — total traffic / elapsed time since last report
 *         peakBytesPerSecond:    number — busiest single 1s bucket since the last report
 *         sentBytes:             number — outgoing bytes since the last report
 *         receivedBytes:         number — incoming bytes since the last report
 *       }
 *     }
 *   }
 *
 * How latency is measured — two complementary signals:
 *
 * networkLatency: on each 1 Hz tick a WebSocket protocol-level PING control frame
 * (RFC 6455) is sent via the ws library with a timestamp embedded in its payload; the
 * peer's networking layer echoes it back in the PONG frame, and the timestamp is read
 * straight out of it (stateless, no pending map). Control frames are ~10 bytes and are
 * answered below the application — no JSON parsing, no routing, no user code — so this
 * approximates pure network round trip time. In browsers the reply comes from the
 * network stack, largely independent of main-thread load; note that Node.js peers
 * answer PINGs on their event loop, so a fully blocked Node peer delays these too.
 *
 * appLatency: ToolSocket's built-in keepalive sends an application-level 'ping'
 * message (route 'action/ping') every ~5s with a response callback, which assigns it
 * a message id. We listen to the 'send' event to record the send time of each ping id
 * and to the 'res' event to match the response id back to it. This round trip includes
 * the peer's full message pipeline (event loop, JSON parse, schema validation, route
 * dispatch), so appLatency minus networkLatency approximates client-side processing
 * pressure.
 *
 * How transport is measured (zero per-message overhead): Node.js already maintains
 * byte counters on every TCP socket (net.Socket bytesRead / bytesWritten) — they are
 * counted by Node core whether or not anyone reads them. The 1 Hz ticker samples the
 * counters of the WebSocket's underlying socket and diffs them against the previous
 * sample. No message events are hooked at all, so the send/receive paths carry zero
 * added work even while info mode is ENABLED. The numbers are exact wire bytes,
 * including WebSocket frame headers, client-side masking, and protocol-level control
 * frames; keepalive ping/pong traffic is included. If the underlying socket is ever
 * replaced, the sampler re-baselines automatically and that second reads as zero.
 */

const BUCKET_INTERVAL_MS = 1000;
const BUCKETS_PER_REPORT = 5; // push a report to the callback every 5 seconds
// Drop pending pings that never got a response (e.g. connection dropped mid-flight)
const PENDING_PING_TIMEOUT_MS = 30000;
// Marks our protocol-level PING payloads so we only interpret our own PONGs
const PROTOCOL_PING_PREFIX = 'tsinfo:';

const now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

class ToolSocketInfo {
    /**
     * @param {Object} toolsocket - The server-side ToolSocket instance to observe
     */
    constructor(toolsocket) {
        this.toolsocket = toolsocket;
        /** @type {?function} */
        this.callback = null;
        this.active = false;
        /**
         * eventType -> handler map of every listener this instance registered,
         * so stop() can remove exactly what start() added and nothing else.
         * @type {Object<string, function>}
         */
        this.listeners = {};
        /** @type {?ReturnType<setInterval>} */
        this.tickInterval = null;
        this.tickCount = 0;
        this.windowStartMs = 0;

        // --- app latency state (ToolSocket-level ping messages) ---
        /** @type {Object<string, number>} ping message id -> send time */
        this.pendingAppPings = {};
        /** @type {number[]} completed round trip times since the last report */
        this.appLatencySamples = [];
        /** @type {?number} most recent completed round trip time */
        this.lastAppLatencyMs = null;

        // --- network latency state (WebSocket protocol-level PING/PONG frames) ---
        /** @type {?Object} the ws WebSocket our 'pong' listener is attached to */
        this.pingedSocket = null;
        /** @type {?function} */
        this.pongHandler = null;
        /** @type {number[]} completed round trip times since the last report */
        this.networkLatencySamples = [];
        /** @type {?number} most recent completed round trip time */
        this.lastNetworkLatencyMs = null;

        // --- transport state ---
        // Baseline sample of the underlying net.Socket's built-in byte counters
        /** @type {?Object} the net.Socket the baseline belongs to */
        this.countedSocket = null;
        this.lastBytesRead = 0;
        this.lastBytesWritten = 0;
        // Window accumulators: rolled up from counter deltas on each tick
        this.windowBytesSent = 0;
        this.windowBytesReceived = 0;
        this.peakBytesPerSecond = 0;
    }

    /**
     * Sets (or replaces) the callback that receives info reports
     * @param {?function} callback
     */
    setCallback(callback) {
        this.callback = typeof callback === 'function' ? callback : null;
    }

    /**
     * Attaches listeners and starts the ticker. Idempotent.
     */
    start() {
        if (this.active) {
            return;
        }
        this.active = true;

        // --- app latency collection ---------------------------------------
        // Record the send time of every outgoing ping that expects a response
        this._listen('send', (messageBundle) => {
            const message = messageBundle && messageBundle.message;
            if (message && message.method === 'ping' && message.id) {
                this.pendingAppPings[message.id] = now();
            }
        });
        // Match incoming responses back to their ping by message id
        this._listen('res', (_route, _body, _response, _binaryData, messageBundle) => {
            const message = messageBundle && messageBundle.message;
            if (!message || !message.id) {
                return;
            }
            const sentAt = this.pendingAppPings[message.id];
            if (sentAt === undefined) {
                return;
            }
            delete this.pendingAppPings[message.id];
            const roundTripMs = Math.round((now() - sentAt) * 10) / 10;
            this.lastAppLatencyMs = roundTripMs;
            this.appLatencySamples.push(roundTripMs);
        });

        // --- network latency collection ------------------------------------
        this._ensureProtocolPingHooks();

        // --- transport collection: baseline the TCP counters ---------------
        this._sampleSocketCounters(); // establishes the baseline, returns zero deltas

        // --- ticker: buckets at 1 Hz, report every 5th tick ---------------
        this.tickCount = 0;
        this.windowStartMs = Date.now();
        this.tickInterval = setInterval(() => this._tick(), BUCKET_INTERVAL_MS);
        // Don't let the ticker keep a Node.js process alive on its own
        if (this.tickInterval.unref) {
            this.tickInterval.unref();
        }
    }

    /**
     * Detaches every listener, stops the ticker, and clears all collected state.
     * After stop(), this instance holds no hooks into the ToolSocket.
     */
    stop() {
        if (!this.active) {
            return;
        }
        clearInterval(this.tickInterval);
        this.tickInterval = null;
        for (const [eventType, handler] of Object.entries(this.listeners)) {
            this.toolsocket.removeEventListener(eventType, handler);
        }
        this.listeners = {};
        this._detachProtocolPingHooks();
        this.pendingAppPings = {};
        this.appLatencySamples = [];
        this.lastAppLatencyMs = null;
        this.networkLatencySamples = [];
        this.lastNetworkLatencyMs = null;
        this.countedSocket = null;
        this.lastBytesRead = 0;
        this.lastBytesWritten = 0;
        this.windowBytesSent = 0;
        this.windowBytesReceived = 0;
        this.peakBytesPerSecond = 0;
        this.callback = null;
        this.active = false;
    }

    /**
     * 1 Hz: rolls the current second's counters into the window and tracks the peak.
     * Every BUCKETS_PER_REPORT ticks, pushes a report.
     */
    _tick() {
        const {deltaRead, deltaWritten} = this._sampleSocketCounters();
        const secondTotal = deltaRead + deltaWritten;
        if (secondTotal > this.peakBytesPerSecond) {
            this.peakBytesPerSecond = secondTotal;
        }
        this.windowBytesSent += deltaWritten;
        this.windowBytesReceived += deltaRead;

        // Network latency: one protocol-level ping per tick (re-hooking if the
        // underlying socket was replaced)
        this._ensureProtocolPingHooks();
        this._sendProtocolPing();

        this.tickCount++;
        if (this.tickCount >= BUCKETS_PER_REPORT) {
            this._report();
        }
    }

    /**
     * Assembles and pushes one info report, then resets the collection window
     */
    _report() {
        this._prunePendingPings();

        const networkLatency = this._summarizeLatency(
            this.networkLatencySamples, this.lastNetworkLatencyMs);
        const appLatency = this._summarizeLatency(
            this.appLatencySamples, this.lastAppLatencyMs);

        // Use real elapsed time, not the nominal window length: under heavy event
        // loop load, timers fire late and the nominal value would overstate rates
        const elapsedSeconds = Math.max((Date.now() - this.windowStartMs) / 1000, 0.001);
        const transport = {
            averageBytesPerSecond: Math.round(
                (this.windowBytesSent + this.windowBytesReceived) / elapsedSeconds),
            peakBytesPerSecond: this.peakBytesPerSecond,
            sentBytes: this.windowBytesSent,
            receivedBytes: this.windowBytesReceived,
        };

        // Reset the collection window
        this.networkLatencySamples = [];
        this.appLatencySamples = [];
        this.windowBytesSent = 0;
        this.windowBytesReceived = 0;
        this.peakBytesPerSecond = 0;
        this.tickCount = 0;
        this.windowStartMs = Date.now();

        if (!this.callback) {
            return;
        }
        this.callback({
            type: 'info',
            timestamp: Date.now(),
            data: {
                networkLatency: networkLatency,
                appLatency: appLatency,
                transport: transport,
            },
        });
    }

    /**
     * Samples the underlying net.Socket's built-in TCP byte counters and returns
     * the change since the previous sample. Re-baselines (returning zero deltas)
     * on the first call and whenever the underlying socket has been replaced.
     * @returns {{deltaRead: number, deltaWritten: number}}
     */
    _sampleSocketCounters() {
        const websocket = this.toolsocket.socket;
        const raw = websocket && websocket._socket;
        if (!raw || typeof raw.bytesRead !== 'number') {
            // No usable underlying socket (e.g. not connected yet)
            this.countedSocket = null;
            return {deltaRead: 0, deltaWritten: 0};
        }
        if (raw !== this.countedSocket) {
            // First sample, or the socket was replaced: establish a new baseline
            this.countedSocket = raw;
            this.lastBytesRead = raw.bytesRead;
            this.lastBytesWritten = raw.bytesWritten;
            return {deltaRead: 0, deltaWritten: 0};
        }
        const deltaRead = raw.bytesRead - this.lastBytesRead;
        const deltaWritten = raw.bytesWritten - this.lastBytesWritten;
        this.lastBytesRead = raw.bytesRead;
        this.lastBytesWritten = raw.bytesWritten;
        return {deltaRead, deltaWritten};
    }

    /**
     * Attaches the protocol-level 'pong' listener to the current underlying ws
     * WebSocket. No-op if already attached to it; re-attaches if it was replaced.
     * The 'pong' event is part of ws's Node.js EventEmitter API, so this quietly
     * does nothing on sockets that don't support it.
     */
    _ensureProtocolPingHooks() {
        const websocket = this.toolsocket.socket;
        if (websocket === this.pingedSocket) {
            return;
        }
        this._detachProtocolPingHooks();
        if (!websocket || typeof websocket.on !== 'function') {
            return;
        }
        this.pongHandler = (data) => {
            const text = data.toString();
            if (!text.startsWith(PROTOCOL_PING_PREFIX)) {
                return; // a pong for someone else's ping
            }
            const sentAt = parseFloat(text.slice(PROTOCOL_PING_PREFIX.length));
            if (!isFinite(sentAt)) {
                return;
            }
            const roundTripMs = Math.round((now() - sentAt) * 10) / 10;
            this.lastNetworkLatencyMs = roundTripMs;
            this.networkLatencySamples.push(roundTripMs);
        };
        websocket.on('pong', this.pongHandler);
        this.pingedSocket = websocket;
    }

    /**
     * Detaches the protocol-level 'pong' listener, if attached
     */
    _detachProtocolPingHooks() {
        if (this.pingedSocket && this.pongHandler
            && typeof this.pingedSocket.off === 'function') {
            this.pingedSocket.off('pong', this.pongHandler);
        }
        this.pingedSocket = null;
        this.pongHandler = null;
    }

    /**
     * Sends one WebSocket protocol-level PING frame with the current time embedded
     * in its payload, so the echoed PONG carries its own send time (stateless RTT).
     */
    _sendProtocolPing() {
        const websocket = this.toolsocket.socket;
        if (!websocket || typeof websocket.ping !== 'function' || websocket.readyState !== 1) {
            return;
        }
        try {
            websocket.ping(PROTOCOL_PING_PREFIX + now());
        } catch (_e) {
            // socket raced into a closing state; skip this sample
        }
    }

    /**
     * Summarizes a window of round trip samples into the report's latency shape
     * @param {number[]} samples
     * @param {?number} currentMs - the most recent round trip measured
     * @returns {?Object} stats, or null if there were no samples this window
     */
    _summarizeLatency(samples, currentMs) {
        if (samples.length === 0) {
            return null;
        }
        const sum = samples.reduce((a, b) => a + b, 0);
        return {
            currentMs: currentMs,
            averageMs: Math.round((sum / samples.length) * 10) / 10,
            minMs: Math.min(...samples),
            maxMs: Math.max(...samples),
            samples: samples.length,
        };
    }

    /**
     * Drops pending ping entries that never received a response
     */
    _prunePendingPings() {
        const cutoff = now() - PENDING_PING_TIMEOUT_MS;
        for (const [id, sentAt] of Object.entries(this.pendingAppPings)) {
            if (sentAt < cutoff) {
                delete this.pendingAppPings[id];
            }
        }
    }

    /**
     * Registers a listener on the ToolSocket and records it for later removal
     * @param {string} eventType
     * @param {function} handler
     */
    _listen(eventType, handler) {
        this.listeners[eventType] = handler;
        this.toolsocket.addEventListener(eventType, handler);
    }
}

module.exports = ToolSocketInfo;
