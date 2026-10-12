'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dgram = require('node:dgram');
const { createTftpServer } = require('../app/tftp.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for TFTP state.'); await sleep(5); }
}
function block(opcode, number, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(data.length + 4); bytes.writeUInt16BE(opcode, 0); bytes.writeUInt16BE(number, 2); data.copy(bytes, 4); return bytes;
}
function request(opcode, filename, mode = 'octet', options = []) {
  const header = Buffer.alloc(2); header.writeUInt16BE(opcode);
  return Buffer.concat([header, Buffer.from([filename, mode, ...options].join('\0') + '\0', 'ascii')]);
}
async function client(t) {
  const socket = dgram.createSocket('udp4'), queued = [];
  let waiting = null;
  socket.on('message', (bytes, remote) => {
    const result = { bytes, remote };
    if (waiting) { const resolve = waiting.resolve; clearTimeout(waiting.timer); waiting = null; resolve(result); }
    else queued.push(result);
  });
  socket.on('error', error => { if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); waiting = null; } });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } }));
  return {
    socket,
    send(bytes, port, address = '127.0.0.1') { return new Promise((resolve, reject) => socket.send(bytes, port, address, error => error ? reject(error) : resolve())); },
    receive(timeout = 1000) {
      if (queued.length) return Promise.resolve(queued.shift());
      if (waiting) throw new Error('Only one receive can wait at a time.');
      const timeoutError = new Error('UDP receive timed out.');
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject, timer: setTimeout(() => { waiting = null; reject(timeoutError); }, timeout) };
      });
    },
  };
}
async function fixture(t, options = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'termforge-tftp-'));
  const root = path.join(directory, 'shared'); await fs.promises.mkdir(root);
  const events = [], states = [];
  const server = createTftpServer({ root, clientAddress: '127.0.0.1', port: 0, timeoutMs: 100, retries: 2, onStatus: value => states.push(value), onTransfer: value => events.push(value), ...options });
  const address = await server.start();
  t.after(async () => { await server.stop(); await fs.promises.rm(directory, { recursive: true, force: true }); });
  return { root, directory, events, states, server, port: address.port };
}
async function download(peer, port, name, options = []) {
  await peer.send(request(1, name, 'octet', options), port);
  const chunks = [], packets = []; let transferPort;
  while (true) {
    const response = await peer.receive();
    const opcode = response.bytes.readUInt16BE(0);
    if (opcode === 5) throw Object.assign(new Error(response.bytes.subarray(4, -1).toString()), { code: response.bytes.readUInt16BE(2) });
    assert.equal(opcode, 3);
    transferPort ||= response.remote.port; assert.equal(response.remote.port, transferPort);
    assert.equal(response.bytes.readUInt16BE(2), (packets.length + 1) & 0xffff);
    packets.push(response.bytes); chunks.push(response.bytes.subarray(4));
    await peer.send(block(4, response.bytes.readUInt16BE(2)), transferPort);
    if (response.bytes.length < 516) return { bytes: Buffer.concat(chunks), packets, transferPort };
  }
}
async function expectError(peer, bytes, port, expected) {
  await peer.send(bytes, port);
  const response = await peer.receive(); assert.equal(response.bytes.readUInt16BE(0), 5);
  assert.ok([expected].flat().includes(response.bytes.readUInt16BE(2)));
  return response;
}

test('TFTP downloads octet bytes from nested paths and terminates exact multiples with a zero block', async t => {
  const state = await fixture(t), peer = await client(t);
  await fs.promises.mkdir(path.join(state.root, 'nested'));
  const bytes = Buffer.alloc(1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
  await fs.promises.writeFile(path.join(state.root, 'nested', 'firmware.bin'), bytes);
  const result = await download(peer, state.port, 'nested/firmware.bin', ['blksize', '1024']);
  assert.deepEqual(result.bytes, bytes);
  assert.deepEqual(result.packets.map(value => value.length), [516, 516, 4]);
  assert.notEqual(result.transferPort, state.port);
  await until(() => state.server.status().completedTransfers === 1);
  assert.equal(state.events.find(value => value.state === 'completed').bytes, bytes.length);
  await fs.promises.writeFile(path.join(state.root, 'empty.bin'), Buffer.alloc(0));
  const empty = await download(peer, state.port, 'empty.bin');
  assert.equal(empty.packets.length, 1); assert.equal(empty.bytes.length, 0);
});

test('TFTP uploads publish a new private file atomically and duplicate DATA/final ACK exchanges are idempotent', async t => {
  const state = await fixture(t, { allowWrite: true }), peer = await client(t);
  await peer.send(request(2, 'config.txt'), state.port);
  const initial = await peer.receive(), tid = initial.remote.port;
  assert.deepEqual(initial.bytes, block(4, 0));
  const files = await fs.promises.readdir(state.root);
  assert.equal(files.length, 1); assert.match(files[0], /^\.termforge-tftp-.*\.part$/u);
  assert.equal(fs.existsSync(path.join(state.root, 'config.txt')), false);
  const first = Buffer.alloc(512, 65), final = Buffer.from('tail\0\xff', 'binary');
  await peer.send(block(3, 1, first), tid); assert.deepEqual((await peer.receive()).bytes, block(4, 1));
  await peer.send(block(3, 1, first), tid); assert.deepEqual((await peer.receive()).bytes, block(4, 1));
  await peer.send(block(3, 2, final), tid); assert.deepEqual((await peer.receive()).bytes, block(4, 2));
  await peer.send(block(3, 2, final), tid); assert.deepEqual((await peer.receive()).bytes, block(4, 2));
  assert.deepEqual(await fs.promises.readFile(path.join(state.root, 'config.txt')), Buffer.concat([first, final]));
  assert.deepEqual(await fs.promises.readdir(state.root), ['config.txt']);
  if (process.platform !== 'win32') assert.equal((await fs.promises.stat(path.join(state.root, 'config.txt'))).mode & 0o777, 0o600);
  assert.equal(state.events.filter(value => value.state === 'completed').length, 1);
  assert.equal(state.server.status().completedTransfers, 1);
});

test('TFTP uploads accept empty files and a zero-length final block after an exact multiple', async t => {
  const state = await fixture(t, { allowWrite: true });
  for (const [name, payload] of [['empty.bin', Buffer.alloc(0)], ['exact.bin', Buffer.alloc(512, 91)]]) {
    const peer = await client(t);
    await peer.send(request(2, name), state.port);
    const initial = await peer.receive(); assert.deepEqual(initial.bytes, block(4, 0));
    let number = 1;
    if (payload.length) {
      await peer.send(block(3, number, payload), initial.remote.port);
      assert.deepEqual((await peer.receive()).bytes, block(4, number)); number++;
    }
    await peer.send(block(3, number), initial.remote.port);
    assert.deepEqual((await peer.receive()).bytes, block(4, number));
    assert.deepEqual(await fs.promises.readFile(path.join(state.root, name)), payload);
  }
  assert.equal(state.server.status().completedTransfers, 2);
});

test('TFTP rejects writes by default, missing files, unsafe filenames and unsupported modes', async t => {
  const state = await fixture(t), peer = await client(t);
  await expectError(peer, request(2, 'upload.bin'), state.port, 2);
  await expectError(peer, request(1, 'missing.bin'), state.port, 1);
  for (const name of ['../outside.txt', '/etc/passwd', 'C:\\secret', 'C:secret', 'nested/../x', 'nested//x', 'bad\x01name', '.termforge-tftp-private.part', 'NUL', 'name.']) await expectError(peer, request(1, name), state.port, [2, 4]);
  await expectError(peer, request(1, 'file', 'netascii'), state.port, 4);
  await expectError(peer, request(1, 'file', 'octet', ['blksize', '1024', 'BLKSIZE', '2048']), state.port, 4);
  await expectError(peer, Buffer.from([0, 1, 65]), state.port, 4);
  await expectError(peer, block(4, 1), state.port, 5);
  await expectError(peer, block(99, 0), state.port, 4);
  await until(() => state.server.status().activeTransfers === 0);
  assert.deepEqual(await fs.promises.readdir(state.root), []);
});

test('TFTP refuses file and directory symlinks escaping the selected root', async t => {
  const state = await fixture(t, { allowWrite: true }), peer = await client(t);
  const outside = path.join(state.directory, 'outside'); await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  try {
    await fs.promises.symlink(path.join(outside, 'secret.txt'), path.join(state.root, 'linked-file'), 'file');
    await fs.promises.symlink(outside, path.join(state.root, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Platform does not permit test symlinks.'); return; } throw error; }
  await expectError(peer, request(1, 'linked-file'), state.port, 2);
  await expectError(peer, request(1, 'linked-dir/secret.txt'), state.port, 2);
  await expectError(peer, request(2, 'linked-dir/new.txt'), state.port, 2);
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

test('TFTP preserves existing files, rejects a final-publish collision and bounds reads to 64 MiB', async t => {
  const state = await fixture(t, { allowWrite: true }), peer = await client(t);
  const destination = path.join(state.root, 'existing.txt'); await fs.promises.writeFile(destination, 'original');
  await expectError(peer, request(2, 'existing.txt'), state.port, 6);
  await peer.send(request(2, 'collision.txt'), state.port);
  const initial = await peer.receive(); assert.deepEqual(initial.bytes, block(4, 0));
  const collision = path.join(state.root, 'collision.txt'); await fs.promises.writeFile(collision, 'created concurrently');
  await expectError(peer, block(3, 1, Buffer.from('replacement')), initial.remote.port, 6);
  await until(async () => !(await fs.promises.readdir(state.root)).some(name => name.endsWith('.part')));
  assert.equal(await fs.promises.readFile(collision, 'utf8'), 'created concurrently');
  assert.equal(await fs.promises.readFile(destination, 'utf8'), 'original');
  const huge = path.join(state.root, 'huge.bin'); const handle = await fs.promises.open(huge, 'w');
  await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
  await expectError(peer, request(1, 'huge.bin'), state.port, 3);
});

test('TFTP retransmits only on timeout and duplicate requests keep the original transfer ID', async t => {
  const state = await fixture(t, { timeoutMs: 150, retries: 2 }), peer = await client(t);
  await fs.promises.writeFile(path.join(state.root, 'file.bin'), Buffer.alloc(700, 7));
  await peer.send(request(1, 'file.bin'), state.port);
  const first = await peer.receive();
  const retry = await peer.receive();
  assert.deepEqual(retry.bytes, first.bytes); assert.equal(retry.remote.port, first.remote.port);
  await peer.send(request(1, 'file.bin'), state.port);
  const duplicateRequest = await peer.receive();
  assert.deepEqual(duplicateRequest.bytes, first.bytes); assert.equal(duplicateRequest.remote.port, first.remote.port);
  assert.equal(state.server.status().activeTransfers, 1);
  await peer.send(block(4, 1), first.remote.port);
  const second = await peer.receive(); assert.equal(second.bytes.readUInt16BE(2), 2);
  await peer.send(block(4, 1), first.remote.port); // Old ACK must not cause retransmission.
  await assert.rejects(peer.receive(30), /timed out/);
  await peer.send(block(4, 2), first.remote.port);
  await until(() => state.server.status().completedTransfers === 1);
});

test('TFTP answers an unexpected transfer ID without disturbing the legitimate client', async t => {
  const state = await fixture(t), peer = await client(t), intruder = await client(t);
  await fs.promises.writeFile(path.join(state.root, 'file.bin'), Buffer.alloc(700, 33));
  await peer.send(request(1, 'file.bin'), state.port);
  const first = await peer.receive(), tid = first.remote.port;
  await expectError(intruder, block(4, 1), tid, 5);
  assert.equal(state.server.status().activeTransfers, 1);
  await peer.send(block(4, 1), tid);
  const second = await peer.receive(); assert.equal(second.bytes.readUInt16BE(0), 3); assert.equal(second.bytes.readUInt16BE(2), 2);
  await peer.send(block(4, 2), tid);
  await until(() => state.server.status().completedTransfers === 1);
});

test('TFTP drops requests from every IP except the explicitly permitted client', async t => {
  const state = await fixture(t, { clientAddress: '127.0.0.2' }), peer = await client(t);
  await peer.send(request(1, 'file.bin'), state.port);
  await assert.rejects(peer.receive(50), /timed out/);
  assert.equal(state.server.status().activeTransfers, 0);
});

test('TFTP times out partial uploads and removes temporary files without publishing a destination', async t => {
  const state = await fixture(t, { allowWrite: true, timeoutMs: 20, retries: 1 }), peer = await client(t);
  await peer.send(request(2, 'partial.bin'), state.port);
  const initial = await peer.receive();
  await peer.send(block(3, 1, Buffer.alloc(512, 12)), initial.remote.port);
  assert.deepEqual((await peer.receive()).bytes, block(4, 1));
  await until(() => state.events.some(value => value.state === 'failed' && value.message.includes('timed out')));
  await until(() => state.server.status().activeTransfers === 0);
  assert.equal(fs.existsSync(path.join(state.root, 'partial.bin')), false);
  assert.deepEqual(await fs.promises.readdir(state.root), []);
});

test('TFTP client ERROR and malformed DATA abort an upload and remove its partial file', async t => {
  const state = await fixture(t, { allowWrite: true }), peer = await client(t);
  await peer.send(request(2, 'canceled.bin'), state.port);
  const initial = await peer.receive();
  await peer.send(block(3, 1, Buffer.alloc(512)), initial.remote.port); await peer.receive();
  await peer.send(block(5, 0, Buffer.from('Canceled by synthetic client\0')), initial.remote.port);
  await until(() => state.server.status().activeTransfers === 0);
  assert.equal(state.events.find(value => value.state === 'failed').message, 'Client ended the transfer.');
  assert.deepEqual(await fs.promises.readdir(state.root), []);
  await peer.send(request(2, 'malformed.bin'), state.port);
  const next = await peer.receive();
  await expectError(peer, Buffer.from([0, 3, 0]), next.remote.port, 4);
  await until(() => state.server.status().activeTransfers === 0);
  assert.deepEqual(await fs.promises.readdir(state.root), []);
});

test('TFTP stop awaits all transfer sockets and cleans partial uploads; the server can restart', async t => {
  const state = await fixture(t, { allowWrite: true }), peer = await client(t);
  await peer.send(request(2, 'partial.bin'), state.port);
  const initial = await peer.receive(), tid = initial.remote.port;
  await peer.send(block(3, 1, Buffer.alloc(512)), tid);
  await peer.receive();
  await state.server.stop();
  assert.equal(state.server.status().running, false); assert.equal(state.server.status().activeTransfers, 0);
  assert.deepEqual(await fs.promises.readdir(state.root), []);
  for (const port of [tid, state.port]) {
    const probe = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.bind(port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  }
  const restarted = await state.server.start(); assert.ok(restarted.port > 0); assert.equal(state.server.status().running, true);
  await state.server.stop(); await state.server.stop();
});

test('TFTP bounds simultaneous transfers to eight and stop cleans all of them', async t => {
  const state = await fixture(t, { timeoutMs: 1000 }), peers = [];
  await fs.promises.writeFile(path.join(state.root, 'file.bin'), Buffer.alloc(1024));
  for (let i = 0; i < 9; i++) peers.push(await client(t));
  for (const peer of peers.slice(0, 8)) {
    await peer.send(request(1, 'file.bin'), state.port);
    assert.equal((await peer.receive()).bytes.readUInt16BE(0), 3);
  }
  assert.equal(state.server.status().activeTransfers, 8);
  await expectError(peers[8], request(1, 'file.bin'), state.port, 0);
  await state.server.stop();
  assert.equal(state.server.status().activeTransfers, 0);
  assert.equal(state.events.filter(value => value.state === 'stopped').length, 8);
});

test('TFTP stop during request setup does not create or leak a partial file', async t => {
  let stopping;
  const state = await fixture(t, { allowWrite: true, onStatus(value) { if (value.activeTransfers === 1 && value.running) stopping ||= state.server.stop(); } });
  const peer = await client(t);
  await peer.send(request(2, 'never-published.bin'), state.port);
  await until(() => Boolean(stopping)); await stopping;
  assert.equal(state.server.status().activeTransfers, 0);
  assert.deepEqual(await fs.promises.readdir(state.root), []);
});

test('TFTP requires an explicit client IP, valid limits and a real selected folder', async t => {
  const root = path.join(os.tmpdir(), `termforge-tftp-missing-${process.pid}`);
  for (const options of [{}, { clientAddress: 'example.com' }, { clientAddress: '0.0.0.0' }, { clientAddress: '255.255.255.255' }, { clientAddress: '::1' }, { clientAddress: '127.0.0.1', port: -1 }, { clientAddress: '127.0.0.1', allowWrite: 'yes' }, { clientAddress: '127.0.0.1', retries: 11 }, { clientAddress: '127.0.0.1', timeoutMs: 0 }]) assert.throws(() => createTftpServer({ root, ...options }));
  const missing = createTftpServer({ root, clientAddress: '127.0.0.1', port: 0 });
  t.after(() => missing.stop());
  await assert.rejects(missing.start(), /ENOENT/);
  assert.equal(missing.status().running, false);
});
