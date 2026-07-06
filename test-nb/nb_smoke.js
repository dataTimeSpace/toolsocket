// nb_smoke.js — verifies the NB layer is API-conformant with original ToolSocket usage.
const crypto = require('crypto');
const NB = require('../src/ToolSocketNB.js');

const server = new NB.NBServer({ port: 9401 }, 'server');
server.on('connection', sock => {
    // Method-style handler, exactly like the original README
    sock.on('post', (route, body, res, binaryData) => {
        if (route !== '/upload') return;
        const hash = crypto.createHash('sha256').update(binaryData).digest('hex');
        console.log(`[srv] post /upload body=${JSON.stringify(body)} bin=${binaryData.length}B hashMatches=${hash === body.sha256}`);
        // Respond WITH a large binary (response path must chunk too)
        const reply = crypto.randomBytes(23 * 1e6);
        res.send({ ok: true, echoSha: hash, replySha: crypto.createHash('sha256').update(reply).digest('hex') }, new Uint8Array(reply));
    });
    // Event-style handler with a small (non-chunked, legacy-framed) binary
    sock.on('/small', (body, bin) => {
        console.log(`[srv] /small body=${JSON.stringify(body)} bin=${bin.length}B firstByte=${bin[0]}`);
    });
});

const client = NB.connect('ws://127.0.0.1:9401', 'testnet', 'web');
client.on('open', () => {
    const big = crypto.randomBytes(37 * 1e6); // 37MB -> 10 chunks
    const sha256 = crypto.createHash('sha256').update(big).digest('hex');
    // ORIGINAL API: post(route, body, callback, binaryData)
    client.post('/upload', { name: 'test.bin', sha256 }, (respBody, respBin) => {
        const gotSha = crypto.createHash('sha256').update(respBin).digest('hex');
        console.log(`[cli] response ok=${respBody.ok} echoOK=${respBody.echoSha === sha256} ` +
            `replyBin=${respBin.length}B replyHashOK=${gotSha === respBody.replySha}`);
        console.log('[cli] stats:', JSON.stringify(client.nbStats()));
        process.exit(0);
    }, new Uint8Array(big));
    client.emit('/small', { tiny: true }, new Uint8Array([7, 7, 7]));
});

setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 20000);
