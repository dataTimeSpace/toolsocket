// nb_internet.js — adaptive window vs static window over internet-like paths (added RTT).
// Paths: 50 Mbit/s + 60ms RTT, and 10 Mbit/s + 60ms RTT. 20MB class-5 transfer + JSON every 100ms.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const NB = require('../src/ToolSocketNB.js');

const CASES = [
    { label: 'static 64KBx4 (256KB in flight)', mbit: 50, nb: { chunkSize: 65536, ackWindow: 4, adaptiveWindow: false } },
    { label: 'ADAPTIVE (budget 250ms)        ', mbit: 50, nb: { chunkSize: 65536, ackWindow: 4, adaptiveWindow: true } },
    { label: 'static 64KBx4 (256KB in flight)', mbit: 10, nb: { chunkSize: 65536, ackWindow: 4, adaptiveWindow: false } },
    { label: 'ADAPTIVE (budget 250ms)        ', mbit: 10, nb: { chunkSize: 65536, ackWindow: 4, adaptiveWindow: true } },
];
const RTT = 60, SIZE = 20 * 1e6;

function run(port, tunPort, c) {
    return new Promise(resolve => {
        const srv = new NB.NBServer({ port }, 'server');
        const jsonLat = [];
        let t0, ji, winInfo = {};
        srv.on('connection', s => {
            s.on('/json', b => jsonLat.push(Date.now() - b.sentAt));
            s.on('nbTransfer', e => {
                if (e.phase !== 'complete') return;
                clearInterval(ji);
                const lat = jsonLat.slice().sort((x, y) => x - y);
                resolve({
                    ms: Date.now() - t0,
                    jsonP50: lat[Math.floor(lat.length * 0.5)], jsonP95: lat[Math.floor(lat.length * 0.95)], jsonMax: lat[lat.length - 1],
                    ...winInfo
                });
                cli.close(); srv.inner.close();
            });
        });
        const cli = NB.connect(`ws://127.0.0.1:${tunPort}`, 'testnet', 'web', c.nb);
        cli.on('nbTransfer', e => { if (e.phase === 'sent') winInfo = { windowChunks: e.windowChunks, rttMinMs: e.rttMinMs }; });
        cli.on('open', () => {
            const buf = new Uint8Array(crypto.randomBytes(SIZE));
            t0 = Date.now();
            cli.io('/file', { name: 'x.rad', type: 'rad' }, null, buf);
            ji = setInterval(() => cli.io('/json', { sentAt: Date.now() }), 100);
        });
    });
}

(async () => {
    const tuns = CASES.map((c, i) => ({ name: `t${i}`, listen: 9461 + i * 2, target: 9460 + i * 2, mbit: c.mbit, latencyMs: RTT }));
    fs.writeFileSync('/tmp/nbinet_tun.json', JSON.stringify(tuns));
    const tun = spawn('node', [path.join(__dirname, 'throttle.js'), '/tmp/nbinet_tun.json'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 400));
    console.log(`20MB class-5 transfer + JSON stream, +${RTT}ms RTT on every path\n`);
    for (let i = 0; i < CASES.length; i++) {
        const c = CASES[i];
        const ideal = SIZE * 8 / (c.mbit * 1e6);
        const r = await run(9460 + i * 2, 9461 + i * 2, c);
        const util = (ideal / (r.ms / 1000) * 100).toFixed(0);
        console.log(`${String(c.mbit).padStart(3)} Mbit | ${c.label} | transfer ${(r.ms / 1000).toFixed(1)}s (util ${util}%)` +
            ` | JSON p50=${r.jsonP50} p95=${r.jsonP95} max=${r.jsonMax}ms | final window=${r.windowChunks}ch rttMin=${r.rttMinMs}ms`);
    }
    tun.kill();
    process.exit(0);
})();
