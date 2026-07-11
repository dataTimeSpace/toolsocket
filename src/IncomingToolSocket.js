const ToolSocket = require("./ToolSocket");

class IncomingToolSocket extends ToolSocket {
    /**
     * Creates an IncomingToolSocket from an incoming WebSocket connection. Used by ToolSocketServer.
     * @param {WebSocket} websocket - The incoming WebSocket connection.
     * @param {ToolSocketServer} server - The ToolSocketServer this is attached to.
     */
    constructor(websocket, server) {
        super();
        this.socket = websocket;
        this.networkId = 'toolbox'; // Or 'io'?
        this.origin = server.origin;
        this.server = server;

        /**
         * Lazy-initialized info handler (see info()). Stays null while info mode is off,
         * in which case the info module is never loaded and no info code runs at all.
         * @type {?Object}
         */
        this.infoHandler = null;

        this.configureSocket();
    }

    /**
     * Enables or disables info updates about this server-side WebSocket connection.
     * This API is server side only and intentionally not available on client sockets.
     *
     * When enabled is false (the default), the entire info subsystem is dormant:
     * the info module is not loaded, no listeners are registered, and the send/receive
     * hot paths carry zero extra processing overhead.
     *
     * When enabled is true, the info module is lazily loaded on first use and begins
     * delivering info reports to the provided callback every 5 seconds. Calling
     * info(true, cb) again simply replaces the callback. Calling info(false) (or
     * info()) tears the info subsystem down completely, returning the socket to its
     * dormant state.
     *
     * @param {boolean} [enabled=false] - Whether info updates should be active
     * @param {?function} [infoCallback] - Called with info report objects while enabled.
     *                                     Report content is defined in ToolSocketInfo.js.
     */
    info(enabled = false, infoCallback) {
        if (enabled) {
            if (!this.infoHandler) {
                // Lazy require: this module is only ever loaded once info mode is activated
                const ToolSocketInfo = require('./ToolSocketInfo.js');
                this.infoHandler = new ToolSocketInfo(this);
            }
            this.infoHandler.setCallback(infoCallback || null);
            this.infoHandler.start();
        } else if (this.infoHandler) {
            this.infoHandler.stop();
            this.infoHandler = null;
        }
    }

    /**
     * Requests the source to create another ToolSocket connection for parallel data transfer.
     * @return {Promise<ToolSocket>} - The parallel socket we just created.
     */
    requestParallelSocket() {
        return this.server.requestParallelSocket(this);
    }
}

module.exports = IncomingToolSocket;
