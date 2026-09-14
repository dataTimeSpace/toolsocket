/* global describe, test, expect, beforeEach */

const BinaryBuffer = require('./BinaryBuffer');

describe('BinaryBuffer', () => {
    /** @type BinaryBuffer */
    let binaryBuffer;

    beforeEach(() => {
        binaryBuffer = new BinaryBuffer(5);
    });

    test('isFull should return false when below limit', () => {
        expect(binaryBuffer.isFull).toBe(false);
        const message = new Uint8Array([1, 2, 3]);
        binaryBuffer.push(message);
        expect(binaryBuffer.isFull).toBe(false);
    });

    test('push should add a message to the messageBuffer', () => {
        const message = new Uint8Array([1, 2, 3]);
        binaryBuffer.push(message);
        expect(binaryBuffer.messageBuffer.length).toBe(1);
        expect(binaryBuffer.messageBuffer[0]).toBe(message);
    });

    test('push should throw an error if buffer length is exceeded', () => {
        const message = new Uint8Array([1, 2, 3]);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        expect(() => binaryBuffer.push(message)).toThrow(
            'Cannot append more data to BinaryBuffer, length exceeded.'
        );
    });

    test('isFull should return true when buffer is full', () => {
        const message = new Uint8Array([1, 2, 3]);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        binaryBuffer.push(message);
        expect(binaryBuffer.isFull).toBe(true);
    });
});
