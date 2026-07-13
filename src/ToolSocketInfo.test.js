/**
 * Integration tests for the connection info API: per-connection info reports
 * (ToolSocketInfo), throughput probes, the server-wide staged probe, and the
 * client-side remote info subscription. Uses real sockets on an ephemeral port.
 */
const path = require('path');
const ToolSocket = require('./index.js');

jest.setTimeout(45000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
    const server = new ToolSocket.Server({port: 0});
    await new Promise((resolve) => server.on('listening', resolve));
    return {server, port: server.server.address().port};
}

function connectClient(port) {
    const client = new ToolSocket(`ws://localhost:${port}`, 'testnet', 'web');
    return new Promise((resolve) => client.on('open', () => resolve(client)));
}

describe('connection info API', () => {
    let server = null;
    let clients = [];

    afterEach(async () => {
        for (const client of clients) {
            try {
                client.close();
            } catch (_e) { /* already closed */ }
        }
        clients = [];
        if (server) {
            try {
                server.close();
            } catch (_e) { /* already closed */ }
            server = null;
        }
        await wait(100);
    });

    test('is dormant until enabled, reports every 5s, and tears down cleanly', async () => {
        const infoModulePath = path.resolve(__dirname, 'ToolSocketInfo.js');
        const started = await startServer();
        server = started.server;
        const connectionPromise = new Promise((resolve) => server.on('connection', resolve));
        clients.push(await connectClient(started.port));
        const serverSocket = await connectionPromise;

        // Dormant: module not even loaded, no handler, client has no local info API
        expect(require.cache[infoModulePath]).toBeUndefined();
        expect(serverSocket.infoHandler).toBeNull();
        const baselineListeners = Object.values(serverSocket.eventCallbacks).flat().length;

        const reports = [];
        serverSocket.info(true, (report) => reports.push(report), {name: 'jest-user'});
        expect(require.cache[infoModulePath]).toBeDefined();

        await wait(5600);
        expect(reports.length).toBeGreaterThanOrEqual(1);
        const data = reports[0].data;
        expect(reports[0].type).toBe('info');
        expect(data.name).toBe('jest-user');
        expect(data.networkLatency).not.toBeNull();
        expect(data.networkLatency.samples).toBeGreaterThanOrEqual(1);
        expect(data.transport.receivedBytes).toBeGreaterThan(0);
        expect(data.networkQuality.flow).toBe('realtime');
        expect(data.networkQuality.score).toBeGreaterThanOrEqual(0);
        expect(data.networkQuality.score).toBeLessThanOrEqual(100);
        expect(data.networkQuality.scores).toHaveProperty('continuity');
        expect(data.history.reports).toBe(1);
        expect(data.probe).toBeNull();

        // Teardown: handler gone, listener count restored, no further reports
        serverSocket.info(false);
        expect(serverSocket.infoHandler).toBeNull();
        expect(Object.values(serverSocket.eventCallbacks).flat().length).toBe(baselineListeners);
        const countAfterDisable = reports.length;
        await wait(5600);
        expect(reports.length).toBe(countAfterDisable);
    });

    test('a graceful client close produces a clean final report', async () => {
        const started = await startServer();
        server = started.server;
        const connectionPromise = new Promise((resolve) => server.on('connection', resolve));
        const client = await connectClient(started.port);
        const serverSocket = await connectionPromise;

        const reports = [];
        serverSocket.info(true, (report) => reports.push(report));
        await wait(300);
        client.close(); // orderly close handshake (close frame without status code)
        await wait(500);

        const finalReport = reports[reports.length - 1];
        expect(finalReport.data.networkQuality.flow).toBe('ended');
        expect(finalReport.data.networkQuality.details.endedCleanly).toBe(true);
        expect(finalReport.data.networkQuality.issues)
            .not.toContain('connection-cut-abnormally');
    });

    test('runProbe measures both directions on any connection', async () => {
        const started = await startServer();
        server = started.server;
        const connectionPromise = new Promise((resolve) => server.on('connection', resolve));
        clients.push(await connectClient(started.port));
        const serverSocket = await connectionPromise;

        const ToolSocketInfo = require('./ToolSocketInfo.js');
        const result = await ToolSocketInfo.runProbe(serverSocket, 32 * 1024);
        expect(result.status).toBe('ok');
        expect(result.sizeBytes).toBe(32 * 1024);
        expect(result.downstreamBytesPerSecond).toBeGreaterThan(0);
        expect(result.upstreamBytesPerSecond).toBeGreaterThan(0);
    });

    test('stagedProbe separates individual limits from the network limit', async () => {
        const started = await startServer();
        server = started.server;
        const connections = [];
        server.on('connection', (socket) => connections.push(socket));
        clients.push(await connectClient(started.port));
        clients.push(await connectClient(started.port));
        clients.push(await connectClient(started.port));
        await wait(200);

        const result = await new Promise((resolve) =>
            server.stagedProbe(resolve, {sizeBytes: 32 * 1024}));
        expect(result.status).toBe('ok');
        expect(result.connections).toBe(3);
        expect(result.individual.perConnection).toHaveLength(3);
        expect(result.individual.totalDownstreamBytesPerSecond).toBeGreaterThan(0);
        expect(result.stages[result.stages.length - 1].concurrent).toBe(3);
        expect(result.networkLimit.downstreamBytesPerSecond).toBeGreaterThan(0);
        expect(typeof result.sharedBottleneck.detected).toBe('boolean');
        expect(server.lastStagedProbeResult).toBe(result);
    });

    test('stagedProbe options.names probes only the named connections', async () => {
        const started = await startServer();
        server = started.server;
        const wifiClient = await connectClient(started.port);
        clients.push(wifiClient);
        clients.push(await connectClient(started.port)); // unnamed bystander
        wifiClient.infoName('wifi-A');
        await wait(300);

        const result = await new Promise((resolve) =>
            server.stagedProbe(resolve, {sizeBytes: 32 * 1024, ramp: false, names: ['wifi-A']}));
        expect(result.status).toBe('ok');
        expect(result.connections).toBe(1);
        expect(result.individual.perConnection).toHaveLength(1);
        expect(result.individual.perConnection[0].name).toBe('wifi-A');
        expect(typeof result.individual.perConnection[0].id).toBe('string');

        // ids address any connection, named or not
        const wifiId = result.individual.perConnection[0].id;
        const byId = await new Promise((resolve) =>
            server.stagedProbe(resolve, {sizeBytes: 32 * 1024, ramp: false, ids: [wifiId]}));
        expect(byId.status).toBe('ok');
        expect(byId.connections).toBe(1);
        expect(byId.individual.perConnection[0].id).toBe(wifiId);

        // a filter that matches nothing fails cleanly instead of probing everyone
        const miss = await new Promise((resolve) =>
            server.stagedProbe(resolve, {names: ['no-such-name']}));
        expect(miss.status).toBe('failed');
        expect(miss.reason).toBe('no-connections');
    });

    test('client-side info() streams server bundles and stops on request', async () => {
        const started = await startServer();
        server = started.server;
        const subscriber = await connectClient(started.port);
        clients.push(subscriber);
        clients.push(await connectClient(started.port));

        const bundles = [];
        subscriber.info(true, (bundle) => bundles.push(bundle));
        await wait(6500);

        expect(bundles.length).toBeGreaterThanOrEqual(1);
        const bundle = bundles[bundles.length - 1];
        expect(bundle.type).toBe('serverInfo');
        expect(bundle.connections).toBe(2);
        expect(Array.isArray(bundle.reports)).toBe(true);
        expect(Array.isArray(bundle.recentlyClosed)).toBe(true);

        subscriber.info(false);
        await wait(300);
        const countAfterStop = bundles.length;
        await wait(5600);
        expect(bundles.length).toBe(countAfterStop);
        expect(server.infoBroadcastInterval).toBeNull();
        // Auto-enabled per-connection info was turned off again
        expect(server.sockets.every((socket) => socket.infoHandler === null)).toBe(true);
    });

    test('client-side infoName() names the connection and the name survives enable/disable cycles', async () => {
        const started = await startServer();
        server = started.server;
        const connectionPromise = new Promise((resolve) => server.on('connection', resolve));
        const namedClient = await connectClient(started.port);
        clients.push(namedClient);
        const namedServerSocket = await connectionPromise;

        // Announcing a name is not an info activation: the socket stays dormant
        namedClient.infoName('avatar-alice');
        await wait(300);
        expect(namedServerSocket.announcedInfoName).toBe('avatar-alice');
        expect(namedServerSocket.infoHandler).toBeNull();

        // A subscriber auto-enables info on all connections: reports carry the name
        const subscriber = await connectClient(started.port);
        clients.push(subscriber);
        const bundles = [];
        subscriber.info(true, (bundle) => bundles.push(bundle));
        await wait(11500);
        const names = bundles.flatMap((b) => b.reports.map((r) => r.data && r.data.name));
        expect(names).toContain('avatar-alice');

        // Last subscriber leaves: info returns to dormant but the name is retained...
        subscriber.info(false);
        await wait(300);
        expect(namedServerSocket.infoHandler).toBeNull();
        expect(namedServerSocket.announcedInfoName).toBe('avatar-alice');

        // ...so a fresh subscription still sees the named connection
        const bundlesAgain = [];
        subscriber.info(true, (bundle) => bundlesAgain.push(bundle));
        await wait(11500);
        const namesAgain = bundlesAgain.flatMap((b) => b.reports.map((r) => r.data && r.data.name));
        expect(namesAgain).toContain('avatar-alice');
        subscriber.info(false);

        // Clearing the name
        namedClient.infoName(null);
        await wait(300);
        expect(namedServerSocket.announcedInfoName).toBeNull();
    });

    test('removeEventListener removes exactly the given listener', () => {
        const socket = new ToolSocket();
        const calls = [];
        const listenerA = () => calls.push('a');
        const listenerB = () => calls.push('b');
        socket.addEventListener('custom', listenerA);
        socket.addEventListener('custom', listenerB);
        socket.triggerEvent('custom');
        socket.removeEventListener('custom', listenerA);
        socket.triggerEvent('custom');
        expect(calls).toEqual(['a', 'b', 'b']);
        socket.removeEventListener('custom', listenerB);
        expect(socket.eventCallbacks.custom).toBeUndefined();
    });
});
