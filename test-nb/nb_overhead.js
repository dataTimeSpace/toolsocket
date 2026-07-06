// nb_overhead.js — measures the EXACT wire overhead per chunk, per chunk size.
// A chunk travels as: [ws frame header][4-byte JSON-length prefix][JSON header][payload]
// and the receiver returns one ack frame per chunk on the reverse path.
const ToolSocketMessage = require('../src/ToolSocketMessage.js');
const MessageBundle = require('../src/MessageBundle.js');

function wsHeader(payloadLen, masked) {
    // RFC6455: 2 bytes base + extended length (2 bytes if 126..65535, 8 bytes if >65535) + 4-byte mask (client->server)
    let h = 2;
    if (payloadLen > 65535) h += 8;
    else if (payloadLen >= 126) h += 2;
    if (masked) h += 4;
    return h;
}

// Worst-ish case realistic header: 12-char tid, 4-digit chunk index, typical origin/network ids
const mkChunkMsg = () => new ToolSocketMessage('web', 'testnet', 'io', '__tsnb/c', { t: 'AbCdEfGhIjKl', q: 1023 }, null);
const mkAckMsg = () => new ToolSocketMessage('web', 'testnet', 'io', '__tsnb/ack', { t: 'AbCdEfGhIjKl', q: 1023 }, null);

const jsonHeader = JSON.stringify(mkChunkMsg());
console.log(`chunk JSON header: ${jsonHeader.length} bytes -> ${jsonHeader}`);
const ackFrame = JSON.stringify(mkAckMsg());
const ackTotal = ackFrame.length + wsHeader(ackFrame.length, true);
console.log(`ack frame: ${ackFrame.length} B JSON + ${wsHeader(ackFrame.length, true)} B ws header = ${ackTotal} B on the reverse path\n`);

const sizes = [4 * 1024 * 1024, 1024 * 1024, 256 * 1024, 64 * 1024, 16 * 1024];
console.log('chunkSize | framing B | +ws hdr | fwd overhead | fwd % | +ack (reverse) | total %');
for (const cs of sizes) {
    const frame = new MessageBundle(mkChunkMsg(), new Uint8Array(cs)).toBinary();
    const framing = frame.length - cs;                       // ToolSocket: length-prefix + JSON header
    const ws = wsHeader(frame.length, true);                 // masked = client->server (server->client is 4B less)
    const fwd = framing + ws;
    const pct = (fwd / cs * 100);
    const tot = ((fwd + ackTotal) / cs * 100);
    console.log(`${(cs / 1024).toString().padStart(6)}KB | ${String(framing).padStart(9)} | ${String(ws).padStart(7)} | ${String(fwd).padStart(12)} | ${pct.toFixed(4).padStart(6)}% | ${String(ackTotal).padStart(14)} | ${tot.toFixed(4)}%`);
}
console.log('\n(per transfer, amortized: one begin ~%dB and one end ~%dB frame)',
    JSON.stringify(new ToolSocketMessage('web', 'testnet', 'io', '__tsnb/begin', { t: 'AbCdEfGhIjKl', c: 100, z: 104857600, e: { o: 'server', n: 'testnet', m: 'io', r: '/file', b: { to: 'B1', fileId: 'B1-f0', size: 104857600, sha256: 'a'.repeat(64), sentAt: Date.now(), type: 'rad' }, i: null, s: null } }, null)).length,
    JSON.stringify(new ToolSocketMessage('web', 'testnet', 'io', '__tsnb/end', { t: 'AbCdEfGhIjKl', h: 'a'.repeat(64) }, null)).length);
