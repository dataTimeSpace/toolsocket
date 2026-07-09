// nb_speed.js — endpoint cost benchmark: 100MB loopback transfer, old vs new settings.
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const NB = require('../src/ToolSocketNB.js');

const CASES = [
    { label: 'OLD (sha256 on, ack/chunk, concat)', opts: { integrity: true, ackEvery: 1 } },
    { label: 'NEW (integrity off, ack/2, in-place)', opts: {} },
];

function run(port, opts) {
    return new Promise(resolve => {
        const srv = new NB.NBServer({ port }, 'server', opts);
        srv.on('connection', s => s.on('/file', (body, bin) => { done(bin.length); }));
        const cli = NB.connect(`ws://127.0.0.1:${port}`, 'testnet', 'web', opts);
        const eld = monitorEventLoopDelay({ resolution: 5 }); eld.enable();
        let t0, c0, done;
        cli.on('open', () => {
            const buf = new Uint8Array(crypto.randomBytes(100 * 1e6));
            eld.reset(); c0 = process.cpuUsage(); t0 = Date.now();
            done = len => {
                const ms = Date.now() - t0, cpu = process.cpuUsage(c0);
                cli.close(); srv.inner.close();
                resolve({ ms, cpuMs: Math.round((cpu.user + cpu.system) / 1000), stall: Math.round(eld.max / 1e6), len });
            };
            cli.io('/file', { name: 'x.rad', type: 'rad' }, null, buf);
        });
    });
}

(async () => {
    console.log('100MB transfer, sender+receiver in ONE process (worst case), loopback:');
    let port = 9491;
    for (const c of CASES) {
        const r = await run(port++, c.opts);
        console.log(`  ${c.label} | wall ${(r.ms / 1000).toFixed(2)}s (${(100000 / r.ms).toFixed(0)} MB/s) | CPU ${(r.cpuMs / 1000).toFixed(2)}s | max stall ${r.stall}ms`);
    }
    process.exit(0);
})();
