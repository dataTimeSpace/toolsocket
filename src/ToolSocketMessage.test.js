/* global describe, test, expect */

const ToolSocketMessage = require('./ToolSocketMessage.js');

describe('ToolSocketMessage', () => {
    test('create a new ToolSocketMessage instance', () => {
        const message = new ToolSocketMessage('client', 'network1', 'get', '/route', {foo: 'bar'}, '123');
        expect(message.id).toBe('123');
        expect(message.origin).toBe('client');
        expect(message.network).toBe('network1');
        expect(message.method).toBe('get');
        expect(message.route).toBe('/route');
        expect(message.body).toEqual({foo: 'bar'});
        expect(message.s).toBeNull();
    });

    test('create a new ToolSocketMessage instance with no id', () => {
        const message = new ToolSocketMessage('server', 'network2', 'post', '/users', {name: 'John'});
        expect(message.id).toBeNull();
        expect(message.origin).toBe('server');
        expect(message.network).toBe('network2');
        expect(message.method).toBe('post');
        expect(message.route).toBe('/users');
        expect(message.body).toEqual({name: 'John'});
        expect(message.s).toBeNull();
    });

    test('fromString recreates ToolSocketMessage', () => {
        const message = new ToolSocketMessage('server', 'network2', 'post', '/users', {name: 'John'});
        const string = '{"b": {"name": "John"}, "f": null, "i": null, "m": "post", "n": "network2", "o": "server", "r": "/users", "s": null}';
        expect(ToolSocketMessage.fromString(string)).toEqual(message);
    });

    test('fromString does not create ToolSocketMessage from invalid string', () => {
        const string = '{}';
        expect(() => ToolSocketMessage.fromString(string)).toThrow(/Cannot parse ToolSocketMessageString/);
    });
});
