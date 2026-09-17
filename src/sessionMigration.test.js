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

    test('a client closing through the API ends the session on the server at once', async () => {
        const srv = await startServer(5049);
        const { client } = await connectClient(5049);
        await waitFor(() => capable(srv, client));
        const t0 = Date.now();
        client.close(); // __ts/bye goes out first: the server knows this close is deliberate
        expect(await waitFor(() => srv.closes.length === 1, 1500)).toBe(true);
        expect(Date.now() - t0).toBeLessThan(FAST.graceMs);
        expect(srv.server.sessions.has(client.__ssn.id)).toBe(false);
    });

    test('a clean close injected outside the API (middlebox-style) is a transport loss: migrate, surface nothing', async () => {
        const srv = await startServer(5050);
        const { client, events } = await connectClient(5050);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const received = [];
        serverSide.addEventListener('/msg', body => received.push(body.n));
        // a firewall / zero-trust proxy closing the flow "cleanly" on our behalf: a proper
        // close frame (1000) arrives at both ends, but nobody called toolsocket's close()
        client.socket.close(1000, 'middlebox');
        for (let n = 0; n < 5; n++) {
            client.emit('/msg', { n }); // queued through the migration, delivered after
        }
        expect(await waitFor(() => received.length === 5, 4000)).toBe(true);
        expect(received).toEqual([0, 1, 2, 3, 4]);
        expect(events.migrating).toBe(1);
        expect(events.close).toBe(0);
        expect(srv.closes.length).toBe(0);
        expect(srv.connections.length).toBe(1);
        expect(srv.server.sessions.get(client.__ssn.id)).toBe(serverSide);
    });

    test('an abnormally cut session-capable client surfaces close only after grace', async () => {
        const srv = await startServer(5046);
        const { client } = await connectClient(5046);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const t0 = Date.now();
        // the transport dies without a close frame (what a firewall or a crash looks like);
        // this client is not coming back, but the server cannot know that yet
        client.__ssn.userClosed = true;
        client._unbindSocket({ terminate: true });
        await sleep(FAST.graceMs / 2);
        expect(srv.closes.length).toBe(0); // still waiting for a successor
        expect(serverSide.connected).toBe(true); // the session reads open meanwhile
        expect(await waitFor(() => srv.closes.length === 1, FAST.graceMs * 3)).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.graceMs - 20);
        expect(srv.server.sockets).not.toContain(serverSide);
        expect(srv.server.sessions.has(client.__ssn.id)).toBe(false);
    });

    test('server forgets a session whose listeners were wiped (removeAllListeners) once grace runs out', async () => {
        const srv = await startServer(5051);
        const { client } = await connectClient(5051);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        serverSide.removeAllListeners(); // what the cloud proxy does to a superseded edge socket
        client.__ssn.userClosed = true;
        client._unbindSocket({ terminate: true }); // abnormal cut, no successor will come
        expect(await waitFor(() => !srv.server.sockets.includes(serverSide) && !srv.server.sessions.has(client.__ssn.id), FAST.graceMs * 3)).toBe(true);
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

    // ---- a working transport that refuses ONE frame ----

    // A WebSocket-aware middlebox (TLS-terminating zero-trust broker, WAF) can drop a single
    // frame and keep the flow. `times` = how often the matching frame is dropped.
    function dropMatching(ws, pattern, times) {
        const realSend = ws.send;
        const state = { dropped: 0 };
        ws.send = function (data, callback) {
            if (typeof data === 'string' && pattern.test(data) && state.dropped < times) {
                state.dropped++;
                if (typeof callback === 'function') {
                    setImmediate(callback);
                }
                return;
            }
            return realSend.apply(this, arguments);
        };
        return state;
    }

    test('one frame dropped in transit on a live transport: resent on the same socket, in order, no migration', async () => {
        const srv = await startServer(5052);
        const { client, events } = await connectClient(5052);
        await waitFor(() => capable(srv, client));
        const received = [];
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));
        const undeliverable = [];
        client.addEventListener('undeliverable', info => undeliverable.push(info));

        const drop = dropMatching(client.socket, /"n":5\}/, 1);
        for (let n = 0; n < 10; n++) {
            client.emit('/msg', { n });
        }
        expect(await waitFor(() => received.length === 10, 4000)).toBe(true);
        expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // the hole was filled BEFORE 6..9 were delivered
        expect(drop.dropped).toBe(1);
        expect(events.migrating).toBe(0); // the transport works: nothing to migrate away from
        expect(events.close).toBe(0);
        expect(undeliverable.length).toBe(0);
        await waitFor(() => client.__ssn.tx.retained.length === 0);
        expect(client.__ssn.tx.retained.length).toBe(0);
    });

    test('a frame dropped every time: given up loudly, the peer is told to skip it, the stream continues', async () => {
        const srv = await startServer(5053);
        const { client, events } = await connectClient(5053);
        await waitFor(() => capable(srv, client));
        const received = [];
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));
        const undeliverable = [];
        client.addEventListener('undeliverable', info => undeliverable.push(info));

        dropMatching(client.socket, /"n":5\}/, Infinity);
        for (let n = 0; n < 10; n++) {
            client.emit('/msg', { n });
        }
        expect(await waitFor(() => received.length === 9, 4000)).toBe(true);
        expect(received).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
        expect(undeliverable.length).toBe(1);
        expect(undeliverable[0].reason).toBe('dropped-in-transit');
        expect(undeliverable[0].route).toBe('/msg');
        expect(undeliverable[0].attempts).toBe(3);
        expect(events.migrating).toBe(0);
        expect(events.close).toBe(0);

        // and the session is not wedged behind it
        client.emit('/msg', { n: 10 });
        expect(await waitFor(() => received.length === 10)).toBe(true);
        await waitFor(() => client.__ssn.tx.retained.length === 0);
        expect(client.__ssn.tx.retained.length).toBe(0);
    });

    test('a frame that wedges every transport (MTU black hole): no endless migration — given up after N, the rest arrives', async () => {
        const srv = await startServer(5054);
        // every CLIENT-side raw socket stalls for good once the poison frame is written to it
        const WS = require('ws');
        const realSend = WS.prototype.send;
        WS.prototype.send = function (data, callback) {
            if (!this._isServer && (this.__wedged || (typeof data === 'string' && /"n":5\}/.test(data)))) {
                this.__wedged = true;
                if (typeof callback === 'function') {
                    setImmediate(callback);
                }
                return;
            }
            return realSend.apply(this, arguments);
        };
        try {
            const { client, events } = await connectClient(5054, Object.assign({}, FAST, { poisonMigrations: 3 }));
            await waitFor(() => capable(srv, client));
            const received = [];
            srv.connections[0].addEventListener('/msg', body => received.push(body.n));
            const undeliverable = [];
            client.addEventListener('undeliverable', info => undeliverable.push(info));

            for (let n = 0; n < 10; n++) {
                client.emit('/msg', { n });
            }
            expect(await waitFor(() => received.length === 9, 8000)).toBe(true);
            expect(received).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
            expect(undeliverable.length).toBe(1);
            expect(undeliverable[0].reason).toBe('stalls-every-transport');
            expect(undeliverable[0].route).toBe('/msg');
            expect(events.migrated).toBe(3);
            expect(events.close).toBe(0);
            expect(events.open).toBe(1);
            expect(srv.connections.length).toBe(1); // still the same server-side instance

            // the migrations stop once the frame is out of the way
            await sleep(600);
            expect(events.migrated).toBe(3);
            client.emit('/msg', { n: 10 });
            expect(await waitFor(() => received.length === 10)).toBe(true);
        } finally {
            WS.prototype.send = realSend;
        }
    });

    // ---- regressions from the adversarial review ----

    test('an unserializable body throws to the caller and costs nothing: no hole, later messages arrive', async () => {
        const srv = await startServer(5055);
        const { client, events } = await connectClient(5055);
        await waitFor(() => capable(srv, client));
        const received = [];
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));
        const undeliverable = [];
        client.addEventListener('undeliverable', info => undeliverable.push(info));

        client.emit('/msg', { n: 0 });
        const circular = { n: 1 };
        circular.self = circular;
        expect(() => client.emit('/msg', circular)).toThrow();
        for (let n = 2; n < 8; n++) {
            client.emit('/msg', { n });
        }
        expect(await waitFor(() => received.length === 7, 4000)).toBe(true);
        expect(received).toEqual([0, 2, 3, 4, 5, 6, 7]);
        expect(undeliverable.length).toBe(0);
        expect(events.migrating).toBe(0);
    });

    test('a number without a frame (however it came about) never wedges the stream or condemns deliverable frames', async () => {
        const srv = await startServer(5056);
        const { client, events } = await connectClient(5056);
        await waitFor(() => capable(srv, client));
        const received = [];
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));
        const undeliverable = [];
        client.addEventListener('undeliverable', info => undeliverable.push(info));

        client.emit('/msg', { n: 0 });
        await waitFor(() => received.length === 1);
        client.__ssn.tx.seq += 2;                           // two numbers burned, by whatever bug
        for (let n = 1; n < 8; n++) {
            client.emit('/msg', { n });
        }
        expect(await waitFor(() => received.length === 8, 4000)).toBe(true);
        expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(undeliverable.length).toBe(0);
        expect(events.close).toBe(0);
        await waitFor(() => client.__ssn.tx.retained.length === 0);
        expect(client.__ssn.tx.retained.length).toBe(0);
    });

    test('a skip lost in transit heals itself on the next gap report', async () => {
        const srv = await startServer(5057);
        const { client } = await connectClient(5057);
        await waitFor(() => capable(srv, client));
        const received = [];
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));
        const undeliverable = [];
        client.addEventListener('undeliverable', info => undeliverable.push(info));

        dropMatching(client.socket, /"n":5\}|__ts\/skip/, 4); // the poison frame 3x, then the first skip
        for (let n = 0; n < 10; n++) {
            client.emit('/msg', { n });
        }
        expect(await waitFor(() => received.length === 9, 5000)).toBe(true);
        expect(received).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
        expect(undeliverable.map(u => u.seq).length).toBe(1);  // only the poison frame, nothing else condemned
    });

    const blob = (byte, size) => new Uint8Array(size).fill(byte);

    test('a multi-frame binary message cut in the MIDDLE is resent whole; the next binary message is intact', async () => {
        const srv = await startServer(5058);
        const { client, events } = await connectClient(5058);
        await waitFor(() => capable(srv, client));
        const got = [];
        srv.connections[0].addEventListener('/bin', (body, binary) => got.push({ n: body.n, binary }));

        // half-open from the second raw frame on: header + first raw frame arrive, the rest vanishes
        const ws = client.socket;
        const realSend = ws.send;
        let raws = 0;
        ws.send = function (data, callback) {
            if (typeof data !== 'string') {
                raws++;
            }
            if (raws >= 2) {
                if (typeof callback === 'function') {
                    setImmediate(callback);
                }
                return;
            }
            return realSend.apply(this, arguments);
        };
        client.emit('/bin', { n: 1 }, [blob(1, 64), blob(2, 64), blob(3, 64)]);
        client.emit('/bin', { n: 2 }, [blob(7, 32), blob(8, 32)]);

        expect(await waitFor(() => got.length === 2, 5000)).toBe(true);
        expect(got.map(g => g.n)).toEqual([1, 2]);
        expect(got[0].binary.map(b => [b.length, b[0]])).toEqual([[64, 1], [64, 2], [64, 3]]);
        expect(got[1].binary.map(b => [b.length, b[0]])).toEqual([[32, 7], [32, 8]]);
        expect(events.migrated).toBe(1);
        expect(events.close).toBe(0);
    });

    test('a RAW frame dropped on a live transport: the unit is resent whole, nothing is delivered corrupt', async () => {
        const srv = await startServer(5059);
        const { client, events } = await connectClient(5059);
        await waitFor(() => capable(srv, client));
        const got = [];
        srv.connections[0].addEventListener('/bin', (body, binary) => got.push({ n: body.n, binary }));
        srv.connections[0].addEventListener('/msg', body => got.push({ n: body.n }));

        const ws = client.socket;
        const realSend = ws.send;
        let raws = 0;
        ws.send = function (data) {
            if (typeof data !== 'string' && ++raws === 2) {
                return; // the second raw frame of the first unit is dropped, once
            }
            return realSend.apply(this, arguments);
        };
        client.emit('/bin', { n: 1 }, [blob(1, 64), blob(2, 64), blob(3, 64)]);
        client.emit('/msg', { n: 2 });
        client.emit('/bin', { n: 3 }, [blob(9, 16)]);

        expect(await waitFor(() => got.length === 3, 5000)).toBe(true);
        expect(got.map(g => g.n)).toEqual([1, 2, 3]);
        expect(got[0].binary.map(b => [b.length, b[0]])).toEqual([[64, 1], [64, 2], [64, 3]]);
        expect(got[2].binary.map(b => [b.length, b[0]])).toEqual([[16, 9]]);
        expect(events.migrating).toBe(0);
    });

    test('a v1 session peer is never waited on: the hole is delivered past, the stream keeps flowing', async () => {
        const srv = await startServer(5060);
        const { client } = await connectClient(5060);
        await waitFor(() => capable(srv, client));
        srv.connections[0].__ssn.peerVersion = 1;           // as if the client were the first session build
        const received = [];
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));
        dropMatching(client.socket, /"n":2\}/, 1);
        for (let n = 0; n < 6; n++) {
            client.emit('/msg', { n });
        }
        expect(await waitFor(() => received.length === 5, 3000)).toBe(true);
        expect(received).toEqual([0, 1, 3, 4, 5]);           // lost like on v1 — but never wedged
        client.emit('/msg', { n: 6 });
        expect(await waitFor(() => received.length === 6)).toBe(true);
    });

    test('server: adoptions by a client that cannot COMPLETE a migration are no evidence against a frame', async () => {
        const srv = await startServer(5061, Object.assign({}, FAST, { poisonMigrations: 2 }));
        const WS = require('ws');
        const realSend = WS.prototype.send;
        let downstreamDead = false;
        WS.prototype.send = function (data, callback) {
            if (downstreamDead && this._isServer) {          // nothing reaches the client
                if (typeof callback === 'function') {
                    setImmediate(callback);
                }
                return;
            }
            return realSend.apply(this, arguments);
        };
        try {
            const { client, events } = await connectClient(5061);
            await waitFor(() => capable(srv, client));
            const serverSide = srv.connections[0];
            const undeliverable = [];
            serverSide.addEventListener('undeliverable', info => undeliverable.push(info));
            let adoptions = 0;
            serverSide.addEventListener('__ts:migrated', () => adoptions++);
            const down = [];
            client.addEventListener('/down', body => down.push(body.n));

            downstreamDead = true;
            serverSide.emit('/down', { n: 1 });                // retained on the server, cannot arrive
            client.emit('/up', { n: 1 });                      // unacked on the client -> it keeps migrating
            expect(await waitFor(() => adoptions >= 4, 8000)).toBe(true);
            expect(undeliverable.length).toBe(0);              // far past poisonMigrations, yet not condemned
            downstreamDead = false;
            expect(await waitFor(() => down.length === 1, 6000)).toBe(true);
            expect(undeliverable.length).toBe(0);
            expect(events.close).toBe(0);
        } finally {
            WS.prototype.send = realSend;
        }
    });

    test('NB: a prepared frame is sequenced (survives a cut exactly once) and never causes a spurious migration', async () => {
        const server = new ToolSocket.Server({ port: 5062, session: FAST }, 'server');
        running.push(server);
        const conns = [];
        server.addEventListener('connection', socket => {
            NB.enhance(socket, { reconnect: false });
            conns.push(socket);
        });
        await new Promise(resolve => server.addEventListener('listening', resolve));
        const { client, events } = await connectClient(5062);
        NB.enhance(client, { reconnect: false });
        await waitFor(() => conns.length === 1 && client.__ssn.peer === true && conns[0].__ssn.peer === true);
        const received = [];
        conns[0].addEventListener('/p', body => received.push(body.n));

        client.emit('/warm', {});
        await waitFor(() => client.__ssn.tx.retained.length === 0);
        client.sendPrepared(NB.prepare('io', '/p', { n: 1 }, 'client', 'testnet'));
        expect(await waitFor(() => received.length === 1)).toBe(true);
        await sleep(500);                                    // > the stall deadline: a stale retention would migrate here
        expect(events.migrating).toBe(0);
        expect(client.__ssn.tx.retained.length).toBe(0);

        cutOutbound(client.socket);
        client.sendPrepared(NB.prepare('io', '/p', { n: 2 }, 'client', 'testnet'));
        expect(await waitFor(() => received.length === 2, 4000)).toBe(true);
        await sleep(300);
        expect(received).toEqual([1, 2]);                    // exactly once
    });

    test('NB: a transfer whose frame was given up is cancelled on both ends instead of hanging half-acked', async () => {
        const srv = await startServer(5063);
        const { client } = await connectClient(5063);
        NB.enhance(client, { reconnect: false });
        await waitFor(() => capable(srv, client));
        const cancelled = [];
        client.addEventListener('transferCancelled', info => cancelled.push(info));
        const aborts = [];
        srv.connections[0].addEventListener('__tsnb/abort', body => aborts.push(body.t));
        client.triggerEvent('undeliverable', { seq: 9, reason: 'dropped-in-transit', route: '__tsnb/c', tid: 'T1' });
        client.triggerEvent('undeliverable', { seq: 10, reason: 'dropped-in-transit', route: '/app' }); // not NB's business
        expect(cancelled).toEqual([{ tid: 'T1', reason: 'undeliverable' }]);
        expect(await waitFor(() => aborts.length === 1)).toBe(true);
        expect(aborts).toEqual(['T1']);
    });

    // ---- regressions from the second review (of the fix itself) ----

    test('a multi-frame transfer LONGER than the stall deadline is not a dead transport: progress keeps it alive', async () => {
        const srv = await startServer(5064);
        const { client, events } = await connectClient(5064);
        await waitFor(() => capable(srv, client));
        const got = [];
        srv.connections[0].addEventListener('/bin', (body, binary) => got.push({ n: body.n, binary }));
        const undeliverable = [];
        client.addEventListener('undeliverable', info => undeliverable.push(info));

        // a slow link, strictly in order: every binary frame takes 50ms to go out
        const ws = client.socket;
        const realSend = ws.send;
        const queue = [];
        let draining = false;
        const drain = () => {
            const item = queue.shift();
            if (!item) {
                draining = false;
                return;
            }
            realSend.apply(ws, item);
            setTimeout(drain, typeof item[0] === 'string' ? 0 : 50);
        };
        ws.send = function () {
            queue.push(Array.from(arguments));
            if (!draining) {
                draining = true;
                drain();
            }
        };
        const frames = Array.from({ length: 12 }, (_v, i) => blob(i + 1, 32)); // ~600ms >> the 150ms deadline
        client.emit('/bin', { n: 1 }, frames);

        expect(await waitFor(() => got.length === 1, 5000)).toBe(true);
        expect(got[0].binary.map(b => b[0])).toEqual(frames.map(f => f[0]));
        expect(events.migrating).toBe(0);
        expect(undeliverable.length).toBe(0);
    });

    test('a session RESET carries nothing over: no half-received unit, and both ends agree on the version', async () => {
        const srv = await startServer(5065);
        const { client, events } = await connectClient(5065);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const got = [];
        client.addEventListener('/msg', body => got.push({ n: body.n }));
        client.addEventListener('/single', (body, binary) => got.push({ n: body.n, bytes: binary }));

        // downstream goes half-open in the MIDDLE of a unit: header + first raw frame arrive
        const ws = serverSide.socket;
        const realSend = ws.send;
        let raws = 0;
        ws.send = function (data, callback) {
            if (typeof data !== 'string') {
                raws++;
            }
            if (raws >= 2) {
                if (typeof callback === 'function') {
                    setImmediate(callback);
                }
                return;
            }
            return realSend.apply(this, arguments);
        };
        serverSide.emit('/bin', { n: 1 }, [blob(1, 64), blob(2, 64), blob(3, 64)]);
        await sleep(80);
        expect(client.__ssn.rx.pending).not.toBe(null);

        srv.server.sessions.delete(client.__ssn.id);         // the server lost the session (restart)
        client.emit('/up', {});                              // unacked -> the client dials a successor
        expect(await waitFor(() => srv.connections.length === 2 && events.open === 2, 5000)).toBe(true);
        const fresh = srv.connections[1];
        expect(fresh.__ssn.peerVersion).toBe(2);
        expect(client.__ssn.peerVersion).toBe(2);
        expect(client.__ssn.rx.pending).toBe(null);

        fresh.emit('/msg', { n: 2 });
        fresh.emit('/single', { n: 3 }, blob(5, 48));        // an enveloped binary message
        fresh.emit('/msg', { n: 4 });
        expect(await waitFor(() => got.length === 3, 4000)).toBe(true);
        expect(got.map(g => g.n)).toEqual([2, 3, 4]);
        expect([got[1].bytes.length, got[1].bytes[0]]).toEqual([48, 5]);
    });

    test('an over-full retained window never breaks the write in progress: send() does not throw, nothing is lost', async () => {
        const srv = await startServer(5066);
        const { client, events } = await connectClient(5066, Object.assign({}, FAST, { retainMaxBytes: 1000 }));
        await waitFor(() => capable(srv, client));
        const received = [];
        srv.connections[0].addEventListener('/big', body => received.push(body.s.length));
        srv.connections[0].addEventListener('/msg', body => received.push(body.n));

        expect(() => client.emit('/big', { s: 'x'.repeat(2000) })).not.toThrow();
        expect(() => client.emit('/msg', { n: 1 })).not.toThrow();
        expect(await waitFor(() => received.length === 2, 4000)).toBe(true);
        expect(received).toEqual([2000, 1]);
        await sleep(400);                                    // an internal ping must not blow up either
        client.emit('/msg', { n: 2 });
        expect(await waitFor(() => received.length === 3, 4000)).toBe(true);
        expect(events.close).toBe(0);
    });

    test('a RAW frame lost, and the next frame is an enveloped BINARY message: it is not swallowed into the unit', async () => {
        const srv = await startServer(5067);
        const { client } = await connectClient(5067);
        await waitFor(() => capable(srv, client));
        const got = [];
        srv.connections[0].addEventListener('/bin', (body, binary) => got.push({ n: body.n, shape: binary.map(b => [b.length, b[0]]) }));
        srv.connections[0].addEventListener('/single', (body, binary) => got.push({ n: body.n, shape: [binary.length, binary[0]] }));

        const ws = client.socket;
        const realSend = ws.send;
        let binaries = 0;
        ws.send = function (data) {
            if (typeof data !== 'string' && ++binaries === 2) {
                return; // the second raw frame of the unit is dropped, once
            }
            return realSend.apply(this, arguments);
        };
        client.emit('/bin', { n: 1 }, [blob(1, 64), blob(2, 64), blob(3, 64)]);
        client.emit('/single', { n: 2 }, blob(9, 40));

        expect(await waitFor(() => got.length === 2, 5000)).toBe(true);
        expect(got).toEqual([
            { n: 1, shape: [[64, 1], [64, 2], [64, 3]] },
            { n: 2, shape: [40, 9] }
        ]);
    });

    test('outbound black-holed while the peer keeps STREAMING to us: inbound traffic must not hide the loss of a button press', async () => {
        const srv = await startServer(5068);
        const { client, events } = await connectClient(5068);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const buttons = [];
        serverSide.addEventListener('/btn', body => buttons.push(body.n));
        let streamed = 0;
        client.addEventListener('/stream', () => streamed++);
        const stream = setInterval(() => {
            try {
                serverSide.emit('/stream', { t: 1 });
            } catch (_e) { /* between transports */ }
        }, 20);
        try {
            await waitFor(() => streamed > 5);
            cutOutbound(client.socket);                      // our clicks vanish; their stream keeps arriving
            client.emit('/btn', { n: 1 });
            // the client sees a lively transport and must not rely on itself: the SERVER gets no
            // acks and hears nothing, declares the stall, and the session moves
            expect(await waitFor(() => buttons.length === 1, 5000)).toBe(true);
            expect(buttons).toEqual([1]);
            expect(events.close).toBe(0);
            expect(events.migrated).toBeGreaterThanOrEqual(1);
        } finally {
            clearInterval(stream);
        }
    });

    test('a gap REPORT lost in transit while the peer keeps streaming: the reminder heals it, nothing wedges', async () => {
        const srv = await startServer(5069);
        const { client, events } = await connectClient(5069);
        await waitFor(() => capable(srv, client));
        const serverSide = srv.connections[0];
        const received = [];
        serverSide.addEventListener('/msg', body => received.push(body.n));
        let streamed = 0;
        client.addEventListener('/stream', () => streamed++);
        const stream = setInterval(() => {
            try {
                serverSide.emit('/stream', { t: 1 });
            } catch (_e) { /* between transports */ }
        }, 20);
        const undeliverable = [];
        client.addEventListener('undeliverable', info => undeliverable.push(info));
        try {
            await waitFor(() => streamed > 5);
            dropMatching(client.socket, /"n":2\}/, 1);                 // our frame is dropped once...
            dropMatching(serverSide.socket, /"g":1/, 1);               // ...and so is the peer's gap report
            for (let n = 0; n < 6; n++) {
                client.emit('/msg', { n });
            }
            expect(await waitFor(() => received.length === 6, 4000)).toBe(true);
            expect(received).toEqual([0, 1, 2, 3, 4, 5]);
            expect(undeliverable.length).toBe(0);                      // a reminder is no evidence against the frame
            expect(events.close).toBe(0);
        } finally {
            clearInterval(stream);
        }
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
        stream.peerVersion = 2;
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
        stream.completeGroup();                           // both raw frames arrived
        expect(stream.rx.lastDelivered).toBe(1);
        expect(stream.onInbound({ q: 1, f: 2 })).toBe(false);
        expect(stream.consumeSkippedBinary()).toBe(true);
        expect(stream.consumeSkippedBinary()).toBe(true);
        expect(stream.consumeSkippedBinary()).toBe(false);
        stream.dispose();
    });

    test('a hole is never delivered past, never acked past, and reported once per failed pass', () => {
        const { stream, calls } = io();
        expect(stream.onInbound({ q: 1 })).toBe(true);
        expect(stream.onInbound({ q: 3 })).toBe(false);  // 2 is missing
        expect(stream.rx.lastDelivered).toBe(1);         // the watermark must not pass the hole
        expect(stream.onInbound({ q: 4 })).toBe(false);  // same pass: no second report
        const gaps = () => calls.control.filter(c => c.route === '__ts/ack' && c.body.g);
        expect(gaps().length).toBe(1);
        expect(gaps()[0].body.w).toBe(1);
        expect(stream.onInbound({ q: 3 })).toBe(false);  // 3 came round AGAIN: a resend pass failed
        expect(gaps().length).toBe(2);
        expect(stream.onInbound({ q: 2 })).toBe(true);   // the resend fills the hole...
        expect(stream.onInbound({ q: 3 })).toBe(true);   // ...and order is restored
        expect(stream.onInbound({ q: 4 })).toBe(true);
        expect(stream.rx.lastDelivered).toBe(4);
        expect(gaps().length).toBe(2);
        stream.dispose();
    });

    test('a header dropped behind a hole takes its raw frames with it', () => {
        const { stream } = io();
        expect(stream.onInbound({ q: 2, f: 2 })).toBe(false);
        expect(stream.consumeSkippedBinary()).toBe(true);
        expect(stream.consumeSkippedBinary()).toBe(true);
        expect(stream.consumeSkippedBinary()).toBe(false);
        stream.dispose();
    });

    test('sender: repeated gap reports for the same frame end in giving up that frame as a unit', () => {
        const { stream } = io();
        const m1 = {}, m2 = {}, m3 = {};
        const q1 = stream.stamp(m1);
        stream.retain('h1', q1);
        const q2 = stream.stamp(m2);
        ['header', 'raw-a', 'raw-b'].forEach(frame => stream.retain(frame, q2));
        const q3 = stream.stamp(m3);
        stream.retain('h3', q3);
        expect(stream.noteGap(1)).toBe(null);             // releases 1, resend from 2
        expect(stream.tx.retained.map(e => e.seq)).toEqual([2, 2, 2, 3]);
        expect(stream.noteGap(1)).toBe(null);
        const given = stream.noteGap(1);
        expect(given.seq).toBe(2);
        expect(given.frames).toEqual(['header', 'raw-a', 'raw-b']); // header + its raw frames share the number
        expect(given.reason).toBe('dropped-in-transit');
        expect(stream.tx.retained.map(e => e.seq)).toEqual([3]);
        expect(stream.noteGap(0)).toBe(false);            // stale report: ignored
        stream.dispose();
    });

    test('sender: progress clears the suspicion; only the same frame surviving N migrations is given up', () => {
        const { stream } = io();
        stream.opts.poisonMigrations = 3;
        const a = stream.stamp({});
        stream.retain('a', a);
        const b = stream.stamp({});
        stream.retain('b', b);
        expect(stream.noteCarried()).toBe(null);
        expect(stream.noteCarried()).toBe(null);
        stream.onAck(1);                                   // 'a' got through: 'b' starts from zero
        expect(stream.noteCarried()).toBe(null);
        expect(stream.noteCarried()).toBe(null);
        const given = stream.noteCarried();
        expect(given.seq).toBe(2);
        expect(given.reason).toBe('stalls-every-transport');
        expect(stream.tx.retained.length).toBe(0);
        stream.dispose();
    });

    test('receiver: a skip moves the watermark up to the given number, never backwards', () => {
        const { stream, calls } = io();
        stream.onInbound({ q: 1 });
        stream.onSkip(1);                                  // at or below the watermark: ignored
        expect(stream.rx.lastDelivered).toBe(1);
        stream.onSkip(3);                                  // the sender holds no frame for 2..3
        expect(stream.rx.lastDelivered).toBe(3);
        expect(calls.control[calls.control.length - 1]).toEqual({ route: '__ts/ack', body: { w: 3 } });
        stream.onSkip(2);                                  // late/repeated: ignored
        expect(stream.rx.lastDelivered).toBe(3);
        expect(stream.onInbound({ q: 4 })).toBe(true);
        stream.dispose();
    });

    test('a multi-frame unit is acked at its LAST raw frame; a cut or a lost raw frame resends the whole unit', () => {
        const { stream, calls } = io();
        stream.onInbound({ q: 1 });
        expect(stream.onInbound({ q: 2, f: 3 })).toBe(true);   // header accepted...
        expect(stream.rx.lastDelivered).toBe(1);                // ...but NOT delivered/acked yet
        // a raw frame was lost on a live transport: the next sequenced frame exposes it
        expect(stream.onInbound({ q: 3 })).toBe(false);
        expect(stream.takePartialDrop()).toBe(true);            // owner must discard the half buffer
        expect(stream.takePartialDrop()).toBe(false);
        const gap = calls.control.filter(c => c.body.g);
        expect(gap.length).toBe(1);
        expect(gap[0].body.w).toBe(1);                          // resend from the HEADER
        expect(stream.onInbound({ q: 2, f: 3 })).toBe(true);    // the unit comes again
        stream.completeGroup();
        expect(stream.rx.lastDelivered).toBe(2);
        expect(stream.onInbound({ q: 3 })).toBe(true);
        // a transport replaced mid-unit voids the half-received unit too
        expect(stream.onInbound({ q: 4, f: 2 })).toBe(true);
        stream.onTransportAttached();
        expect(stream.takePartialDrop()).toBe(true);
        expect(stream.rx.lastDelivered).toBe(3);
        stream.dispose();
    });

    test('a v1 session peer keeps the lenient v1 behaviour: a hole is logged, delivered past, never waited on', () => {
        const { stream, calls } = io();
        stream.peerVersion = 1;
        expect(stream.onInbound({ q: 1 })).toBe(true);
        expect(stream.onInbound({ q: 3 })).toBe(true);
        expect(stream.rx.lastDelivered).toBe(3);
        expect(calls.control.filter(c => c.body.g).length).toBe(0);
        stream.dispose();
    });

    test('sender: a number it holds no frame for is skipped, never blamed on a deliverable frame', () => {
        const { stream } = io();
        const a = stream.stamp({});
        stream.retain('a', a);
        const burned = stream.stamp({});                   // stamped, never written
        const c = stream.stamp({});
        stream.retain('c', c);
        expect([a, burned, c]).toEqual([1, 2, 3]);
        expect(stream.noteGap(1)).toBe(null);              // receiver waits for 2
        expect(stream.unheldAbove(1)).toBe(2);             // -> tell it to skip to 2
        expect(stream.tx.suspect).toBe(null);              // frame 3 is NOT accused
        expect(stream.noteGap(1)).toBe(null);
        expect(stream.noteGap(1)).toBe(null);              // however often: never given up
        expect(stream.tx.retained.map(e => e.seq)).toEqual([3]);
        expect(stream.noteCarried()).toBe(null);           // nor by migrations
        stream.onAck(3);
        expect(stream.unheldAbove(3)).toBe(null);
        stream.dispose();
    });

    test('a failed build takes its number back; the first frame on a fresh transport is acked at once', () => {
        const { stream, calls } = io();
        const message = {};
        expect(stream.stamp(message)).toBe(1);
        stream.unstampLast(message);
        expect(message.q).toBeUndefined();
        expect(stream.stamp({})).toBe(1);                  // no hole
        stream.onTransportAttached();
        const before = calls.control.length;
        stream.onInbound({ q: 1 });
        expect(calls.control.length).toBe(before + 1);     // immediate, not coalesced
        expect(calls.control[before]).toEqual({ route: '__ts/ack', body: { w: 1 } });
        stream.dispose();
    });

    test('inbound traffic postpones a stall but never cancels it; a reminder is no evidence against a frame', async () => {
        const calls = { control: [], stalls: [] };
        const stream = new SessionStream({
            sendControl: (route, body) => calls.control.push({ route, body }),
            onStall: reason => calls.stalls.push(reason)
        }, { migrateAfterMs: 40, stallInboundGraceMs: 160 });
        stream.peer = true;
        stream.peerVersion = 2;
        stream.retain('a', stream.stamp({}));
        const chatter = setInterval(() => stream.noteInbound(), 10);   // the peer never stops sending
        await sleep(100);
        expect(calls.stalls.length).toBe(0);                           // past the deadline, but excused
        await sleep(140);
        clearInterval(chatter);
        expect(calls.stalls).toEqual(['ack-timeout']);                 // ...not past the grace
        const b = stream.stamp({});
        stream.retain('b', b);
        expect(stream.noteGap(0, true)).toBe(null);
        expect(stream.noteGap(0, true)).toBe(null);
        expect(stream.noteGap(0, true)).toBe(null);
        expect(stream.noteGap(0, true)).toBe(null);                    // reminders never add up to a give-up
        expect(stream.tx.retained.length).toBe(2);
        stream.dispose();
    });

    test('reports a stall when the oldest unacked frame ages past the deadline', async () => {
        const { stream, calls } = io();
        stream.retain('x', stream.stamp({}));
        await sleep(80);
        expect(calls.stalls).toEqual(['ack-timeout']);
        stream.dispose();
    });

    test('adapts the stall deadline to observed ack latency, within floor and cap', () => {
        // production-shaped config: 1s floor, 8s cap, 200ms slack
        const stream = new SessionStream({ sendControl: () => {}, onStall: () => {} },
            { migrateAfterMs: 1000, migrateAfterMaxMs: 8000, migrateSlackMs: 200, ackIntervalMs: 5 });
        stream.peer = true;
        expect(stream.deadline()).toBe(1000); // floor before any sample
        const feed = (latencyMs, n) => {
            for (let i = 0; i < n; i++) {
                const seq = stream.stamp({});
                stream.tx.retained.push({ seq, frame: 'x', at: Date.now() - latencyMs });
                stream.onAck(seq);
            }
        };
        feed(100, 10);                     // fast link (100ms write->ack): stays at the floor
        expect(stream.deadline()).toBe(1000);
        feed(2500, 20);                    // a 2.5s delay wave: deadline rises well above it
        expect(stream.deadline()).toBeGreaterThan(2500);
        expect(stream.deadline()).toBeLessThanOrEqual(8000);
        feed(20000, 20);                   // pathological: capped
        expect(stream.deadline()).toBe(8000);
        stream.dispose();
    });

    test('mints unguessable session ids', () => {
        const a = SessionStream.secureId(32);
        const b = SessionStream.secureId(32);
        expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
        expect(a).not.toBe(b);
    });
});
