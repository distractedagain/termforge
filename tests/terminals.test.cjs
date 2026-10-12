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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-log-'));
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
  state.manager.disableLog(terminal.id);
  state.handles[0].data('after disable\n');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'remote output\r\nstill logging\n');
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
