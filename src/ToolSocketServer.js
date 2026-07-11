const { WebSocketWrapper } = require('./utilities.js');
const { URL_SCHEMA, MESSAGE_BUNDLE_SCHEMA } = require('./schemas.js');
const IncomingToolSocket = require('./IncomingToolSocket');
const {generateUniqueId} = require("./utilities");

/**
 * A server for ToolSocket
 */
class ToolSocketServer {
    /**
     * Constructs a ToolSocketServer
     * @param {Object} options - Options to pass to the WebSocket.Server constructor
     * @param {string} [origin] - The origin
     */
    constructor(options, origin) {
        this.origin = origin || 'server';
        this.server = new WebSocketWrapper.Server(options);

        /** @type [ToolSocket] */
        this.sockets = [];

        this.eventCallbacks = {}; // For internal events

        this.pendingParallelRequests = new Map();

        // Staged throughput probe state (see stagedProbe())
        this.stagedProbeRunning = false;
        /** @type {?Object} latest staged probe result */
        this.lastStagedProbeResult = null;

        this.server.on('listening', (...args) => {
            this.triggerEvent('listening', ...args);
        });

        this.server.on('connection', socket => {
            const toolSocket = new IncomingToolSocket(socket, this);
            this.sockets.push(toolSocket);
            this.triggerEvent('connection', toolSocket);

            toolSocket.on('confirmParallel', id => {
                if (this.pendingParallelRequests.has(id)) {
                    const resolve = this.pendingParallelRequests.get(id);
                    resolve(toolSocket);
                    this.pendingParallelRequests.delete(id);
                }
            });

            socket.on('close', () => {
                this.sockets.splice(this.sockets.indexOf(toolSocket), 1);
            });
        });

        this.server.on('close', (...args) => {
            this.triggerEvent('close', ...args);
        });

        this.configureAliases();
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
     * Adds aliases for backwards compatibility
     */
    configureAliases() {
        this.on = this.addEventListener;
        this.emitInt = this.triggerEvent;
        this.dataPackageSchema = MESSAGE_BUNDLE_SCHEMA.oldFormat;
        this.routeSchema = URL_SCHEMA.oldFormat;
        this.server.server = this.server;
    }

    /**
     * Requests the source to create another ToolSocket connection for parallel data transfer.
     * @param {ToolSocket} toolSocket - The toolSocket requesting a parallel connection.
     * @return {Promise<ToolSocket>} - The parallel socket we just created.
     */
    requestParallelSocket(toolSocket) {
        const id = generateUniqueId(8);
        const requestTimeout = 5 * 1000;
        if (toolSocket.supportsParallelSocket === undefined) {
            // We don't know if the socket supports this feature due to backwards-compatibility requirements
            toolSocket.meta('requestParallel', id, null, null);
            let promiseResolved = false;
            let resolve, reject;
            const promise = new Promise((res, rej) => {
                resolve = res;
                reject = rej;
            }).then(parallelSocket => {
                toolSocket.supportsParallelSocket = true;
                promiseResolved = true;
                return parallelSocket;
            });
            this.pendingParallelRequests.set(id, resolve);
            setTimeout(() => {
                if (promiseResolved) {
                    return; // Do nothing if already resolved
                }
                this.pendingParallelRequests.delete(id);
                if (toolSocket.supportsParallelSocket === undefined) {
                    toolSocket.supportsParallelSocket = false;
                    reject('Unable to create parallel socket connection. Might not be supported by client.');
                } else {
                    reject('Unable to create parallel socket connection. Client does support it, but there\'s likely a network issue.'); // If it's succeeded at least once before, we don't need to set it to false, might just be a network issue
                }
            }, requestTimeout);
            return promise;
        } else if (toolSocket.supportsParallelSocket) {
            // We know the socket supports this feature
            toolSocket.meta('requestParallel', id, null, null);
            let resolve;
            const promise = new Promise((res) => {
                resolve = res;
            });
            this.pendingParallelRequests.set(id, resolve);
            return promise;
        } else {
            // The socket does not support this feature
            return Promise.reject('Unable to create parallel socket connection. Might not be supported by client.');
        }
    }

    close() {
        this.server.close();
    }

    /**
     * Runs a staged throughput probe across all connected sockets to distinguish the
     * per-client limit from the shared network limit (e.g. ten clients on one WiFi).
     *
     * Stage 'individual': every connection is probed alone, one after another — each
     * client's own capacity, free of probe-vs-probe contention.
     * Growing stages: 2, 4, 8, ... connections probed simultaneously, ending with all
     * at once. If the summed rate stops growing while more clients join in, the
     * shared medium is saturated — that plateau is the network limit.
     *
     * sharedBottleneck.downstreamRatio = (sum of individual capacities) / (all-at-once
     * total). ~1 means clients barely limit each other; above ~1.5 the shared network
     * is the bottleneck (flagged as detected: true).
     *
     * Deliberately saturates the network while running; intended for manual trigger.
     * One staged probe at a time per server. Connections with info enabled get their
     * per-connection probe results updated along the way.
     *
     * @param {function} callback - Receives the full result object when finished
     * @param {?Object} [options]
     * @param {number} [options.sizeBytes] - Payload per direction per probe (default 256 KB)
     * @param {boolean} [options.ramp] - Include the growing 2, 4, 8... stages between
     *                                   'individual' and all-at-once (default true)
     */
    stagedProbe(callback, options = {}) {
        if (typeof callback !== 'function') {
            return;
        }
        if (this.stagedProbeRunning) {
            callback({status: 'failed', reason: 'staged-probe-already-running'});
            return;
        }
        // Lazy require: staged probing shares the dormant info module
        const ToolSocketInfo = require('./ToolSocketInfo.js');
        const connections = this.sockets.filter(socket => socket.connected);
        if (connections.length === 0) {
            callback({status: 'failed', reason: 'no-connections'});
            return;
        }
        this.stagedProbeRunning = true;
        const sizeBytes = (typeof options.sizeBytes === 'number' && options.sizeBytes > 0)
            ? Math.floor(options.sizeBytes) : ToolSocketInfo.DEFAULT_PROBE_SIZE_BYTES;
        const ramp = options.ramp !== false;

        // Probe one connection: through its info handler when enabled (keeps its
        // per-connection reports and quality windows consistent), bare otherwise
        const probeOne = (connection) => new Promise((resolve) => {
            if (connection.infoHandler && connection.infoHandler.active) {
                if (!connection.infoHandler.startProbe(sizeBytes, resolve)) {
                    resolve({status: 'failed', reason: 'probe-already-running'});
                }
            } else {
                ToolSocketInfo.runProbe(connection, sizeBytes, 0).then(resolve);
            }
        });
        const describe = (connection, result) => ({
            name: (connection.infoHandler && connection.infoHandler.connectionName) || null,
            status: result.status,
            downstreamBytesPerSecond: result.downstreamBytesPerSecond,
            upstreamBytesPerSecond: result.upstreamBytesPerSecond,
            contended: result.contended || false,
        });
        const total = (list, key) => list.reduce(
            (accumulated, entry) => accumulated
                + ((entry.status === 'ok' && entry[key]) ? entry[key] : 0), 0);

        const run = async () => {
            const startedAt = Date.now();

            // Stage 'individual': sequential, one connection at a time
            const individual = [];
            for (const connection of connections) {
                const result = await probeOne(connection);
                individual.push(describe(connection, result));
            }
            const individualTotalDown = total(individual, 'downstreamBytesPerSecond');
            const individualTotalUp = total(individual, 'upstreamBytesPerSecond');

            // Growing stages: 2, 4, 8, ... simultaneous probes, always ending with all
            const groupSizes = [];
            if (ramp) {
                for (let k = 2; k < connections.length; k *= 2) {
                    groupSizes.push(k);
                }
            }
            if (connections.length > 1) {
                groupSizes.push(connections.length);
            }
            const stages = [];
            for (const concurrent of groupSizes) {
                const group = connections.slice(0, concurrent);
                const results = await Promise.all(group.map(probeOne));
                const perConnection = results.map(
                    (result, index) => describe(group[index], result));
                stages.push({
                    concurrent: concurrent,
                    totalDownstreamBytesPerSecond: total(perConnection, 'downstreamBytesPerSecond'),
                    totalUpstreamBytesPerSecond: total(perConnection, 'upstreamBytesPerSecond'),
                    perConnection: perConnection,
                });
            }

            // Network limit: the all-at-once totals (with a single connection, its
            // individual capacity IS the network limit)
            const allStage = stages.length > 0 ? stages[stages.length - 1] : {
                totalDownstreamBytesPerSecond: individualTotalDown,
                totalUpstreamBytesPerSecond: individualTotalUp,
            };
            const ratio = (individualSum, allSum) => allSum > 0
                ? Math.round((individualSum / allSum) * 100) / 100 : null;
            const downstreamRatio = ratio(individualTotalDown, allStage.totalDownstreamBytesPerSecond);
            const upstreamRatio = ratio(individualTotalUp, allStage.totalUpstreamBytesPerSecond);

            const result = {
                status: 'ok',
                startedAt: startedAt,
                finishedAt: Date.now(),
                sizeBytes: sizeBytes,
                connections: connections.length,
                individual: {
                    perConnection: individual,
                    totalDownstreamBytesPerSecond: individualTotalDown,
                    totalUpstreamBytesPerSecond: individualTotalUp,
                },
                stages: stages,
                networkLimit: {
                    downstreamBytesPerSecond: allStage.totalDownstreamBytesPerSecond,
                    upstreamBytesPerSecond: allStage.totalUpstreamBytesPerSecond,
                },
                sharedBottleneck: {
                    downstreamRatio: downstreamRatio,
                    upstreamRatio: upstreamRatio,
                    detected: (downstreamRatio !== null && downstreamRatio > 1.5)
                        || (upstreamRatio !== null && upstreamRatio > 1.5),
                },
            };
            this.lastStagedProbeResult = result;
            this.stagedProbeRunning = false;
            callback(result);
        };
        run().catch(() => {
            this.stagedProbeRunning = false;
            callback({status: 'failed', reason: 'internal-error'});
        });
    }
}

module.exports = ToolSocketServer;
