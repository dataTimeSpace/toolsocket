# ToolSocket

## Setup

### Installing for Production (Node.js)
Run `npm i toolsocket` in your project directory.

### Installing for Development (Node.js)
Run `npm link` in your `toolsocket` repository, then `npm link toolsocket` in your projects
that use `toolsocket`. They should now be linked to your local `toolsocket` repository.

### Building ToolSocket (Web)
Run `npm run build`, then copy `dist/toolsocket.js` to your server and load it in a script tag.
The build script automatically minifies `dist/toolsocket.js` for you.

### Testing
Run the included jest test suite via `npm run test`.

Run tests with coverage analysis via `npm run coverage`.

## Usage

### Server
```javascript
const ToolSocket = require('toolsocket');
const webSocketServer = new ToolSocket.Server({/* WS server options go here */});

webSocketServer.on('connection', function connection(socket) {
    // Method-style request handling
    socket.on('post', (route, body, res, binaryData) => {
        if (route === "/") {
            console.log(body); // "hello"
            if (res) { // res object is available only if sender registered a callback
                if (binaryData) {
                    res.send('hi', binaryData); // res.send can optionally send binaryData (Uint8Array) as well
                } else {
                    res.send('hi');
                }
            }
        }
    });

    // Event-style request handling (Cannot send responses)
    socket.on('/', (body, binary) => {
        console.log(body); // "hello"
        if (binaryData) {
            console.log('hi', binaryData);
        } else {
            console.log('hi');
        }
    });
});
```

### Client
In your html file:
```html
<script src="dist/toolsocket.js"></script>
```

In your js code:
```javascript
const socket = new ToolSocket('ws://localhost:12345', 'networkID', 'client');

const route = "/";
const body = "hello";
const binaryData = new TextEncoder().encode("binary");

// Method-style request without acknowledgement
socket.post(route, body, null, binaryData);

// Method-style request with callback
socket.post(route, body, (responseMsg, _responseBinary) => {
    console.log(responseMsg); // "hi"
}, binaryData); // binaryData is optional and must be a Uint8Array

// Event-style request (cannot be used with callbacks)
socket.emit(route, body, binaryData);
```

### Additional Socket Events:

```javascript
// On network ID change, such as when connecting to an existing network
socket.on('network', (newNet, oldNet) => {
    console.log(newNet, oldNet);
});

// On WebSocket message received (raw string)
socket.on('rawMessage', (rawMessage) => {});

// On WebSocket message dropped (could not be processed into a ToolSocketMessage)
socket.on('droppedMessage', (droppedMessage) => {});

// On WebSocket message sent (raw string)
socket.on('rawSend', (rawSentMessage) => {});

// On ToolSocket message sent (see ToolSocketMessage)
socket.on('send', (sentMessage) => {});

// On connection open
socket.on('open', () => {
    console.log('CONNECTION OPEN');
});

// On connection close
socket.on('close', () => {
    console.log('CONNECTION CLOSED');
});

// Subscribe to underlying WebSocket connection events directly
socket.on('status', (status) => {
    if (status === socket.CONNECTING) {
        console.log('CONNECTION CONNECTING');
    } else if (status === socket.OPEN){
        console.log('CONNECTION OPEN');
    } else if (status === socket.CLOSING){
        console.log('CONNECTION CLOSING');
    } else if (status === socket.CLOSED){
        console.log('CONNECTION CLOSED');
    }
})

// On WebSocket error
socket.on('error', (error) => {
    console.error(error); // output error message
});

// Same as 'open'
socket.on('connected', () => {});
```

## Underlying Message Format
ToolSocket's underlying WebSocket messages use the shorthand single-letter keys seen below, but ToolSocket exposes
clearly named getters and setters for ease of use. See `src/ToolSocketMessage.js` for more details.

```
{
  o/origin: (e.g. client, web, server),
  n/network: (can be thought of as a socket.io room),
  m/method: (e.g. get, post, delete),
  r/route: (e.g. /about, /home),
  b/body: (an arbitrary JS object to be stringified),
  i/id: (an ID for listening for responses),
  s/secret: (used to manage write access),
  f/frameCount: (number of binary buffers that will be sent following this message)
}
```

## Connection Info API

Server-side diagnostics for realtime connection quality. Fully dormant until enabled:
the info module is only loaded on first use and adds zero per-message overhead —
measurement rides on TCP byte counters, WebSocket protocol ping/pong frames, and the
existing keepalive, all sampled by a single 1 Hz ticker.

### Per connection (server side)
```javascript
webSocketServer.on('connection', (socket) => {
    socket.info(true, (report) => {
        // Every 5 seconds:
        // report.data.networkLatency  - protocol-level ping RTT (pure network path)
        // report.data.appLatency      - application-level RTT (network + client pressure)
        // report.data.transport       - exact wire bytes: average/peak per second, totals
        // report.data.networkQuality  - score, rating, flow (realtime/buffered/stalled),
        //                               trend, per-dimension sub-scores, issue flags
        // report.data.history         - issue counts/episodes since info was enabled
        // report.data.probe           - latest on-demand throughput probe result
    }, {name: 'alice'}); // optional connection name, included as report.data.name

    socket.info(true, undefined, {probe: true}); // one-shot up/downstream capacity probe
    socket.info(false);                          // full teardown, back to dormant
});
```
When the connection closes, one final report is pushed (`flow: 'ended'`, including
the close code — an abnormal close without a handshake is the typical signature of
proxies or zero-trust gateways cutting the socket).

### Across all connections (server side)
```javascript
webSocketServer.stagedProbe((result) => {
    // result.individual       - every client probed alone, sequentially (per-client limits)
    // result.stages           - 2, 4, 8, ... clients probed simultaneously
    // result.networkLimit     - all-at-once totals (shared-medium capacity)
    // result.sharedBottleneck - ratio of individual sum to network limit; detected: true
    //                           means clients limit each other (e.g. shared WiFi)
}, {sizeBytes: 256 * 1024});
```

### Remote (client side)
```javascript
clientSocket.info(true, (bundle) => {
    // Every 5 seconds, pushed by the server:
    // bundle.reports        - info reports of ALL server connections
    // bundle.recentlyClosed - final reports of recently closed connections
    // bundle.stagedProbe    - latest staged probe result
});
clientSocket.info(true, undefined, {probe: true}); // trigger a server-wide staged probe
clientSocket.info(false);                          // stop the stream
```
The stream also ends automatically when the subscribing connection closes. There is
no built-in authorization: gate this at the application level if info reports should
not be visible to every client.
