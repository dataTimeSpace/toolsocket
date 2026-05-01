const MAX_MESSAGE_SIZE = 3000 * 1024 * 1024;
const VALID_FILETYPES = ['css', 'csv', 'dat', 'fbx', 'gif', 'glb', 'htm', 'html', 'jpg', 'jpeg', 'js', 'json', 'map', 'mp4', 'obj', 'otf', 'pdf', 'ply', 'png', 'pvs', 'pvz', 'splat', 'svg', 'ttf', 'wasm', 'webm', 'webp', 'woff', 'xml', 'zip', '3dt', 'rad', 'radc'];
/**
 * @typedef {'action' | 'beat' | 'delete' | 'get' | 'io' | 'keys' | 'message' | 'new' | 'patch' | 'ping' | 'post' | 'pub' | 'put' | 'res' | 'sub' | 'unsub' | 'meta'} MethodString
 */
/** @type MethodString[] */
const VALID_METHODS = ['action', 'beat', 'delete', 'get', 'io', 'keys', 'message', 'new', 'patch', 'ping', 'post', 'pub', 'put', 'res', 'sub', 'unsub', 'meta'];

module.exports = {
    MAX_MESSAGE_SIZE,
    VALID_FILETYPES,
    VALID_METHODS
};
