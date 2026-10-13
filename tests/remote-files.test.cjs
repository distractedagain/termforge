'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const nativePath = require('node:path');
const path = require('node:path').posix;
const { Client, Server, utils } = require('ssh2');
const { createSecureTransfers } = require('../app/secure-transfers.cjs');
const { generateEd25519Fixture } = require('../scripts/ssh-key-fixtures.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function memorySftp() {
  const entries = new Map(); const mutations = []; const hooks = {};
  function put(name, type = 'file', overrides = {}) {
    entries.set(name, { mode: ({ file: 0o100000, directory: 0o040000, symlink: 0o120000 }[type]) | 0o700,
      uid: 123, gid: 456, size: type === 'file' ? 4 : 0, mtime: 100, atime: 100, ...overrides });
  }
  put('/', 'directory'); put('/home', 'directory'); put('/home/file'); put('/home/empty', 'directory');
  const attrs = item => ({ ...item, isSymbolicLink: () => (item.mode & 0o170000) === 0o120000,
    isDirectory: () => (item.mode & 0o170000) === 0o040000, isFile: () => (item.mode & 0o170000) === 0o100000 });
  const missing = () => Object.assign(new Error('No such file'), { code: 2 });
  const refusal = () => Object.assign(new Error('Server refused operation'), { code: 4 });
  const implementations = {
    realpath: name => name === '.' ? '/home' : name,
    lstat: name => { if (!entries.has(name)) throw missing(); return attrs(entries.get(name)); },
    readdir: name => [...entries].filter(([filename]) => filename !== name && path.dirname(filename) === name)
      .map(([filename, item]) => ({ filename: path.basename(filename), attrs: attrs(item) })),
    mkdir: (name, options) => { if (entries.has(name)) throw refusal(); put(name, 'directory', { mode: 0o040000 | options.mode }); },
    rename: (from, to) => { if (!entries.has(from)) throw missing(); if (entries.has(to)) throw refusal(); entries.set(to, entries.get(from)); entries.delete(from); },
    unlink: name => { if (!entries.has(name)) throw missing(); entries.delete(name); },
    rmdir: name => { if ([...entries.keys()].some(filename => filename !== name && path.dirname(filename) === name)) throw refusal(); entries.delete(name); },
    chmod: (name, mode) => { if (!entries.has(name)) throw missing(); entries.get(name).mode = (entries.get(name).mode & 0o170000) | mode; },
  };
  const sftp = { end() {} };
  for (const [method, implementation] of Object.entries(implementations)) sftp[method] = (...args) => {
    const callback = args.pop();
    Promise.resolve().then(async () => {
      if (hooks[method] && await hooks[method](...args) === false) return;
      if (['mkdir', 'rename', 'unlink', 'rmdir', 'chmod'].includes(method)) mutations.push({ method, args });
      callback(null, implementation(...args));
    }).catch(callback);
  };
  return { sftp, entries, mutations, hooks, put };
}
async function fixture(t, options = {}) {
  const storage = memorySftp(); const client = new EventEmitter();
  client.sftp = callback => callback(null, storage.sftp);
  client.end = () => queueMicrotask(() => client.emit('close'));
  const approvals = [];
  const manager = createSecureTransfers({ connect: async () => client,
    confirmRemoteOperation: async (review, approval) => { approvals.push(review); return options.confirm ? options.confirm(review, storage, approval) : true; },
    commitTimeoutMs: options.timeout || 30000, remotePlanLifetimeMs: options.lifetime || 60000 });
  t.after(() => manager.closeAll());
  const connection = await manager.open({ host: 'fixture.test', port: 2222 });
  const localPath = nativePath.join(os.tmpdir(), `termforge-cancelled-${randomUUID()}`);
  const prepare = (operation, more = {}) => manager.prepareRemoteOperation({ id: connection.id, operation, path: '/home/file', ...more });
  const apply = plan => manager.applyRemoteOperation({ planId: plan.planId });
  return { ...storage, manager, client, connection, approvals, prepare, apply, localPath };
}

test('remote operations require one-use plans and approval for mkdir, rename, chmod and both delete types', async t => {
  const f = await fixture(t);
  const directory = await f.prepare('mkdir', { path: '/home', name: 'new folder' });
  assert.deepEqual({ ...directory, planId: null, id: null }, { planId: null, id: null, operation: 'mkdir', path: '/home/new folder', host: 'fixture.test', port: 2222, type: 'directory' });
  assert.equal(f.entries.has(directory.path), false);
  assert.equal((await f.apply(directory)).applied, true);
  assert.equal(f.entries.get(directory.path).mode & 0o777, 0o700);
  const renamed = await f.prepare('rename', { name: 'new name.txt' });
  assert.equal(renamed.destination, '/home/new name.txt'); await f.apply(renamed);
  assert.equal(f.entries.has('/home/file'), false);
  const permissions = await f.prepare('chmod', { path: renamed.destination, permissions: '640' });
  assert.equal(permissions.currentPermissions, '700'); await f.apply(permissions);
  assert.equal(f.entries.get(renamed.destination).mode & 0o7777, 0o640);
  const listed = await f.manager.listRemote({ id: f.connection.id, path: '/home' });
  assert.equal(listed.entries.find(item => item.name === 'new name.txt').permissions, '640');
  await f.apply(await f.prepare('delete', { path: renamed.destination }));
  await f.apply(await f.prepare('delete', { path: directory.path }));
  assert.deepEqual(f.mutations.map(item => item.method), ['mkdir', 'rename', 'chmod', 'unlink', 'rmdir']);
  assert.equal(f.approvals.length, 5);
  await assert.rejects(f.apply(directory), /already been used/);
});

test('remote approval defaults to deny and explicit decline consumes the plan without mutations', async t => {
  const f = await fixture(t, { confirm: () => false });
  const plan = await f.prepare('delete');
  assert.equal((await f.apply(plan)).cancelled, true); assert.equal(f.mutations.length, 0);
  await assert.rejects(f.apply(plan), /already been used/);
  const client = new EventEmitter(); const storage = memorySftp();
  client.sftp = callback => callback(null, storage.sftp); client.end = () => client.emit('close');
  const manager = createSecureTransfers({ connect: async () => client }); t.after(() => manager.closeAll());
  const { id } = await manager.open({ host: 'fixture.test' });
  const denied = await manager.prepareRemoteOperation({ id, operation: 'delete', path: '/home/file' });
  assert.equal((await manager.applyRemoteOperation(denied)).applied, false); assert.equal(storage.mutations.length, 0);
});

test('remote names, absolute paths, root targets and permission special bits are rejected', async t => {
  const f = await fixture(t);
  for (const value of ['.', '..', 'dir/file', '../file', 'bad\\name', 'bad\nname', '', 'x'.repeat(256)]) await assert.rejects(f.prepare('mkdir', { path: '/home', name: value }), /filename/);
  for (const value of ['/', '.', '/home/../file', '/home/./file', 'file', '/home//file', '/home/file/']) await assert.rejects(f.prepare('delete', { path: value }), /absolute remote path/);
  for (const permissions of ['888', '1777', '0644', '77', '7777', 'rwx', 0o777, null]) await assert.rejects(f.prepare('chmod', { permissions }), /three octal digits/);
  for (const permissions of ['000', '777']) await f.apply(await f.prepare('chmod', { permissions }));
  await assert.rejects(f.prepare('rename', { name: 'file' }), /different/);
});

test('symlink targets, symlink ancestors, destination collisions and nonempty directories are refused', async t => {
  const f = await fixture(t);
  f.put('/home/link', 'symlink'); f.put('/home/full', 'directory'); f.put('/home/full/child');
  for (const operation of ['rename', 'delete', 'chmod']) await assert.rejects(f.prepare(operation, { path: '/home/link', name: 'renamed', permissions: '600' }), /symbolic links/);
  await assert.rejects(f.prepare('mkdir', { path: '/home', name: 'link' }), /already exists/);
  await assert.rejects(f.prepare('rename', { name: 'link' }), /already exists/);
  await assert.rejects(f.prepare('delete', { path: '/home/full' }), /empty remote directories/);
  f.put('/linked', 'symlink'); f.put('/linked/file');
  await assert.rejects(f.prepare('delete', { path: '/linked/file' }), /parent.*symbolic link/);
  assert.equal(f.mutations.length, 0);
});

test('chmod refuses existing special bits before review and special bits added during approval', async t => {
  const f = await fixture(t);
  for (const bits of [0o1000, 0o2000, 0o4000]) {
    f.put('/home/file', 'file', { mode: 0o100700 | bits });
    await assert.rejects(f.prepare('chmod', { permissions: '600' }), /special permission bits/);
    assert.equal(f.entries.get('/home/file').mode & 0o7000, bits);
  }
  const changed = await fixture(t, { confirm: (_, state) => { state.entries.get('/home/file').mode |= 0o4000; return true; } });
  await assert.rejects(changed.apply(await changed.prepare('chmod', { permissions: '600' })), /special permission bits/);
  assert.equal(f.mutations.length + changed.mutations.length, 0);
});

test('target metadata changes during native confirmation prevent every mutation', async t => {
  for (const field of ['size', 'mtime', 'mode', 'uid', 'gid']) {
    const f = await fixture(t, { confirm: (_, state) => { state.entries.get('/home/file')[field]++; return true; } });
    const plan = await f.prepare('delete');
    await assert.rejects(f.apply(plan), /metadata changed/); assert.equal(f.mutations.length, 0);
  }
});

test('parent changes, symlink replacement and late rename collisions are rechecked after approval', async t => {
  for (const change of [state => state.entries.get('/home').mtime++, state => state.put('/home', 'symlink'), state => state.put('/home/file', 'symlink'), state => state.put('/home/renamed')]) {
    const f = await fixture(t, { confirm: (_, state) => { change(state); return true; } });
    await assert.rejects(f.apply(await f.prepare('rename', { name: 'renamed' })), /changed|symbolic link|already exists/);
    assert.equal(f.mutations.length, 0);
  }
});

test('directory populated during approval is never deleted recursively', async t => {
  const f = await fixture(t, { confirm: (_, state) => { state.put('/home/empty/new'); return true; } });
  await assert.rejects(f.apply(await f.prepare('delete', { path: '/home/empty' })), /empty remote directories/);
  assert.equal(f.mutations.length, 0);
});

test('remote plans reserve the session before async inspection and remain exclusive through confirmation', async t => {
  const gate = deferred(); const f = await fixture(t, { confirm: () => gate.promise });
  const start = () => f.manager.start({ id: f.connection.id, direction: 'download', protocol: 'sftp', remotePath: '/home/file', localPath: f.localPath });
  const preparing = f.prepare('delete');
  assert.throws(start, /pending remote file operation/);
  await assert.rejects(f.prepare('delete'), /pending remote file operation/);
  const plan = await preparing; const applying = f.apply(plan);
  await assert.rejects(f.apply(plan), /already been used/); assert.throws(start, /pending remote file operation/);
  assert.equal(f.manager.discardRemoteOperation(plan), false);
  gate.resolve(false); await applying;
  const second = await f.prepare('delete'); assert.equal(f.manager.discardRemoteOperation(second), true);
  assert.equal(f.manager.discardRemoteOperation(second), false);
  await assert.rejects(f.apply(second), /already been used/);
});

test('queued and running transfers block preparing a remote operation', async t => {
  const f = await fixture(t); const gate = deferred(); const started = deferred();
  f.hooks.lstat = async name => { if (name === '/home/file') { started.resolve(); await gate.promise; } };
  const job = f.manager.start({ id: f.connection.id, direction: 'download', protocol: 'sftp', remotePath: '/home/file', localPath: f.localPath });
  await assert.rejects(f.prepare('delete'), /queued or running transfers/);
  await started.promise;
  await assert.rejects(f.prepare('delete'), /queued or running transfers/);
  const cancelling = f.manager.cancel(job.transferId); gate.resolve(); await cancelling;
  assert.equal(f.manager.listJobs()[0].status, 'cancelled');
  const plan = await f.prepare('delete'); assert.equal(f.manager.discardRemoteOperation(plan), true);
});

test('closed connections and expired or discarded plans cannot mutate files', async t => {
  const f = await fixture(t, { lifetime: 20 });
  const plan = await f.prepare('delete'); await delay(30);
  await assert.rejects(f.apply(plan), /expired/);
  const next = await f.prepare('delete'); await f.manager.close(f.connection.id);
  await assert.rejects(f.apply(next), /missing|closed/); assert.equal(f.mutations.length, 0);
});

test('approval expiry aborts the native prompt and consumes the plan without a mutation', async t => {
  let signal; const gate = deferred();
  const f = await fixture(t, { lifetime: 50, confirm: (_, __, approval) => { signal = approval.signal; return gate.promise; } });
  const plan = await f.prepare('delete'); await assert.rejects(f.apply(plan), /expired/);
  assert.equal(signal.aborted, true); gate.resolve(true); await delay(1);
  assert.equal(f.mutations.length, 0); await assert.rejects(f.apply(plan), /already been used/);
  const next = await f.prepare('delete'); assert.equal(f.manager.discardRemoteOperation(next), true);
});

test('remote plans and transfer conflicts are serialized across connections to prevent same-host aliases racing', async t => {
  const f = await fixture(t); const other = await f.manager.open({ host: 'same-host-alias.test' });
  const plan = await f.prepare('delete');
  await assert.rejects(f.manager.prepareRemoteOperation({ id: other.id, operation: 'delete', path: '/home/file' }), /pending remote file operation/);
  assert.throws(() => f.manager.start({ id: other.id, direction: 'download', protocol: 'sftp', remotePath: '/home/file', localPath: f.localPath }), /pending remote file operation/);
  f.manager.discardRemoteOperation(plan);
  const job = f.manager.start({ id: other.id, direction: 'download', protocol: 'sftp', remotePath: '/home/file', localPath: f.localPath });
  const refused = assert.rejects(f.prepare('delete'), /queued or running transfers/);
  await f.manager.cancel(job.transferId); await refused;
});

test('closing a session cancels an outstanding native approval and ignores its later acceptance', async t => {
  const gate = deferred(); const entered = deferred();
  const f = await fixture(t, { confirm: () => { entered.resolve(); return gate.promise; } });
  const pending = f.apply(await f.prepare('delete')); const rejected = assert.rejects(pending, /cancelled/);
  await entered.promise; await f.manager.close(f.connection.id); await rejected;
  gate.resolve(true); await delay(1); assert.equal(f.mutations.length, 0);
});

test('lost mutation acknowledgements report unknown outcome, consume plans and close the connection', async t => {
  const f = await fixture(t, { timeout: 15 });
  f.hooks.unlink = name => { f.entries.delete(name); return false; };
  const plan = await f.prepare('delete');
  await assert.rejects(f.apply(plan), error => error.indeterminate === true && /outcome is unknown.*Reconnect/.test(error.message));
  assert.equal(f.entries.has('/home/file'), false, 'The remote mutation can succeed even when its reply is lost');
  await assert.rejects(f.apply(plan), /already been used/);
  await assert.rejects(f.prepare('delete'), /closed/);
});

test('disconnected mutations remain owned until their bounded outcome and shutdown waits for them', async t => {
  const entered = deferred(); const f = await fixture(t, { timeout: 30 });
  f.hooks.unlink = name => { f.entries.delete(name); entered.resolve(); return false; };
  const failed = assert.rejects(f.apply(await f.prepare('delete')), /outcome is unknown/);
  await entered.promise; f.client.emit('close'); assert.equal(f.manager.count, 1);
  let complete = false; const closing = f.manager.closeAll().then(() => { complete = true; });
  await delay(5); assert.equal(complete, false); await closing; await failed;
  assert.equal(f.manager.count, 0);
});

test('SFTP server refusals are definitive and a new operation can be reviewed afterward', async t => {
  const f = await fixture(t); f.hooks.unlink = () => { throw Object.assign(new Error('Permission denied'), { code: 3 }); };
  await assert.rejects(f.apply(await f.prepare('delete')), /Permission denied/);
  delete f.hooks.unlink;
  assert.equal((await f.apply(await f.prepare('delete'))).applied, true);
});

test('real SSH/SFTP wire performs reviewed mkdir, chmod, no-overwrite rename and empty directory removal', { timeout: 15000 }, async t => {
  const storage = memorySftp(); const clients = new Set();
  const server = new Server({ hostKeys: [generateEd25519Fixture().private] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'password' && context.password === 'fixture-only' ? context.accept() : context.reject());
    client.on('ready', () => client.on('session', accept => accept().on('sftp', acceptSftp => {
      const stream = acceptSftp();
      for (const [event, method] of Object.entries({ REALPATH: 'realpath', LSTAT: 'lstat', MKDIR: 'mkdir', RENAME: 'rename', REMOVE: 'unlink', RMDIR: 'rmdir', SETSTAT: 'chmod' })) {
        stream.on(event, (id, ...args) => {
          if (event === 'SETSTAT') args[1] = args[1].mode;
          storage.sftp[method](...args, (error, result) => {
            if (error) return stream.status(id, Number.isInteger(error.code) ? error.code : utils.sftp.STATUS_CODE.FAILURE, error.message);
            if (event === 'REALPATH') stream.name(id, [{ filename: result, longname: '', attrs: {} }]);
            else if (event === 'LSTAT') stream.attrs(id, result);
            else stream.status(id, utils.sftp.STATUS_CODE.OK);
          });
        });
      }
      stream.on('OPENDIR', id => stream.handle(id, Buffer.from('empty')));
      stream.on('READDIR', id => stream.status(id, utils.sftp.STATUS_CODE.EOF));
      stream.on('CLOSE', id => stream.status(id, utils.sftp.STATUS_CODE.OK));
    })));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const manager = createSecureTransfers({ confirmRemoteOperation: async () => true, connect: () => new Promise((resolve, reject) => {
    const client = new Client(); client.once('error', reject); client.once('ready', () => resolve(client));
    // Isolated ephemeral loopback only. Host trust is separately owned by the
    // verified production connection factory.
    client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'fixture-only', hostVerifier: () => true });
  }) });
  t.after(async () => { await manager.closeAll(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  const { id } = await manager.open({ host: '127.0.0.1', port: server.address().port });
  async function run(operation, more) { const plan = await manager.prepareRemoteOperation({ id, operation, ...more }); return manager.applyRemoteOperation(plan); }
  await run('mkdir', { path: '/home', name: 'new' });
  await run('chmod', { path: '/home/file', permissions: '640' });
  await run('rename', { path: '/home/file', name: 'renamed' });
  await assert.rejects(manager.prepareRemoteOperation({ id, operation: 'rename', path: '/home/renamed', name: 'new' }), /already exists/);
  await run('delete', { path: '/home/renamed' }); await run('delete', { path: '/home/new' });
  assert.deepEqual(storage.mutations.map(item => item.method), ['mkdir', 'chmod', 'rename', 'unlink', 'rmdir']);
});
