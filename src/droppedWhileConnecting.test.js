/* global describe, test, expect, afterEach, jest */
// A raw socket that ToolSocket drops while it is still CONNECTING: a migration successor
// whose upgrade never completes, a fresh dial the liveness watchdog gives up on, a pending
// dial that connect() replaces. In Node, ws reports such a drop as an 'error' on the next
// tick, and an EventEmitter with no 'error' listener throws it: the whole process exits.
// The discarded socket must still swallow that error, and the ToolSocket must carry on.
const http = require('http');
const WebSocket = require('ws');
const ToolSocket = require('./index.js');

jest.setTimeout(20000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, timeoutMs = 5000, stepMs = 10) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (condition()) {
            return true;
        }
        await sleep(stepMs);
    }
    return condition();
};

// fast clocks so a whole migration fits in well under a second (as in sessionMigration.test.js)
const FAST = {
    migrateAfterMs: 150, ackIntervalMs: 20, sessionTimeoutMs: 400, migrateAckMs: 600,
    graceMs: 400, migrateRetryMs: 30, migrateMaxMs: 3000, gapRemindMs: 80
};

const running = [];
afterEach(async () => {
    while (running.length) {
        const item = running.pop();
        try {
            if (item.close) {
                item.close();
            }
        } catch (_e) { /* already closed */ }
    }
    await sleep(50);
});

// A ToolSocket server behind a plain HTTP server, the way the cloud proxy mounts it
// (noServer + handleUpgrade), so an upgrade can be held: the TCP connection is accepted and
// the HTTP upgrade is simply never answered. That is what a slow credential check, or a
// black-holed path in front of the server, looks like to the dialing client.
function startGatedServer(session = FAST) {
    const server = new ToolSocket.Server({ noServer: true, session }, 'server');
    const state = { server, port: 0, connections: [], closes: [], held: [], holdNext: 0, upgrades: 0 };
    server.addEventListener('connection', (socket) => {
        state.connections.push(socket);
        socket.addEventListener('close', () => state.closes.push(socket));
    });
    const httpServer = http.createServer();
    httpServer.on('upgrade', (request, socket, head) => {
        state.upgrades++;
        if (state.holdNext > 0) {
            state.holdNext--;
            socket.on('error', () => {}); // the client aborting it resets this end
            state.held.push(socket);
            return;
        }
        server.server.handleUpgrade(request, socket, head, ws => server.server.emit('connection', ws, request));
    });
    state.close = () => {
        for (const socket of state.held) {
            socket.destroy();
        }
        server.close();
        httpServer.close();
    };
    running.push(state);
    return new Promise(resolve => httpServer.listen(0, '127.0.0.1', () => {
        state.port = httpServer.address().port;
        resolve(state);
    }));
}

function makeClient(port, session = FAST) {
    const client = new ToolSocket(new URL(`ws://127.0.0.1:${port}`), 'testnet', 'client', { session });
    const events = { open: 0, close: 0, closeEvents: [], migrating: 0, migrated: 0 };
    client.addEventListener('open', () => events.open++);
    client.addEventListener('close', (event) => {
        events.close++;
        events.closeEvents.push(event);
    });
    client.addEventListener('__ts:migrating', () => events.migrating++);
    client.addEventListener('__ts:migrated', () => events.migrated++);
    running.push(client);
    return { client, events };
}

const capable = (srv, client) =>
    client.__ssn.peer === true && srv.connections.length > 0 && srv.connections[0].__ssn.peer === true;

describe('a raw socket dropped while CONNECTING', () => {
    test('migration successor whose upgrade never completes: dropped on ack-timeout, the process survives, the session carries on', async () => {
        // the server holds the session long enough for the successors that time out
        const srv = await startGatedServer(Object.assign({}, FAST, { graceMs: 5000 }));
        const { client, events } = makeClient(srv.port);
        expect(await waitFor(() => capable(srv, client))).toBe(true);
        const serverSide = srv.connections[0];
        const received = [];
        serverSide.addEventListener('/msg', body => received.push(body.n));
        client.emit('/msg', { n: 0 });
        expect(await waitFor(() => received.length === 1)).toBe(true);

        // which transport state each successor was in when the migration gave up on it
        const givenUp = [];
        const retryMigration = client._retryMigration;
        client._retryMigration = function (why) {
            givenUp.push({ why, readyState: this.socket ? this.socket.readyState : null });
            return retryMigration.call(this, why);
        };

        // the next two upgrades hang, then the server answers again
        srv.holdNext = 2;
        serverSide.socket.terminate(); // the link is lost: the client migrates
        for (let n = 1; n <= 5; n++) {
            client.emit('/msg', { n }); // queued through the migration, delivered after it
        }

        expect(await waitFor(() => received.length === 6, 8000)).toBe(true);
        expect(received).toEqual([0, 1, 2, 3, 4, 5]);
        // both hung successors were dropped by the ack timeout while still CONNECTING
        expect(srv.held.length).toBe(2);
        expect(givenUp).toEqual([
            { why: 'ack-timeout', readyState: WebSocket.CONNECTING },
            { why: 'ack-timeout', readyState: WebSocket.CONNECTING }
        ]);
        // one migration, nothing surfaced, still the same server-side session
        expect(events.migrating).toBe(1);
        expect(events.migrated).toBe(1);
        expect(events.close).toBe(0);
        expect(events.open).toBe(1);
        expect(client.connected).toBe(true);
        expect(srv.closes.length).toBe(0);
        expect(srv.connections.length).toBe(1);
        expect(srv.server.sessions.get(client.__ssn.id)).toBe(serverSide);

        // and the carried session keeps working in both directions
        const back = [];
        client.addEventListener('/back', body => back.push(body.n));
        serverSide.emit('/back', { n: 1 });
        client.emit('/msg', { n: 6 });
        expect(await waitFor(() => back.length === 1 && received.length === 7)).toBe(true);
    });

    test('fresh dial that hangs past the liveness watchdog: dropped while CONNECTING, the process survives, the redial connects', async () => {
        const srv = await startGatedServer();
        srv.holdNext = 1; // the first upgrade hangs
        const { client, events } = makeClient(srv.port);

        // which transport state the watchdog found when it gave up
        const lost = [];
        const onLivenessLost = client._onLivenessLost;
        client._onLivenessLost = function () {
            lost.push(this.socket ? this.socket.readyState : null);
            return onLivenessLost.call(this);
        };

        // the watchdog gives up after 16 s without inbound traffic, checked on its 5 s tick
        expect(await waitFor(() => lost.length === 1, 25000, 50)).toBe(true);
        expect(lost[0]).toBe(WebSocket.CONNECTING);
        expect(events.close).toBe(1);
        expect(events.closeEvents[0].reason).toBe('liveness-timeout');

        // the watchdog dialed afresh, and this time the server answers
        expect(await waitFor(() => events.open === 1 && srv.connections.length === 1)).toBe(true);
        expect(srv.upgrades).toBe(2);
        expect(srv.held.length).toBe(1);
        const serverSide = srv.connections[0];
        const received = [];
        const back = [];
        serverSide.addEventListener('/msg', body => received.push(body.n));
        client.addEventListener('/back', body => back.push(body.n));
        client.emit('/msg', { n: 1 });
        serverSide.emit('/back', { n: 1 });
        expect(await waitFor(() => received.length === 1 && back.length === 1)).toBe(true);
        expect(events.close).toBe(1);
    }, 40000);

    test('connect() while the previous dial is still CONNECTING: the pending dial is dropped, the process survives, the new dial connects', async () => {
        const srv = await startGatedServer();
        srv.holdNext = 1; // the first upgrade hangs
        const { client, events } = makeClient(srv.port);
        expect(await waitFor(() => srv.held.length === 1)).toBe(true);
        expect(client.socket.readyState).toBe(WebSocket.CONNECTING);

        client.connect(new URL(`ws://127.0.0.1:${srv.port}`), 'testnet', 'client');

        expect(await waitFor(() => events.open === 1 && srv.connections.length === 1)).toBe(true);
        expect(srv.upgrades).toBe(2);
        const serverSide = srv.connections[0];
        const received = [];
        serverSide.addEventListener('/msg', body => received.push(body.n));
        client.emit('/msg', { n: 1 });
        expect(await waitFor(() => received.length === 1)).toBe(true);
        expect(events.close).toBe(0); // the replaced dial never surfaces anything
    });
});
