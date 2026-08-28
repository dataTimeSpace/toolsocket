const BinaryBuffer = require('./BinaryBuffer.js');
const ToolSocketMessage = require('./ToolSocketMessage.js');
const ToolSocketResponse = require('./ToolSocketResponse.js');
const MessageBundle = require('./MessageBundle.js');

const { generateUniqueId, addSearchParams, isBrowser, WebSocketWrapper, makeProbePayload } = require('./utilities.js');
const { VALID_METHODS, MAX_MESSAGE_SIZE } = require('./constants.js');
const { URL_SCHEMA, MESSAGE_BUNDLE_SCHEMA } = require('./schemas.js');

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

        if (url) {
            // store extra options so we can reuse them on reconnect
            this.wsOptions = wsOptions;
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

    get readyState() {
        if (!this.socket) {
            return WebSocketWrapper.CLOSED;
        }
        return this.socket.readyState;
    }

    get connected() {
        return this.socket && this.socket.readyState === this.socket.OPEN;
    }

    /**
     * Connects the WebSocket
     * @param {?URL} url - The URL to connect to
     * @param {?string} [networkId] - The network ID
     * @param {?string} [origin] - The origin
     */
    connect(url, networkId, origin) {
        if (this.socket) {
            this.socket.close();
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

        this.socket = new WebSocketWrapper(this.url, [], {
            maxPayload: MAX_MESSAGE_SIZE,
            ...this.wsOptions
        });
        this.configureSocket();
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
     * Closes the WebSocket connection
     */
    close() {
        this.socket.close();
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
     */
    configureSocket() {
        this.socket.binaryType = 'arraybuffer';
        this.socket.addEventListener('open', event => {
            this.triggerEvent('open', event);
            this.triggerEvent('connect', event);
            this.triggerEvent('connected', event);
            this.triggerEvent('status', this.socket.readyState);
            this.sendQueuedMessages();
        });
        this.socket.addEventListener('close', event => {
            this.triggerEvent('close', event);
            this.triggerEvent('disconnect', event);
            this.triggerEvent('status', this.socket.readyState);
        });
        this.socket.addEventListener('error', event => {
            this.triggerEvent('error', event);
        });
        this.socket.addEventListener('message', event => {
            this.triggerEvent('rawMessage', event.data);
            if (typeof event.data === 'string') {
                this.routeMessage(event.data);
            } else {
                this.routeMessage(new Uint8Array(event.data));
            }
        });
        this.setupPingInterval();
    }

    /**
     * Initiates the ping interval
     */
    setupPingInterval() {
        // Liveness watchdog. The reconnect logic fires only on a 'close' event, but a
        // silently half-open connection (NAT/firewall idle-drop, cellular<->wifi handoff, a
        // dead TCP that never delivers a FIN) never produces one — the socket sits in
        // readyState OPEN forever and the client becomes a zombie that receives nothing and
        // never reconnects. So track inbound liveness: any inbound frame (a pong reply alone
        // guarantees traffic every 5s on a healthy link) refreshes it; if nothing arrives for
        // LIVENESS_DEADLINE_MS we force-close the RAW socket — this.socket.close(), NOT
        // this.close() which sets userClosed and would suppress reconnect — so the 'close'
        // handler fires and the reconnect loop re-establishes the connection.
        const LIVENESS_DEADLINE_MS = 16000; // ~3 missed 5s pings; below the proxy's 20s reaper
        let lastInbound = Date.now();
        this.socket.addEventListener('message', () => {
            lastInbound = Date.now();
        });
        const autoPing = () => {
            if (Date.now() - lastInbound > LIVENESS_DEADLINE_MS) {
                // Silent half-open: no inbound for the deadline and no 'close' will come.
                // Stop this ping loop and force a FRESH connection. We must NOT just wait for
                // this.socket.close() to fire 'close' — a graceful close handshake hangs on an
                // unresponsive peer, wedging the socket in CLOSING forever (no 'close', so the
                // reconnect never fires). this.connect() replaces this.socket with a new
                // connection; the reconnect layer stays armed on the ToolSocket for later drops.
                clearInterval(interval);
                try {
                    this.socket.close();
                } catch (_e) { /* best effort; we're replacing it anyway */ }
                if (this.url) {
                    // outbound socket: dial a fresh connection
                    this.connect(this.url, this.networkId, this.origin);
                } else if (this.socket.terminate) {
                    // server-side incoming socket (IncomingToolSocket, url=null): there is
                    // nothing to dial — connect(null) would throw and crash the server.
                    // Terminate the dead transport so 'close' fires and the server reaps
                    // the connection; the CLIENT's own watchdog/reconnect re-establishes.
                    try {
                        this.socket.terminate();
                    } catch (_e) { /* already dead */ }
                }
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
        autoPing(); // Must ping before messages get sent so that cloud-proxy can set up network properly
        this.socket.addEventListener('close', () => {
            clearInterval(interval);
        });
    }

    /**
     * Processes an incoming message
     * @param {string | Uint8Array} message - The message to process
     */
    routeMessage(message) {
        /** @type {MessageBundle} */
        let messageBundle = null;
        let messageLength = 0;
        if (typeof message === 'string') {
            try {
                messageBundle = MessageBundle.fromString(message);
                messageLength = message.length;
                if (messageBundle.message.frameCount !== null) {
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
        if (!this.connected) {
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

        if (messageBundle.binaryData) {
            if (Array.isArray(messageBundle.binaryData)) {
                messageBundle.message.frameCount = messageBundle.binaryData.length;
                const metaSendData = JSON.stringify(messageBundle.message);
                this.socket.send(metaSendData);
                this.triggerEvent('rawSend', metaSendData);
                messageBundle.binaryData.forEach(entry => {
                    const sendData = entry;
                    this.socket.send(sendData);
                    this.triggerEvent('rawSend', sendData);
                });
            } else {
                const sendData = messageBundle.toBinary();
                this.socket.send(sendData);
                this.triggerEvent('rawSend', sendData);
            }
        } else {
            const sendData = JSON.stringify(messageBundle.message);
            this.socket.send(sendData);
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
