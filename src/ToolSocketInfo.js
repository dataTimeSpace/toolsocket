/**
 * ToolSocketInfo — live info reporting for a ToolSocket connection.
 *
 * This module is ONLY loaded when IncomingToolSocket.info(true, callback) is called
 * for the first time — the info API is server side only; client sockets do not expose
 * it. While info mode is off, none of this code is loaded or executed and the
 * ToolSocket hot paths carry zero extra work: observation happens exclusively through
 * ToolSocket's event system, whose triggerEvent() early-returns with no listeners.
 *
 * Reporting model: data is collected continuously while enabled and pushed to the
 * callback every REPORT_INTERVAL_MS (5 seconds) as:
 *   {
 *     type:      'info'
 *     timestamp: number  — Date.now() at the moment the report is pushed
 *     data: {
 *       latency: {
 *         currentMs: number  — round trip time of the most recent ping/pong
 *         averageMs: number  — average over samples since the last report
 *         minMs:     number  — fastest sample since the last report
 *         maxMs:     number  — slowest sample since the last report
 *         samples:   number  — how many pings were measured since the last report
 *       } | null             — null if no ping completed since the last report
 *     }
 *   }
 *
 * How latency is measured: ToolSocket's built-in keepalive sends a 'ping' message
 * (route 'action/ping') every ~5s with a response callback, which assigns it a message
 * id. We listen to the 'send' event to record the send time of each ping id, and to
 * the 'res' event to match the incoming response id back to it. The difference is the
 * application-level round trip time between the server and that connected client, as
 * measured on the server-side IncomingToolSocket, which runs its own keepalive loop.
 */

const REPORT_INTERVAL_MS = 5000;
// Drop pending pings that never got a response (e.g. connection dropped mid-flight)
const PENDING_PING_TIMEOUT_MS = 30000;

const now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

class ToolSocketInfo {
    /**
     * @param {Object} toolsocket - The ToolSocket instance to observe
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
        this.reportInterval = null;

        /** @type {Object<string, number>} ping message id -> send time */
        this.pendingPings = {};
        /** @type {number[]} completed round trip times since the last report */
        this.latencySamples = [];
        /** @type {?number} most recent completed round trip time */
        this.lastLatencyMs = null;
    }

    /**
     * Sets (or replaces) the callback that receives info reports
     * @param {?function} callback
     */
    setCallback(callback) {
        this.callback = typeof callback === 'function' ? callback : null;
    }

    /**
     * Attaches listeners and starts the 5 second reporting cycle. Idempotent.
     */
    start() {
        if (this.active) {
            return;
        }
        this.active = true;

        // --- latency collection ------------------------------------------
        // Record the send time of every outgoing ping that expects a response
        this._listen('send', (messageBundle) => {
            const message = messageBundle && messageBundle.message;
            if (message && message.method === 'ping' && message.id) {
                this.pendingPings[message.id] = now();
            }
        });
        // Match incoming responses back to their ping by message id
        this._listen('res', (_route, _body, _response, _binaryData, messageBundle) => {
            const message = messageBundle && messageBundle.message;
            if (!message || !message.id) {
                return;
            }
            const sentAt = this.pendingPings[message.id];
            if (sentAt === undefined) {
                return;
            }
            delete this.pendingPings[message.id];
            const roundTripMs = Math.round((now() - sentAt) * 10) / 10;
            this.lastLatencyMs = roundTripMs;
            this.latencySamples.push(roundTripMs);
        });

        // --- reporting cycle ---------------------------------------------
        this.reportInterval = setInterval(() => this._report(), REPORT_INTERVAL_MS);
        // Don't let the report interval keep a Node.js process alive on its own
        if (this.reportInterval.unref) {
            this.reportInterval.unref();
        }
    }

    /**
     * Detaches every listener, stops the reporting cycle, and clears all
     * collected state. After stop(), this instance holds no hooks into the ToolSocket.
     */
    stop() {
        if (!this.active) {
            return;
        }
        clearInterval(this.reportInterval);
        this.reportInterval = null;
        for (const [eventType, handler] of Object.entries(this.listeners)) {
            this.toolsocket.removeEventListener(eventType, handler);
        }
        this.listeners = {};
        this.pendingPings = {};
        this.latencySamples = [];
        this.lastLatencyMs = null;
        this.callback = null;
        this.active = false;
    }

    /**
     * Assembles and pushes one info report, then resets the collection window
     */
    _report() {
        this._prunePendingPings();

        let latency = null;
        if (this.latencySamples.length > 0) {
            const sum = this.latencySamples.reduce((a, b) => a + b, 0);
            latency = {
                currentMs: this.lastLatencyMs,
                averageMs: Math.round((sum / this.latencySamples.length) * 10) / 10,
                minMs: Math.min(...this.latencySamples),
                maxMs: Math.max(...this.latencySamples),
                samples: this.latencySamples.length,
            };
        }
        this.latencySamples = [];

        if (!this.callback) {
            return;
        }
        this.callback({
            type: 'info',
            timestamp: Date.now(),
            data: {
                latency: latency,
            },
        });
    }

    /**
     * Drops pending ping entries that never received a response
     */
    _prunePendingPings() {
        const cutoff = now() - PENDING_PING_TIMEOUT_MS;
        for (const [id, sentAt] of Object.entries(this.pendingPings)) {
            if (sentAt < cutoff) {
                delete this.pendingPings[id];
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

    /**
     * Delivers an info update to the callback, if one is set
     * @param {string} type
     * @param {Object} data
     */
    _emit(type, data) {
        if (!this.callback) {
            return;
        }
        this.callback({
            type: type,
            timestamp: Date.now(),
            data: data,
        });
    }
}

module.exports = ToolSocketInfo;
