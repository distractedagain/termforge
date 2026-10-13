'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { Client, Server, utils } = require('ssh2');
const { createSecureTransfers } = require('../app/secure-transfers.cjs');
const { generateEd25519Fixture } = require('../scripts/ssh-key-fixtures.cjs');
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const key = generateEd25519Fixture().private;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'termforge-remote-editor-wire-')));
  const local = path.join(root, 'local'); const remote = path.join(root, 'remote');
  await fsp.mkdir(local); await fsp.mkdir(remote);
  const clients = new Set(); const mutations = []; const events = []; const approvals = [];
  const target = value => path.join(remote, ...path.posix.resolve('/', value).split('/').filter(Boolean));
  const attrs = stat => ({ mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'password' && context.username === 'fixture' && context.password === 'test-only' ? context.accept() : context.reject(['password']));
    client.on('ready', () => client.on('session', accept => accept().on('sftp', acceptSftp => {
      const stream = acceptSftp(); const handles = new Map(); let next = 1;
      const action = (name, handler) => stream.on(name, (id, ...args) => { Promise.resolve().then(() => handler(id, ...args)).catch(error => { try { stream.status(id, error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, error.message); } catch {} }); });
      const remember = item => { const id = next++; handles.set(id, item); const handle = Buffer.alloc(4); handle.writeUInt32BE(id); return handle; };
      const lookup = handle => { const item = handle.length === 4 && handles.get(handle.readUInt32BE()); if (!item) throw new Error('Invalid handle'); return item; };
      action('REALPATH', async (id, name) => {
        const actual = await fsp.realpath(target(name)); const relative = path.relative(remote, actual);
        if (relative.startsWith('..')) throw new Error('Escaped fixture');
        stream.name(id, [{ filename: '/' + relative.split(path.sep).join('/'), longname: '', attrs: {} }]);
      });
      action('LSTAT', async (id, name) => { const patch = await options.onStat?.({ name, local, remote }); stream.attrs(id, { ...attrs(await fsp.lstat(target(name))), ...(patch || {}) }); });
      action('STAT', async (id, name) => stream.attrs(id, attrs(await fsp.stat(target(name)))));
      action('FSTAT', async (id, handle) => stream.attrs(id, attrs(await lookup(handle).file.stat())));
      action('FSETSTAT', async (id, handle, attributes) => { if (attributes.mode !== undefined) await lookup(handle).file.chmod(attributes.mode & 0o7777); stream.status(id, STATUS_CODE.OK); });
      action('OPENDIR', async (id, name) => stream.handle(id, remember({ directory: target(name), sent: false })));
      action('READDIR', async (id, handle) => {
        const item = lookup(handle); if (item.sent) return stream.status(id, STATUS_CODE.EOF); item.sent = true;
        const original = await fsp.readdir(item.directory); const names = options.directoryNames ? options.directoryNames(original, item.directory) : original;
        const entries = await Promise.all(names.map(async name => ({ filename: name, longname: '', attrs: attrs(await fsp.lstat(path.join(item.directory, name))) })));
        entries.length ? stream.name(id, entries) : stream.status(id, STATUS_CODE.EOF);
      });
      action('OPEN', async (id, name, flags, attributes) => {
        let mode = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.READ ? fs.constants.O_RDWR : fs.constants.O_WRONLY) : fs.constants.O_RDONLY;
        if (flags & OPEN_MODE.CREAT) mode |= fs.constants.O_CREAT;
        if (flags & OPEN_MODE.EXCL) mode |= fs.constants.O_EXCL;
        if (flags & OPEN_MODE.TRUNC) mode |= fs.constants.O_TRUNC;
        if (flags & OPEN_MODE.WRITE) mutations.push(['open', name]);
        const handle = remember({ file: await fsp.open(target(name), mode, (attributes.mode ?? 0o600) & (options.creationMask ?? 0o777)), name });
        if (await options.afterOpen?.({ local, remote, name, flags }) === false) return;
        stream.handle(id, handle);
      });
      action('READ', async (id, handle, offset, length) => {
        await options.onRead?.({ local, remote, offset, name: lookup(handle).name });
        const buffer = Buffer.alloc(Math.min(length, 65536)); const { bytesRead } = await lookup(handle).file.read(buffer, 0, buffer.length, offset);
        bytesRead ? stream.data(id, buffer.subarray(0, bytesRead)) : stream.status(id, STATUS_CODE.EOF);
      });
      action('WRITE', async (id, handle, offset, data) => {
        await options.onWrite?.({ local, remote, offset, name: lookup(handle).name });
        await lookup(handle).file.write(data, 0, data.length, offset); stream.status(id, STATUS_CODE.OK);
      });
      action('CLOSE', async (id, handle) => { const item = lookup(handle); handles.delete(handle.readUInt32BE()); await item.file?.close(); stream.status(id, STATUS_CODE.OK); });
      action('MKDIR', async (id, name, attributes) => {
        mutations.push(['mkdir', name]); await options.onMkdir?.({ local, remote, name });
        await fsp.mkdir(target(name), { mode: attributes.mode || 0o700 });
        if (options.afterMkdir && await options.afterMkdir({ local, remote, name }) === false) return;
        stream.status(id, STATUS_CODE.OK);
      });
      action('REMOVE', async (id, name) => { mutations.push(['remove', name]); await fsp.unlink(target(name)); stream.status(id, STATUS_CODE.OK); });
      action('RENAME', async (id, from, to) => {
        mutations.push(['rename', from, to]); await options.onRename?.({ local, remote, from, to });
        await fsp.link(target(from), target(to)); await fsp.unlink(target(from));
        if (options.afterRename && await options.afterRename({ local, remote, from, to }) === false) return;
        stream.status(id, STATUS_CODE.OK);
      });
      stream.on('close', () => { for (const item of handles.values()) item.file?.close().catch(() => {}); handles.clear(); });
    })));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const manager = createSecureTransfers({ home: local, commitTimeoutMs: options.commitTimeoutMs || 30000,
    folderPlanLifetimeMs: options.folderPlanLifetimeMs || 300000,
    emit: event => events.push(event),
    confirmOverwrite: async () => { throw new Error('Folder copies must never request overwrite permission.'); },
    confirmRemoteEdit: options.defaultDeny ? undefined : async (review, meta) => {
      approvals.push(review); return options.confirm ? options.confirm(review, meta, { local, remote }) : true;
    },
    connect: () => new Promise((resolve, reject) => {
      const client = new Client(); client.once('error', reject); client.once('ready', () => resolve(client));
      client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'test-only', hostVerifier: () => true });
    }) });
  const connection = await manager.open({ host: '127.0.0.1', port: server.address().port });
  t.after(async () => { await manager.closeAll(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); await fsp.rm(root, { recursive: true, force: true }); });
  const open = () => manager.remoteEditOpen({ id: connection.id, path: '/home/config.txt' });
  const prepare = (doc, text = 'edited\n') => manager.remoteEditPrepareSave({ documentId: doc.documentId, revision: doc.revision, text });
  return { local, remote, manager, connection, open, prepare, mutations, events, approvals,
    disconnect: () => { for (const client of clients) client.end(); } };
}


async function source(f, text = 'original\n') {
  await fsp.mkdir(path.join(f.remote, 'home')); await fsp.writeFile(path.join(f.remote, 'home', 'config.txt'), text);
  await fsp.chmod(path.join(f.remote, 'home', 'config.txt'), 0o640);
}
async function replaceSameMetadata(filename, text) {
  const before = await fsp.stat(filename); await fsp.writeFile(filename, text); await fsp.utimes(filename, before.atime, before.mtime);
}

test('real SFTP remote edit verifies bytes and preserves ordinary permissions despite restrictive creation mask', async t => {
  const f = await fixture(t, { creationMask: 0o600 }); await source(f, '\ufefforiginal 🌍\r\n');
  const doc = await f.open(); assert.equal(doc.text, '\ufefforiginal 🌍\r\n');
  const text = '\ufeff' + 'edited 🌍\r\n'.repeat(12000); const plan = await f.prepare(doc, text);
  assert.deepEqual(f.mutations, []); const saved = await f.manager.remoteEditSave({ planId: plan.planId });
  assert.equal(saved.saved, true); assert.equal(saved.text, text); assert.notEqual(saved.revision, doc.revision);
  assert.equal(await fsp.readFile(path.join(f.remote, 'home', 'config.txt'), 'utf8'), text);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(path.join(f.remote, 'home', 'config.txt'))).mode & 0o777, 0o640);
  assert.deepEqual(await fsp.readdir(path.join(f.remote, 'home')), ['config.txt']);
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].path, '/home/config.txt');
  await assert.rejects(f.manager.remoteEditSave({ planId: plan.planId }), /missing|used/);
});

test('real SFTP remote editor native decline performs no mutations and keeps document usable', async t => {
  const f = await fixture(t, { defaultDeny: true }); await source(f); const doc = await f.open(); const plan = await f.prepare(doc);
  assert.deepEqual(await f.manager.remoteEditSave({ planId: plan.planId }), { cancelled: true });
  assert.deepEqual(f.mutations, []); assert.equal(await fsp.readFile(path.join(f.remote, 'home', 'config.txt'), 'utf8'), 'original\n');
  const again = await f.prepare(doc); assert.equal(f.manager.remoteEditDiscardSave({ planId: again.planId }), true);
});

test('real SFTP remote editor detects equal-size content conflict even when server mtime is restored', async t => {
  const f = await fixture(t); await source(f); const doc = await f.open();
  await replaceSameMetadata(path.join(f.remote, 'home', 'config.txt'), 'changed!\n');
  await assert.rejects(f.prepare(doc), /changed on the server/); assert.deepEqual(f.mutations, []);
});

test('real SFTP remote editor rechecks content after native confirmation', async t => {
  const f = await fixture(t, { confirm: async (_, __, { remote }) => { await replaceSameMetadata(path.join(remote, 'home', 'config.txt'), 'changed!\n'); return true; } });
  await source(f); const plan = await f.prepare(await f.open());
  await assert.rejects(f.manager.remoteEditSave({ planId: plan.planId }), /changed on the server/); assert.deepEqual(f.mutations, []);
});

test('real SFTP remote editor retains staged edit and changed destination on commit conflict', async t => {
  let once = false; const f = await fixture(t, { onWrite: async ({ remote }) => { if (!once) { once = true; await replaceSameMetadata(path.join(remote, 'home', 'config.txt'), 'changed!\n'); } } });
  await source(f); const plan = await f.prepare(await f.open(), 'proposed\n');
  await assert.rejects(f.manager.remoteEditSave({ planId: plan.planId }), /changed on the server.*staging file may remain/s);
  assert.equal(await fsp.readFile(path.join(f.remote, 'home', 'config.txt'), 'utf8'), 'changed!\n');
  const stages = (await fsp.readdir(path.join(f.remote, 'home'))).filter(name => name.endsWith('.part')); assert.equal(stages.length, 1);
  assert.equal(await fsp.readFile(path.join(f.remote, 'home', stages[0]), 'utf8'), 'proposed\n');
});

// These are lost-response tests, not 50 ms latency tests. Give successful RPCs
// room to complete on a loaded runner, and deliberately delay ordinary reads
// beyond the old timeout so setup cannot accidentally be the tested failure.
const lostAcknowledgmentTimeoutMs = 2000;

test('real SFTP lost staging open acknowledgment reports possible file path without changing original', { timeout: 20000 }, async t => {
  let droppedOpen = null;
  const f = await fixture(t, {
    commitTimeoutMs: lostAcknowledgmentTimeoutMs, onRead: () => pause(75),
    afterOpen: async ({ name, flags }) => { if (flags & OPEN_MODE.WRITE) { assert.equal(droppedOpen, null); droppedOpen = name; return false; } },
  });
  await source(f); const plan = await f.prepare(await f.open());
  await assert.rejects(f.manager.remoteEditSave({ planId: plan.planId }), error => {
    assert.match(droppedOpen || '', /^\/home\/\.termforge-.*\.part$/, 'The missing staging OPEN response must be reached before timeout');
    assert.equal(error.code, 'TRANSFER_TIMEOUT');
    assert.match(error.message, /staging file may remain at .*\.part/);
    return true;
  });
  assert.equal(await fsp.readFile(path.join(f.remote, 'home', 'config.txt'), 'utf8'), 'original\n');
  assert.equal((await fsp.stat(path.join(f.remote, droppedOpen))).size, 0);
  assert.deepEqual(f.mutations, [['open', droppedOpen]], 'An unacknowledged OPEN must not trigger writes or cleanup');
});

test('real SFTP lost final rename acknowledgment reports uncertainty and never deletes saved data', { timeout: 20000 }, async t => {
  let droppedRename = null;
  const f = await fixture(t, {
    commitTimeoutMs: lostAcknowledgmentTimeoutMs, onRead: () => pause(75),
    afterRename: async ({ from, to }) => { if (to === '/home/config.txt') { assert.equal(droppedRename, null); droppedRename = [from, to]; return false; } },
  });
  await source(f); const plan = await f.prepare(await f.open(), 'committed replacement\n');
  await assert.rejects(f.manager.remoteEditSave({ planId: plan.planId }), error => {
    assert.equal(droppedRename?.[1], '/home/config.txt', 'The missing final RENAME response must be reached before timeout');
    assert.equal(error.indeterminate, true);
    assert.match(error.message, /outcome could not be verified.*operation timed out/s);
    return true;
  });
  assert.equal(await fsp.readFile(path.join(f.remote, 'home', 'config.txt'), 'utf8'), 'committed replacement\n');
  const recovery = (await fsp.readdir(path.join(f.remote, 'home'))).filter(name => name.endsWith('.recovery')); assert.equal(recovery.length, 1);
  assert.equal(await fsp.readFile(path.join(f.remote, 'home', recovery[0]), 'utf8'), 'original\n');
  assert.deepEqual(f.mutations.at(-1), ['rename', ...droppedRename], 'An unacknowledged final RENAME must not trigger rollback or cleanup');
});

test('real SFTP editor reservation blocks competing mutations and disconnect aborts approval', async t => {
  let reached; const seen = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, { confirm: async (_, { signal }) => { reached(signal); return new Promise(() => {}); } }); await source(f);
  const plan = await f.prepare(await f.open());
  assert.throws(() => f.manager.start({ id: f.connection.id, direction: 'download', protocol: 'sftp', remotePath: '/home/config.txt', localPath: path.join(f.local, 'config') }), /remote edit/);
  await assert.rejects(f.manager.prepareRemoteOperation({ id: f.connection.id, operation: 'mkdir', path: '/', name: 'conflict' }), /queued|running/);
  const saving = f.manager.remoteEditSave({ planId: plan.planId }); const outcome = assert.rejects(saving, /cancelled/); const signal = await seen;
  await f.manager.close(f.connection.id); await outcome; assert.equal(signal.aborted, true); assert.deepEqual(f.mutations, []);
});

test('real SFTP acknowledged edit with failed refresh returns saved and closed', async t => {
  let committed = false; const f = await fixture(t, { afterRename: async ({ to }) => { if (to === '/home/config.txt') committed = true; }, onStat: async ({ name }) => { if (committed && name === '/home/config.txt') throw new Error('Injected revision refresh failure'); } });
  await source(f); const plan = await f.prepare(await f.open(), 'saved successfully\n'); const result = await f.manager.remoteEditSave({ planId: plan.planId });
  assert.equal(result.saved, true); assert.equal(result.closed, true); assert.equal(result.text, 'saved successfully\n'); assert.match(result.warning, /save was acknowledged/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'home', 'config.txt'), 'utf8'), result.text); assert.equal(f.manager.remoteEditCount, 0);
});
