const Schema = require('./Schema.js');
const { MAX_MESSAGE_SIZE, VALID_FILETYPES, VALID_METHODS} = require('./constants.js');

const REGEXES = {
    n: /^[A-Za-z0-9_]*$/,
    i: /^[A-Za-z0-9_]*$/,
    s: /^[A-Za-z0-9_]*$/,
    r: /^[A-Za-z0-9_/?:&+.%=-]*$/,
    query: /^[A-Za-z0-9~!@$%^&*()\-_=+{}|;:,./?]*$/,
    route: /^[A-Za-z0-9/~!@$%^&*()\-_=+|;:,.]*$/,
    server: /^[A-Za-z0-9~!@$%^&*()\-_=+|;:,.]*$/
};

const URL_SCHEMA = new Schema([
    new Schema.StringValidator('n', {
        minLength: 1,
        maxLength: 25,
        pattern: REGEXES.n,
        required: true,
        expected: true
    }),
    new Schema.StringValidator('type', {
        enum: VALID_FILETYPES
    }),
    new Schema.StringValidator('protocol', {
        enum: ['spatialtoolbox', 'ws', 'wss', 'http', 'https']
    }),
    new Schema.StringValidator('query', {
        minLength: 0,
        maxLength: 2000,
        pattern: REGEXES.query
    }),
    new Schema.StringValidator('route', {
        minLength: 0,
        maxLength: 2000,
        pattern: REGEXES.route
    }),
    new Schema.StringValidator('server', {
        minLength: 0,
        maxLength: 2000,
        pattern: REGEXES.server
    }),
    new Schema.NumberValidator('port', {
        minValue: 0,
        maxValue: 99999
    })
]);

const MESSAGE_BUNDLE_SCHEMA = new Schema([
    // ID
    new Schema.GroupValidator('i', [
        new Schema.StringValidator('i', {
            minLength: 1,
            maxLength: 22,
            pattern: REGEXES.i
        }),
        new Schema.NullValidator('i'),
        new Schema.UndefinedValidator('i')
    ]),
    // Origin
    new Schema.StringValidator('o', {
        enum: ['server', 'client', 'web', 'edge', 'proxy', 'parallel'],
        required: true
    }),
    // Network
    new Schema.StringValidator('n', {
        minLength: 1,
        maxLength: 25,
        pattern: REGEXES.n,
        required: true
    }),
    // Method
    new Schema.StringValidator('m', {
        enum: VALID_METHODS,
        required: true
    }),
    // Route
    new Schema.StringValidator('r', {
        minLength: 0,
        maxLength: 2000,
        pattern: REGEXES.r,
        required: true
    }),
    // Body
    new Schema.GroupValidator('b', [
        new Schema.BooleanValidator('b'),
        new Schema.ArrayValidator('b', {
            minLength: 0,
            maxLength: MAX_MESSAGE_SIZE
        }),
        new Schema.NumberValidator('b'),
        new Schema.StringValidator('b', {
            minLength: 0,
            maxLength: MAX_MESSAGE_SIZE
        }),
        new Schema.ObjectValidator('b')
    ], { required: true }),
    // Secret
    new Schema.GroupValidator('s', [
        new Schema.StringValidator('s', {
            minLength: 0,
            maxLength: 45,
            pattern: REGEXES.s
        }),
        new Schema.NullValidator('s'),
        new Schema.UndefinedValidator('s')
    ]),
    // Frame Count
    new Schema.GroupValidator('f', [
        new Schema.NumberValidator('f', {
            minValue: 1,
            maxValue: 99
        }),
        new Schema.NullValidator('f'),
        new Schema.UndefinedValidator('f')
    ]),
    // Session sequence (see SessionStream.js): present only between session-capable peers
    new Schema.GroupValidator('q', [
        new Schema.NumberValidator('q', {
            minValue: 1,
            maxValue: Number.MAX_SAFE_INTEGER
        }),
        new Schema.UndefinedValidator('q')
    ])
]);

module.exports = {
    URL_SCHEMA,
    MESSAGE_BUNDLE_SCHEMA
};
