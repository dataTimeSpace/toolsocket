// nb_chunksize.js — practical comparison of chunk sizes.
// Part 1: max throughput on unthrottled loopback (measures per-chunk CPU/pacing cost).
// Part 2: 25 Mbit/s link: transfer time + JSON latency during transfer (window kept at
//         in-flight = 2 chunks, so smaller chunks = less in-flight = lower JSON latency).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const NB = require('../src/ToolSocketNB.js');

const CASES_FAST = [
    { label: '4MB chunks', chunkSize: 4 * 1024 * 1024 },
    { label: '1MB chunks', chunkSize: 1024 * 1024 },
    { label: '64KB chunks', chunkSize: 64 * 1024 },
];
const SIZE_FAST = 200 * 1e6;

async function fastCase(port, c) {
    return new Promise(resolve => {
        const srv = new NB.NBServer({ port }, 'server');
        srv.on('connection', s => s.on('nbTransfer', e => {
            if (e.phase === 'complete') {
                resolve({ ms: Date.now() - t0, chunks: cli.nbStats().chunksSent });
                cli.close(); srv.inner.close();
            }
        }));
        // keep ~16MB in flight so the ack window never limits on loopback
        const cli = NB.connect(`ws://127.0.0.1:${port}`, 'testnet', 'web',
            { chunkSize: c.chunkSize, ackWindow: Math.ceil(16 * 1024 * 1024 / c.chunkSize), maxUnackedBytes: 16 * 1024 * 1024 });
        let t0;
        cli.on('open', () => {
            const buf = new Uint8Array(crypto.randomBytes(SIZE_FAST));
            t0 = Date.now();
            cli.io('/file', { name: 'x.rad', type: 'rad' }, null, buf);
        });
    });
}

async function slowCase(port, tunPort, c) {
    return new Promise(resolve => {
        const srv = new NB.NBServer({ port }, 'server');
        const jsonLat = [];
        let t0;
        srv.on('connection', s => {
            s.on('/json', b => jsonLat.push(Date.now() - b.sentAt));
            s.on('nbTransfer', e => {
                if (e.phase === 'complete') {
                    clearInterval(ji);
                    const lat = jsonLat.slice().sort((a, b) => a - b);
                    resolve({
                        ms: Date.now() - t0,
                        jsonP50: lat[Math.floor(lat.length * 0.5)], jsonMax: lat[lat.length - 1]
                    });
                    cli.close(); srv.inner.close();
                }
            });
        });
        const cli = NB.connect(`ws://127.0.0.1:${tunPort}`, 'testnet', 'web',
            { chunkSize: c.chunkSize, ackWindow: 2 }); // in-flight = 2 chunks
        let ji;
        cli.on('open', () => {
            const buf = new Uint8Array(crypto.randomBytes(20 * 1e6)); // 20MB over 25Mbit ~ 6.4s ideal
            t0 = Date.now();
            cli.io('/file', { name: 'x.rad', type: 'rad' }, null, buf);
            ji = setInterval(() => cli.io('/json', { sentAt: Date.now() }), 100);
        });
    });
}

(async () => {
    console.log(`PART 1 — unthrottled loopback, ${SIZE_FAST / 1e6}MB transfer (per-chunk CPU/pacing cost):`);
    let port = 9431;
    for (const c of CASES_FAST) {
        const r = await fastCase(port++, c);
        console.log(`  ${c.label.padEnd(12)} ${(SIZE_FAST / 1e6 / (r.ms / 1000)).toFixed(0).padStart(5)} MB/s  (${r.ms}ms, ${r.chunks} chunks, ${(r.ms * 1000 / r.chunks).toFixed(0)}us/chunk)`);
    }

    console.log('\nPART 2 — 25 Mbit/s link, 20MB rad + JSON every 100ms, ackWindow=2 (in-flight = 2 chunks):');
    fs.writeFileSync('/tmp/nbcs_tun.json', JSON.stringify([
        { name: 'a', listen: 9441, target: 9440, mbit: 25 },
        { name: 'b', listen: 9443, target: 9442, mbit: 25 },
        { name: 'c', listen: 9445, target: 9444, mbit: 25 },
    ]));
    const tun = spawn('node', [path.join(__dirname, 'throttle.js'), '/tmp/nbcs_tun.json'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 400));
    const ideal = 20e6 * 8 / 25e6;
    console.log(`  (ideal transfer time at 25 Mbit/s: ${ideal.toFixed(1)}s)`);
    const slots = [[9440, 9441], [9442, 9443], [9444, 9445]];
    for (let i = 0; i < CASES_FAST.length; i++) {
        const c = CASES_FAST[i];
        const r = await slowCase(slots[i][0], slots[i][1], c);
        console.log(`  ${c.label.padEnd(12)} transfer ${(r.ms / 1000).toFixed(1)}s (util ${(ideal / (r.ms / 1000) * 100).toFixed(0)}%)  JSON p50=${r.jsonP50}ms max=${r.jsonMax}ms  in-flight=${(2 * c.chunkSize / 1024).toFixed(0)}KB`);
    }
    tun.kill();
    process.exit(0);
})();
