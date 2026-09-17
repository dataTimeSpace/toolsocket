const NB = require('../src/ToolSocketNB.js');
const srv = new NB.NBServer({ port: 9422 }, 'server');
const got = [];
srv.on('connection', s => s.on('/msg', b => { got.push(b.sent); console.log('[srv] got', JSON.stringify(b)); }));
const cli = NB.connect('ws://127.0.0.1:9422', 'testnet', 'web');
let opens = 0;
let migrations = 0;
cli.on('open', () => console.log('[cli] open #' + (++opens)));
cli.on('nbReconnect', e => console.log('[cli] reconnect scheduled in', e.inMs, 'ms'));
// A session-capable peer recovers from the drop by migrating the live session to a fresh
// transport (no close/open is surfaced); a legacy peer recovers by reconnecting. Both count.
cli.on('__ts:migrated', e => console.log('[cli] session migrated, generation', e.gen, '(no reconnect surfaced: ' + (++migrations) + ')'));
setTimeout(() => { console.log('--- terminating connection server-side (simulated network drop)');
    for (const s of srv.inner.sockets) s.socket.terminate(); }, 1000);
setTimeout(() => { console.log('--- sending while down (should queue in scheduler)'); cli.emit('/msg', { sent: 'while-down' }); }, 1200);
setTimeout(() => { cli.emit('/msg', { sent: 'after-reconnect' }); }, 4000);
setTimeout(() => {
    console.log('opens:', opens, 'migrations:', migrations, 'delivered:', JSON.stringify(got));
    const recovered = opens >= 2 || migrations >= 1;
    process.exit(recovered && got.includes('while-down') && got.includes('after-reconnect') ? 0 : 1);
}, 5500);
