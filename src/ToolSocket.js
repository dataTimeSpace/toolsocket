const BinaryBuffer = require('./BinaryBuffer.js');
const ToolSocketMessage = require('./ToolSocketMessage.js');
const ToolSocketResponse = require('./ToolSocketResponse.js');
const MessageBundle = require('./MessageBundle.js');

const SessionStream = require('./SessionStream.js');

const { generateUniqueId, addSearchParams, isBrowser, WebSocketWrapper, makeProbePayload } = require('./utilities.js');
const { VALID_METHODS, MAX_MESSAGE_SIZE } = require('./constants.js');
const { URL_SCHEMA, MESSAGE_BUNDLE_SCHEMA } = require('./schemas.js');

// Liveness watchdog deadline: ~3 missed 5s pings; below the proxy's 20s reaper. For a
// session-capable peer the SessionStream's ack-age detector fires long before this; the
// watchdog remains the backstop and the whole story for legacy peers.
const LIVENESS_DEADLINE_MS = 16000;

/**
 * A WebSocket-based connection library that allows for file-sending, response callbacks,
 * and automatic re-connection
 */
class ToolSocket {
    /**
     * Creates a ToolSocket
     * @param {?URL} [url] - The URL to connect to
     * @param {?string} [networkId] - The network ID
     * @param {?string} [origin] - The origin
     * @param {?Object} [wsOptions] - Additional options passed to the WebSocket constructor.
     * @param {?Object} [wsOptions.headers] - Optional headers to include during the WebSocket handshake (e.g., Authorization).
     */
    constructor(url, networkId, origin, wsOptions = {}) {
        this.url = null;
        this.networkId = null;
        this.origin = null;

        this.eventCallbacks = {}; // For events
        this.responseCallbacks = {}; // For handling direct responses to sent messages

        // Client-side remote info subscription state (see info())
        /** @type {?function} */
        this.remoteInfoCallback = null;
        this.remoteInfoSubscribed = false;
        this.remoteInfoReattachArmed = false;
        /** @type {?BinaryBuffer} */
        this.binaryBuffer = null;

        /**
         * @typedef {object} QueuedMessage
         * @property {MessageBundle} messageBundle
         * @property {function} callback
         */

        /** @type [QueuedMessage] */
        this.queuedMessages = []; // For messages sent while not connected

        this.socket = null;
        /** the raw socket currently attached: {ws, handlers, pingInterval, livenessListener} */
        this._binding = null;

        // Reliable session layer (see SessionStream.js). `session` in wsOptions configures it;
        // it is not a WebSocket option, so it is split off before the rest reaches ws.
        const { session: sessionOptions, ...socketOptions } = wsOptions || {};
        this.__ssn = new SessionStream({
            sendControl: (route, body) => this._sendControl(route, body),
            onStall: (reason) => this._onSessionStall(reason)
        }, sessionOptions);
        /** in-progress transport migration on a client socket, or null */
        this._migration = null;

        if (url) {
            // store extra options so we can reuse them on reconnect
            this.wsOptions = socketOptions;
            this.connect(url, networkId, origin);
        } else if (isBrowser) {
            url = new URL(window.location.href);
            url.protocol = url.protocol.replace('http', 'ws');
            url.hash = '';
            this.connect(url, networkId, origin);
        }

        this.configureDefaultRoutes();
        this.configureAliases();
    }

    get network() {
        return this.networkId;
    }

    /**
     * The session is open while its transport is being replaced underneath (client-side
     * migration) or while the server waits for a successor (grace): the application sees
     * one continuously open socket.
     * @return {boolean}
     */
    _sessionOpen() {
        return this._migration !== null || this.__ssn.inGrace();
    }

    /** Raw transport state, regardless of the session. */
    _rawOpen() {
        return !!this.socket && this.socket.readyState === WebSocketWrapper.OPEN;
    }

    /**
     * Whether sequenced traffic may be written right now. False during a migration even
     * once the successor is open: nothing may go out ahead of the session handshake and the
     * resend of retained frames, or it would arrive out of sequence.
     * @return {boolean}
     */
    _transportOpen() {
        return this._migration === null && this._rawOpen();
    }

    get readyState() {
        if (this._sessionOpen()) {
            return WebSocketWrapper.OPEN;
        }
        if (!this.socket) {
            return WebSocketWrapper.CLOSED;
        }
        return this.socket.readyState;
    }

    get connected() {
        return this._sessionOpen() || this._rawOpen();
    }

    /**
     * Connects the WebSocket
     * @param {?URL} url - The URL to connect to
     * @param {?string} [networkId] - The network ID
     * @param {?string} [origin] - The origin
     */
    connect(url, networkId, origin) {
        if (this.socket) {
            this._unbindSocket({ terminate: false });
        }

        if (!networkId) {
            const urlData = URL_SCHEMA.parseUrl(url);
            if (urlData) {
                this.networkId = urlData.n || 'io'; // Unclear what the purpose of this default is
            } else {
                this.networkId = 'io'; // Unclear what the purpose of this default is
            }
        } else {
            this.networkId = networkId;
        }
        this.origin = origin ? origin : (isBrowser ? 'web' : 'server'); // Unclear what the purpose of this default is

        const searchParams = new URLSearchParams({networkID: this.networkId});
        this.url = addSearchParams(url, searchParams);

        // A fresh connection is a fresh session: numbering restarts and the peer's capability
        // is negotiated again. (A migration keeps the session — see _migrate().)
        this._resetSession();
        this._dial(false);
    }

    /**
     * Opens the raw WebSocket. A migration names the live session in the URL so the server
     * can re-bind it at upgrade time, before any instance is created or event fired:
     * tsm=<session id>.<generation>.<highest sequence this end delivered>.
     * @param {boolean} migrating
     */
    _dial(migrating) {
        let target = this.url;
        if (migrating) {
            const ssn = this.__ssn;
            target = new URL(String(this.url));
            target.searchParams.set('tsm', `${ssn.id}.${ssn.gen}.${ssn.rx.lastDelivered}`);
        }
        this.socket = new WebSocketWrapper(target, [], {
            maxPayload: MAX_MESSAGE_SIZE,
            ...this.wsOptions
        });
        // a successor must not ping (a sequenced frame) before the session is re-established
        this.configureSocket({ deferPing: migrating });
    }

    _resetSession() {
        const options = this.__ssn ? this.__ssn.opts : undefined;
        if (this.__ssn) {
            this.__ssn.dispose();
        }
        this.__ssn = new SessionStream({
            sendControl: (route, body) => this._sendControl(route, body),
            onStall: (reason) => this._onSessionStall(reason)
        }, options);
        this._migration = null;
    }

    /**
     * Adds an event listener to internal events
     * @param {string} eventType - The event type to listen to
     * @param {function} callback - The function to call when the event occurs
     */
    addEventListener(eventType, callback) {
        if (!this.eventCallbacks[eventType]) {
            this.eventCallbacks[eventType] = [];
        }
        this.eventCallbacks[eventType].push(callback);
    }

    /**
     * Triggers event listeners for a given event
     * @param {string} eventType - The event type to trigger
     * @param {...any} args - The arguments to pass to the event listeners
     */
    triggerEvent(eventType, ...args) {
        if (!this.eventCallbacks[eventType]) {
            return;
        }
        this.eventCallbacks[eventType].forEach(callback => callback(...args));
    }

    /**
     * Removes a previously added event listener
     * @param {string} eventType - The event type the listener was added for
     * @param {function} callback - The exact callback that was passed to addEventListener
     */
    removeEventListener(eventType, callback) {
        if (!this.eventCallbacks[eventType]) {
            return;
        }
        this.eventCallbacks[eventType] = this.eventCallbacks[eventType].filter(cb => cb !== callback);
        if (this.eventCallbacks[eventType].length === 0) {
            // Restore the "no listeners" fast path in triggerEvent
            delete this.eventCallbacks[eventType];
        }
    }

    /**
     * Clears all event listeners
     */
    removeAllListeners() {
        this.eventCallbacks = [];
    }

    /**
     * Closes the WebSocket connection. A close through this API ends the session on both
     * ends: the peer is told so in-band (__ts/bye) before the close frame goes out, so it
     * surfaces the close at once instead of holding the session for a successor. This is the
     * ONLY way a session ends deliberately — a close frame that merely shows up on the wire
     * is treated as a transport loss (see _onTransportClosed).
     */
    close() {
        this.__ssn.userClosed = true;
        this.__ssn.clearGrace();
        if (this._migration) {
            this._cancelMigrationTimers();
            this._migration = null;
        }
        if (this.__ssn.peer === true) {
            this._sendControl('__ts/bye', {});
        }
        this.socket.close();
    }

    // ======================================================================================
    // Session layer plumbing (see SessionStream.js for the model). Everything below is
    // internal: the public API and events are exactly those of a single, always-open socket.
    // ======================================================================================

    /**
     * Writes one frame to the wire under its sequence number and retains it until the peer
     * acknowledges it. This is the ONLY place frames are written, for the plain path and
     * the NB scheduler alike, so the retained window is complete.
     * @param {string|Uint8Array} frame - serialized frame (its envelope already carries `q`)
     * @param {?number} seq - the sequence stamped into that envelope, or null if unsequenced
     * @param {?function} [callback] - Node ws send-completion callback (NB pacing)
     */
    _writeFrame(frame, seq, callback) {
        if (callback) {
            this.socket.send(frame, callback);
        } else {
            this.socket.send(frame);
        }
        this.__ssn.retain(frame, seq);
    }

    /**
     * Writes an unsequenced, unretained control frame straight to the transport (session
     * handshake, watermark acks). Bypasses queueing and the NB scheduler: these must never
     * wait behind bulk traffic, and must never be resent.
     * @param {string} route
     * @param {Object} body
     */
    _sendControl(route, body) {
        if (!this._rawOpen()) {
            return;
        }
        const message = new ToolSocketMessage(this.origin, this.networkId, 'meta', route, body);
        try {
            this.socket.send(JSON.stringify(message));
        } catch (_e) { /* dead transport: the close/stall paths take it from here */ }
    }

    /**
     * Resends every retained frame above the peer's watermark, in sequence order, on the
     * current transport. Frames keep the sequence they were stamped with.
     * @param {number} w - highest sequence the peer reports having delivered
     */
    _resendRetained(w) {
        for (const frame of this.__ssn.retainedAbove(w)) {
            try {
                this.socket.send(frame);
            } catch (_e) { /* transport died again: its close handler retries */ }
        }
    }

    /**
     * Stops the ping interval and liveness listener of the current raw socket. Must run as
     * soon as that transport is closed: a watchdog left running on a dead transport would
     * fire 16s later and surface a second close (or re-arm a server's grace forever).
     */
    _stopWatchdog() {
        const binding = this._binding;
        if (!binding) {
            return;
        }
        if (binding.pingInterval) {
            clearInterval(binding.pingInterval);
            binding.pingInterval = null;
        }
        if (binding.livenessListener) {
            try {
                binding.ws.removeEventListener('message', binding.livenessListener);
            } catch (_e) { /* already gone */ }
            binding.livenessListener = null;
        }
    }

    /**
     * Detaches this instance from its current raw socket: listeners off, watchdog off, and
     * the socket dropped (terminate() where available — a graceful close handshake hangs
     * on an unresponsive peer). Events from that socket are ignored from here on.
     * @param {{terminate: boolean}} [options]
     */
    _unbindSocket({ terminate = true } = {}) {
        const binding = this._binding;
        const ws = binding ? binding.ws : this.socket;
        this._binding = null;
        if (binding) {
            for (const type of Object.keys(binding.handlers)) {
                try {
                    ws.removeEventListener(type, binding.handlers[type]);
                } catch (_e) { /* already gone */ }
            }
            if (binding.livenessListener) {
                try {
                    ws.removeEventListener('message', binding.livenessListener);
                } catch (_e) { /* already gone */ }
            }
            if (binding.pingInterval) {
                clearInterval(binding.pingInterval);
            }
        }
        if (ws) {
            try {
                if (terminate && ws.terminate) {
                    ws.terminate();
                } else {
                    ws.close();
                }
            } catch (_e) { /* already closed */ }
        }
        if (this.socket === ws) {
            this.socket = null;
        }
    }

    /**
     * The raw socket reported open.
     * @param {Event} event
     */
    _onTransportOpen(event) {
        if (this._migration) {
            // successor transport for a live session: the URL named the session, the server
            // answers with __ts/session-ack once it re-bound (or reset) it — wait for that
            this._migration.opened = true;
            return;
        }
        // Fresh session: announce it before anything else goes out, so the peer can re-bind
        // it later. A legacy peer ignores the unknown meta route and never answers.
        if (this.__ssn.active() && !this.__ssn.serverSide) {
            this._sendControl('__ts/session', { id: this.__ssn.id, g: this.__ssn.gen, w: this.__ssn.rx.lastDelivered });
            this.__ssn.armPeerTimeout();
        }
        this._surfaceOpen(event);
    }

    _surfaceOpen(event) {
        this.triggerEvent('open', event);
        this.triggerEvent('connect', event);
        this.triggerEvent('connected', event);
        this.triggerEvent('status', this.readyState);
        this.sendQueuedMessages();
    }

    /**
     * The raw socket reported closed. For a session-capable peer this is NOT the end of the
     * session: a client moves it to a fresh transport, a server keeps it for a successor.
     * @param {Event} event
     */
    _onTransportClosed(event) {
        const ssn = this.__ssn;
        this._stopWatchdog(); // this transport is gone; nothing may fire on its behalf later
        if (this._migration) {
            // the successor died before the session was re-established: try again (bounded)
            this._retryMigration('transport-closed');
            return;
        }
        // Deliberate only if the peer said so in-band (__ts/bye from its toolsocket close()).
        // The close frame itself — clean code or not — is NOT trusted: middleboxes close flows
        // on a peer's behalf, and that is precisely the loss to migrate from (client) or to
        // hold the session open for a successor through (server).
        const intentional = ssn.peerClosed === true;
        if (!ssn.userClosed && ssn.peer === true && !intentional) {
            if (this.url) {
                this._migrate('transport-closed');
                return;
            }
            if (ssn.serverSide) {
                this._enterGrace(event);
                return;
            }
        }
        this._surfaceClose(event);
    }

    _surfaceClose(event) {
        this._stopWatchdog();
        this.__ssn.releaseRetained();
        this.__ssn.clearGrace();
        this.triggerEvent('close', event);
        this.triggerEvent('disconnect', event);
        this.triggerEvent('status', this.readyState);
        // internal, after the application's listeners: server-side bookkeeping. A direct
        // hook rather than an event: an application may wipe a socket's listeners
        // (removeAllListeners — the cloud proxy does it to a superseded edge socket) and the
        // server must still forget the session when its grace runs out.
        if (this.server && this.server._onSessionClosed) {
            this.server._onSessionClosed(this);
        }
        this.triggerEvent('__ts:closed', event);
    }

    /**
     * Server side: the transport is gone but the session lives on for graceMs. If the
     * client's successor arrives in time the application never hears about it.
     * @param {Event} event
     */
    _enterGrace(event) {
        const ssn = this.__ssn;
        ssn.suspendStallTimer();
        ssn.armGrace(() => {
            // no successor came: a genuine departure, surfaced exactly as before
            this._surfaceClose(event);
        });
    }

    /**
     * Server side: bind this live session to the successor transport a client dialed.
     * Handshake first, then the retained frames the client is missing, then whatever was
     * queued meanwhile — all before the first new sequenced frame (the ping) may go out.
     * @param {WebSocket} ws - the already-open successor
     * @param {number} peerW - highest sequence the client reports having delivered
     */
    _adoptSocket(ws, peerW) {
        const ssn = this.__ssn;
        ssn.clearGrace();
        if (this.socket) {
            this._unbindSocket({ terminate: true });
        }
        this.socket = ws;
        this.configureSocket({ deferPing: true });
        ssn.onAck(peerW);
        this._sendControl('__ts/session-ack', { w: ssn.rx.lastDelivered });
        this._resendRetained(peerW);
        ssn.resumeStallTimer();
        this.sendQueuedMessages();
        this.setupPingInterval();
        this.triggerEvent('__ts:migrated', { gen: ssn.gen });
    }

    /**
     * Client side: move the live session to a fresh transport. The application is not
     * told; the socket simply keeps working.
     * @param {string} reason
     */
    _migrate(reason) {
        const ssn = this.__ssn;
        if (this._migration || ssn.userClosed || ssn.peer !== true || !this.url) {
            return;
        }
        ssn.gen++;
        ssn.suspendStallTimer();
        this._migration = { reason, startedAt: Date.now(), attempts: 0, retryTimer: null, ackTimer: null, opened: false };
        this._unbindSocket({ terminate: true });
        this.triggerEvent('__ts:migrating', { reason, gen: ssn.gen });
        this._dialSuccessor();
    }

    _dialSuccessor() {
        const m = this._migration;
        if (!m) {
            return;
        }
        m.attempts++;
        m.opened = false;
        try {
            this._dial(true);
        } catch (_e) {
            this._retryMigration('dial-failed');
            return;
        }
        m.ackTimer = setTimeout(() => {
            m.ackTimer = null;
            this._retryMigration('ack-timeout');
        }, this.__ssn.opts.migrateAckMs);
        if (m.ackTimer.unref) {
            m.ackTimer.unref();
        }
    }

    _cancelMigrationTimers() {
        const m = this._migration;
        if (!m) {
            return;
        }
        if (m.ackTimer) {
            clearTimeout(m.ackTimer);
            m.ackTimer = null;
        }
        if (m.retryTimer) {
            clearTimeout(m.retryTimer);
            m.retryTimer = null;
        }
    }

    _retryMigration(why) {
        const m = this._migration;
        if (!m) {
            return;
        }
        this._cancelMigrationTimers();
        this._unbindSocket({ terminate: true });
        if (why === 'transport-closed' && !m.opened) {
            // refused before it even opened: the server is most likely down, not the path.
            // A few of those in a row and the ordinary reconnect path (with its own backoff)
            // takes over instead of burning the whole migration budget.
            m.refusals = (m.refusals || 0) + 1;
            if (m.refusals >= 3) {
                this._abandonMigration('refused');
                return;
            }
        }
        if (this.__ssn.userClosed || Date.now() - m.startedAt >= this.__ssn.opts.migrateMaxMs) {
            this._abandonMigration(why);
            return;
        }
        const delay = Math.min(this.__ssn.opts.migrateRetryMs * Math.pow(2, m.attempts - 1), 4000);
        m.retryTimer = setTimeout(() => {
            m.retryTimer = null;
            this._dialSuccessor();
        }, delay);
        if (m.retryTimer.unref) {
            m.retryTimer.unref();
        }
    }

    /**
     * The session could not be carried over. Fall back to the ordinary lifecycle exactly as
     * a lost connection looks today: 'close' now, and the reconnect layers dial a fresh
     * session from there.
     * @param {string} why
     */
    _abandonMigration(why) {
        this._migration = null;
        this.__ssn.peer = 'unknown';
        this.__ssn.releaseRetained();
        this._surfaceClose({ code: 1006, reason: 'session-migration-failed:' + why, wasClean: false });
    }

    _completeMigration(w) {
        const ssn = this.__ssn;
        this._cancelMigrationTimers();
        this._migration = null;
        ssn.markCapable();
        ssn.onAck(w);
        this._resendRetained(w);
        ssn.resumeStallTimer();
        this.sendQueuedMessages();
        this.setupPingInterval();
        this.triggerEvent('__ts:migrated', { gen: ssn.gen });
    }

    /**
     * Server side: a client announced its session on a fresh connection.
     * @param {Object} body - {id, g, w}
     */
    _onSessionHello(body) {
        const ssn = this.__ssn;
        if (!ssn.serverSide || !ssn.opts.enabled || !body || typeof body.id !== 'string' || body.id.length === 0) {
            return;
        }
        ssn.id = body.id.slice(0, 64);
        ssn.gen = typeof body.g === 'number' ? body.g : 0;
        ssn.markCapable();
        if (this.server && this.server._registerSession) {
            this.server._registerSession(this);
        }
        this._sendControl('__ts/session-ack', { w: ssn.rx.lastDelivered });
    }

    /**
     * Client side: the server answered the session handshake — either for a fresh
     * announcement (capability confirmed) or for a successor transport.
     * @param {Object} body - {w, reset?}
     */
    _onSessionAck(body) {
        const ssn = this.__ssn;
        if (ssn.serverSide) {
            return;
        }
        if (!this._migration) {
            ssn.markCapable();
            return;
        }
        if (!body || body.reset) {
            // the server no longer had our session and gave us a fresh one: the application
            // sees what it would see on any reconnect — close, then open — and re-arms itself
            this._cancelMigrationTimers();
            this._migration = null;
            ssn.releaseRetained();
            ssn.tx.seq = 0;
            ssn.tx.acked = 0;
            ssn.rx.lastDelivered = 0;
            ssn.markCapable();
            this._surfaceClose({ code: 1006, reason: 'session-reset', wasClean: false });
            this._surfaceOpen({});
            this.setupPingInterval();
            return;
        }
        this._completeMigration(typeof body.w === 'number' ? body.w : 0);
    }

    /**
     * The SessionStream found the transport dead (unacked frames aging past the deadline).
     * @param {string} reason
     */
    _onSessionStall(reason) {
        const ssn = this.__ssn;
        if (ssn.userClosed || ssn.peer !== true || this._migration) {
            return;
        }
        if (this.url) {
            this._migrate(reason);
            return;
        }
        if (ssn.serverSide) {
            // nothing to dial from here: drop the dead transport so the kernel stops retrying
            // into it, and wait in grace for the client's successor
            this._unbindSocket({ terminate: true });
            this._enterGrace({ code: 1006, reason: 'session-stall:' + reason, wasClean: false });
        }
    }

    /**
     * The liveness watchdog saw no inbound frame for LIVENESS_DEADLINE_MS.
     */
    _onLivenessLost() {
        const ssn = this.__ssn;
        const event = { code: 1006, reason: 'liveness-timeout', wasClean: false };
        if (!ssn.userClosed && ssn.peer === true) {
            if (this.url) {
                this._migrate('liveness');
                return;
            }
            if (ssn.serverSide) {
                this._unbindSocket({ terminate: true });
                this._enterGrace(event);
                return;
            }
        }
        // Legacy peer: exactly the previous behaviour. Drop the zombie (a graceful close
        // handshake would hang on an unresponsive peer) and, on a client, dial afresh.
        this._unbindSocket({ terminate: true });
        this._surfaceClose(event);
        if (this.url) {
            this.connect(this.url, this.networkId, this.origin);
        }
    }

    /**
     * Sets up event listeners for routes that ToolSocket handles itself
     */
    configureDefaultRoutes() {
        // Send pong in response and trigger network update if appropriate
        this.addEventListener('ping', (_route, body, response, _binaryData, messageBundle) => {
            response.send('pong');
            if (!messageBundle) {
                return;
            }
            if (messageBundle.message.network !== 'toolbox' && messageBundle.message.network !== this.networkId) {
                this.triggerEvent('network', messageBundle.message.network, this.networkId, messageBundle.message);
                this.networkId = messageBundle.message.network;
            }
        });

        this.addEventListener('meta', (route, body, response, _binaryData, _messageBundle) => {
            if (route === 'requestParallel') {
                this.triggerEvent('requestParallel', body); // body = id
            } else if (route === 'confirmParallel') {
                this.triggerEvent('confirmParallel', body); // body = id
            } else if (route === 'probe/down') {
                // Throughput probe (see ToolSocketInfo.js): a large payload just
                // arrived; a tiny acknowledgement lets the sender compute the
                // downstream rate. Only runs when a probe is explicitly requested.
                if (response) {
                    response.send('ok');
                }
            } else if (route === 'probe/up') {
                // Throughput probe: the sender asks for `body` bytes of
                // incompressible data to measure the upstream rate
                if (response) {
                    response.send('ok', makeProbePayload(body));
                }
            } else if (route === 'info/report') {
                // A server-info bundle pushed by the other side for a subscription
                // created via the client-side info(true, callback) API
                if (this.remoteInfoCallback) {
                    this.remoteInfoCallback(body);
                }
            } else if (route === 'info/subscribe') {
                // Only meaningful on server-side sockets (this.server is set there)
                if (this.server && this.server.subscribeServerInfo) {
                    this.server.subscribeServerInfo(this);
                }
            } else if (route === 'info/unsubscribe') {
                if (this.server && this.server.unsubscribeServerInfo) {
                    this.server.unsubscribeServerInfo(this);
                }
            } else if (route === 'info/probe') {
                // Client-requested staged throughput probe across all connections;
                // the result is sent back as the response and also appears in the
                // stagedProbe field of subsequent info/report bundles
                if (this.server && this.server.stagedProbe) {
                    this.server.stagedProbe((result) => {
                        if (response) {
                            response.send(result);
                        }
                    }, body || {});
                }
            } else if (route === 'info/name') {
                // The remote end names its own connection (e.g. the avatar or user
                // it represents), sent via the client-side infoName() API. Stored on
                // the socket — not the info handler — so it survives the info
                // enable/disable cycles that come with subscribers joining/leaving.
                const name = (body && typeof body.name === 'string' && body.name.length > 0)
                    ? body.name.slice(0, 256) : null;
                this.announcedInfoName = name;
                if (this.infoHandler && this.infoHandler.setName) {
                    this.infoHandler.setName(name);
                }
            } else if (route === '__ts/session') {
                // session layer handshake (see SessionStream.js); socket-local, never relayed
                this._onSessionHello(body);
            } else if (route === '__ts/session-ack') {
                this._onSessionAck(body);
            } else if (route === '__ts/ack') {
                if (body && typeof body.w === 'number') {
                    this.__ssn.onAck(body.w);
                }
            } else if (route === '__ts/bye') {
                // the peer is closing through its toolsocket API: the coming close is final
                this.__ssn.peerClosed = true;
            } else {
                console.warn(`Received unknown meta route: "${route}"`);
            }
        });

        // We're receiving an event, trigger it
        this.addEventListener('io', (route, body, _responseObject, binaryData) => {
            if (VALID_METHODS.includes(route)) {
                console.warn(`Received IO message with route: "${route}", which cannot be distinguished from the request method with the same name. Please pick a different route.`);
            }
            this.triggerEvent(route, body, binaryData);
        });

        // We're receiving a response to a message we sent earlier, trigger callbacks
        this.addEventListener('res', (_route, _body, _response, _binaryData, messageBundle) => {
            if (!messageBundle) {
                return;
            }
            if (messageBundle.message.id) {
                if (this.responseCallbacks[messageBundle.message.id]) {
                    this.responseCallbacks[messageBundle.message.id](messageBundle.message.body, messageBundle.binaryData);
                    delete this.responseCallbacks[messageBundle.message.id];
                }
            }
        });
    }

    /**
     * Adds event listeners to the WebSocket instance and sets the binaryType to arraybuffer.
     * arraybuffer is used because it is available in both Node.js and the browser.
     * The listeners are bound to THIS raw socket: once the instance has moved on to another
     * transport (migration, adoption, reconnect) a late event from the old one is ignored,
     * so a stale close can never surface as the session's close.
     * @param {{deferPing: boolean}} [options] - deferPing: do not start the ping/watchdog
     *     yet (a successor transport must not write a sequenced frame before the session
     *     handshake and resend; the caller starts it afterwards)
     */
    configureSocket({ deferPing = false } = {}) {
        const ws = this.socket;
        ws.binaryType = 'arraybuffer';
        const isCurrent = () => ws === this.socket;
        const handlers = {
            open: event => {
                if (!isCurrent()) {
                    return;
                }
                this._onTransportOpen(event);
            },
            close: event => {
                if (!isCurrent()) {
                    return;
                }
                this._onTransportClosed(event);
            },
            error: event => {
                if (!isCurrent() || this._migration) {
                    return; // a successor's hiccup is handled by the migration retry
                }
                this.triggerEvent('error', event);
            },
            message: event => {
                if (!isCurrent()) {
                    return;
                }
                this.triggerEvent('rawMessage', event.data);
                if (typeof event.data === 'string') {
                    this.routeMessage(event.data);
                } else {
                    this.routeMessage(new Uint8Array(event.data));
                }
            }
        };
        for (const type of Object.keys(handlers)) {
            ws.addEventListener(type, handlers[type]);
        }
        this._binding = { ws, handlers, pingInterval: null, livenessListener: null };
        if (!deferPing) {
            this.setupPingInterval();
        }
    }

    /**
     * Initiates the ping interval and the liveness watchdog for the current raw socket.
     * Liveness: a silently half-open connection (NAT/firewall idle-drop, cellular<->wifi
     * handoff, a dead TCP that never delivers a FIN) never produces a 'close' — the socket
     * sits in readyState OPEN forever. Any inbound frame (a pong reply alone guarantees
     * traffic every 5s on a healthy link) refreshes the clock; if nothing arrives for
     * LIVENESS_DEADLINE_MS the transport is presumed dead (see _onLivenessLost). Between
     * session-capable peers the SessionStream's ack-age detector normally fires long before
     * this; the watchdog is the backstop, and the whole story for legacy peers.
     */
    setupPingInterval() {
        const ws = this.socket;
        const binding = this._binding;
        if (!ws || !binding || binding.ws !== ws || binding.pingInterval) {
            return;
        }
        let lastInbound = Date.now();
        const liveness = () => {
            lastInbound = Date.now();
        };
        ws.addEventListener('message', liveness);
        binding.livenessListener = liveness;
        const autoPing = () => {
            if (ws !== this.socket) {
                clearInterval(interval); // the instance moved on to another transport
                return;
            }
            if (Date.now() - lastInbound > LIVENESS_DEADLINE_MS) {
                clearInterval(interval);
                this._onLivenessLost();
                return;
            }
            this.ping('action/ping', null, () => {
                this.triggerEvent('pong');
            });
        };
        // 2s was aggressive keepalive traffic (ping+pong per socket every 2s). 5s cuts
        // that ~2.5x; the proxy's ping-deadline reaper is widened to match. The immediate
        // autoPing() below still runs first so cloud-proxy network setup is unaffected.
        const interval = setInterval(autoPing, 5000);
        binding.pingInterval = interval;
        autoPing(); // Must ping before messages get sent so that cloud-proxy can set up network properly
    }

    /**
     * Processes an incoming message
     * @param {string | Uint8Array} message - The message to process
     */
    routeMessage(message) {
        /** @type {MessageBundle} */
        let messageBundle = null;
        let messageLength = 0;
        if (typeof message !== 'string' && this.__ssn.consumeSkippedBinary()) {
            return; // raw frame of a legacy multi-frame transfer that was already delivered once
        }
        if (typeof message === 'string') {
            try {
                messageBundle = MessageBundle.fromString(message);
                messageLength = message.length;
                if (messageBundle.message.frameCount !== null) {
                    if (!this.__ssn.onInbound(messageBundle.message)) {
                        return; // duplicate transfer header: its raw frames are skipped too
                    }
                    // frameCount is the number of binary messages to follow
                    // Set up this.binaryBuffer so that we can receive those messages
                    this.binaryBuffer = new BinaryBuffer(messageBundle.message.frameCount);
                    this.binaryBuffer.mainMessage = messageBundle.message;
                    return;
                }
            } catch (_e) {
                console.warn('failed to process stringified message, dropping', message);
                this.triggerEvent('droppedMessage', message);
                return;
            }
        } else if (this.binaryBuffer) {
            // Part of a sequence of broken up binary messages
            // Append messages one at a time to the buffer until message length is reached
            this.binaryBuffer.push(message);
            if (!this.binaryBuffer.isFull) {
                return;
            }
            // We can now process the full buffer
            try {
                messageBundle = MessageBundle.fromBinaryBuffer(this.binaryBuffer);
                messageLength = message.length;
                this.binaryBuffer = null;
            } catch (_e) {
                console.warn('failed to process full binary buffer, dropping', message);
                this.triggerEvent('droppedMessage', message);
                return;
            }
        } else {
            try {
                // Single binary message, can process immediately
                messageBundle = MessageBundle.fromBinary(message);
                messageLength = message.length;
            } catch (_e) {
                console.warn('failed to process binary message, dropping', message);
                this.triggerEvent('droppedMessage', message);
                return;
            }
        }

        if (!MESSAGE_BUNDLE_SCHEMA.validate(messageBundle.message)) {
            console.warn('message schema validation failed, dropping', messageBundle.message, MESSAGE_BUNDLE_SCHEMA.failedValidator);
            this.triggerEvent('droppedMessage', message);
            return;
        }

        if (messageLength > MAX_MESSAGE_SIZE) {
            console.warn('message too large, dropping', messageBundle.message, messageLength);
            this.triggerEvent('droppedMessage', message);
            return;
        }

        // Session layer: exactly-once, in-order delivery of sequenced frames; the hop-local
        // sequence is consumed here and never reaches the application or a relay.
        if (!this.__ssn.onInbound(messageBundle.message)) {
            return;
        }

        // Trigger appropriate method handler
        if (VALID_METHODS.includes(messageBundle.message.method)) {
            // If the message was sent with an ID, we want to be able to send a response
            const responseObject = messageBundle.message.id ? new ToolSocketResponse(this, messageBundle.message) : null;
            this.triggerEvent(messageBundle.message.method,
                messageBundle.message.route,
                messageBundle.message.body,
                responseObject,
                messageBundle.binaryData,
                messageBundle
            );
        }
    }

    /**
     * Sends messages that were queued up while socket was disconnected
     */
    sendQueuedMessages() {
        this.queuedMessages.forEach(({messageBundle, callback}) => {
            this.send(messageBundle, callback);
        });
        this.queuedMessages = [];
    }

    /**
     * Sends a message bundle, used internally. Do not call this method from outside ToolSocket.
     * If the underlying socket is not yet open, queue the messages to be sent once the connection is open.
     * @param {MessageBundle} messageBundle - The MessageBundle to send
     * @param {?function} callback - An optional callback to handle responses
     */
    send(messageBundle, callback) {
        if (!this._transportOpen()) {
            this.queuedMessages.push({messageBundle, callback});
            return;
        }
        // Note: if too much data is queued to be sent, the connection automatically closes
        // https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/send
        // Should we check for this?
        if (callback) {
            messageBundle.message.id = generateUniqueId(8);
            this.responseCallbacks[messageBundle.message.id] = callback;
        }

        // sequence assigned at write time: the wire order is the sequence order
        const seq = this.__ssn.stamp(messageBundle.message);
        if (messageBundle.binaryData) {
            if (Array.isArray(messageBundle.binaryData)) {
                messageBundle.message.frameCount = messageBundle.binaryData.length;
                const metaSendData = JSON.stringify(messageBundle.message);
                this._writeFrame(metaSendData, seq);
                this.triggerEvent('rawSend', metaSendData);
                messageBundle.binaryData.forEach(entry => {
                    const sendData = entry;
                    this._writeFrame(sendData, seq); // the raw frames ride under the header's sequence
                    this.triggerEvent('rawSend', sendData);
                });
            } else {
                const sendData = messageBundle.toBinary();
                this._writeFrame(sendData, seq);
                this.triggerEvent('rawSend', sendData);
            }
        } else {
            const sendData = JSON.stringify(messageBundle.message);
            this._writeFrame(sendData, seq);
            this.triggerEvent('rawSend', sendData);
        }
        this.triggerEvent('send', messageBundle);
    }

    /**
     * Sends an IO message
     * @param {string} route
     * @param {any} body
     * @param {object} binaryData
     */
    emit(route, body, binaryData) {
        this.io(route, body, null, binaryData);
    }

    /**
     * Sends a message using the given HTTP-like method
     * @param {MethodString} method - The method to use
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    sendMethod(method, route, body, callback, binaryData) {
        if (!binaryData) {
            binaryData = null;
        }
        const message = new ToolSocketMessage(this.origin, this.networkId, method, route, body);
        const messageBundle = new MessageBundle(message, binaryData);
        this.send(messageBundle, callback);
    }

    /**
     * Sends an ACTION message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    action(route, body, callback, binaryData) {
        this.sendMethod('action', route, body, callback, binaryData);
    }

    /**
     * Sends a BEAT message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    beat(route, body, callback, binaryData) {
        this.sendMethod('beat', route, body, callback, binaryData);
    }

    /**
     * Sends a DELETE message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    delete(route, body, callback, binaryData) {
        this.sendMethod('delete', route, body, callback, binaryData);
    }

    /**
     * Sends a GET message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    get(route, body, callback, binaryData) {
        this.sendMethod('get', route, body, callback, binaryData);
    }

    /**
     * Sends an IO message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    io(route, body, callback, binaryData) {
        this.sendMethod('io', route, body, callback, binaryData);
    }

    /**
     * Sends a KEYS message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    keys(route, body, callback, binaryData) {
        this.sendMethod('keys', route, body, callback, binaryData);
    }

    /**
     * Sends a MESSAGE message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    message(route, body, callback, binaryData) {
        this.sendMethod('message', route, body, callback, binaryData);
    }

    /**
     * Sends a NEW message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    new(route, body, callback, binaryData) {
        this.sendMethod('new', route, body, callback, binaryData);
    }

    /**
     * Sends a PATCH message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    patch(route, body, callback, binaryData) {
        this.sendMethod('patch', route, body, callback, binaryData);
    }

    /**
     * Sends a PING message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    ping(route, body, callback, binaryData) {
        this.sendMethod('ping', route, body, callback, binaryData);
    }

    /**
     * Sends a POST message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    post(route, body, callback, binaryData) {
        this.sendMethod('post', route, body, callback, binaryData);
    }

    /**
     * Sends a PUB message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    pub(route, body, callback, binaryData) {
        this.sendMethod('pub', route, body, callback, binaryData);
    }

    /**
     * Sends a PUT message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    put(route, body, callback, binaryData) {
        this.sendMethod('put', route, body, callback, binaryData);
    }

    /**
     * Sends a RES message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    res(route, body, callback, binaryData) {
        this.sendMethod('res', route, body, callback, binaryData);
    }

    /**
     * Sends a SUB message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    sub(route, body, callback, binaryData) {
        this.sendMethod('sub', route, body, callback, binaryData);
    }

    /**
     * Sends an UNSUB message
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    unsub(route, body, callback, binaryData) {
        this.sendMethod('unsub', route, body, callback, binaryData);
    }

    /**
     * Sends a META message, used for ToolSocket internal messages (i.e. requestParallel)
     * @param {string} route - The route
     * @param {any} body - The message body
     * @param {function} [callback] - A callback function that is called if a response is required
     * @param {object} [binaryData] - Binary data
     */
    meta(route, body, callback, binaryData) {
        this.sendMethod('meta', route, body, callback, binaryData);
    }

    /**
     * Client-side info API: asks the connected server to stream its info reports for
     * ALL of its connections to this client via the given callback, every 5 seconds,
     * until info(false) is called or this connection closes. Rides on ToolSocket's
     * meta transport (routes info/subscribe, info/unsubscribe, info/report,
     * info/probe, info/name) — the server only responds if it supports the info API. The
     * subscription automatically re-arms after a reconnect. Note: there is no
     * built-in authorization; gate access at the application level if needed.
     * (On server-side IncomingToolSockets this method is overridden by the local
     * per-connection info API.)
     * @param {boolean} [enabled=false] - Start (true) or stop (false) the stream
     * @param {?function} [infoCallback] - Receives {type: 'serverInfo', timestamp,
     *     connections, reports: [per-connection info report objects], recentlyClosed:
     *     [final reports of recently closed connections], stagedProbe}. Omit
     *     (undefined) to keep the current callback.
     * @param {?Object} [options]
     * @param {boolean} [options.probe] - Ask the server to run a staged throughput
     *     probe across its connections (results appear in stagedProbe and in each
     *     probed connection's data.probe)
     * @param {number} [options.probeSizeBytes] - Payload per direction per probe
     * @param {string[]} [options.probeNames] - Probe only the connections carrying
     *     one of these names (assigned via infoName()); omit to probe all
     * @param {string[]} [options.probeIds] - Probe only the connections with one of
     *     these ids (data.id in the server's info reports); addresses any
     *     connection, named or not
     * @param {boolean} [options.probeRamp] - Pass false to skip the growing 2, 4,
     *     8... intermediate stages: the probe then measures each connection alone
     *     and all of them at once, nothing in between
     */
    info(enabled = false, infoCallback, options) {
        if (enabled) {
            if (infoCallback !== undefined) {
                this.remoteInfoCallback = infoCallback || null;
            }
            if (!this.remoteInfoSubscribed) {
                this.remoteInfoSubscribed = true;
                this.meta('info/subscribe', null);
                if (!this.remoteInfoReattachArmed) {
                    // Re-subscribe automatically when the connection re-opens
                    this.remoteInfoReattachArmed = true;
                    this.addEventListener('open', () => {
                        if (this.remoteInfoSubscribed) {
                            this.meta('info/subscribe', null);
                        }
                    });
                }
            }
            if (options && options.probe) {
                const probeBody = {};
                if (options.probeSizeBytes) probeBody.sizeBytes = options.probeSizeBytes;
                if (Array.isArray(options.probeNames) && options.probeNames.length > 0) {
                    probeBody.names = options.probeNames.slice(0, 64);
                }
                if (Array.isArray(options.probeIds) && options.probeIds.length > 0) {
                    probeBody.ids = options.probeIds.slice(0, 128);
                }
                if (options.probeRamp === false) {
                    probeBody.ramp = false;
                }
                this.meta('info/probe', Object.keys(probeBody).length ? probeBody : null);
            }
        } else if (this.remoteInfoSubscribed) {
            this.remoteInfoSubscribed = false;
            this.remoteInfoCallback = null;
            this.meta('info/unsubscribe', null);
        }
    }

    /**
     * Client-side info API: names this connection on the connected server (e.g. the
     * avatar or user id this client represents). The server keeps the name on the
     * connection and stamps it into every info report as data.name whenever info is
     * active — independent of whether this client ever subscribes. One tiny meta
     * message per call; automatically re-sent after a reconnect. Call it once when
     * the client knows who it is.
     * @param {?string} name - up to 256 chars; null or '' clears the name
     */
    infoName(name) {
        this.remoteInfoName = (typeof name === 'string' && name.length > 0)
            ? name.slice(0, 256) : null;
        this.meta('info/name', {name: this.remoteInfoName});
        if (!this.remoteInfoNameReattachArmed) {
            // Re-introduce ourselves when the connection re-opens
            this.remoteInfoNameReattachArmed = true;
            this.addEventListener('open', () => {
                if (this.remoteInfoName) {
                    this.meta('info/name', {name: this.remoteInfoName});
                }
            });
        }
        // parallel sockets belong to this connection: keep their names in sync so
        // diagnostics group them under this name even when naming happens late
        if (this.parallelSockets) {
            for (const parallel of this.parallelSockets) {
                parallel.infoName(this.remoteInfoName ? this.remoteInfoName + ' · data' : null);
            }
        }
    }

    /**
     * Adds aliases for backwards compatibility
     */
    configureAliases() {
        this.on = this.addEventListener;
        this.emitInt = this.triggerEvent;
        this.dataPackageSchema = MESSAGE_BUNDLE_SCHEMA.oldFormat;
        this.routeSchema = URL_SCHEMA.oldFormat;
        this.OPEN = WebSocketWrapper.OPEN;
        this.CONNECTING = WebSocketWrapper.CONNECTING;
        this.CLOSING = WebSocketWrapper.CLOSING;
        this.CLOSED = WebSocketWrapper.CLOSED;
    }

    /**
     * Clones a ToolSocket, creating a parallel connection to the same endpoint.
     * @param {ToolSocket} toolsocket - The source ToolSocket.
     * @returns {ToolSocket} - A new ToolSocket created to the same endpoint as the original.
     */
    static makeParallelSocket(toolsocket) {
        const parallel = new ToolSocket(toolsocket.url, toolsocket.networkId, 'parallel');
        // a parallel socket belongs to its source connection: track it and inherit
        // the announced name (suffixed) so diagnostics group it under its parent —
        // infoName() keeps the children in sync if the parent is named later
        if (!toolsocket.parallelSockets) toolsocket.parallelSockets = [];
        toolsocket.parallelSockets.push(parallel);
        // Stop tracking a parallel once it closes. Most parallels are one-shot (the
        // proxy closes them after a single request), so a list that only ever grew
        // pinned a ToolSocket, its WebSocket, Sender, Receiver and ping Timeout per
        // request for the life of the process. A parallel that reconnects re-registers
        // itself on 'open', mirroring how the NB layer gates its own teardown.
        parallel.addEventListener('close', () => {
            const index = toolsocket.parallelSockets.indexOf(parallel);
            if (index > -1) {
                toolsocket.parallelSockets.splice(index, 1);
            }
        });
        parallel.addEventListener('open', () => {
            if (!toolsocket.parallelSockets.includes(parallel)) {
                toolsocket.parallelSockets.push(parallel);
            }
        });
        if (toolsocket.remoteInfoName) {
            parallel.infoName(toolsocket.remoteInfoName + ' · data');
        }
        return parallel;
    }
}

module.exports = ToolSocket;
