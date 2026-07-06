// nb_priority.js — validates priority classes, JSON preemption, backpressure events,
// pauseSends/resumeSends and flushQueued over a 20 Mbit/s throttled link.
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const NB = require('../src/ToolSocketNB.js');

// 20 Mbit/s tunnel :9411 -> :9410
fs.writeFileSync('/tmp/nbprio_tun.json', JSON.stringify([{ name: 't', listen: 9411, target: 9410, mbit: 20 }]));
const tun = spawn('node', [path.join(__dirname, 'throttle.js'), '/tmp/nbprio_tun.json'], { stdio: 'ignore' });

const server = new NB.NBServer({ port: 9410 }, 'server');
const order = [];
const jsonLat = [];
let sender = null;

server.on('connection', sock => {
    sock.on('/file', body => order.push({ id: body.name, at: Date.now() }));
    sock.on('/json', body => jsonLat.push(Date.now() - body.sentAt));
});

const client = NB.connect('ws://127.0.0.1:9411', 'testnet', 'web');
const bpEvents = [];
client.on('backpressure', e => bpEvents.push({ level: e.level, queuedMB: +(e.queuedBytes / 1e6).toFixed(1) }));
client.on('transferCancelled', e => bpEvents.push({ cancelled: e.tid }));

client.on('open', () => {
    if (sender) return; sender = true;
    console.log('PHASE 1: enqueue rad(20MB, class5) FIRST, then png(10MB, class3), then css(6MB, class2), plus JSON every 100ms');
    const t0 = Date.now();
    client.io('/file', { name: 'big.rad', type: 'rad' }, null, new Uint8Array(crypto.randomBytes(20 * 1e6)));
    client.io('/file', { name: 'img.png', type: 'png' }, null, new Uint8Array(crypto.randomBytes(10 * 1e6)));
    client.io('/file', { name: 'style.css', type: 'css' }, null, new Uint8Array(crypto.randomBytes(6 * 1e6)));
    const ji = setInterval(() => client.io('/json', { sentAt: Date.now() }), 100);

    const waitDone = setInterval(() => {
        if (order.length === 3) {
            clearInterval(waitDone); clearInterval(ji);
            console.log('completion order:', order.map(o => `${o.id}@+${((o.at - t0) / 1000).toFixed(1)}s`).join('  '));
            const lat = jsonLat.slice().sort((a, b) => a - b);
            console.log(`JSON during transfers: n=${lat.length} p50=${lat[Math.floor(lat.length * .5)]}ms p95=${lat[Math.floor(lat.length * .95)]}ms max=${lat[lat.length - 1]}ms`);
            phase2();
        }
    }, 100);
});

function phase2() {
    console.log('\nPHASE 2: pauseSends(2) gates a 30MB rad; JSON still flows; then flushQueued(2) aborts it');
    client.pauseSends(2);
    client.io('/file', { name: 'never.rad', type: 'rad' }, null, new Uint8Array(crypto.randomBytes(30 * 1e6)));
    const before = client.getBackpressure();
    jsonLat.length = 0;
    let n = 0;
    const ji = setInterval(() => { client.io('/json', { sentAt: Date.now() }); if (++n >= 10) clearInterval(ji); }, 50);
    setTimeout(() => {
        const lat = jsonLat.slice().sort((a, b) => a - b);
        console.log(`while paused: queued=${(before.queuedBytes / 1e6).toFixed(1)}MB (class5=${(before.queuedByClass[5] / 1e6).toFixed(1)}MB); ` +
            `JSON still delivered: ${jsonLat.length}/10, max latency ${lat[lat.length - 1]}ms`);
        const res = client.flushQueued(2);
        console.log(`flushQueued(2): removed ${res.items} items, ${(res.bytes / 1e6).toFixed(1)}MB, aborted ${res.transfersAborted} transfer(s)`);
        console.log(`after flush: queued=${(client.getBackpressure().queuedBytes / 1e6).toFixed(1)}MB`);
        client.resumeSends();
        console.log('backpressure/cancel events observed:', JSON.stringify(bpEvents));
        tun.kill(); process.exit(0);
    }, 1200);
}

setTimeout(() => { console.error('TIMEOUT'); tun.kill(); process.exit(1); }, 60000);
