'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { createTransport, listSerialPorts } = require('../app/transports.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transport event.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function observe(handle) {
  const chunks = [], exits = [];
  const data = handle.onData(value => chunks.push(value));
  const exit = handle.onExit(value => exits.push(value));
  return { chunks, exits, data, exit, get text() { return chunks.join(''); } };
}
class Socket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; this.writableLength = 0; this.acceptWrites = true; }
  write(bytes, callback) { this.writes.push(Buffer.from(bytes)); callback?.(null); return this.acceptWrites; }
  destroy() { this.destroyed = true; queueMicrotask(() => this.emit('close', false)); }
  setNoDelay(value) { this.noDelay = value; }
}
function tcp(protocol = 'telnet', extras = {}) {
  const socket = new Socket();
  const connections = [];
  const handle = createTransport({ protocol, host: '127.0.0.1', port: 23, ...extras }, { net: { createConnection(options) { connections.push(options); return socket; } } });
  return { socket, connections, handle, events: observe(handle) };
}
function wire(socket) { return Buffer.concat(socket.writes); }
function includes(buffer, sequence) { return buffer.indexOf(Buffer.from(sequence)) >= 0; }

test('raw TCP exchanges real loopback data, queues input before connect, and closes once', async t => {
  let peer;
  const server = net.createServer(socket => { peer = socket; socket.on('data', data => socket.write(Buffer.concat([Buffer.from('echo: '), data]))); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { peer?.destroy(); server.close(); });
  const handle = createTransport({ protocol: 'raw', host: '127.0.0.1', port: server.address().port });
  t.after(() => handle.kill());
  const events = observe(handle);
  assert.equal(events.text, '');
  handle.write('λ\r\n');
  await until(() => events.text.includes('echo: λ\r\n'));
  assert.match(events.text, /Raw TCP connection established/);
  handle.resize(120, 42); // Raw sockets have no terminal-size protocol.
  handle.kill(); handle.kill();
  await tick();
  assert.deepEqual(events.exits, [{ exitCode: 0, signal: 'closed' }]);
  assert.throws(() => handle.write('late'), /no longer open/);
});

test('Telnet performs a real loopback terminal-type/window-size negotiation and data exchange', async t => {
  let peer, received = Buffer.alloc(0);
  const server = net.createServer(socket => {
    peer = socket;
    socket.on('data', bytes => { received = Buffer.concat([received, bytes]); });
    socket.write(Buffer.from([255]));
    setTimeout(() => socket.write(Buffer.from([253, 24, 255, 253, 31, 255, 251, 1, 255, 253, 0, 255, 251, 0, 255, 250, 24, 1, 255, 240])), 5);
    setTimeout(() => socket.write(Buffer.from('router> λ')), 10);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { peer?.destroy(); server.close(); });
  const handle = createTransport({ protocol: 'telnet', host: '127.0.0.1', port: server.address().port, terminalType: 'vt100' });
  t.after(() => handle.kill());
  const events = observe(handle);
  handle.resize(132, 43);
  await until(() => events.text.includes('router> λ') && includes(received, [255, 250, 24, 0, ...Buffer.from('VT100'), 255, 240]));
  assert.ok(includes(received, [255, 250, 31, 0, 132, 0, 43, 255, 240]));
  handle.write('show version\r');
  await until(() => received.includes(Buffer.from('show version\r')));
  assert.ok(!events.text.includes('show version')); // Server is responsible for echo.
  peer.end('bye\r\n');
  await until(() => events.exits.length === 1);
  assert.equal(events.exits[0].exitCode, 0);
});

test('Telnet retains fragmented IAC, subnegotiation, UTF-8 and NVT CR state', async t => {
  const state = tcp('telnet', { terminal: { terminalType: 'xterm-256color' } });
  t.after(() => state.handle.kill());
  await tick(); state.socket.emit('connect');
  state.socket.writes.length = 0;
  // A SEND without a completed DO TTYPE is not accepted.
  state.socket.emit('data', Buffer.from([255, 250, 24, 1, 255, 240]));
  assert.equal(state.socket.writes.length, 0);
  for (const byte of [255, 253, 24, 255, 250, 24, 1, 255, 240]) state.socket.emit('data', Buffer.from([byte]));
  assert.ok(includes(wire(state.socket), [255, 250, 24, 0, ...Buffer.from('XTERM-256COLOR'), 255, 240]));
  const lambda = Buffer.from('λ');
  state.socket.emit('data', lambda.subarray(0, 1));
  state.socket.emit('data', Buffer.concat([lambda.subarray(1), Buffer.from([13])]));
  state.socket.emit('data', Buffer.from([255, 241])); // NOP between CR and NUL.
  state.socket.emit('data', Buffer.from([0, 10, 255]));
  state.socket.emit('data', Buffer.from([255, 65]));
  assert.match(state.events.text, /λ\r\n�A$/u);
  assert.ok(!state.events.text.includes('\u0000'));
  // A fragmented unknown subnegotiation with escaped IAC is discarded.
  for (const byte of [255, 250, 99, 255, 255, 65, 255, 240]) state.socket.emit('data', Buffer.from([byte]));
  state.socket.emit('data', Buffer.from('tail'));
  assert.match(state.events.text, /�Atail$/u);
});

test('Telnet rejects unsupported options, accepts directional options, and does not loop on acknowledgments', async t => {
  const state = tcp(); t.after(() => state.handle.kill());
  await tick(); state.socket.emit('connect'); state.socket.writes.length = 0;
  state.socket.emit('data', Buffer.from([255, 251, 42, 255, 253, 42, 255, 253, 1]));
  assert.deepEqual(wire(state.socket), Buffer.from([255, 254, 42, 255, 252, 42, 255, 252, 1]));
  state.socket.writes.length = 0;
  state.socket.emit('data', Buffer.from([255, 251, 1, 255, 251, 1, 255, 253, 3, 255, 253, 3, 255, 252, 42, 255, 254, 42]));
  assert.equal(state.socket.writes.length, 0); // Replies to our initial offers.
  state.socket.emit('data', Buffer.from([255, 252, 1, 255, 252, 1]));
  assert.deepEqual(wire(state.socket), Buffer.from([255, 254, 1]));
  state.handle.write('abc\r');
  assert.match(state.events.text, /abc\r\n$/u); // Local echo after ECHO disabled.
  assert.ok(includes(wire(state.socket), [...Buffer.from('abc'), 13, 0]));
  state.socket.emit('data', Buffer.from([255, 253, 0, 255, 251, 0]));
  state.socket.writes.length = 0;
  state.handle.write('binary\r\u0000');
  assert.deepEqual(wire(state.socket), Buffer.from('binary\r\u0000'));
  state.socket.emit('data', Buffer.from([13, 0]));
  assert.match(state.events.text, /\r\u0000$/u); // Binary data is not NVT-filtered.
});

test('Telnet NAWS doubles IAC bytes, updates only when negotiated, and sends a real break command', async t => {
  const state = tcp(); t.after(() => state.handle.kill());
  state.handle.resize(255, 511);
  await tick(); state.socket.emit('connect'); state.socket.writes.length = 0;
  state.socket.emit('data', Buffer.from([255, 253, 31]));
  assert.deepEqual(wire(state.socket), Buffer.from([255, 250, 31, 0, 255, 255, 1, 255, 255, 255, 240]));
  state.socket.writes.length = 0;
  state.handle.resize(80, 24); state.handle.sendBreak();
  assert.deepEqual(wire(state.socket), Buffer.from([255, 250, 31, 0, 80, 0, 24, 255, 240, 255, 243]));
  state.socket.emit('data', Buffer.from([255, 254, 31]));
  state.socket.writes.length = 0;
  state.handle.resize(132, 60);
  assert.equal(state.socket.writes.length, 0);
});

test('backpressure, input and negotiation buffers are bounded; timeout and errors close once', async t => {
  const state = tcp('raw'); t.after(() => state.handle.kill());
  assert.throws(() => state.handle.write('λ'.repeat(140000)), /256 KiB/);
  await tick(); state.socket.emit('connect'); state.socket.acceptWrites = false;
  state.handle.write('one'); state.handle.write('two');
  assert.equal(state.socket.writes.length, 1);
  state.socket.acceptWrites = true; state.socket.emit('drain');
  assert.equal(wire(state.socket).toString(), 'onetwo');
  state.socket.acceptWrites = false;
  for (let i = 0; i < 6; i++) { if (!state.events.exits.length) state.handle.write('x'.repeat(256 * 1024)); }
  assert.equal(state.events.exits.length, 1);
  assert.match(state.events.text, /queue exceeds 1 MiB/);
  assert.ok(state.socket.destroyed);
  await tick();
  assert.equal(state.socket.listenerCount('data'), 0);

  const telnet = tcp(); t.after(() => telnet.handle.kill());
  await tick(); telnet.socket.emit('connect');
  telnet.socket.emit('data', Buffer.concat([Buffer.from([255, 250, 99]), Buffer.alloc(4097, 65)]));
  assert.match(telnet.events.text, /subnegotiation exceeds 4 KiB/);
  assert.equal(telnet.events.exits[0].exitCode, 1);

  const socket = new Socket();
  const timed = createTransport({ protocol: 'raw', host: 'localhost', port: 23 }, { timeoutMs: 10, net: { createConnection: () => socket } });
  const events = observe(timed); t.after(() => timed.kill());
  await until(() => events.exits.length > 0);
  assert.match(events.text, /timed out/);
  assert.equal(events.exits[0].exitCode, 1);
  assert.ok(socket.destroyed);
  const stopped = events.text;
  socket.emit('data', Buffer.from('stale'));
  assert.equal(events.text, stopped);
});

test('real refused TCP connection reports failure rather than a successful connection', async t => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const handle = createTransport({ protocol: 'raw', host: '127.0.0.1', port });
  t.after(() => handle.kill());
  const events = observe(handle);
  await until(() => events.exits.length > 0);
  assert.match(events.text, /Raw TCP error:.*ECONNREFUSED/);
  assert.ok(!events.text.includes('connection established'));
  assert.deepEqual(events.exits, [{ exitCode: 1, signal: null }]);
});

function fakeSerial({ openError, writeError, closeError, manualOpen = false } = {}) {
  const instances = [];
  class Port extends Socket {
    constructor(options) { super(); this.options = options; this.isOpen = false; this.closeCount = 0; this.flags = []; instances.push(this); }
    open(callback) {
      this.completeOpen = () => {
        if (openError) { callback(openError); return; }
        this.isOpen = true; this.emit('open'); callback(null);
      };
      if (!manualOpen) queueMicrotask(() => this.completeOpen());
    }
    write(bytes, callback) { this.writes.push(Buffer.from(bytes)); queueMicrotask(() => callback?.(writeError || null)); return true; }
    close(callback) {
      this.closeCount++;
      queueMicrotask(() => {
        if (!closeError) { this.isOpen = false; this.emit('close'); }
        callback(closeError || null);
      });
    }
    set(flags, callback) { this.flags.push(flags); callback?.(null); }
    destroy() { this.isOpen = false; super.destroy(); }
    static async list() { return [{ path: '/dev/tty.fake', manufacturer: 'Synthetic', vendorId: '1234' }, { path: 'bad\u0000path' }]; }
  }
  return { Port, instances };
}
function serial(Port, fields = {}, options = {}) {
  const handle = createTransport({ protocol: 'serial', serial: { path: '/dev/tty.fake', ...fields } }, { SerialPort: Port, ...options });
  return { handle, events: observe(handle) };
}

test('serial opens the actual adapter API, applies hardware/software flow control, and streams fragmented UTF-8', async t => {
  const fake = fakeSerial();
  const state = serial(fake.Port, { baudRate: 115200, dataBits: 7, stopBits: 2, parity: 'even', flowControl: 'rtscts' });
  t.after(() => state.handle.kill());
  state.handle.write('queued');
  await tick();
  const port = fake.instances[0];
  assert.deepEqual(port.options, { path: '/dev/tty.fake', baudRate: 115200, dataBits: 7, stopBits: 2, parity: 'even', rtscts: true, xon: false, xoff: false, xany: false, autoOpen: false, highWaterMark: 65536 });
  assert.equal(wire(port).toString(), 'queued');
  const utf8 = Buffer.from('€');
  port.emit('data', utf8.subarray(0, 1)); port.emit('data', utf8.subarray(1));
  assert.match(state.events.text, /115200 baud.*\r\n€$/su);
  const beforeDispose = state.events.chunks.length;
  state.events.data.dispose(); port.emit('data', Buffer.from('later'));
  assert.equal(state.events.chunks.length, beforeDispose);
  state.handle.kill(); state.handle.kill();
  await tick();
  assert.equal(port.closeCount, 1);
  assert.equal(port.listenerCount('data'), 0);
  assert.deepEqual(state.events.exits, [{ exitCode: 0, signal: 'closed' }]);

  const software = serial(fake.Port, { flowControl: 'xonxoff' }); t.after(() => software.handle.kill());
  await tick();
  assert.equal(fake.instances[1].options.xon, true);
  assert.equal(fake.instances[1].options.xoff, true);
  assert.equal(fake.instances[1].options.rtscts, false);
  assert.deepEqual(await listSerialPorts({ SerialPort: fake.Port }), [{ path: '/dev/tty.fake', manufacturer: 'Synthetic', vendorId: '1234' }]);
});

test('serial open/write/disconnect failures and a canceled pending open release the device', async t => {
  const opening = fakeSerial({ openError: new Error('Synthetic permission denied') });
  const denied = serial(opening.Port); t.after(() => denied.handle.kill());
  await tick();
  assert.match(denied.events.text, /permission denied/);
  assert.equal(denied.events.exits[0].exitCode, 1);
  assert.equal(opening.instances[0].listenerCount('data'), 0);

  const writing = fakeSerial({ writeError: new Error('Synthetic write failure') });
  const failed = serial(writing.Port); t.after(() => failed.handle.kill());
  await tick(); failed.handle.write('x'); await tick();
  assert.match(failed.events.text, /write failure/);
  assert.equal(failed.events.exits[0].exitCode, 1);
  assert.equal(writing.instances[0].closeCount, 1);

  const disconnected = fakeSerial();
  const unplugged = serial(disconnected.Port); t.after(() => unplugged.handle.kill());
  await tick(); disconnected.instances[0].isOpen = false;
  disconnected.instances[0].emit('close', new Error('Synthetic device unplugged'));
  assert.equal(unplugged.events.exits[0].exitCode, 1);

  const pending = fakeSerial({ manualOpen: true });
  const canceled = serial(pending.Port); t.after(() => canceled.handle.kill());
  await tick();
  const cancel = canceled.handle.kill();
  let resolved = false; cancel.then(() => { resolved = true; });
  await tick();
  assert.equal(canceled.events.exits.length, 0);
  assert.equal(resolved, false);
  assert.throws(() => canceled.handle.write('late'), /closing/);
  pending.instances[0].completeOpen(); await cancel;
  assert.equal(pending.instances[0].closeCount, 1);
  assert.equal(pending.instances[0].isOpen, false);
  assert.equal(canceled.events.exits.length, 1);
  assert.ok(!canceled.events.text.includes('connection established'));
});

test('serial timeout waits for a late-opened port to close before reporting exit', async t => {
  const late = fakeSerial({ manualOpen: true });
  const state = serial(late.Port, {}, { timeoutMs: 10 }); t.after(() => state.handle.kill());
  await until(() => state.events.text.includes('timed out'));
  assert.equal(state.events.exits.length, 0);
  late.instances[0].completeOpen(); await state.handle.kill();
  assert.equal(late.instances[0].closeCount, 1);
  assert.equal(late.instances[0].isOpen, false);
  assert.equal(state.events.exits[0].exitCode, 1);

});

test('serial uses the installed SerialPortMock stream with a real binding lifecycle', async t => {
  const { SerialPortMock } = require('serialport');
  const device = `/dev/termforge-synthetic-${process.pid}`;
  SerialPortMock.binding.createPort(device, { echo: true, record: true, maxReadSize: 1 });
  let port;
  class Adapter extends SerialPortMock { constructor(options) { super(options); port = this; } }
  const state = serial(Adapter, { path: device, baudRate: 57600 });
  t.after(() => state.handle.kill());
  state.handle.write('native mock λ\r\n');
  await until(() => state.events.text.includes('native mock λ\r\n'));
  assert.equal(port.port.recording.toString(), 'native mock λ\r\n');
  const binding = port.port;
  state.handle.write('write during close');
  await state.handle.kill();
  await tick(); await tick();
  assert.equal(binding.isOpen, false);
  assert.equal(state.events.exits.length, 1);
  assert.equal(port.listenerCount('data'), 0);
});

test('serial recovers an adapter close failure by closing its actual OS binding', async t => {
  const { SerialPortMock } = require('serialport');
  const device = `/dev/termforge-close-synthetic-${process.pid}`;
  SerialPortMock.binding.createPort(device);
  let port;
  class Adapter extends SerialPortMock { constructor(options) { super(options); port = this; } }
  const state = serial(Adapter, { path: device });
  t.after(() => state.handle.kill());
  await until(() => port?.isOpen);
  const binding = port.port, originalClose = binding.close.bind(binding);
  let attempts = 0;
  binding.close = async () => {
    if (++attempts === 1) throw new Error('Synthetic initial close failure');
    await originalClose();
  };
  await state.handle.kill();
  await tick(); await tick();
  assert.equal(attempts, 2);
  assert.equal(state.events.exits.length, 1);
  assert.equal(port.listenerCount('data'), 0);
  assert.equal(port.listenerCount('error'), 0);
});

test('serial permanent close rejection retains its native handle and succeeds on an explicit retry', async t => {
  const { SerialPortMock } = require('serialport');
  const device = `/dev/termforge-retry-synthetic-${process.pid}`;
  SerialPortMock.binding.createPort(device, { record: true });
  let port;
  class Adapter extends SerialPortMock { constructor(options) { super(options); port = this; } }
  const state = serial(Adapter, { path: device });
  t.after(() => state.handle.kill());
  await until(() => port?.isOpen);
  const binding = port.port, originalClose = binding.close.bind(binding);
  let attempts = 0;
  binding.close = async () => { attempts++; throw new Error('Synthetic persistent close refusal'); };
  const rejected = state.handle.kill();
  assert.equal(state.handle.kill(), rejected); // One close attempt at a time.
  await assert.rejects(rejected, /persistent close refusal/);
  assert.equal(attempts, 2); // Adapter close, then one direct binding fallback.
  assert.equal(binding.isOpen, true);
  assert.equal(state.events.exits.length, 0);
  assert.ok(port.listenerCount('data') > 0);
  assert.ok(port.listenerCount('error') > 0);
  binding.emitData('device still owned');
  await until(() => state.events.text.includes('device still owned'));
  state.handle.write('retryable');
  await until(() => binding.recording.toString() === 'retryable');
  binding.close = originalClose;
  await state.handle.kill();
  await tick(); await tick();
  assert.equal(binding.isOpen, false);
  assert.deepEqual(state.events.exits, [{ exitCode: 0, signal: 'closed' }]);
  assert.equal(port.listenerCount('data'), 0);
  assert.equal(port.listenerCount('error'), 0);
});

test('transport validation prevents invalid device options and closed/disposed subscriptions stay quiet', async () => {
  assert.throws(() => createTransport({ protocol: 'ssh' }), /protocol/);
  assert.throws(() => createTransport({ protocol: 'raw', host: 'host', port: 0 }), /TCP port/);
  assert.throws(() => createTransport({ protocol: 'telnet', host: 'host', port: 23, terminalType: 'xterm\r\n' }), /Terminal type/);
  const fake = fakeSerial();
  for (const fields of [{ path: '' }, { baudRate: 0 }, { baudRate: 12.5 }, { dataBits: 9 }, { parity: 'invalid' }, { stopBits: 3 }, { flowControl: 'invalid' }]) assert.throws(() => serial(fake.Port, fields), /serial|Serial/);
  const state = tcp('raw');
  const extra = []; const listener = state.handle.onExit(event => extra.push(event)); listener.dispose();
  state.handle.kill();
  await tick();
  assert.equal(state.connections.length, 0);
  assert.equal(extra.length, 0);
  const late = []; const disposed = state.handle.onExit(event => late.push(event)); disposed.dispose();
  await tick(); assert.equal(late.length, 0);
  assert.throws(() => state.handle.resize(0, 30), /dimensions/);
});
