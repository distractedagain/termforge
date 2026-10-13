'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTerminalManager } = require('../app/terminals.cjs');

function setup(overrides = {}) {
  const handles = [];
  const launches = [];
  const data = [];
  const exits = [];
  const manager = createTerminalManager({
    cwd: process.cwd(), env: { SHELL: '/bin/sh', HOME: '/tmp' }, platform: 'linux',
    emitData: event => data.push(event), emitExit: event => exits.push(event),
    spawn(file, args, options) {
      launches.push({ file, args, options });
      const handle = { writes: [], sizes: [], killed: 0, disposed: 0,
        onData(callback) { this.data = callback; if (overrides.earlyData) callback(overrides.earlyData); return { dispose: () => this.disposed++ }; },
        onExit(callback) { this.exit = callback; return { dispose: () => this.disposed++ }; },
        write(value) { this.writes.push(value); }, resize(cols, rows) { this.sizes.push({ cols, rows }); },
        kill() { this.killed++; if (overrides.killError) throw new Error('Kill failed'); this.exit?.({ exitCode: 0, signal: 1 }); },
      };
      handles.push(handle); return handle;
    },
    ...overrides,
  });
  return { manager, handles, launches, data, exits };
}

test('terminal manager holds startup output, streams UTF-8, resizes and disposes after exit', async t => {
  const state = setup({ earlyData: 'ready> ' });
  t.after(() => state.manager.closeAll());
  const terminal = state.manager.open({ protocol: 'local', name: 'Shell' });
  assert.equal(terminal.title, 'Shell');
  assert.equal(terminal.protocol, 'local');
  assert.equal(state.manager.count, 1);
  assert.equal(state.data.length, 0);
  assert.equal(state.launches[0].options.encoding, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(state.data, [{ id: terminal.id, data: 'ready> ' }]);
  state.handles[0].data('λ terminal output');
  state.manager.write({ id: terminal.id, data: 'pwd\r' });
  state.manager.resize({ id: terminal.id, cols: 120, rows: 42 });
  assert.deepEqual(state.handles[0].writes, ['pwd\r']);
  assert.deepEqual(state.handles[0].sizes, [{ cols: 120, rows: 42 }]);
  assert.equal(state.data[1].data, 'λ terminal output');
  state.handles[0].exit({ exitCode: 7, signal: 0 });
  assert.equal(state.manager.count, 0);
  assert.equal(state.handles[0].disposed, 2);
  assert.deepEqual(state.exits, [{ id: terminal.id, exitCode: 7, signal: 0 }]);
  assert.throws(() => state.manager.write({ id: terminal.id, data: 'x' }), /no longer open/);
});

test('native early exit flushes output before exit and closed callbacks cannot deliver stale data', () => {
  const state = setup({ earlyData: 'error\r\n' });
  const terminal = state.manager.open({ protocol: 'local' });
  state.handles[0].exit({ exitCode: 1 });
  assert.deepEqual(state.data, [{ id: terminal.id, data: 'error\r\n' }]);
  assert.equal(state.exits[0].exitCode, 1);
  state.handles[0].data('stale');
  state.handles[0].exit({ exitCode: 5 });
  assert.equal(state.data.length, 1);
  assert.equal(state.exits.length, 1);
});

test('input, terminal counts and dimensions have resource bounds', t => {
  const state = setup();
  t.after(() => state.manager.closeAll());
  const terminal = state.manager.open({ protocol: 'local' });
  for (const dimensions of [{ cols: 0, rows: 24 }, { cols: 100, rows: 301 }, { cols: 12.5, rows: 24 }, { cols: 501, rows: 24 }]) assert.throws(() => state.manager.resize({ id: terminal.id, ...dimensions }), /dimensions/);
  assert.throws(() => state.manager.write({ id: terminal.id, data: Buffer.from('input') }), /input/);
  assert.throws(() => state.manager.write({ id: terminal.id, data: 'λ'.repeat(140000) }), /256 KiB/);
  for (let i = 1; i < 32; i++) state.manager.open({ protocol: 'local' });
  assert.equal(state.manager.count, 32);
  assert.throws(() => state.manager.open({ protocol: 'local' }), /32 terminals/);
});

test('close and closeAll terminate each native process exactly once, including a failed kill', () => {
  const state = setup();
  const first = state.manager.open({ protocol: 'local' });
  state.manager.open({ protocol: 'local' });
  state.manager.close(first.id);
  state.manager.close(first.id);
  state.manager.closeAll();
  assert.equal(state.manager.count, 0);
  assert.deepEqual(state.handles.map(handle => handle.killed), [1, 1]);
  assert.equal(state.exits.length, 2);
  const failureOptions = { killError: true };
  const broken = setup(failureOptions);
  broken.manager.open({ protocol: 'local' }); broken.manager.open({ protocol: 'local' });
  assert.throws(() => broken.manager.closeAll(), /Kill failed/);
  assert.equal(broken.manager.count, 2);
  assert.deepEqual(broken.handles.map(handle => handle.killed), [1, 1]);
  failureOptions.killError = false;
  broken.manager.closeAll();
  assert.equal(broken.manager.count, 0);
  assert.deepEqual(broken.handles.map(handle => handle.killed), [2, 2]);
});

test('logging records output only, creates private files, and closes on terminal exit', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = setup();
  t.after(() => state.manager.closeAll());
  const terminal = state.manager.open({ protocol: 'local' });
  await new Promise(resolve => setTimeout(resolve, 40));
  const filename = path.join(directory, 'session.log');
  assert.deepEqual(state.manager.enableLog(terminal.id, filename), { id: terminal.id, path: filename, logging: true });
  state.manager.write({ id: terminal.id, data: 'typed-secret' });
  state.handles[0].data('remote output\r\n');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'remote output\r\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.throws(() => state.manager.enableLog(terminal.id, filename), /EEXIST/);
  state.handles[0].data('still logging\n');
  state.manager.pauseLog(terminal.id, true);
  state.handles[0].data('paused output\n');
  state.manager.pauseLog(terminal.id, false);
  state.handles[0].data('resumed in same file\n');
  state.manager.disableLog(terminal.id);
  state.handles[0].data('after disable\n');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'remote output\r\nstill logging\nresumed in same file\n');
  state.manager.enableLog(terminal.id, path.join(directory, 'second.log'));
  state.handles[0].exit({ exitCode: 0 });
  assert.equal(state.manager.count, 0);
  assert.throws(() => state.manager.disableLog(terminal.id), /no longer open/);
});

test('an invalid native process or SSH profile cannot leak a counted terminal', () => {
  const invalid = createTerminalManager({ spawn: () => ({ kill() {} }) });
  assert.throws(() => invalid.open({ protocol: 'local' }), /could not be started/);
  assert.equal(invalid.count, 0);
  const state = setup();
  assert.throws(() => state.manager.open({ protocol: 'ssh', host: '-oProxyCommand=id' }), /Host/);
  assert.equal(state.launches.length, 0);
  assert.equal(state.manager.count, 0);
});

test('a synchronous native exit during registration disposes both subscriptions', () => {
  let disposed = 0;
  const manager = createTerminalManager({ spawn: () => ({
    write() {}, resize() {}, kill() {},
    onData() { return { dispose() { disposed++; } }; },
    onExit(callback) { callback({ exitCode: 1 }); return { dispose() { disposed++; } }; },
  }) });
  manager.open({ protocol: 'local' });
  assert.equal(manager.count, 0);
  assert.equal(disposed, 2);
});

test('TCP and serial sessions share terminal buffering/logging/cleanup without spawning a process', async t => {
  const calls = [];
  const output = [];
  const handle = {
    onData(fn) { this.data = fn; fn('transport ready'); return { dispose() {} }; },
    onExit(fn) { this.exit = fn; return { dispose() {} }; },
    write(text) { calls.push(['write', text]); }, resize(cols, rows) { calls.push(['resize', cols, rows]); },
    sendBreak() { calls.push(['break']); }, kill() { calls.push(['kill']); this.exit({ exitCode: 0 }); },
  };
  const manager = createTerminalManager({ spawn() { assert.fail('Socket sessions must never spawn SSH.'); }, transport(session) { calls.push(['transport', session.protocol]); return handle; }, emitData(event) { output.push(event); } });
  t.after(() => manager.closeAll());
  const result = manager.open({ name: 'Legacy', host: 'localhost', protocol: 'telnet' });
  assert.equal(output.length, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(output[0].data, 'transport ready');
  manager.write({ id: result.id, data: 'show version\r' }); manager.resize({ id: result.id, cols: 80, rows: 24 }); manager.sendBreak(result.id); manager.close(result.id);
  assert.deepEqual(calls, [['transport', 'telnet'], ['write', 'show version\r'], ['resize', 80, 24], ['break'], ['kill']]);
  assert.equal(manager.count, 0);
});

test('asynchronous device close remains counted until confirmed, and failed closes can retry', async () => {
  let resolveClose, rejectClose, attempts = 0;
  const handle = { write() {}, resize() {}, onData() { return { dispose() {} }; }, onExit(fn) { this.exit = fn; return { dispose() {} }; }, kill() { attempts++; return new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; }); } };
  const manager = createTerminalManager({ transport() { return handle; } });
  const terminal = manager.open({ name: 'Device', protocol: 'serial', serial: { path: 'COM1' } });
  const first = manager.close(terminal.id);
  assert.equal(manager.close(terminal.id), first);
  assert.equal(manager.count, 1); assert.equal(attempts, 1);
  rejectClose(new Error('Device did not close'));
  await assert.rejects(first, /did not close/);
  assert.equal(manager.count, 1);
  const second = manager.closeAll();
  assert.equal(attempts, 2); assert.equal(manager.count, 1);
  resolveClose();
  await second;
  assert.equal(manager.count, 0);
});

test('live terminal metadata follows dragged order without replacing process handles', t => {
  const state = setup(); t.after(() => state.manager.closeAll());
  const first = state.manager.open({ protocol: 'local', name: 'First' }); const second = state.manager.open({ protocol: 'local', name: 'Second' });
  state.manager.reorder([second.id, first.id]);
  assert.deepEqual(state.manager.list().map(terminal => terminal.id), [second.id, first.id]);
  assert.equal(state.manager.describe(first.id).title, 'First');
  state.manager.write({ id: first.id, data: 'same process' }); assert.deepEqual(state.handles[0].writes, ['same process']);
  const detached = state.manager.describe(first.id); detached.session.name = 'Changed copy'; assert.equal(state.manager.describe(first.id).title, 'First');
  assert.throws(() => state.manager.reorder([first.id, first.id]), /Invalid terminal order/);
  state.manager.close(second.id); state.manager.reorder([second.id, first.id]); assert.deepEqual(state.manager.list().map(terminal => terminal.id), [first.id]);
});

function rawSetup() {
  const changes = [], data = [], writes = [];
  const handle = { write() {}, resize() {}, kill() { this.exit?.({ exitCode: 0 }); },
    writeBytes(bytes) { writes.push(bytes); },
    onData(callback) { this.data = callback; return { dispose() {} }; },
    onRawData(callback) { this.raw = callback; return { dispose() {} }; },
    onExit(callback) { this.exit = callback; return { dispose() {} }; },
  };
  const manager = createTerminalManager({ transport: () => handle, emitOutputState: state => changes.push(state), emitData: value => data.push(value) });
  const terminal = manager.open({ protocol: 'raw', host: '127.0.0.1', port: 1234 });
  return { manager, handle, terminal, changes, data, writes };
}

test('raw logging and independent ASCII receive capture exact bytes and filtered text with independent stop/pause', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = rawSetup(); t.after(() => state.manager.closeAll());
  const id = state.terminal.id, raw = path.join(directory, 'raw.bin'), text = path.join(directory, 'receive.txt');
  state.handle.data('before capture');
  state.manager.enableLog(id, raw, { mode: 'raw' }); state.manager.enableCapture(id, text);
  const first = Buffer.from([0xff, 0, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41]);
  state.handle.raw(first); state.handle.data('\uFFFD\0\x1b[31mA');
  state.manager.pauseLog(id, true); state.handle.raw(Buffer.from('paused')); state.handle.data('during pause');
  state.manager.pauseLog(id, false); state.handle.raw(Buffer.from('last')); state.handle.data('\x1b[0mlast');
  state.manager.disableCapture(id); state.handle.data('not received'); state.manager.disableLog(id);
  assert.deepEqual(fs.readFileSync(raw), Buffer.concat([first, Buffer.from('last')]));
  assert.equal(fs.readFileSync(text, 'utf8'), '\uFFFDA' + 'during pauselast');
  assert.equal(state.manager.outputState(id).log.enabled, false); assert.equal(state.manager.outputState(id).capture.enabled, false);
  assert.ok(state.changes.some(value => value.log.paused)); assert.equal(state.changes.at(-1).log.enabled, false);
});

test('Hex View retains only the newest 64 KiB of received bytes with a truthful absolute offset', t => {
  const state = rawSetup(); t.after(() => state.manager.closeAll()); const id = state.terminal.id;
  state.handle.data('synthetic status is not received bytes'); state.handle.raw(Buffer.alloc(70000, 0xff));
  state.handle.raw(Buffer.from([0x00, 0xc0, 0xff]));
  const result = state.manager.readRaw(id), bytes = Buffer.from(result.base64, 'base64');
  assert.equal(bytes.length, 65536); assert.equal(result.offset, 70003 - 65536); assert.equal(result.totalBytes, 70003);
  assert.deepEqual(bytes.subarray(-3), Buffer.from([0x00, 0xc0, 0xff]));
  assert.equal(state.manager.outputState(id).capabilities.hex, true);
  state.manager.close(id); assert.throws(() => state.manager.readRaw(id), /no longer open/);
});

test('binary send preserves every byte, copies caller buffers and rejects overflow and text', t => {
  const state = rawSetup(); t.after(() => state.manager.closeAll()); const id = state.terminal.id;
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(state.manager.writeBinary({ id, data: bytes }), { id, bytes: 256 });
  bytes.fill(0); assert.deepEqual(state.writes[0], Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  assert.throws(() => state.manager.writeBinary({ id, data: 'text' }), /256 KiB/);
  assert.throws(() => state.manager.writeBinary({ id, data: Buffer.alloc(256 * 1024 + 1) }), /256 KiB/);
  assert.equal(state.writes.length, 1);
});

test('decoded native PTYs cannot claim raw logging, binary sending or Hex View capabilities', t => {
  const state = setup(); t.after(() => state.manager.closeAll()); const terminal = state.manager.open({ protocol: 'local' });
  assert.deepEqual(state.manager.outputState(terminal.id).capabilities, { rawLog: false, binary: false, hex: false });
  assert.throws(() => state.manager.enableLog(terminal.id, path.join(os.tmpdir(), 'unused-raw.log'), { mode: 'raw' }), /decoded text/);
  assert.throws(() => state.manager.readRaw(terminal.id), /decoded text/);
  assert.throws(() => state.manager.writeBinary({ id: terminal.id, data: Buffer.from([255]) }), /requires/);
});

test('file write errors stop the affected capture and publish its disabled state while preserving the terminal', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = rawSetup(); t.after(() => state.manager.closeAll()); const id = state.terminal.id;
  state.manager.enableCapture(id, path.join(directory, 'capture.txt'));
  t.mock.method(fs, 'writeSync', () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); });
  state.handle.data('output');
  assert.equal(state.manager.outputState(id).capture.enabled, false);
  assert.equal(state.changes.at(-1).capture.enabled, false);
  assert.equal(state.manager.has(id), true);
  assert.match(state.data.at(-2).data, /ASCII receive stopped/); assert.equal(state.data.at(-1).data, 'output');
});
