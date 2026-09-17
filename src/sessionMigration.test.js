/* global describe, test, expect, afterEach, jest */
// Session layer: a half-open transport is replaced underneath a live ToolSocket without
// losing, duplicating or reordering a single message, and without the application ever
// seeing a close/open. See SessionStream.js.
const ToolSocket = require('./index.js');
const NB = require('./ToolSocketNB.js');
const SessionStream = require('./SessionStream.js');

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

// fast clocks so a whole migration fits in well under a second
const FAST = {
    migrateAfterMs: 150, ackIntervalMs: 20, sessionTimeoutMs: 400, migrateAckMs: 600,
    graceMs: 400, migrateRetryMs: 30, migrateMaxMs: 3000
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

function startServer(port, session = FAST) {
    const server = new ToolSocket.Server({ port, session }, 'server');
    const state = { server, connections: [], closes: [] };
    server.addEventListener('connection', (socket) => {
        state.connections.push(socket);
        socket.addEventListener('close', () => state.closes.push(socket));
    });
    running.push(server);
    return new Promise(resolve => server.addEventListener('listening', () => resolve(state)));
}

function connectClient(port, session = FAST) {
    const client = new ToolSocket(new URL(`ws://127.0.0.1:${port}`), 'testnet', 'client', { session });
    const events = { open: 0, close: 0, error: 0, migrating: 0, migrated: 0 };
    client.addEventListener('open', () => events.open++);
    client.addEventListener('close', () => events.close++);
    client.addEventListener('error', () => events.error++);
    client.addEventListener('__ts:migrating', () => events.migrating++);
    client.addEventListener('__ts:migrated', () => events.migrated++);
    running.push(client);
    return new Promise(resolve => client.addEventListener('open', () => resolve({ client, events })));
}

// A half-open transport from the application's point of view: ws.send() succeeds (the
// kernel accepts the bytes, readyState stays OPEN, the completion callback fires) and
// nothing ever arrives at the other end.
function cutOutbound(ws) {
    ws.send = function (_data, callback) {
        if (typeof callback === 'function') {
            setImmediate(callback);
        }
    };
}

const capable = (server, client) =>
    client.__ssn.peer === true && server.connections.length > 0 && server.connections[0].__ssn.peer === true;

describe('session layer', () => {
    test('negotiates the capability and registers the session', async () => {
        const srv = await startServer(5041);
        const { client, events } = await connectClient(5041);
        expect(await waitFor(() => capable(srv, client))).toBe(true);
        const serverSide = srv.connections[0];
        expect(srv.server.sessions.get(client.__ssn.id)).toBe(serverSide);
        expect(serverSide.__ssn.id).toBe(client.__ssn.id);
        expect(events.open).toBe(1);
        expect(events.close).toBe(0);
    });

    test('half-open client transport: migrates with nothing lost, nothing surfaced', async () => {
        const srv = await startServer(5042);
        const { client, events } = await connectClient(5042);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const received = [];
        serverSide.addEventListener('/msg', body => received.push(body.n));

        // warm up: one message over the healthy transport, acked
        client.emit('/msg', { n: 0 });
        await waitFor(() => received.length === 1);

        cutOutbound(client.socket);
        const connectedSamples = [];
        for (let n = 1; n <= 20; n++) {
            client.emit('/msg', { n });
            connectedSamples.push(client.connected);
        }
        // the frames vanished into the dead transport; the ack-age detector must notice
        expect(await waitFor(() => received.length === 21, 4000)).toBe(true);
        expect(received).toEqual(Array.from({ length: 21 }, (_v, i) => i));

        // nothing surfaced: no close, no second open, still the same server-side instance
        expect(events.close).toBe(0);
        expect(events.open).toBe(1);
        expect(events.migrating).toBe(1);
        expect(events.migrated).toBe(1);
        expect(connectedSamples.every(v => v === true)).toBe(true);
        expect(client.connected).toBe(true);
        expect(srv.connections.length).toBe(1);
        expect(srv.closes.length).toBe(0);
        expect(srv.server.sessions.get(client.__ssn.id)).toBe(serverSide);

        // and the moved session keeps working in both directions afterwards
        const back = [];
        client.addEventListener('/back', body => back.push(body.n));
        serverSide.emit('/back', { n: 1 });
        client.emit('/msg', { n: 21 });
        expect(await waitFor(() => back.length === 1 && received.length === 22)).toBe(true);
    });

    test('half-open in both directions: both ends resend what the other missed', async () => {
        const srv = await startServer(5043);
        const { client, events } = await connectClient(5043);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const up = [];
        const down = [];
        serverSide.addEventListener('/up', body => up.push(body.n));
        client.addEventListener('/down', body => down.push(body.n));

        cutOutbound(client.socket);
        cutOutbound(serverSide.socket);
        for (let n = 0; n < 10; n++) {
            client.emit('/up', { n });
            serverSide.emit('/down', { n });
        }
        expect(await waitFor(() => up.length === 10 && down.length === 10, 4000)).toBe(true);
        expect(up).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(down).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(events.close).toBe(0);
        expect(srv.closes.length).toBe(0);
        expect(srv.connections.length).toBe(1);
    });

    test('legacy server (no session layer): client falls back and never migrates', async () => {
        const srv = await startServer(5044, { enabled: false });
        const { client, events } = await connectClient(5044);
        expect(await waitFor(() => client.__ssn.peer === false, 2000)).toBe(true);
        const received = [];
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));
        client.emit('/msg', { n: 1 });
        expect(await waitFor(() => received.length === 1)).toBe(true);
        expect(client.__ssn.tx.retained.length).toBe(0); // no retention for a legacy peer
        cutOutbound(client.socket);
        client.emit('/msg', { n: 2 });
        await sleep(600);
        expect(events.migrating).toBe(0); // the 16s liveness watchdog owns this case, as before
        expect(events.close).toBe(0);
    });

    test('legacy client (no session layer): server closes promptly, without grace', async () => {
        const srv = await startServer(5045);
        const { client } = await connectClient(5045, { enabled: false });
        expect(await waitFor(() => srv.connections.length === 1 && srv.connections[0].__ssn.peer === false, 2000)).toBe(true);
        const closedAt = { t: 0 };
        srv.connections[0].addEventListener('close', () => { closedAt.t = Date.now(); });
        const t0 = Date.now();
        client.close();
        expect(await waitFor(() => closedAt.t > 0, 1500)).toBe(true);
        expect(closedAt.t - t0).toBeLessThan(FAST.graceMs);
        expect(srv.server.sockets.length).toBe(0);
    });

    test('a departed session-capable client surfaces close only after grace', async () => {
        const srv = await startServer(5046);
        const { client } = await connectClient(5046);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const t0 = Date.now();
        client.close(); // an explicit close on the client never migrates; the server only sees its transport go
        await sleep(FAST.graceMs / 2);
        expect(srv.closes.length).toBe(0); // still waiting for a successor
        expect(serverSide.connected).toBe(true); // the session reads open meanwhile
        expect(await waitFor(() => srv.closes.length === 1, FAST.graceMs * 3)).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.graceMs - 20);
        expect(srv.server.sockets).not.toContain(serverSide);
        expect(srv.server.sessions.has(client.__ssn.id)).toBe(false);
    });

    test('explicit close(): immediate, no migration', async () => {
        const srv = await startServer(5047);
        const { client, events } = await connectClient(5047);
        await waitFor(() => capable(srv, client));
        client.close();
        expect(await waitFor(() => events.close === 1, 1500)).toBe(true);
        expect(events.migrating).toBe(0);
        expect(client.connected).toBe(false);
    });

    test('NB-enhanced pair: a chunked transfer and a burst survive a half-open cut', async () => {
        const srv = await startServer(5048);
        srv.server.addEventListener('connection', socket => NB.enhance(socket, { reconnect: false }));
        const { client, events } = await connectClient(5048);
        NB.enhance(client, { reconnect: false });
        await waitFor(() => capable(srv, client) && client.__nb.peer === true && srv.connections[0].__nb.peer === true);
        const serverSide = srv.connections[0];
        const received = [];
        let blob = null;
        serverSide.addEventListener('/msg', body => received.push(body.n));
        serverSide.addEventListener('/blob', (body, binary) => { blob = { body, bytes: binary }; });

        const payload = new Uint8Array(600 * 1024); // > chunkSize (256KB): goes out chunked
        for (let i = 0; i < payload.length; i++) {
            payload[i] = (i * 7) & 0xff;
        }

        cutOutbound(client.socket);
        for (let n = 0; n < 15; n++) {
            client.emit('/msg', { n });
        }
        client.emit('/blob', { name: 'x' }, payload);
        for (let n = 15; n < 30; n++) {
            client.emit('/msg', { n });
        }
        expect(await waitFor(() => received.length === 30 && blob !== null, 8000)).toBe(true);
        expect(received).toEqual(Array.from({ length: 30 }, (_v, i) => i));
        expect(blob.body).toEqual({ name: 'x' });
        expect(blob.bytes.length).toBe(payload.length);
        let same = true;
        for (let i = 0; i < payload.length && same; i += 4099) {
            same = blob.bytes[i] === payload[i];
        }
        expect(same).toBe(true);
        expect(events.close).toBe(0);
        expect(events.migrated).toBeGreaterThanOrEqual(1);
        expect(srv.connections.length).toBe(1);
    });
});

describe('SessionStream (unit)', () => {
    const io = () => {
        const calls = { control: [], stalls: [] };
        const stream = new SessionStream({
            sendControl: (route, body) => calls.control.push({ route, body }),
            onStall: reason => calls.stalls.push(reason)
        }, { ackIntervalMs: 5, migrateAfterMs: 30 });
        stream.peer = true;
        return { stream, calls };
    };

    test('stamps in order and trims the retained window on ack', () => {
        const { stream } = io();
        const messages = [{}, {}, {}];
        const seqs = messages.map(m => stream.stamp(m));
        expect(seqs).toEqual([1, 2, 3]);
        messages.forEach((m, i) => stream.retain(JSON.stringify(m), seqs[i]));
        expect(stream.tx.retained.length).toBe(3);
        stream.onAck(2);
        expect(stream.tx.retained.map(e => e.seq)).toEqual([3]);
        expect(stream.retainedAbove(0).length).toBe(1);
        stream.onAck(1); // stale ack: ignored
        expect(stream.tx.retained.length).toBe(1);
        stream.dispose();
    });

    test('delivers sequenced frames exactly once, in order, and passes unsequenced ones', () => {
        const { stream } = io();
        expect(stream.onInbound({ q: 1 })).toBe(true);
        expect(stream.onInbound({ q: 2 })).toBe(true);
        expect(stream.onInbound({ q: 2 })).toBe(false); // straggler from the old transport
        expect(stream.onInbound({ q: 1 })).toBe(false);
        expect(stream.onInbound({})).toBe(true);         // control / legacy frame
        expect(stream.onInbound({ q: 3 })).toBe(true);
        expect(stream.rx.lastDelivered).toBe(3);
        stream.dispose();
    });

    test('a duplicate legacy transfer header skips its raw frames', () => {
        const { stream } = io();
        expect(stream.onInbound({ q: 1, f: 2 })).toBe(true);
        expect(stream.consumeSkippedBinary()).toBe(false);
        expect(stream.onInbound({ q: 1, f: 2 })).toBe(false);
        expect(stream.consumeSkippedBinary()).toBe(true);
        expect(stream.consumeSkippedBinary()).toBe(true);
        expect(stream.consumeSkippedBinary()).toBe(false);
        stream.dispose();
    });

    test('reports a stall when the oldest unacked frame ages past the deadline', async () => {
        const { stream, calls } = io();
        stream.retain('x', stream.stamp({}));
        await sleep(80);
        expect(calls.stalls).toEqual(['ack-timeout']);
        stream.dispose();
    });

    test('mints unguessable session ids', () => {
        const a = SessionStream.secureId(32);
        const b = SessionStream.secureId(32);
        expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
        expect(a).not.toBe(b);
    });
});
