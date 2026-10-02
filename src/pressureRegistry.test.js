/* global test, expect, afterEach, jest */
// NB's process-wide pressure registry (see ToolSocketNB.js) holds an entry per enhanced
// socket and samples them on an interval while it has any. A socket leaves the registry when
// its close surfaces, so every way an application ends a socket for good must surface one:
// otherwise the entry, its socket, and the sampler outlive it for the rest of the process.
const ToolSocket = require('./index.js');
const NB = require('./ToolSocketNB.js');

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

const registry = () => globalThis[Symbol.for('toolsocketnb.pressure.v1')];
const registered = () => NB.pressure.state().sockets;

const running = [];
afterEach(async () => {
    while (running.length) {
        try {
            running.pop().close();
        } catch (_e) { /* already closed */ }
    }
    await waitFor(() => registered() === 0);
});

function startServer() {
    const server = new ToolSocket.Server({ port: 0 }, 'server');
    server.addEventListener('connection', socket => NB.enhance(socket, { reconnect: false }));
    running.push(server);
    return new Promise(resolve => server.server.on('listening', () => {
        resolve({ server, url: `ws://127.0.0.1:${server.server.address().port}` });
    }));
}

function opened(socket) {
    return new Promise(resolve => socket.addEventListener('open', resolve));
}

test('closing a server releases its connections from the registry', async () => {
    const { server, url } = await startServer();
    // a legacy client, as most of the edge server's own are, and an NB one
    const legacy = new ToolSocket(new URL(url), 'testnet', 'web');
    const nb = NB.connect(url, 'testnet', 'web', { reconnect: false });
    await Promise.all([opened(legacy), opened(nb)]);
    // the server's two connections and the NB client
    expect(await waitFor(() => registered() === 3)).toBe(true);
    expect(registry().timer).not.toBe(null);

    const closed = [legacy, nb].map(socket => new Promise(resolve => socket.addEventListener('close', resolve)));
    server.close();
    await Promise.all(closed);
    expect(await waitFor(() => registered() === 0)).toBe(true);
    expect(registry().timer).toBe(null);
});

test('closing a server closes connections to peers without the session layer', async () => {
    const { server, url } = await startServer();
    // a plain WebSocket never answers the session handshake, so it is never told __ts/bye
    const WebSocket = require('ws');
    const peer = new WebSocket(url);
    peer.on('error', () => {});
    await new Promise(resolve => peer.on('open', resolve));
    expect(await waitFor(() => registered() === 1)).toBe(true);

    const peerClosed = new Promise(resolve => peer.on('close', resolve));
    server.close();
    await peerClosed;
    expect(await waitFor(() => registered() === 0)).toBe(true);
    expect(registry().timer).toBe(null);
});

test('closing a server surfaces the close of a session held in grace', async () => {
    const server = new ToolSocket.Server({ port: 0, session: { graceMs: 60000 } }, 'server');
    running.push(server);
    await new Promise(resolve => server.server.on('listening', resolve));
    const url = `ws://127.0.0.1:${server.server.address().port}`;
    const connected = new Promise(resolve => server.addEventListener('connection', resolve));
    const client = new ToolSocket(new URL(url), 'testnet', 'web');
    running.push(client);
    const incoming = await connected;
    NB.enhance(incoming, { reconnect: false });
    await opened(client);
    expect(await waitFor(() => incoming.__ssn.peer === true)).toBe(true);
    expect(registered()).toBe(1);

    // the transport drops without a toolsocket close(): the server holds the session for a
    // successor that, with the client's migration stopped, never comes
    client.__ssn.userClosed = true;
    client.socket.terminate();
    expect(await waitFor(() => incoming.__ssn.inGrace())).toBe(true);

    const incomingClosed = new Promise(resolve => incoming.addEventListener('close', resolve));
    server.close();
    await incomingClosed;
    expect(registered()).toBe(0);
});

test('a close listener that throws does not stop the server closing the rest', async () => {
    const server = new ToolSocket.Server({ port: 0, session: { graceMs: 60000 } }, 'server');
    running.push(server);
    await new Promise(resolve => server.server.on('listening', resolve));
    const url = `ws://127.0.0.1:${server.server.address().port}`;
    server.addEventListener('connection', socket => NB.enhance(socket, { reconnect: false }));
    const clients = [];
    for (let i = 0; i < 2; i++) {
        const client = new ToolSocket(new URL(url), 'testnet', 'web');
        running.push(client);
        clients.push(client);
        await opened(client);
    }
    expect(await waitFor(() => server.sockets.length === 2 && server.sockets.every(s => s.__ssn.peer === true))).toBe(true);
    expect(registered()).toBe(2);

    // both sessions held in grace, so server.close() surfaces their closes, and so runs their
    // listeners, synchronously
    for (const client of clients) {
        client.__ssn.userClosed = true;
        client.socket.terminate();
    }
    expect(await waitFor(() => server.sockets.every(s => s.__ssn.inGrace()))).toBe(true);

    const [first, second] = server.sockets;
    const listenerError = new Error('application close listener');
    first.addEventListener('close', () => {
        throw listenerError;
    });
    let secondClosed = false;
    second.addEventListener('close', () => {
        secondClosed = true;
    });

    expect(() => server.close()).toThrow(listenerError);
    expect(secondClosed).toBe(true);
    expect(server.sockets.length).toBe(0);
    expect(registered()).toBe(0);
    expect(registry().timer).toBe(null);
    expect(server.server.address()).toBe(null); // stopped listening
});

test('closing a reconnecting client releases it from the registry', async () => {
    const { url } = await startServer();
    const client = NB.connect(url, 'testnet', 'web', { reconnect: true });
    await opened(client);
    // once the session handshake is done, a close is sent as __ts/bye, so the server's end
    // closes at once rather than waiting out its grace for a successor
    expect(await waitFor(() => client.__ssn.peer === true)).toBe(true);
    expect(await waitFor(() => registered() === 2)).toBe(true);

    const clientClosed = new Promise(resolve => client.addEventListener('close', resolve));
    client.close();
    await clientClosed;
    // the server's end goes when the client's close reaches it
    expect(await waitFor(() => registered() === 0)).toBe(true);
    expect(registry().timer).toBe(null);
});
