/* global describe, test, expect, beforeEach, beforeAll, afterEach, afterAll */
const ToolSocket = require('./index.js');

describe('ToolSocket', () => {
    let toolSocket;
    let server;
    let serverSideSocket;

    beforeAll((done) => {
        server = new ToolSocket.Server({ port: 5010 }, 'client');
        server.addEventListener('listening', () => {
            done();
        });
        server.addEventListener('connection', (socket) => {
            serverSideSocket = socket;
            // serverSideSocket.addEventListener('rawMessage', rawMessage => {
            //     console.log('rawMessage', rawMessage);
            // });
        });
    });

    beforeEach((done) => {
        toolSocket = new ToolSocket(new URL('ws://localhost:5010'), 'test_network', 'client');
        toolSocket.addEventListener('open', () => {
            done();
        });
    });

    afterEach((done) => {
        toolSocket.addEventListener('close', () => {
            done();
        });
        toolSocket.close();
        toolSocket = null;
        serverSideSocket = null;
    });

    afterAll((done) => {
        server.addEventListener('close', () => {
            done();
        });
        server.close();
        server = null;
    });

    test('should connect to the server', () => {
        expect(toolSocket.connected).toBe(true);
    });

    test('server should receive messages', (done) => {
        serverSideSocket.addEventListener('message', (route, body) => {
            try {
                expect(route).toBe('test/route');
                expect(body).toEqual({message: 'Hello, server!'});
                done();
            } catch (error) {
                done(error);
            }
        });

        toolSocket.message('test/route', { message: 'Hello, server!' });
    });

    test('client should receive messages', (done) => {
        toolSocket.addEventListener('message', (route, body) => {
            try {
                expect(route).toBe('test/route');
                expect(body).toEqual({ message: 'Hello, client!' });
                done();
            } catch (error) {
                done(error);
            }
        });

        serverSideSocket.message('test/route', { message: 'Hello, client!' });
    });

    test('client should receive responses', (done) => {
        const sentBody  = { message: 'Echo!' };

        serverSideSocket.addEventListener('message', (route, body, response) => {
            response.send(body);
        });

        toolSocket.message('test/response', sentBody, responseBody => {
            try {
                expect(responseBody).toEqual(sentBody);
                done();
            } catch (error) {
                done(error);
            }
        });
    });

    test('server should receive responses', (done) => {
        const sentBody  = { message: 'Echo!' };

        toolSocket.addEventListener('message', (route, body, response) => {
            response.send(body);
        });

        serverSideSocket.message('test/response', sentBody, responseBody => {
            try {
                expect(responseBody).toEqual(sentBody);
                done();
            } catch (error) {
                done(error);
            }
        });
    });

    test('should receive binary data without body', (done) => {
        const binaryData = new Uint8Array([1, 2, 3, 4, 5]);

        serverSideSocket.addEventListener('message', (route, body, response, receivedBinaryData) => {
            try {
                expect(route).toBe('test/binary');
                expect(body).toEqual(null);
                expect(receivedBinaryData).toEqual(binaryData);
                done();
            } catch (error) {
                done(error);
            }
        });

        toolSocket.message('test/binary', null, null, binaryData);
    });

    test('should receive binary data with body', (done) => {
        const binaryData = new Uint8Array([1, 2, 3, 4, 5]);

        serverSideSocket.addEventListener('message', (route, body, response, receivedBinaryData) => {
            try {
                expect(route).toBe('test/binary');
                expect(body).toEqual({message: 'Binary data'});
                expect(receivedBinaryData).toEqual(binaryData);
                done();
            } catch (error) {
                done(error);
            }
        });

        toolSocket.message('test/binary', { message: 'Binary data' }, null, binaryData);
    });

    test('server should receive array-based binary data', (done) => {
        const binaryData1 = new Uint8Array([1, 2, 3, 4, 5]);
        const binaryData2 = new Uint8Array([2, 4, 6, 8, 10]);

        serverSideSocket.addEventListener('message', (route, body, response, receivedBinaryData) => {
            try {
                expect(route).toBe('test/binary');
                expect(body).toEqual({message: 'Binary data'});
                expect(receivedBinaryData).toEqual([binaryData1, binaryData2]);
                done();
            } catch (error) {
                done(error);
            }
        });

        toolSocket.message('test/binary', { message: 'Binary data' }, null, [binaryData1, binaryData2]);
    });
});
