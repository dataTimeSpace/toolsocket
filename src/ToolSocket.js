const BinaryBuffer = require('./BinaryBuffer.js');
const ToolSocketMessage = require('./ToolSocketMessage.js');
const ToolSocketResponse = require('./ToolSocketResponse.js');
const MessageBundle = require('./MessageBundle.js');

const { generateUniqueId, addSearchParams, isBrowser, WebSocketWrapper } = require('./utilities.js');
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

        this.addEventListener('meta', (route, body, _response, _binaryData, _messageBundle) => {
            if (route === 'requestParallel') {
                this.triggerEvent('requestParallel', body); // body = id
            } else if (route === 'confirmParallel') {
                this.triggerEvent('confirmParallel', body); // body = id
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
        const autoPing = () => {
            this.ping('action/ping', null, () => {
                this.triggerEvent('pong');
            });
        };
        const interval = setInterval(autoPing, 2000);
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
        return new ToolSocket(toolsocket.url, toolsocket.networkId, 'parallel');
    }
}

module.exports = ToolSocket;
