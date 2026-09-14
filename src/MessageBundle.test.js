/* global describe, test, expect, beforeEach */

const BinaryBuffer = require('./BinaryBuffer.js');
const MessageBundle = require('./MessageBundle.js');
const ToolSocketMessage = require('./ToolSocketMessage.js');
const utilities = require('./utilities.js');

describe('MessageBundle', () => {
    /** @type MessageBundle */
    let messageBundle;
    /** @type ToolSocketMessage */
    let message;
    /** @type Uint8Array */
    let binaryData;

    beforeEach(() => {
        message = new ToolSocketMessage('web', 'io', 'get', '/test', { data: 'test' });
        binaryData = new Uint8Array([1, 2, 3, 4]);
        messageBundle = new MessageBundle(message, binaryData);
    });

    test('toBinary should convert the message bundle to binary format', () => {
        const binary = messageBundle.toBinary();
        expect(binary).toBeInstanceOf(Uint8Array);

        // Check the binary format
        const messageBuffer = new TextEncoder().encode(JSON.stringify(message));
        const messageLengthBuffer = utilities.intToByte(messageBuffer.length);
        const expectedBinary = new Uint8Array([
            ...messageLengthBuffer,
            ...messageBuffer,
            ...binaryData
        ]);
        expect(binary).toEqual(expectedBinary);
    });

    test('fromString should create a MessageBundle from a string message', () => {
        const stringMessage = JSON.stringify(message);
        const createdMessageBundle = MessageBundle.fromString(stringMessage);
        expect(createdMessageBundle).toBeInstanceOf(MessageBundle);
        expect(createdMessageBundle.message).toEqual(message);
        expect(createdMessageBundle.binaryData).toBeNull();
    });

    test('fromBinary should recreate a MessageBundle from a binary message', () => {
        const binary = messageBundle.toBinary();
        const createdMessageBundle = MessageBundle.fromBinary(binary);
        expect(createdMessageBundle).toBeInstanceOf(MessageBundle);
        expect(createdMessageBundle.message).toEqual(message);
        expect(createdMessageBundle.binaryData).toEqual(binaryData);
    });

    test('fromBinaryBuffer should create a MessageBundle from a BinaryBuffer', () => {
        const binaryBuffer = new BinaryBuffer(1);
        binaryBuffer.mainMessage = message;
        binaryBuffer.push(binaryData);
        const createdMessageBundle = MessageBundle.fromBinaryBuffer(binaryBuffer);
        expect(createdMessageBundle).toBeInstanceOf(MessageBundle);
        expect(createdMessageBundle.message).toEqual(message);
        expect(createdMessageBundle.binaryData).toEqual([binaryData]);
    });

    test('fromBinaryBuffer should throw an error if the BinaryBuffer is not full', () => {
        const binaryBuffer = new BinaryBuffer(2);
        binaryBuffer.mainMessage = message;
        binaryBuffer.push(binaryData);
        expect(() => MessageBundle.fromBinaryBuffer(binaryBuffer)).toThrow(
            'Cannot create a MessageBundle from a BinaryBuffer that is not full.'
        );
    });
});
