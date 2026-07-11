/**
 * ToolSocketInfo — live info/diagnostics reporting for a ToolSocket connection.
 *
 * This module is ONLY loaded when ToolSocket.info(true, callback) is called for the
 * first time. While info mode is off, none of this code is loaded or executed and the
 * ToolSocket hot paths (send / routeMessage) carry zero extra work: observation happens
 * exclusively through ToolSocket's event system, whose triggerEvent() early-returns
 * when no listeners are registered.
 *
 * Every info update delivered to the callback uses this envelope:
 *   {
 *     type:      string  — what kind of update this is (e.g. 'open', 'close', 'status')
 *     timestamp: number  — Date.now() at the moment of the update
 *     data:      object  — type-specific content
 *   }
 *
 * NOTE: The concrete info content is being defined incrementally. The lifecycle hooks
 * below are plumbing that proves the enable/disable/teardown mechanics work; the real
 * payloads will be built out in the marked section.
 */
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
    }

    /**
     * Sets (or replaces) the callback that receives info updates
     * @param {?function} callback
     */
    setCallback(callback) {
        this.callback = typeof callback === 'function' ? callback : null;
    }

    /**
     * Attaches listeners and begins delivering info updates. Idempotent.
     */
    start() {
        if (this.active) {
            return;
        }
        this.active = true;

        // ------------------------------------------------------------------
        // Info sources — TO BE DEFINED
        // The hooks below are minimal plumbing. The actual info content that
        // the callback provides will be designed and implemented here.
        // ------------------------------------------------------------------
        this._listen('open', () => this._emit('open', this.connectionSnapshot()));
        this._listen('close', () => this._emit('close', this.connectionSnapshot()));
        this._listen('error', () => this._emit('error', this.connectionSnapshot()));
        this._listen('status', (readyState) => this._emit('status', {readyState}));

        // Confirm activation immediately with a snapshot of the current connection
        this._emit('infoEnabled', this.connectionSnapshot());
    }

    /**
     * Detaches every listener this instance registered and stops all updates.
     * After stop(), this instance holds no hooks into the ToolSocket.
     */
    stop() {
        if (!this.active) {
            return;
        }
        for (const [eventType, handler] of Object.entries(this.listeners)) {
            this.toolsocket.removeEventListener(eventType, handler);
        }
        this.listeners = {};
        this.callback = null;
        this.active = false;
    }

    /**
     * A minimal snapshot of the current connection state (placeholder content)
     * @returns {Object}
     */
    connectionSnapshot() {
        return {
            url: this.toolsocket.url ? this.toolsocket.url.toString() : null,
            networkId: this.toolsocket.networkId,
            origin: this.toolsocket.origin,
            readyState: this.toolsocket.readyState,
            connected: this.toolsocket.connected,
            queuedMessages: this.toolsocket.queuedMessages.length,
        };
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
