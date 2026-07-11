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
 *       networkQuality: { — plain-language interpretation of realtime connection quality
 *         score:  number   — 0 (unusable) to 100 (perfect realtime behavior)
 *         rating: string   — 'excellent' | 'good' | 'degraded' | 'poor'
 *         flow:   string   — 'realtime' (data moves live) | 'buffered' (held by the
 *                            network and pumped in bursts) | 'stalled' (nothing
 *                            arriving) | 'ended' (connection closed; final report)
 *         summary: string  — one plain sentence describing the current situation
 *         issues: [{       — present only when detected; each issue explains itself:
 *           id:              stable identifier, e.g. 'incoming-data-stalled',
 *                            'data-arriving-in-bursts-not-realtime',
 *                            'outgoing-data-queuing-locally', 'high-latency',
 *                            'latency-unstable', 'client-under-pressure',
 *                            'connection-cut-abnormally'
 *           severity:        'critical' | 'warning' | 'info'
 *           whatIsHappening: plain-language description with measured values
 *           likelyCause:     plain-language explanation of the probable cause
 *           tellYourIT:      a ready-to-forward message for the IT department,
 *                            containing the technical vocabulary and measurements
 *                            an expert needs to act (or a note when it is NOT a
 *                            network problem, so IT isn't sent chasing ghosts)
 *         }]
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
        let score = 100;
        const connectionAgeSeconds = Math.round((Date.now() - this.connectionStartMs) / 1000);

        // Flow: is data actually moving in realtime?
        let flow = 'realtime';
        if (this.closeInfo) {
            flow = 'ended';
        } else if (this.longestSilenceSeconds >= 3) {
            flow = 'stalled';
            issues.push({
                id: 'incoming-data-stalled',
                severity: 'critical',
                whatIsHappening: `No data has arrived from the other side for ${this.longestSilenceSeconds} seconds in a row, even though the connection looks open.`,
                likelyCause: 'The connection is probably silently blocked or dropped: a firewall, proxy or VPN cut it off without telling either side.',
                tellYourIT: `Our WebSocket connection stopped receiving any data for ${this.longestSilenceSeconds}s while remaining in the OPEN state. Please check firewalls, proxies and zero-trust gateways on the path for idle timeouts or connection-tracking limits affecting long-lived WebSocket (wss) connections to this server.`,
            });
        } else if (this.silentSeconds >= 1) {
            flow = 'buffered';
            issues.push({
                id: 'data-arriving-in-bursts-not-realtime',
                severity: 'warning',
                whatIsHappening: `Data is not flowing continuously: in ${this.silentSeconds} of the last ${BUCKETS_PER_REPORT} seconds nothing arrived, and then data came in bursts.`,
                likelyCause: 'A device on the network path (proxy, VPN or security gateway) is holding data back and forwarding it in chunks instead of streaming it live.',
                tellYourIT: `WebSocket frames to this server are being buffered on the network path: ${this.silentSeconds} of ${BUCKETS_PER_REPORT} seconds had zero inbound bytes, with traffic arriving in bursts afterwards. This is typical of TLS inspection or content scanning that does not stream WebSocket traffic. Please exempt this host from response buffering / inspection, or enable WebSocket streaming support on the gateway.`,
            });
        }
        score -= Math.min(this.silentSeconds * 15, 45);

        // Latency magnitude and steadiness
        let jitterMs = null;
        if (networkLatency) {
            jitterMs = Math.round((networkLatency.maxMs - networkLatency.minMs) * 10) / 10;
            if (networkLatency.averageMs > 150) {
                score -= (networkLatency.averageMs > 400) ? 25 : 10;
                issues.push({
                    id: 'high-latency',
                    severity: 'warning',
                    whatIsHappening: `Round trips to the other side take ${networkLatency.averageMs}ms on average, which is slow for realtime use.`,
                    likelyCause: 'Traffic may be routed through a distant gateway (common with VPNs and cloud security services), or the network path is overloaded.',
                    tellYourIT: `WebSocket round trip time to this client averages ${networkLatency.averageMs}ms (worst ${networkLatency.maxMs}ms). Please check whether this traffic is routed through a remote VPN or cloud security POP and whether a more direct route (e.g. split tunneling for this host) is possible.`,
                });
            }
            if (jitterMs > 100 || (jitterMs > 20 && jitterMs > networkLatency.averageMs * 2)) {
                score -= (jitterMs > 100) ? 25 : 10;
                issues.push({
                    id: 'latency-unstable',
                    severity: 'warning',
                    whatIsHappening: `Response times are swinging between ${networkLatency.minMs}ms and ${networkLatency.maxMs}ms, which makes realtime interaction feel jerky.`,
                    likelyCause: 'Network congestion, or a device that queues traffic and releases it unevenly.',
                    tellYourIT: `WebSocket round trip jitter is ${jitterMs}ms (RTT ranges ${networkLatency.minMs}-${networkLatency.maxMs}ms within 5 seconds). Please check for congestion, traffic shaping or QoS queuing on the path to this server.`,
                });
            }
        }

        // Outgoing backpressure
        if (this.bufferedTicks >= 1 && (this.maxBufferedBytes > 16 * 1024 || this.bufferedTicks >= 3)) {
            const severe = this.maxBufferedBytes > 1024 * 1024 || this.bufferedTicks >= 3;
            score -= severe ? 30 : 15;
            issues.push({
                id: 'outgoing-data-queuing-locally',
                severity: severe ? 'critical' : 'warning',
                whatIsHappening: `Data we are sending is piling up locally (up to ${Math.round(this.maxBufferedBytes / 1024)} KB waiting) because the network is not accepting it fast enough.`,
                likelyCause: 'The upload path towards the client is too slow or being throttled, or a device in between is not draining the stream.',
                tellYourIT: `Outbound WebSocket data to this client is backing up in the local send buffer (peak ${this.maxBufferedBytes} bytes queued). Please check available bandwidth, rate limiting and traffic shaping between this server and the client.`,
            });
        }

        // Client pressure: informational, does not count against the network score
        if (networkLatency && appLatency
            && appLatency.averageMs - networkLatency.averageMs > 100) {
            const diff = Math.round(appLatency.averageMs - networkLatency.averageMs);
            issues.push({
                id: 'client-under-pressure',
                severity: 'info',
                whatIsHappening: `The client application answers ${diff}ms slower than the network itself, so the client device is busy or overloaded.`,
                likelyCause: 'The client device, app or browser tab is under heavy load. The network itself is fine.',
                tellYourIT: `This one is NOT a network problem: network round trip is ${networkLatency.averageMs}ms but the application-level round trip is ${appLatency.averageMs}ms. The delay is inside the client device or application - check its CPU load or what else it is running.`,
            });
        }

        if (this.closeInfo && !this.closeInfo.endedCleanly) {
            // Being cut without a close handshake is the signature of proxies and
            // zero-trust gateways killing the socket — a serious quality problem
            score -= 40;
            issues.push({
                id: 'connection-cut-abnormally',
                severity: 'critical',
                whatIsHappening: `The connection was terminated without a proper close handshake after ${connectionAgeSeconds} seconds.`,
                likelyCause: 'A proxy, firewall or security gateway most likely killed the connection, typically due to an idle timeout or a maximum connection lifetime.',
                tellYourIT: `The WebSocket to this client closed abnormally (close code ${this.closeInfo.closeCode === null ? '1006/none' : this.closeInfo.closeCode}, no close frame) after ${connectionAgeSeconds}s. If this repeats at similar connection ages, a proxy or zero-trust gateway is enforcing a connection lifetime or idle timeout - please allowlist long-lived wss connections to this server or extend the timeout.`,
            });
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

        // One-sentence summary a non-expert can read out loud
        let summary;
        if (this.closeInfo) {
            summary = this.closeInfo.endedCleanly
                ? 'The connection ended normally.'
                : 'The connection was cut off by the network without warning - see issues for what to tell your IT department.';
        } else if (flow === 'stalled') {
            summary = 'Realtime communication is interrupted: nothing is arriving anymore.';
        } else if (flow === 'buffered') {
            summary = 'Realtime communication is degraded: the network delivers data in bursts instead of live.';
        } else if (issues.length > 0) {
            summary = 'Realtime communication works, but with reduced quality - see issues.';
        } else {
            summary = 'Realtime communication is working normally.';
        }

        const quality = {
            score: score,
            rating: rating,
            flow: flow,
            summary: summary,
            issues: issues,
            details: {
                jitterMs: jitterMs,
                silentSeconds: this.silentSeconds,
                longestSilenceSeconds: this.longestSilenceSeconds,
                maxBufferedBytes: this.maxBufferedBytes,
                connectionAgeSeconds: connectionAgeSeconds,
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
