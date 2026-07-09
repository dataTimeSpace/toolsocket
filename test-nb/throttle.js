// throttle.js — TCP tunnels with token-bucket rate limiting per direction.
// Emulates client<->proxy links of 10-100 Mbit/s and the server<->proxy 1 Gbit/s link.
// Usage: node throttle.js <config.json>
// config: [{ name, listen, target, mbit, latencyMs? }]  (latencyMs = added round-trip time)
const net = require('net');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

function shape(src, dst, bytesPerSec, oneWayDelayMs) {
    const TICK_MS = 10;
    const perTick = Math.max(1, Math.floor(bytesPerSec * TICK_MS / 1000));
    const maxAllowance = perTick * 5; // 50ms burst
    let allowance = perTick;
    const queue = [];
    let queued = 0;
    let paused = false;
    let writable = true;
    let ended = false;
    let closed = false;

    src.on('data', chunk => {
        queue.push(chunk);
        queued += chunk.length;
        // Propagate backpressure upstream so the sender's kernel/ws buffers fill,
        // just like a real slow network path would cause.
        if (queued > 1 << 20 && !paused) { src.pause(); paused = true; }
    });
    src.on('end', () => { ended = true; pump(); });
    src.on('error', () => { ended = true; });
    dst.on('drain', () => { writable = true; pump(); });
    dst.on('error', () => { closed = true; cleanup(); });
    dst.on('close', () => { closed = true; cleanup(); });

    const timer = setInterval(() => {
        allowance = Math.min(allowance + perTick, maxAllowance);
        pump();
    }, TICK_MS);

    function cleanup() {
        clearInterval(timer);
        try { src.destroy(); } catch (e) { /* ignore */ }
    }

    function pump() {
        if (closed) return;
        while (writable && queue.length && allowance > 0) {
            let chunk = queue[0];
            if (chunk.length > allowance) {
                queue[0] = chunk.subarray(allowance);
                chunk = chunk.subarray(0, allowance);
            } else {
                queue.shift();
            }
            queued -= chunk.length;
            allowance -= chunk.length;
            if (oneWayDelayMs > 0) {
                // Propagation delay: release the bytes after the one-way latency.
                // Rate limiting already happened above, so this purely shifts time.
                setTimeout(c => {
                    if (closed) return;
                    try { writable = dst.write(c) && writable; } catch (e) { closed = true; cleanup(); }
                }, oneWayDelayMs, chunk);
            } else {
                try { writable = dst.write(chunk); } catch (e) { closed = true; cleanup(); return; }
            }
        }
        if (paused && queued < (256 << 10)) { src.resume(); paused = false; }
        if (ended && queue.length === 0) {
            clearInterval(timer);
            try { dst.end(); } catch (e) { /* ignore */ }
        }
    }
}

for (const tun of config) {
    const bytesPerSec = Math.floor(tun.mbit * 1e6 / 8);
    const oneWay = (tun.latencyMs || 0) / 2;
    const srv = net.createServer(clientSide => {
        const proxySide = net.connect(tun.target, '127.0.0.1');
        clientSide.on('error', () => { });
        proxySide.on('error', () => { });
        proxySide.on('connect', () => {
            shape(clientSide, proxySide, bytesPerSec, oneWay); // upstream (client -> proxy)
            shape(proxySide, clientSide, bytesPerSec, oneWay); // downstream (proxy -> client)
        });
    });
    srv.listen(tun.listen, '127.0.0.1', () => {
        console.log(`[throttle] ${tun.name}: :${tun.listen} -> :${tun.target} @ ${tun.mbit} Mbit/s rtt+${tun.latencyMs || 0}ms`);
    });
}

process.on('SIGTERM', () => process.exit(0));
