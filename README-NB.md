# ToolSocketNB — non-blocking transport layer for ToolSocket

This package is the original ToolSocket 2.1.2 (unmodified, in `src/`) plus
`src/ToolSocketNB.js`: an API-compatible layer that replaces how binaries travel
between two NB-enhanced endpoints.

## What it adds

- Chunked binary transport (64 KB default, 4 MB hard cap) with per-transfer IDs —
  removes head-of-line blocking, the ws 100 MiB `maxPayload` connection kill, and
  the interleaving corruption of the legacy multi-frame protocol.
- Strict priority classes: 1 = JSON/text (always first), 2 = htm html js css csv dat
  xml woff webp, 3 = jpeg jpg gif png svg ttf otf pdf, 4 = 3dt fbx glb map mp4 obj
  wasm webm zip (+ unknown), 5 = rad radc splat ply pvs pvz (sent only when nothing
  else is queued).
- End-to-end ack flow control with an adaptive per-transfer window
  (`min(2 x bandwidth x RTT, bandwidth x latencyBudgetMs)`): saturates each path
  while keeping JSON latency near `min(2 x RTT, 250 ms)`.
- Backpressure API: `'backpressure'` events, `getBackpressure()`,
  `pauseSends(minClass)`, `resumeSends()`, `flushQueued(minClass)` (aborts cleanly),
  `drained()`, `nbStats()`.
- Auto-reconnect with exponential backoff; queue survives outages.
- Streaming relay for proxies (`relay` option): chunks forwarded cut-through, final
  receiver's acks routed upstream; proxy memory stays ~window-sized per transfer.
- Optional end-to-end SHA-256 (`integrity: true`; off by default — TLS/TCP cover the
  wire, structural tid/seq/count/length checks remain; enable while developing
  transport changes).
- Capability handshake with automatic legacy fallback for non-NB peers.

## Usage (API identical to original ToolSocket)

```js
const NB = require('toolsocket/src/ToolSocketNB.js'); // or './src/ToolSocketNB.js'

const server = new NB.NBServer({ port: 12345 }, 'server');
server.on('connection', sock => {
    sock.on('post', (route, body, res, binaryData) => { res.send({ ok: true }); });
});

const sock = NB.connect('ws://localhost:12345', 'myNetwork', 'web');
sock.post('/upload', { name: 'scan.rad' }, (resBody) => { ... }, bigUint8Array);

// or wrap any existing ToolSocket / incoming server socket:
NB.enhance(existingSocket, { latencyBudgetMs: 250 });
```

Proxy with streaming relay:

```js
const server = new NB.NBServer({ port }, 'proxy', {
    relay: env => env.r === '/file' ? clients.get(env.b.to) : null
});
```

Fan-out fast path (serialize once for many recipients):

```js
const str = NB.prepare('io', '/json', body, sock.origin, sock.networkId);
for (const c of clients) c.sendPrepared(str);
```

## Options (per socket, all optional)

chunkSize (64 KB, capped 4 MB), ackWindow (4 initial), adaptiveWindow (true),
latencyBudgetMs (250), rttFloorMs (20), maxWindowBytes (8 MB), maxUnackedBytes
(32 MB), ackEvery (2), lowWater (256 KB), backpressureHigh/Low (32/8 MB),
maxQueuedBytes (512 MB), maxTransferBytes (2 GB), defaultBinaryClass (4),
helloTimeoutMs (3000), transferTimeoutMs (120000), integrity (false),
reconnect (true), maxPayload (16 MB), relay (null).

## Tests

- `npm test` — original suite on the original library (unchanged).
- `npx jest -c jest.nb.config.json` — the ORIGINAL test suite with every socket
  routed through the NB layer (API conformance; 56/56 pass).
- `node test-nb/nb_smoke.js` — chunked roundtrips via the original API.
- `node test-nb/nb_priority.js` — priority classes, pause/resume, flush, backpressure.
- `node test-nb/nb_reconnect.js` — auto-reconnect + offline queueing.
- `node test-nb/nb_overhead.js` / `nb_chunksize.js` / `nb_internet.js` /
  `nb_speed.js` / `nb_eventloop.js` — measurements (overhead, chunk size, adaptive
  window vs RTT, endpoint CPU, event-loop stalls).
- `node test-nb/orchestrate_nb.js` — full 20-client / 1.5 GB load scenario with an
  emulated network (rate + RTT), results in `test-nb/logs_nb/`.

Original library: (c) PTC / Valentin Heun, MPL-2.0. The NB layer is a wrapper; no
original source file is modified.


## Process-wide backpressure (v2.1.2-nb.2)

Every enhanced socket in a Node process shares ONE pressure registry (anchored on a
global Symbol, so duplicate module loads still share state). When aggregate pressure
(sum of scheduler queued bytes + ws bufferedAmount across all sockets, or process RSS)
crosses the high watermark, all NB-capable peers receive an ADVISORY hold signal for
class-5 requests. Nothing is dropped or blocked by the library; the signal only fires
a callback so the application can slow itself down.

Server / pressured process:
    NB.pressure.configure({ highBytes: 128e6, lowBytes: 32e6, rssHighFrac: 0.75,
                            rssLowFrac: 0.65, sampleMs: 250, minHoldMs: 2000 }); // defaults shown
    NB.pressure.on(ev => console.log(ev.held ? 'HOLD' : 'RESUME', ev.reason)); // change events
    NB.pressure.hold(true|false|null);   // manual override / back to automatic
    NB.pressure.state();                 // { held, seq, aggBytes, rss, sockets, config }

Client (your engineers implement the slowdown):
    const off = sock.onHoldChange(held => {
        if (held) stopRequestingSplatLODs();   // advisory: stop requesting class-5 content
        else      resumeRequestingSplatLODs(); // delivered with 0-2s per-client jitter (herd control)
    });
    sock.isHeld();                             // synchronous check

Details: hold state rides the __tsnb/hello handshake (late joiners and reconnects learn
it immediately), carries a monotonic sequence number (stale signals ignored, reset per
connection), releases respect minHoldMs + 4:1 watermark hysteresis, resume callbacks are
jittered (holdResumeJitterMs, default 2000), legacy peers ignore holds silently, and the
sampling timer is unref()d. Active by default; invisible until the process nears its limits.
Test: node test-nb/nb_pressure.js

## Robustness fixes (v2.1.2-nb.3)

Found by a full-horizon 100+100-client run where class-5 chunks were starved for
minutes behind a class-1 JSON backlog:

- Receiver partial-transfer GC is now INACTIVITY-based (was age-based): a transfer
  actively receiving chunks is never garbage-collected, however long it takes.
- When the receiver does give up (transferTimeoutMs of silence), it now sends
  __tsnb/abort upstream so the sender fails fast instead of stalling until its own
  ack timeout while holding window capacity.
- The relay proxy routes receiver-originated aborts UPSTREAM via its ack-return map
  (previously they dead-ended at the proxy).
- A sender receiving an abort cancels the transfer: releases unacked capacity and
  flushes that transfer's queued frames from the scheduler (dropByTid).

Integration pattern for on-demand class-5 loading under backpressure (request loop
pauses on hold, resumes on release, retries on nbTransfer failed/aborted):
see test-nb/client_lod.js, test-nb/server_lod.js, test-nb/nbproxy_lod.js.
Protocol robustness repro: node test-nb/repro_stall2.js

## File-format table (v2.1.2-nb.4)

Priority formats are now managed as a class-keyed object, the single editable
source of truth:

    NB.CLASS_FORMATS = {
      2: ['htm','html','js','css','csv','dat','xml','woff','webp'],
      3: ['jpeg','jpg','gif','png','svg','ttf','otf','pdf'],
      4: ['3dt','fbx','glb','map','mp4','obj','wasm','webm','zip'],  // + default for unknown binaries
      5: ['rad','radc','splat','ply','pvs','pvz']                    // bulk, lowest priority
    }

Classes 0 (protocol control) and 1 (JSON/text) are not extension-driven. To add a
format to a class, at load time or runtime:

    NB.CLASS_FORMATS[5].push('gsplat');
    NB.rebuildExtIndex();   // refreshes the derived EXT_CLASS lookup in place

EXT_CLASS (extension -> class) is still exported for backward compatibility; it is
derived from CLASS_FORMATS and reference-stable across rebuilds.
