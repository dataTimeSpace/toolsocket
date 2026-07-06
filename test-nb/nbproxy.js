// nbproxy.js — same proxy as proxy.js, but built on the ToolSocketNB layer.
// - NBServer sets maxPayload explicitly and enhances every connection.
// - /file transfers are STREAMING-RELAYED: chunks are forwarded to the target as they
//   arrive (cut-through), never reassembled at the proxy; the final client's acks flow
//   back upstream so the server is paced end-to-end by each client's link.
// - Backpressure events per socket are logged (this is where a real proxy would emit
//   its own app-level signals to clients).
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const NB = require('../src/ToolSocketNB.js');

const LOGDIR = path.join(__dirname, 'logs_nb');
const evStream = fs.createWriteStream(path.join(LOGDIR, 'proxy.events.jsonl'));
const mStream = fs.createWriteStream(path.join(LOGDIR, 'proxy.metrics.jsonl'));
function logEvent(type, data) {
    evStream.write(JSON.stringify({ t: Date.now(), type, ...data }) + '\n');
}

const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();

const clients = new Map();   // name -> enhanced IncomingToolSocket
const sockMeta = new Map();
let serverSock = null;

// Streaming relay hook: route /file transfers straight through to the addressed client.
const relay = env => {
    if (env && env.r === '/file' && env.b && env.b.to) {
        const target = clients.get(env.b.to);
        return (target && target.connected) ? target : null;
    }
    return null;
};

const tsServer = new NB.NBServer({ port: 9100 }, 'proxy', { relay });

const stats = {
    jsonIn: 0, jsonOut: 0,
    fileIn: 0, fileInBytes: 0, fileOut: 0, fileOutBytes: 0,
    relayBegins: 0, relayEnds: 0, storeAndForward: 0,
    dropped: 0, closes: [], errors: 0, backpressureEvents: [],
    peakRss: 0, peakBufTotal: 0, peakBufSingle: 0, peakBufSingleName: '',
    peakQueuedTotal: 0, fileRelays: []
};

tsServer.on('connection', sock => {
    const meta = { name: '?', kind: '?' };
    sockMeta.set(sock, meta);

    sock.on('/hello', body => {
        meta.name = body.name;
        meta.kind = body.kind;
        if (body.kind === 'server') serverSock = sock;
        else clients.set(body.name, sock);
        logEvent('hello', { name: body.name, kind: body.kind });
    });

    sock.on('/json', body => {
        stats.jsonIn++;
        // Serialize ONCE per unique (origin, networkId) among recipients, then fan out.
        const prepared = new Map();
        const str = c => {
            const k = c.origin + '|' + c.networkId;
            if (!prepared.has(k)) prepared.set(k, NB.prepare('io', '/json', body, c.origin, c.networkId));
            return prepared.get(k);
        };
        for (const [, c] of clients) {
            if (c === sock || !c.connected) continue;
            c.sendPrepared(str(c));
            stats.jsonOut++;
        }
        if (serverSock && sock !== serverSock && serverSock.connected) {
            serverSock.sendPrepared(str(serverSock));
            stats.jsonOut++;
        }
    });

    // Fallback only: fires when the relay hook declined (unknown target / legacy peer).
    sock.on('/file', (body, binaryData) => {
        stats.storeAndForward++;
        const target = clients.get(body.to);
        if (!target || !target.connected) {
            logEvent('file-target-unavailable', { to: body.to, fileId: body.fileId });
            return;
        }
        target.io('/file', body, null, binaryData);
    });

    // Observability of the streaming relay
    sock.on('nbRelay', e => {
        if (e.phase === 'begin') {
            stats.relayBegins++;
            stats.fileIn++; stats.fileOut++;
            stats.fileInBytes += e.bytes; stats.fileOutBytes += e.bytes;
            stats.fileRelays.push({ t: Date.now(), fileId: e.env.b.fileId, to: e.env.b.to, size: e.bytes });
            logEvent('relay-begin', { tid: e.tid, fileId: e.env.b.fileId, to: e.env.b.to, size: e.bytes });
        } else if (e.phase === 'end') {
            stats.relayEnds++;
            logEvent('relay-end', { tid: e.tid });
        }
    });

    // Where a real deployment would send its own app-level slow-down signals:
    sock.on('backpressure', e => {
        stats.backpressureEvents.push({ t: Date.now(), name: meta.name, level: e.level, queuedBytes: e.queuedBytes });
        logEvent('backpressure', { name: meta.name, level: e.level, queuedBytes: e.queuedBytes });
    });

    sock.on('droppedMessage', () => { stats.dropped++; logEvent('droppedMessage', { name: meta.name }); });
    sock.socket.on('close', (code, reason) => {
        stats.closes.push({ t: Date.now(), name: meta.name, code, reason: reason ? reason.toString() : '' });
        logEvent('ws-close', { name: meta.name, code, reason: reason ? reason.toString() : '' });
        clients.delete(meta.name);
        if (sock === serverSock) serverSock = null;
    });
    sock.on('error', () => { stats.errors++; });
});

setInterval(() => {
    const mem = process.memoryUsage();
    let bufTotal = 0, bufMax = 0, bufMaxName = '', queuedTotal = 0;
    for (const s of tsServer.sockets) {
        const b = s.socket ? (s.socket.bufferedAmount || 0) : 0;
        bufTotal += b;
        if (b > bufMax) { bufMax = b; bufMaxName = (sockMeta.get(s) || {}).name || '?'; }
        if (s.getBackpressure) queuedTotal += s.getBackpressure().queuedBytes;
    }
    stats.peakRss = Math.max(stats.peakRss, mem.rss);
    stats.peakBufTotal = Math.max(stats.peakBufTotal, bufTotal);
    stats.peakQueuedTotal = Math.max(stats.peakQueuedTotal, queuedTotal);
    if (bufMax > stats.peakBufSingle) { stats.peakBufSingle = bufMax; stats.peakBufSingleName = bufMaxName; }
    mStream.write(JSON.stringify({
        t: Date.now(), rss: mem.rss, external: mem.external, heapUsed: mem.heapUsed,
        sockets: tsServer.sockets.length, bufTotal, bufMax, bufMaxName, queuedTotal,
        elP50: Math.round(eld.percentile(50) / 1e6), elP99: Math.round(eld.percentile(99) / 1e6),
        elMax: Math.round(eld.max / 1e6)
    }) + '\n');
    eld.reset();
}, 250);

function shutdown() {
    const cpu = process.cpuUsage();
    stats.cpuSeconds = Math.round((cpu.user + cpu.system) / 1e4) / 100;
    fs.writeFileSync(path.join(LOGDIR, 'proxy.summary.json'), JSON.stringify(stats, null, 2));
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('[nbproxy] listening on :9100 (streaming relay enabled)');
