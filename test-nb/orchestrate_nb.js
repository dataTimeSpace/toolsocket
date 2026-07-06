// orchestrate.js — spins up the whole system, runs the test, tears it down.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOGDIR = path.join(__dirname, 'logs_nb');
fs.mkdirSync(LOGDIR, { recursive: true });
const SEED = 42;
const WINDOW_MS = parseInt(process.env.WINDOW_MS || '90000', 10);
const HARD_TIMEOUT_MS = parseInt(process.env.HARD_TIMEOUT_MS || '420000', 10);

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(SEED * 7);

// Build throttle config: per-client link 10-100 Mbit/s, server link 1000 Mbit/s
const tunnels = [{ name: 'server', listen: 9199, target: 9100, mbit: 1000 }];
const clientSpecs = [];
let port = 9201;
for (let i = 1; i <= 10; i++) {
    const mbit = Math.round(10 + rand() * 90);
    tunnels.push({ name: `A${i}`, listen: port, target: 9100, mbit });
    clientSpecs.push({ name: `A${i}`, kind: 'A', port, mbit });
    port++;
}
for (let i = 1; i <= 10; i++) {
    const mbit = Math.round(10 + rand() * 90);
    tunnels.push({ name: `B${i}`, listen: port, target: 9100, mbit });
    clientSpecs.push({ name: `B${i}`, kind: 'B', port, mbit });
    port++;
}
fs.writeFileSync(path.join(LOGDIR, 'throttle.config.json'), JSON.stringify(tunnels, null, 2));
fs.writeFileSync(path.join(LOGDIR, 'clients.config.json'), JSON.stringify(clientSpecs, null, 2));

const procs = [];
function start(name, args, env) {
    const p = spawn('node', args, {
        cwd: __dirname,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = fs.createWriteStream(path.join(LOGDIR, `${name}.out.log`));
    p.stdout.pipe(out); p.stderr.pipe(out);
    p.on('exit', code => console.log(`[orchestrator] ${name} exited (${code}) at +${((Date.now() - T0) / 1000).toFixed(1)}s`));
    procs.push({ name, p });
    return p;
}

const T0 = Date.now() + 8000; // send window opens 8s from now, gives everything time to connect
const DEADLINE = T0 + HARD_TIMEOUT_MS;

start('throttle', ['throttle.js', path.join(LOGDIR, 'throttle.config.json')]);
setTimeout(() => start('proxy', ['nbproxy.js']), 500);
setTimeout(() => start('server', ['nbserver.js'], { SEED: String(SEED), T0: String(T0), WINDOW_MS: String(WINDOW_MS), PORT: '9199', NMSG: process.env.NMSG || '200', FILE_MIN_MB: process.env.FILE_MIN_MB || '5', FILE_MAX_MB: process.env.FILE_MAX_MB || '100' }), 1500);

// A clients: all 10 in one process (small JSON traffic only).
// B clients: one process each (100 MB sha256 hashing must not block other clients' latency measurements).
setTimeout(() => {
    const aSpec = clientSpecs.filter(c => c.kind === 'A').map(c => `${c.name}:${c.port}`).join(',');
    start('clientsA', ['nbclient.js'], { SPEC: aSpec, KIND: 'A', SEED: String(SEED), T0: String(T0), WINDOW_MS: String(WINDOW_MS), DEADLINE: String(DEADLINE), NMSG: process.env.NMSG || '200' });
    for (const c of clientSpecs.filter(c => c.kind === 'B')) {
        start(`client${c.name}`, ['nbclient.js'], { SPEC: `${c.name}:${c.port}`, KIND: 'B', SEED: String(SEED), T0: String(T0), WINDOW_MS: String(WINDOW_MS), DEADLINE: String(DEADLINE), NMSG: process.env.NMSG || '200' });
    }
}, 3000);

// Wait for all client processes to exit, then stop server/proxy/throttle
const waitLoop = setInterval(() => {
    const clientProcs = procs.filter(x => x.name.startsWith('client'));
    const stillRunning = clientProcs.filter(x => x.p.exitCode === null);
    if (clientProcs.length >= 11 && stillRunning.length === 0) {
        clearInterval(waitLoop);
        console.log('[orchestrator] all clients done, shutting down');
        setTimeout(() => {
            for (const { name, p } of procs) {
                if (p.exitCode === null) p.kill('SIGTERM');
            }
            setTimeout(() => process.exit(0), 2000);
        }, 1000);
    }
    if (Date.now() > DEADLINE + 30000) {
        clearInterval(waitLoop);
        console.log('[orchestrator] hard timeout, killing everything');
        for (const { p } of procs) { if (p.exitCode === null) p.kill('SIGKILL'); }
        setTimeout(() => process.exit(1), 2000);
    }
}, 1000);
