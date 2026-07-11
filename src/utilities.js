/**
 * Converts an unsigned number to an array of four unsigned bytes, with the most significant byte first
 * @param {number} num - An integer in range [0, 2^32-1]
 * @returns {Uint8Array} - An array of four bytes, with the most significant byte first
 */
function intToByte(num) {
    return new Uint8Array([
        (num >> 24) & 255,
        (num >> 16) & 255,
        (num >> 8) & 255,
        num & 255
    ]);
}

/**
 * Converts an array of four unsigned bytes into an unsigned number
 * @param {Uint8Array} byteArray - An array of four bytes, each of which is an integer in range [0, 255]
 * @returns {number} - An unsigned integer corresponding to the input byte array
 */
function byteToInt(byteArray) {
    // An older version of this function used bitwise OR (|) to combine these values, but bitwise
    // operators use two's complement to determine sign, causing inputs larger than [127,255,255,255]
    // to return negative outputs. This is also why we cannot bitshift left by 24 on numbers greater
    // than 127 and have to resort to Math.pow.
    return (
        (byteArray[0] * Math.pow(2, 24)) +
        (byteArray[1] << 16) +
        (byteArray[2] << 8) +
        (byteArray[3])
    );
}

/**
 * Generates a unique ID of length `length`
 * @param {number} length - How many characters the generated ID should be
 * @returns {string} - The generated ID
 */
function generateUniqueId(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let id = '';
    for (let i = 0; i < length; i++) {
        id += characters[Math.floor(Math.random() * characters.length)];
    }
    return id;
}

/**
 * Returns a new URL with the added parameters based on the input URL
 * @param {URL} url - The URL to add the parameters to
 * @param {URLSearchParams} newParams - The parameters to add
 * @returns {URL} - A new URL with the added parameters
 */
function addSearchParams(url, newParams) {
    const newUrl = new URL(url);
    for (const [key, value] of newParams.entries()) {
        newUrl.searchParams.set(key, value);
    }
    return newUrl;
}

// Largest payload a throughput probe may request (see ToolSocketInfo.js)
const MAX_PROBE_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Builds an incompressible payload for throughput probes. Random-ish content is
 * required so that compression anywhere on the path cannot fake higher rates.
 * Uses a fast xorshift generator; only runs when a probe is explicitly requested.
 * @param {number} requestedBytes
 * @returns {Uint8Array}
 */
function makeProbePayload(requestedBytes) {
    const size = (typeof requestedBytes === 'number' && requestedBytes > 0)
        ? Math.min(Math.floor(requestedBytes), MAX_PROBE_PAYLOAD_BYTES)
        : 1024;
    const payload = new Uint8Array(size);
    let state = (Date.now() & 0x7fffffff) | 1;
    for (let i = 0; i < size; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        payload[i] = state & 0xff;
    }
    return payload;
}

const isBrowser = typeof window !== 'undefined';
/** @type {WebSocket} */
const WebSocketWrapper = isBrowser ? WebSocket : require('ws');

module.exports = {
    intToByte,
    byteToInt,
    generateUniqueId,
    addSearchParams,
    isBrowser,
    WebSocketWrapper,
    makeProbePayload
};
