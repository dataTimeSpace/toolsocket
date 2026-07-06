// proxy.js — ToolSocket-based proxy.
// - Is the ToolSocket server for all clients (A, B) and for the collector server.
// - Broadcasts every /json message from any client to all other clients and the server.
// - Relays /file messages (JSON header + binary payload) from the server to the target client.
// Instrumentation: RSS, ws bufferedAmount per socket, event-loop delay, relay counters, drop/close events.
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const ToolSocket = require(process.env.LIB || '../src/index.js');

const LOGDIR = process.env.LOGDIR ? (path.isAbsolute(process.env.LOGDIR)?process.env.LOGDIR:path.join(__dirname,process.env.LOGDIR)) : path.join(__dirname, 'logs');
fs.mkdirSync(LOGDIR,{recursive:true});
const evStream = fs.createWriteStream(path.join(LOGDIR, 'proxy.events.jsonl'));
const mStream = fs.createWriteStream(path.join(LOGDIR, 'proxy.metrics.jsonl'));
function logEvent(type, data) {
    evStream.write(JSON.stringify({ t: Date.now(), type, ...data }) + '\n');
}

const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();

// NOTE: intentionally NOT setting maxPayload here — ToolSocketServer passes options
// straight to ws.Server, and a "naive" proxy built on this library would not know
// that ws defaults maxPayload to 100 MiB while the ToolSocket *client* side sets 3000 MiB.
const tsServer = new ToolSocket.Server({ port: 9100 }, 'proxy');

const clients = new Map();   // name -> IncomingToolSocket
const sockMeta = new Map();  // IncomingToolSocket -> {name, kind}
let serverSock = null;

const stats = {
    jsonIn: 0, jsonOut: 0,
    fileIn: 0, fileInBytes: 0, fileOut: 0, fileOutBytes: 0,
    dropped: 0, closes: [], errors: 0,
    peakRss: 0, peakBufTotal: 0, peakBufSingle: 0, peakBufSingleName: '',
    fileRelays: []
};

tsServer.on('connection', sock => {
    const meta = { name: '?', kind: '?' };
    sockMeta.set(sock, meta);

    sock.on('/hello', body => {
        meta.name = body.name;
        meta.kind = body.kind;
        if (body.kind === 'server') {
            serverSock = sock;
        } else {
            clients.set(body.name, sock);
        }
        logEvent('hello', { name: body.name, kind: body.kind });
    });

    // Broadcast JSON messages from any client to all other clients and the server
    sock.on('/json', body => {
        stats.jsonIn++;
        for (const [name, c] of clients) {
            if (c === sock) continue;
            if (!c.connected) continue;
            c.io('/json', body);
            stats.jsonOut++;
        }
        if (serverSock && sock !== serverSock && serverSock.connected) {
            serverSock.io('/json', body);
            stats.jsonOut++;
        }
    });

    // Relay binary files from the server to the addressed client
    sock.on('/file', (body, binaryData) => {
        stats.fileIn++;
        stats.fileInBytes += binaryData ? binaryData.length : 0;
        const target = clients.get(body.to);
        if (!target || !target.connected) {
            logEvent('file-target-unavailable', { to: body.to, fileId: body.fileId });
            return;
        }
        const t0 = Date.now();
        target.io('/file', body, null, binaryData);
        const buffered = target.socket.bufferedAmount || 0;
        stats.fileOut++;
        stats.fileOutBytes += binaryData ? binaryData.length : 0;
        stats.fileRelays.push({
            t: t0, fileId: body.fileId, to: body.to, size: body.size,
            bufferedAfterSend: buffered, relayCallMs: Date.now() - t0
        });
        logEvent('file-relay', { fileId: body.fileId, to: body.to, size: body.size, bufferedAfterSend: buffered });
    });

    sock.on('droppedMessage', () => {
        stats.dropped++;
        logEvent('droppedMessage', { name: meta.name });
    });

    // Raw ws-level close to capture close codes (e.g. 1009 = message too big)
    sock.socket.on('close', (code, reason) => {
        stats.closes.push({ t: Date.now(), name: meta.name, code, reason: reason ? reason.toString() : '' });
        logEvent('ws-close', { name: meta.name, code, reason: reason ? reason.toString() : '' });
        clients.delete(meta.name);
        if (sock === serverSock) serverSock = null;
    });
    sock.on('error', () => { stats.errors++; });
});

// Metrics sampling
setInterval(() => {
    const mem = process.memoryUsage();
    let bufTotal = 0, bufMax = 0, bufMaxName = '';
    for (const s of tsServer.sockets) {
        const b = s.socket.bufferedAmount || 0;
        bufTotal += b;
        if (b > bufMax) { bufMax = b; bufMaxName = (sockMeta.get(s) || {}).name || '?'; }
    }
    stats.peakRss = Math.max(stats.peakRss, mem.rss);
    stats.peakBufTotal = Math.max(stats.peakBufTotal, bufTotal);
    if (bufMax > stats.peakBufSingle) { stats.peakBufSingle = bufMax; stats.peakBufSingleName = bufMaxName; }
    mStream.write(JSON.stringify({
        t: Date.now(), rss: mem.rss, external: mem.external, heapUsed: mem.heapUsed,
        sockets: tsServer.sockets.length, bufTotal, bufMax, bufMaxName,
        elP50: Math.round(eld.percentile(50) / 1e6), elP99: Math.round(eld.percentile(99) / 1e6),
        elMax: Math.round(eld.max / 1e6)
    }) + '\n');
    eld.reset();
}, 250);

function shutdown() {
    fs.writeFileSync(path.join(LOGDIR, 'proxy.summary.json'), JSON.stringify(stats, null, 2));
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('[proxy] listening on :9100');
