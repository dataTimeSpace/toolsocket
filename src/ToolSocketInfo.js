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
 *       probe: {          — latest throughput probe result; null until the first
 *                            probe, then persists unchanged until the next one.
 *                            Triggered on demand via info(true, undefined, {probe: true})
 *         status:    'running' | 'ok' | 'failed'
 *         timestamp: number  — when the probe finished (or started, while running)
 *         sizeBytes: number  — payload size used per direction
 *         rttMsAtProbe:            number — network RTT baseline subtracted from timings
 *         downstreamBytesPerSecond: ?number — measured server -> client rate
 *         upstreamBytesPerSecond:   ?number — measured client -> server rate
 *         reason:    string  — only when failed, e.g. 'not-connected',
 *                              'timeout-or-unsupported-client'
 *       }
 *       networkQuality: { — plain-language interpretation of realtime connection quality
 *         score:  number   — 0 (unusable) to 100 (perfect realtime behavior)
 *         rating: string   — 'excellent' | 'good' | 'degraded' | 'poor'
 *         flow:   string   — 'realtime' (data moves live) | 'buffered' (held by the
 *                            network and pumped in bursts) | 'stalled' (nothing
 *                            arriving) | 'ended' (connection closed; final report)
 *         trend:  string   — 'improving' | 'stable' | 'degrading' vs recent reports
 *         scores: {        — per-dimension indicators, each 0-100 (null = no data):
 *           continuity:      is data arriving every second (the realtime dimension)
 *           latency:         is the round trip fast enough for realtime use
 *           stability:       is the round trip consistent (jitter)
 *           delivery:        is outbound data draining (send backpressure)
 *         }
 *         issues: string[] — flags, present only when detected:
 *                            'data-arriving-in-bursts-not-realtime',
 *                            'incoming-data-stalled', 'outgoing-data-queuing-locally',
 *                            'high-latency', 'latency-unstable',
 *                            'client-under-pressure', 'connection-cut-abnormally'
 *         details: {       — the underlying low-level numbers, for experts
 *           jitterMs, silentSeconds, longestSilenceSeconds, maxBufferedBytes,
 *           connectionAgeSeconds, and on the final report closeCode + endedCleanly
 *         }
 *       }
 *     }
 *   }
 *
 * How network quality is derived: because a protocol ping goes out every second, a
 * healthy realtime link ALWAYS has inbound bytes every second — so seconds with zero
 * inbound bytes ('silent seconds') mean the path is not live: a few of them with data
 * still arriving overall is the store-and-forward pattern of buffering middleboxes
 * (flow 'buffered'); a streak of them is a stall. Outgoing pressure is read from the
 * socket's bufferedAmount (data queued locally because the path isn't draining).
 * Jitter is the spread (max - min) of the window's protocol ping round trips. On
 * close, the close code is captured and a final report is pushed: code 1000/1001 is
 * a clean end, anything else (especially 1006) means the connection was cut, which
 * is the typical signature of proxies and zero-trust gateways killing the socket.
 *
 * Throughput probe: an on-demand (never automatic) measurement of the maximum data
 * rate each direction sustains. Downstream: a payload of incompressible bytes is sent
 * to the client via meta route 'probe/down'; the client acknowledges with a tiny
 * response, so the elapsed time minus the RTT baseline is the payload's transfer
 * time. Upstream: meta route 'probe/up' asks the client to respond with the same
 * amount of incompressible data. Both responders are built into ToolSocket's default
 * meta routes and are completely passive until a probe request arrives. Probe traffic
 * is real traffic: it will appear in that window's transport numbers, and protocol
 * pings sent during the transfer measure latency under load.
 *
 * Scoring: each dimension maps to 0-100 through the piecewise-linear anchor tables
 * below (continuity is simply the fraction of seconds with inbound data). The overall
 * score is 50% the worst dimension + 50% a weighted average with continuity weighted
 * highest — realtime systems fail on their weakest dimension, so one bad dimension
 * must drag the overall down. An abnormal connection cut caps the final report's
 * score at 30. 'trend' compares the score against the previous three reports.
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
// Throughput probe defaults: payload per direction and overall timeout
const DEFAULT_PROBE_SIZE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 10000;

const { makeProbePayload } = require('./utilities.js');

// Piecewise-linear anchor tables: [measurement, score] pairs mapping a raw value to
// a 0-100 dimension score. Values between anchors are linearly interpolated.
// Average round trip in ms -> latency score
const LATENCY_SCORE_ANCHORS = [[0, 100], [50, 95], [150, 80], [300, 55], [600, 30], [1200, 10], [2000, 0]];
// Round trip spread (max - min) in ms -> stability score
const JITTER_SCORE_ANCHORS = [[0, 100], [10, 95], [30, 85], [75, 65], [150, 40], [400, 15], [1000, 0]];
// Peak bytes stuck in the local send buffer -> delivery score (before persistence penalty)
const BUFFERED_SCORE_ANCHORS = [[0, 100], [16384, 85], [131072, 60], [1048576, 30], [8388608, 0]];
// How many recent scores 'trend' compares against, and the change it must exceed
const TREND_HISTORY_LENGTH = 3;
const TREND_THRESHOLD = 8;

/**
 * Maps a measurement to a 0-100 score by linear interpolation over an anchor table
 * @param {number[][]} anchors - [value, score] pairs, ascending by value
 * @param {number} value
 * @returns {number}
 */
function interpolateScore(anchors, value) {
    if (value <= anchors[0][0]) {
        return anchors[0][1];
    }
    for (let i = 1; i < anchors.length; i++) {
        if (value <= anchors[i][0]) {
            const [x0, y0] = anchors[i - 1];
            const [x1, y1] = anchors[i];
            return Math.round(y0 + (y1 - y0) * ((value - x0) / (x1 - x0)));
        }
    }
    return anchors[anchors.length - 1][1];
}

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

        // --- network quality state ---
        this.connectionStartMs = 0;
        // Seconds in this window with zero inbound bytes (not live if > 0)
        this.silentSeconds = 0;
        // Running streak of consecutive silent seconds (spans window boundaries)
        this.currentSilenceStreak = 0;
        this.longestSilenceSeconds = 0;
        // Outgoing backpressure observed this window
        this.maxBufferedBytes = 0;
        this.bufferedTicks = 0;
        /** @type {?{closeCode: ?number, endedCleanly: boolean}} set once on close */
        this.closeInfo = null;
        /** @type {number[]} recent overall scores, for the trend indicator */
        this.scoreHistory = [];

        // --- throughput probe state ---
        /** @type {?Object} latest probe result; persists until the next probe */
        this.probeResult = null;
        this.probeRunning = false;
        /** @type {?ReturnType<setTimeout>} */
        this.probeTimeout = null;
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

        // --- connection end capture -----------------------------------------
        // A clean close is code 1000/1001; anything else (especially 1006, closed
        // without a close frame) means the connection was cut, e.g. by a proxy
        this._listen('close', (event) => {
            if (this.closeInfo) {
                return;
            }
            const code = (event && typeof event.code === 'number') ? event.code : null;
            this.closeInfo = {
                closeCode: code,
                endedCleanly: code === 1000 || code === 1001,
            };
            this._report(); // push a final report for this connection immediately
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        });

        this.connectionStartMs = Date.now();

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
        this.connectionStartMs = 0;
        this.silentSeconds = 0;
        this.currentSilenceStreak = 0;
        this.longestSilenceSeconds = 0;
        this.maxBufferedBytes = 0;
        this.bufferedTicks = 0;
        this.closeInfo = null;
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
     * Runs a one-shot throughput probe measuring the maximum sustained data rate in
     * both directions. The result is stored in every report's data.probe until the
     * next probe replaces it. No-op while a probe is already running.
     * @param {number} [sizeBytes] - Payload size per direction (default 256 KB)
     */
    startProbe(sizeBytes) {
        if (!this.active || this.probeRunning) {
            return;
        }
        const size = (typeof sizeBytes === 'number' && sizeBytes > 0)
            ? Math.floor(sizeBytes) : DEFAULT_PROBE_SIZE_BYTES;
        if (!this.toolsocket.connected) {
            this.probeResult = {
                status: 'failed',
                reason: 'not-connected',
                timestamp: Date.now(),
                sizeBytes: size,
                rttMsAtProbe: null,
                downstreamBytesPerSecond: null,
                upstreamBytesPerSecond: null,
            };
            return;
        }

        this.probeRunning = true;
        const rttMs = this.lastNetworkLatencyMs || 0;
        this.probeResult = {
            status: 'running',
            timestamp: Date.now(),
            sizeBytes: size,
            rttMsAtProbe: rttMs,
            downstreamBytesPerSecond: null,
            upstreamBytesPerSecond: null,
        };
        // bytes / (elapsed minus the RTT baseline) = transfer rate of the payload
        const toRate = (bytes, elapsedMs) =>
            Math.round(bytes / Math.max(elapsedMs - rttMs, 0.5) * 1000);

        this.probeTimeout = setTimeout(() => {
            if (!this.probeRunning) {
                return;
            }
            this.probeRunning = false;
            this.probeResult.status = 'failed';
            this.probeResult.reason = 'timeout-or-unsupported-client';
            this.probeResult.timestamp = Date.now();
        }, PROBE_TIMEOUT_MS);
        if (this.probeTimeout.unref) {
            this.probeTimeout.unref();
        }

        // Phase 1 — downstream: send a large incompressible payload, get a tiny ack
        const downStart = now();
        this.toolsocket.meta('probe/down', null, () => {
            if (!this.probeRunning) {
                return; // timed out in the meantime
            }
            this.probeResult.downstreamBytesPerSecond = toRate(size, now() - downStart);

            // Phase 2 — upstream: ask the client for the same amount back
            const upStart = now();
            this.toolsocket.meta('probe/up', size, (_body, binaryData) => {
                if (!this.probeRunning) {
                    return;
                }
                const received = (binaryData && binaryData.byteLength) || size;
                this.probeResult.upstreamBytesPerSecond = toRate(received, now() - upStart);
                this.probeResult.status = 'ok';
                this.probeResult.timestamp = Date.now();
                this.probeRunning = false;
                clearTimeout(this.probeTimeout);
                this.probeTimeout = null;
            });
        }, makeProbePayload(size));
    }

    /**
     * 1 Hz: rolls the current second's counters into the window and tracks the peak.
     * Every BUCKETS_PER_REPORT ticks, pushes a report.
     */
    _tick() {
        const {deltaRead, deltaWritten, rebaselined} = this._sampleSocketCounters();
        const secondTotal = deltaRead + deltaWritten;
        if (secondTotal > this.peakBytesPerSecond) {
            this.peakBytesPerSecond = secondTotal;
        }
        this.windowBytesSent += deltaWritten;
        this.windowBytesReceived += deltaRead;

        // Flow probing: our own 1 Hz protocol ping guarantees inbound bytes every
        // second on a healthy realtime link, so a silent second means "not live"
        if (!rebaselined && !this.closeInfo) {
            if (deltaRead === 0) {
                this.silentSeconds++;
                this.currentSilenceStreak++;
                if (this.currentSilenceStreak > this.longestSilenceSeconds) {
                    this.longestSilenceSeconds = this.currentSilenceStreak;
                }
            } else {
                this.currentSilenceStreak = 0;
            }
        }

        // Outgoing backpressure: bytes stuck in the local send buffer because the
        // network path is not draining them
        const websocket = this.toolsocket.socket;
        const buffered = (websocket && typeof websocket.bufferedAmount === 'number')
            ? websocket.bufferedAmount : 0;
        if (buffered > 0) {
            this.bufferedTicks++;
            if (buffered > this.maxBufferedBytes) {
                this.maxBufferedBytes = buffered;
            }
        }

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

        const networkQuality = this._deriveNetworkQuality(networkLatency, appLatency);

        // Reset the collection window
        this.networkLatencySamples = [];
        this.appLatencySamples = [];
        this.windowBytesSent = 0;
        this.windowBytesReceived = 0;
        this.peakBytesPerSecond = 0;
        this.silentSeconds = 0;
        this.longestSilenceSeconds = 0;
        this.maxBufferedBytes = 0;
        this.bufferedTicks = 0;
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
                networkQuality: networkQuality,
                probe: this.probeResult,
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
            return {deltaRead: 0, deltaWritten: 0, rebaselined: true};
        }
        if (raw !== this.countedSocket) {
            // First sample, or the socket was replaced: establish a new baseline
            this.countedSocket = raw;
            this.lastBytesRead = raw.bytesRead;
            this.lastBytesWritten = raw.bytesWritten;
            return {deltaRead: 0, deltaWritten: 0, rebaselined: true};
        }
        const deltaRead = raw.bytesRead - this.lastBytesRead;
        const deltaWritten = raw.bytesWritten - this.lastBytesWritten;
        this.lastBytesRead = raw.bytesRead;
        this.lastBytesWritten = raw.bytesWritten;
        return {deltaRead, deltaWritten, rebaselined: false};
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
     * Turns this window's low-level signals into a plain-language quality summary
     * that a non-expert can act on. See the module comment for the reasoning.
     * @param {?Object} networkLatency - this window's protocol ping stats
     * @param {?Object} appLatency - this window's ToolSocket ping stats
     * @returns {Object}
     */
    _deriveNetworkQuality(networkLatency, appLatency) {
        const issues = [];
        const measuredSeconds = Math.max(this.tickCount, 1);

        // --- continuity: the realtime dimension. Our own 1 Hz protocol ping
        // guarantees inbound bytes every second on a live path, so continuity is
        // simply the fraction of measured seconds that actually carried data.
        const liveSeconds = Math.max(measuredSeconds - this.silentSeconds, 0);
        const continuity = Math.round(100 * liveSeconds / measuredSeconds);

        let flow = 'realtime';
        if (this.closeInfo) {
            flow = 'ended';
        } else if (this.longestSilenceSeconds >= 3) {
            flow = 'stalled';
            issues.push('incoming-data-stalled');
        } else if (this.silentSeconds >= 1) {
            flow = 'buffered';
            issues.push('data-arriving-in-bursts-not-realtime');
        }

        // --- latency and stability, from this window's protocol ping round trips
        let jitterMs = null;
        let latencyScore = null;
        let stabilityScore = null;
        if (networkLatency) {
            jitterMs = Math.round((networkLatency.maxMs - networkLatency.minMs) * 10) / 10;
            latencyScore = interpolateScore(LATENCY_SCORE_ANCHORS, networkLatency.averageMs);
            stabilityScore = interpolateScore(JITTER_SCORE_ANCHORS, jitterMs);
            if (networkLatency.averageMs > 150) {
                issues.push('high-latency');
            }
            if (jitterMs > 100 || (jitterMs > 20 && jitterMs > networkLatency.averageMs * 2)) {
                issues.push('latency-unstable');
            }
        }

        // --- delivery: is our outbound data draining, or queuing locally?
        // Score from the worst queue depth seen, reduced further the more of the
        // window the queue existed for (persistent backpressure is worse than a blip)
        const persistencePenalty = Math.round(30 * this.bufferedTicks / measuredSeconds);
        const delivery = Math.max(0,
            interpolateScore(BUFFERED_SCORE_ANCHORS, this.maxBufferedBytes) - persistencePenalty);
        if (this.bufferedTicks >= 1 && (this.maxBufferedBytes > 16 * 1024 || this.bufferedTicks >= 3)) {
            issues.push('outgoing-data-queuing-locally');
        }

        // Client pressure: informational, not a network dimension
        if (networkLatency && appLatency
            && appLatency.averageMs - networkLatency.averageMs > 100) {
            issues.push('client-under-pressure');
        }

        // --- overall: 50% the worst dimension + 50% a weighted average, so a single
        // failing dimension drags the overall down the way it drags realtime down
        const weighted = [
            [continuity, 0.4],
            [latencyScore, 0.25],
            [stabilityScore, 0.2],
            [delivery, 0.15],
        ].filter(([value]) => value !== null);
        const weightSum = weighted.reduce((sum, [, weight]) => sum + weight, 0);
        const weightedAverage = weighted.reduce(
            (sum, [value, weight]) => sum + value * weight, 0) / weightSum;
        const worst = Math.min(...weighted.map(([value]) => value));
        let score = Math.round(0.5 * worst + 0.5 * weightedAverage);

        if (this.closeInfo && !this.closeInfo.endedCleanly) {
            // Cut without a close handshake: the signature of proxies and zero-trust
            // gateways killing the socket. Cap the final report's score accordingly.
            score = Math.min(score, 30);
            issues.push('connection-cut-abnormally');
        }
        score = Math.max(0, Math.min(100, score));

        let rating;
        if (score >= 90) {
            rating = 'excellent';
        } else if (score >= 70) {
            rating = 'good';
        } else if (score >= 40) {
            rating = 'degraded';
        } else {
            rating = 'poor';
        }

        // --- trend: compare against the recent scores
        let trend = 'stable';
        if (this.scoreHistory.length > 0) {
            const previousAverage = this.scoreHistory.reduce((a, b) => a + b, 0)
                / this.scoreHistory.length;
            if (score >= previousAverage + TREND_THRESHOLD) {
                trend = 'improving';
            } else if (score <= previousAverage - TREND_THRESHOLD) {
                trend = 'degrading';
            }
        }
        this.scoreHistory.push(score);
        if (this.scoreHistory.length > TREND_HISTORY_LENGTH) {
            this.scoreHistory.shift();
        }

        const quality = {
            score: score,
            rating: rating,
            flow: flow,
            trend: trend,
            scores: {
                continuity: continuity,
                latency: latencyScore,
                stability: stabilityScore,
                delivery: delivery,
            },
            issues: issues,
            details: {
                jitterMs: jitterMs,
                silentSeconds: this.silentSeconds,
                longestSilenceSeconds: this.longestSilenceSeconds,
                maxBufferedBytes: this.maxBufferedBytes,
                connectionAgeSeconds: Math.round((Date.now() - this.connectionStartMs) / 1000),
            },
        };
        if (this.closeInfo) {
            quality.details.closeCode = this.closeInfo.closeCode;
            quality.details.endedCleanly = this.closeInfo.endedCleanly;
        }
        return quality;
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
