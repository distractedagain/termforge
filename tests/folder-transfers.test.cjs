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
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'termforge-folder-')));
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
        stream.handle(id, remember({ file: await fsp.open(target(name), mode, attributes.mode || 0o600), name }));
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
      action('REMOVE', async (id, name) => { mutations.push(['remove', name]); await options.onRemove?.({ local, remote, name }); await fsp.unlink(target(name)); if (options.afterRemove && await options.afterRemove({ local, remote, name }) === false) return; stream.status(id, STATUS_CODE.OK); });
      action('RMDIR', async (id, name) => { mutations.push(['rmdir', name]); await fsp.rmdir(target(name)); stream.status(id, STATUS_CODE.OK); });
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
    syncDirectory: options.persistent ? path.join(root, 'sync') : undefined,
    getConnectionIdentity: () => ({ host: '127.0.0.1', port: server.address().port, username: options.account?.() || 'fixture', algorithm: 'ssh-ed25519', fingerprint: options.fingerprint?.() || 'test-fixture-key' }),
    folderPlanLifetimeMs: options.folderPlanLifetimeMs || 300000,
    emit: event => events.push(event),
    confirmOverwrite: async () => { throw new Error('Folder copies must never request overwrite permission.'); },
    confirmFolderTransfer: options.defaultDeny ? undefined : async (review, meta) => {
      approvals.push(review); return options.confirm ? options.confirm(review, meta, { local, remote }) : true;
    },
    connect: () => new Promise((resolve, reject) => {
      const client = new Client(); client.once('error', reject); client.once('ready', () => resolve(client));
      client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'test-only', hostVerifier: () => true });
    }) });
  const connection = await manager.open({ host: '127.0.0.1', port: server.address().port });
  t.after(async () => { await manager.closeAll(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); await fsp.rm(root, { recursive: true, force: true }); });
  async function plan(direction = 'upload', name = 'source', destination = 'copy', operation = {}) {
    return manager.prepareFolderTransfer({ id: connection.id, direction,
      localPath: path.join(local, direction === 'upload' ? name : destination), remotePath: '/' + (direction === 'upload' ? destination : name), ...operation });
  }
  async function waitJob(id) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const job = manager.listJobs().find(item => item.transferId === id); if (['completed', 'failed', 'cancelled'].includes(job?.status)) return job; await pause(10); }
    throw new Error('Folder job did not finish.');
  }
  async function run(prepared) { return waitJob((await manager.startFolderTransfer({ planId: prepared.planId })).transferId); }
  return { local, remote, root, manager, connection, plan, run, waitJob, mutations, events, approvals,
    disconnect: () => { for (const client of clients) client.end(); } };
}

async function tree(root) {
  await fsp.mkdir(path.join(root, 'source', 'nested', 'empty'), { recursive: true });
  await fsp.writeFile(path.join(root, 'source', 'zero'), '');
  await fsp.writeFile(path.join(root, 'source', 'nested', 'payload'), Buffer.alloc(150000, 67));
}

test('real SFTP reviewed upload and download preserve nested bytes and empty folders', { timeout: 30000 }, async t => {
  const f = await fixture(t); await tree(f.local);
  const plan = await f.plan();
  assert.equal(plan.files, 2); assert.equal(plan.directories, 3); assert.equal(plan.entries[0].relativePath, ''); assert.equal(plan.totalBytes, 150000);
  assert.equal(plan.protocol, 'sftp'); assert.deepEqual(f.mutations, []); assert.equal(plan.host, '127.0.0.1');
  const uploaded = await f.run(plan);
  assert.equal(uploaded.status, 'completed', uploaded.error); assert.equal(uploaded.kind, 'folder');
  assert.equal(uploaded.filesCompleted, 2); assert.equal(uploaded.directoriesCreated, 3); assert.equal(uploaded.bytes, 150000); assert.equal(uploaded.total, 150000);
  assert.deepEqual(await fsp.readFile(path.join(f.remote, 'copy', 'nested', 'payload')), Buffer.alloc(150000, 67));
  assert.deepEqual(await fsp.readdir(path.join(f.remote, 'copy', 'nested', 'empty')), []);
  const downloaded = await f.run(await f.plan('download', 'copy', 'downloaded'));
  assert.equal(downloaded.status, 'completed', downloaded.error); assert.equal(downloaded.filesCompleted, 2);
  assert.deepEqual(await fsp.readFile(path.join(f.local, 'downloaded', 'nested', 'payload')), Buffer.alloc(150000, 67));
  assert.deepEqual(await fsp.readdir(path.join(f.local, 'downloaded', 'nested', 'empty')), []);
  assert.equal(f.approvals.length, 2); assert(f.events.some(event => event.kind === 'folder' && event.bytes > 0 && event.status === 'running'));
  assert.equal(f.manager.listJobs().length, 2);
});

test('default-denied native review performs no writes and consumes its token', async t => {
  const f = await fixture(t, { defaultDeny: true }); await tree(f.local); const plan = await f.plan();
  assert.deepEqual(await f.manager.startFolderTransfer({ planId: plan.planId }), { cancelled: true });
  assert.deepEqual(f.mutations, []); assert.equal(f.manager.listJobs().length, 0);
  await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /missing|expired|used/);
});

test('discard and expiry invalidate review tokens without writes', async t => {
  const f = await fixture(t, { folderPlanLifetimeMs: 1000 }); await tree(f.local);
  const first = await f.plan(); assert.equal(f.manager.discardFolderTransfer({ planId: first.planId }), true);
  assert.equal(f.manager.discardFolderTransfer({ planId: first.planId }), false);
  await assert.rejects(f.manager.startFolderTransfer({ planId: first.planId }), /missing|expired|used/);
  const second = await f.plan(); await pause(1050);
  await assert.rejects(f.manager.startFolderTransfer({ planId: second.planId }), /missing|expired|used/); assert.deepEqual(f.mutations, []);
});

test('native cancellation blocks repeated apply and global competing operations', async t => {
  let finish; const f = await fixture(t, { confirm: () => new Promise(resolve => { finish = resolve; }) }); await tree(f.local);
  const plan = await f.plan();
  assert.throws(() => f.manager.start({ id: f.connection.id, direction: 'upload', protocol: 'sftp', localPath: path.join(f.local, 'source', 'zero'), remotePath: '/other' }), /reviewed folder/);
  await assert.rejects(f.manager.prepareRemoteOperation({ id: f.connection.id, operation: 'mkdir', path: '/', name: 'other' }), /queued|running/);
  const pending = f.manager.startFolderTransfer({ planId: plan.planId });
  while (!finish) await pause(1);
  await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /already used/);
  finish(false); assert.deepEqual(await pending, { cancelled: true }); assert.deepEqual(f.mutations, []);
});

test('existing destination roots and changed trees fail without writes', async t => {
  const f = await fixture(t, { confirm: async (_, __, roots) => { await fsp.writeFile(path.join(roots.local, 'source', 'new'), 'late'); return true; } });
  await tree(f.local); await fsp.mkdir(path.join(f.remote, 'copy'));
  await assert.rejects(f.plan(), /already exists/); await fsp.rmdir(path.join(f.remote, 'copy'));
  const plan = await f.plan(); await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /changed after review/);
  assert.deepEqual(f.mutations, []);
});

test('destination appearing during approval is never replaced', async t => {
  const f = await fixture(t, { confirm: async (_, __, roots) => { await fsp.mkdir(path.join(roots.remote, 'copy')); await fsp.writeFile(path.join(roots.remote, 'copy', 'keep'), 'original'); return true; } });
  await tree(f.local); const plan = await f.plan(); await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /already exists/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'keep'), 'utf8'), 'original'); assert.deepEqual(f.mutations, []);
});

test('case-colliding source names and dot traversal are rejected before writes', async t => {
  const f = await fixture(t, { directoryNames: names => [...new Set([...names, 'Case', 'case'])] }); await fsp.mkdir(path.join(f.remote, 'source')); await fsp.writeFile(path.join(f.remote, 'source', 'Case'), '1');
  // A real case-insensitive filesystem cannot represent this fixture; inject
  // the alternate spelling through the directory protocol when necessary.
  await fsp.writeFile(path.join(f.remote, 'source', 'case'), '2');
  await assert.rejects(f.plan('download'), /collide/);
  await assert.rejects(f.manager.prepareFolderTransfer({ id: f.connection.id, direction: 'upload', localPath: path.join(f.local, 'source'), remotePath: '/other/../copy' }), /absolute folder/);
  assert.deepEqual(f.mutations, []);
});

test('source and ancestor symbolic links are refused without following them', { skip: process.platform === 'win32' && 'Windows symlink creation requires a platform privilege', timeout: 20000 }, async t => {
  const f = await fixture(t); await tree(f.local); await fsp.symlink('nested/payload', path.join(f.local, 'source', 'link'));
  await assert.rejects(f.plan(), /symbolic links/); await fsp.unlink(path.join(f.local, 'source', 'link'));
  await fsp.symlink('source', path.join(f.local, 'alias'));
  await assert.rejects(f.plan('upload', 'alias'), /symbolic links/);
  await tree(f.remote); await fsp.symlink('source', path.join(f.remote, 'alias'));
  await assert.rejects(f.manager.prepareFolderTransfer({ id: f.connection.id, direction: 'download', localPath: path.join(f.local, 'download'), remotePath: '/alias/nested' }), /symbolic links/);
  assert.deepEqual(f.mutations, []);
});

test('nested files cannot replace a competing destination created during copying', async t => {
  let once = false; const f = await fixture(t, { onWrite: async ({ remote }) => { if (!once) { once = true; await fsp.writeFile(path.join(remote, 'copy', 'nested', 'payload'), 'competing'); } } });
  await tree(f.local); const result = await f.run(await f.plan());
  assert.equal(result.status, 'failed'); assert.match(result.error, /destination changed|appeared/); assert.match(result.warning, /Partial folder (copy|operation)/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'nested', 'payload'), 'utf8'), 'competing');
  assert((await fsp.readdir(path.join(f.remote, 'copy', 'nested'))).every(name => !name.endsWith('.part')));
});

test('changed source during payload copying fails before committing that file', async t => {
  let once = false; const f = await fixture(t, { onWrite: async ({ local }) => { if (!once) { once = true; await fsp.writeFile(path.join(local, 'source', 'nested', 'payload'), 'changed'); } } });
  await tree(f.local); const result = await f.run(await f.plan());
  assert.equal(result.status, 'failed'); assert.match(result.error, /source.*changed/i);
  await assert.rejects(fsp.stat(path.join(f.remote, 'copy', 'nested', 'payload')), { code: 'ENOENT' });
});

test('cancelling a folder job retains completed children and stops pending children', { timeout: 30000 }, async t => {
  let release; let copying;
  const f = await fixture(t, { onWrite: async ({ name }) => { if (name.includes('/nested/') && !copying) { copying = true; await new Promise(resolve => { release = resolve; }); } } });
  await tree(f.local); await fsp.writeFile(path.join(f.local, 'source', 'a-first'), 'first');
  const started = await f.manager.startFolderTransfer({ planId: (await f.plan()).planId });
  while (!release) await pause(5);
  const cancelling = f.manager.cancel(started.transferId); release(); await cancelling;
  const result = await f.waitJob(started.transferId); assert.equal(result.status, 'cancelled'); assert.equal(result.filesCompleted, 1);
  assert.match(result.warning, /1 of 3 files completed/); assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'a-first'), 'utf8'), 'first');
  await assert.rejects(fsp.stat(path.join(f.remote, 'copy', 'zero')), { code: 'ENOENT' });
});

test('lost mkdir acknowledgment reports failed unknown outcome and retains the created root', { timeout: 15000 }, async t => {
  const f = await fixture(t, { commitTimeoutMs: 50, afterMkdir: async () => false }); await tree(f.local);
  const result = await f.run(await f.plan()); assert.equal(result.status, 'failed'); assert.match(result.error, /outcome is unknown/); assert.match(result.error, /\/copy/);
  assert((await fsp.stat(path.join(f.remote, 'copy'))).isDirectory());
});

test('lost file rename acknowledgment reports failed unknown outcome instead of cancelled', { timeout: 15000 }, async t => {
  const f = await fixture(t, { commitTimeoutMs: 50, afterRename: async () => false }); await tree(f.local);
  const result = await f.run(await f.plan()); assert.equal(result.status, 'failed'); assert.match(result.error, /outcome could not be verified/);
  assert.deepEqual(await fsp.readFile(path.join(f.remote, 'copy', 'nested', 'payload')), Buffer.alloc(150000, 67));
});

test('closing during native review aborts approval and leaves no jobs or destinations', async t => {
  let entered; const seen = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { confirm: async (_, { signal }) => { entered(signal); return new Promise(() => {}); } }); await tree(f.local);
  const pending = f.manager.startFolderTransfer({ planId: (await f.plan()).planId }); const signal = await seen;
  const outcome = assert.rejects(pending, /cancelled|closed/); await f.manager.close(f.connection.id); await outcome;
  assert(signal.aborted); assert.deepEqual(f.mutations, []); assert.equal(f.manager.count, 0);
});

test('empty folder copy completes with one created root and zero bytes', async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); const result = await f.run(await f.plan());
  assert.equal(result.status, 'completed', result.error); assert.equal(result.directoriesCreated, 1); assert.equal(result.filesCompleted, 0); assert.equal(result.total, 0);
});

test('depth limit and oversized source metadata fail before any mutation', async t => {
  const f = await fixture(t, { onStat: async ({ name }) => name === '/source/large' ? { size: 1024 ** 4 + 1 } : undefined });
  await fsp.mkdir(path.join(f.remote, 'source')); await fsp.writeFile(path.join(f.remote, 'source', 'large'), 'synthetic metadata');
  await assert.rejects(f.plan('download'), /1 TiB/);
  const source = path.join(f.local, 'source'); await fsp.mkdir(source);
  await fsp.mkdir(path.join(source, ...Array(33).fill('d')), { recursive: true });
  await assert.rejects(f.plan(), /32 nested/); assert.deepEqual(f.mutations, []);
});

test('entry limit refuses an oversized directory listing before mutations', async t => {
  const f = await fixture(t, { directoryNames: () => Array(2000).fill('entry') });
  await fsp.mkdir(path.join(f.remote, 'source')); await fsp.writeFile(path.join(f.remote, 'source', 'entry'), '');
  await assert.rejects(f.plan('download'), /2000 entries/); assert.deepEqual(f.mutations, []);
});

test('review expiry aborts a pending native approval and writes nothing', async t => {
  let approvalSignal;
  const f = await fixture(t, { folderPlanLifetimeMs: 100, confirm: (_, { signal }) => { approvalSignal = signal; return new Promise(() => {}); } });
  await fsp.mkdir(path.join(f.local, 'source'));
  await assert.rejects(f.manager.startFolderTransfer({ planId: (await f.plan()).planId }), /expired/);
  assert.equal(approvalSignal.aborted, true); assert.deepEqual(f.mutations, []);
});

test('shutdown retains ownership until a disconnected local scan has settled', async t => {
  const f = await fixture(t); await tree(f.local);
  const originalStat = fsp.lstat; let release; let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  fsp.lstat = async filename => {
    if (filename === path.join(f.local, 'source')) { entered(); await new Promise(resolve => { release = resolve; }); }
    return originalStat(filename);
  };
  t.after(() => { fsp.lstat = originalStat; release?.(); });
  const preparing = f.plan(); const outcome = assert.rejects(preparing, /cancelled|closed/);
  await reading; f.disconnect(); await pause(20);
  assert.equal(f.manager.count, 1);
  let closed = false; const closing = f.manager.closeAll().then(() => { closed = true; });
  await pause(20); assert.equal(closed, false); release(); await outcome; await closing;
  assert.equal(f.manager.count, 0); assert.deepEqual(f.mutations, []); fsp.lstat = originalStat;
});

test('global reservation also blocks another authenticated transfer connection', async t => {
  const f = await fixture(t); await tree(f.local); const other = await f.manager.open({ host: 'same-server-alias', port: f.connection.port });
  const plan = await f.plan();
  assert.throws(() => f.manager.start({ id: other.id, direction: 'upload', protocol: 'sftp', localPath: path.join(f.local, 'source', 'zero'), remotePath: '/other' }), /reviewed folder/);
  await assert.rejects(f.manager.prepareFolderTransfer({ id: other.id, direction: 'upload', localPath: path.join(f.local, 'source'), remotePath: '/other' }), /reviewed folder/);
  f.manager.discardFolderTransfer({ planId: plan.planId }); assert.deepEqual(f.mutations, []);
});

test('cancellation waits for an issued mkdir and reports retained folders', async t => {
  let release; let created;
  const f = await fixture(t, { afterMkdir: async () => { created = true; await new Promise(resolve => { release = resolve; }); } });
  await fsp.mkdir(path.join(f.local, 'source'));
  const started = await f.manager.startFolderTransfer({ planId: (await f.plan()).planId });
  while (!created) await pause(1);
  let stopped = false; const stopping = f.manager.cancel(started.transferId).then(() => { stopped = true; });
  await pause(20); assert.equal(stopped, false); release(); await stopping;
  const job = await f.waitJob(started.transferId); assert.equal(job.status, 'cancelled'); assert.equal(job.directoriesCreated, 1);
  assert.match(job.warning, /folders remain|operations remain/); assert((await fsp.stat(path.join(f.remote, 'copy'))).isDirectory());
});

test('closing during the final file commit waits for acknowledgment and reports completed bytes', async t => {
  let release; let committed;
  const f = await fixture(t, { afterRename: async () => { committed = true; await new Promise(resolve => { release = resolve; }); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.writeFile(path.join(f.local, 'source', 'last'), 'final committed bytes');
  const started = await f.manager.startFolderTransfer({ planId: (await f.plan()).planId });
  while (!committed) await pause(1);
  let closed = false; const closing = f.manager.close(f.connection.id).then(() => { closed = true; });
  await pause(20); assert.equal(closed, false); release(); await closing;
  const job = await f.waitJob(started.transferId); assert.equal(job.status, 'completed', job.error); assert.equal(job.filesCompleted, 1);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'last'), 'utf8'), 'final committed bytes'); assert.equal(f.manager.count, 0);
  const mutations = f.mutations.length; await pause(20); assert.equal(f.mutations.length, mutations);
});


test('merge defaults to skipping existing files and retains destination-only files and folders', async t => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.local, 'source', 'new-empty'), { recursive: true });
  await fsp.writeFile(path.join(f.local, 'source', 'existing'), 'source version');
  await fsp.writeFile(path.join(f.local, 'source', 'new-file'), 'new bytes');
  await fsp.mkdir(path.join(f.remote, 'copy', 'keep-dir'), { recursive: true });
  await fsp.writeFile(path.join(f.remote, 'copy', 'existing'), 'destination version');
  await fsp.writeFile(path.join(f.remote, 'copy', 'keep-dir', 'keep-file'), 'keep bytes');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'merge' });
  assert.equal(plan.mode, 'merge'); assert.equal(plan.conflictPolicy, 'skip');
  assert.equal(plan.copied, 1); assert.equal(plan.replaced, 0); assert.equal(plan.skipped, 1); assert.equal(plan.kept, 2);
  assert.equal(plan.files, 1); assert.equal(plan.sourceFiles, 2); assert.equal(plan.directories, 1); assert.equal(plan.totalBytes, 9);
  assert.equal(plan.entries.find(entry => entry.relativePath === 'existing').action, 'skip');
  assert.equal(plan.entries[0].action, 'skip'); assert(!('expected' in plan.entries[1])); assert.deepEqual(f.mutations, []);
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error); assert.equal(result.filesCompleted, 1);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'existing'), 'utf8'), 'destination version');
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'new-file'), 'utf8'), 'new bytes');
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'keep-dir', 'keep-file'), 'utf8'), 'keep bytes');
  assert.deepEqual(await fsp.readdir(path.join(f.remote, 'copy', 'new-empty')), []);
});

for (const direction of ['upload', 'download']) test(`reviewed merge replacement works for ${direction} without a second overwrite prompt`, async t => {
  const f = await fixture(t); const source = path.join(direction === 'upload' ? f.local : f.remote, 'source'); const destination = path.join(direction === 'upload' ? f.remote : f.local, 'copy');
  await fsp.mkdir(source); await fsp.mkdir(destination);
  await fsp.writeFile(path.join(source, 'replace'), 'replacement bytes'); await fsp.writeFile(path.join(destination, 'replace'), 'old bytes');
  await fsp.chmod(path.join(destination, 'replace'), 0o640);
  await fsp.writeFile(path.join(source, 'new-file'), 'new bytes'); await fsp.writeFile(path.join(destination, 'keep'), 'retained');
  const plan = await f.plan(direction, 'source', 'copy', { mode: 'merge', conflictPolicy: 'replace' });
  assert.equal(plan.replaced, 1); assert.equal(plan.copied, 1); assert.equal(plan.skipped, 0); assert.equal(plan.kept, 1);
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error); assert.equal(result.filesCompleted, 2);
  assert.equal(await fsp.readFile(path.join(destination, 'replace'), 'utf8'), 'replacement bytes');
  if (process.platform !== 'win32') assert.equal((await fsp.stat(path.join(destination, 'replace'))).mode & 0o777, 0o640);
  assert.equal(await fsp.readFile(path.join(destination, 'keep'), 'utf8'), 'retained');
  assert((await fsp.readdir(destination)).every(name => !name.startsWith('.termforge-')));
});

for (const direction of ['upload', 'download']) test(`one-way ${direction} sync compares content and retains destination-only items`, async t => {
  const f = await fixture(t); const source = path.join(direction === 'upload' ? f.local : f.remote, 'source'); const destination = path.join(direction === 'upload' ? f.remote : f.local, 'copy');
  await fsp.mkdir(source); await fsp.mkdir(destination);
  await fsp.writeFile(path.join(source, 'identical'), 'same bytes'); await fsp.writeFile(path.join(destination, 'identical'), 'same bytes');
  await fsp.writeFile(path.join(source, 'changed'), 'new bytes!'); await fsp.writeFile(path.join(destination, 'changed'), 'old bytes!');
  await fsp.writeFile(path.join(source, 'added'), 'addition'); await fsp.writeFile(path.join(destination, 'keep'), 'retained');
  const sameTime = new Date(1700000000000); for (const root of [source, destination]) await fsp.utimes(path.join(root, 'changed'), sameTime, sameTime);
  const plan = await f.plan(direction, 'source', 'copy', { mode: 'sync' });
  assert.equal(plan.mode, 'sync'); assert.equal(plan.replaced, 1); assert.equal(plan.copied, 1); assert.equal(plan.skipped, 1); assert.equal(plan.kept, 1);
  assert.equal(plan.entries.find(entry => entry.relativePath === 'changed').action, 'replace');
  assert.equal(plan.entries.find(entry => entry.relativePath === 'identical').action, 'skip');
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error); assert.equal(result.total, 18);
  assert.equal(await fsp.readFile(path.join(destination, 'changed'), 'utf8'), 'new bytes!');
  assert.equal(await fsp.readFile(path.join(destination, 'keep'), 'utf8'), 'retained');
  const again = await f.plan(direction, 'source', 'copy', { mode: 'sync' });
  assert.equal(again.files, 0); assert.equal(again.skipped, 3); assert.equal(again.totalBytes, 0);
  const before = f.mutations.length; const unchanged = await f.run(again); assert.equal(unchanged.status, 'completed', unchanged.error); assert.equal(f.mutations.length, before);
});

test('merge and sync reject file-directory conflicts and invalid policies before writes', async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.writeFile(path.join(f.local, 'source', 'conflict'), 'file');
  await fsp.mkdir(path.join(f.remote, 'copy', 'conflict'), { recursive: true });
  for (const mode of ['merge', 'sync']) await assert.rejects(f.plan('upload', 'source', 'copy', { mode }), /conflicts with a destination/);
  await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'unsupported-mode' }), /supported folder operation/);
  await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'merge', conflictPolicy: 'newer' }), /supported folder operation/);
  assert.deepEqual(f.mutations, []);
});

test('cross-tree case collisions reject merge before writing distinct logical names', async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.local, 'source', 'Config'), 'source'); await fsp.writeFile(path.join(f.remote, 'copy', 'config'), 'destination');
  await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'merge' }), /names collide/); assert.deepEqual(f.mutations, []);
});

test('destination-only symbolic links are rejected in merge and sync inventories', { skip: process.platform === 'win32' && 'Windows symlink creation requires a platform privilege' }, async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.remote, 'keep'), 'target'); await fsp.symlink('../keep', path.join(f.remote, 'copy', 'link'));
  for (const mode of ['merge', 'sync']) await assert.rejects(f.plan('upload', 'source', 'copy', { mode }), /symbolic links/);
  assert.deepEqual(f.mutations, []);
});

test('same-size remote destination content change during approval invalidates sync despite restored mtime', async t => {
  const f = await fixture(t, { confirm: async (_, __, { remote }) => { const file = path.join(remote, 'copy', 'item'); const before = await fsp.stat(file); await fsp.writeFile(file, 'raced bytes'); await fsp.utimes(file, before.atime, before.mtime); return true; } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.local, 'source', 'item'), 'newer bytes'); await fsp.writeFile(path.join(f.remote, 'copy', 'item'), 'older bytes');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'sync' });
  await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /changed after review/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'item'), 'utf8'), 'raced bytes'); assert.deepEqual(f.mutations, []);
});

test('same-size remote source content change during approval invalidates download sync despite restored mtime', async t => {
  const f = await fixture(t, { confirm: async (_, __, { remote }) => { const file = path.join(remote, 'source', 'item'); const before = await fsp.stat(file); await fsp.writeFile(file, 'raced bytes'); await fsp.utimes(file, before.atime, before.mtime); return true; } });
  await fsp.mkdir(path.join(f.remote, 'source')); await fsp.mkdir(path.join(f.local, 'copy'));
  await fsp.writeFile(path.join(f.remote, 'source', 'item'), 'newer bytes'); await fsp.writeFile(path.join(f.local, 'copy', 'item'), 'older bytes');
  const plan = await f.plan('download', 'source', 'copy', { mode: 'sync' });
  await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /changed after review/);
  assert.equal(await fsp.readFile(path.join(f.local, 'copy', 'item'), 'utf8'), 'older bytes'); assert.deepEqual(f.mutations, []);
});

test('merge replacement checks destination content again after payload transfer', async t => {
  let changed = false; const f = await fixture(t, { onWrite: async ({ remote }) => { if (changed) return; changed = true; const file = path.join(remote, 'copy', 'item'); const before = await fsp.stat(file); await fsp.writeFile(file, 'raced bytes'); await fsp.utimes(file, before.atime, before.mtime); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.local, 'source', 'item'), 'newer bytes'); await fsp.writeFile(path.join(f.remote, 'copy', 'item'), 'older bytes');
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'merge', conflictPolicy: 'replace' }));
  assert.equal(result.status, 'failed'); assert.match(result.error, /destination.*changed/i);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'item'), 'utf8'), 'raced bytes');
});

test('partial merge retains completed replacement and unmodified later files after failure', async t => {
  const f = await fixture(t, { onRename: async ({ to }) => { if (to === '/copy/b-second') throw new Error('Injected second commit refusal'); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  for (const name of ['a-first', 'b-second']) { await fsp.writeFile(path.join(f.local, 'source', name), 'replacement'); await fsp.writeFile(path.join(f.remote, 'copy', name), 'original'); }
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'merge', conflictPolicy: 'replace' }));
  assert.equal(result.status, 'failed'); assert.equal(result.filesCompleted, 1); assert.match(result.warning, /1 of 2 files completed/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'a-first'), 'utf8'), 'replacement');
  // A refusal of both commit and rollback leaves the old file under a recovery
  // name; the transfer engine must identify that retained path, never erase it.
  const second = (await fsp.readdir(path.join(f.remote, 'copy'))).filter(name => name.endsWith('.recovery'));
  assert.equal(second.length, 1); assert.equal(await fsp.readFile(path.join(f.remote, 'copy', second[0]), 'utf8'), 'original');
  assert.match(result.error, /Previous destination preserved/);
});

test('native denial of a replacement plan leaves both trees byte-for-byte unchanged', async t => {
  const f = await fixture(t, { defaultDeny: true });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.local, 'source', 'item'), 'source bytes'); await fsp.writeFile(path.join(f.remote, 'copy', 'item'), 'target bytes');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'merge', conflictPolicy: 'replace' });
  assert.equal(plan.replaced, 1); assert.deepEqual(await f.manager.startFolderTransfer({ planId: plan.planId }), { cancelled: true });
  assert.equal(await fsp.readFile(path.join(f.local, 'source', 'item'), 'utf8'), 'source bytes');
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'item'), 'utf8'), 'target bytes'); assert.deepEqual(f.mutations, []);
});

test('review expiration interrupts remote content comparison without mutation or leaked reservation', async t => {
  const f = await fixture(t, { folderPlanLifetimeMs: 100, onRead: async () => { await pause(200); } });
  await fsp.mkdir(path.join(f.remote, 'source')); await fsp.writeFile(path.join(f.remote, 'source', 'item'), Buffer.alloc(70000, 12));
  await assert.rejects(f.plan('download', 'source', 'copy', { mode: 'sync' }), /cancelled|expired/);
  assert.deepEqual(f.mutations, []); assert.equal(f.manager.listJobs().length, 0);
  assert.equal(f.manager.discardFolderTransfer({ planId: 'expired' }), false);
  const review = await f.manager.prepareRemoteOperation({ id: f.connection.id, operation: 'mkdir', path: '/', name: 'after-expiry' });
  assert.equal(f.manager.discardRemoteOperation({ planId: review.planId }), true);
});


test('reviewed replacement refuses destination special permission bits', { skip: process.platform === 'win32' && 'Windows mode bits do not represent setuid' }, async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.local, 'source', 'item'), 'newer'); await fsp.writeFile(path.join(f.remote, 'copy', 'item'), 'older');
  await fsp.chmod(path.join(f.remote, 'copy', 'item'), 0o4640);
  await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'merge', conflictPolicy: 'replace' }), /special permission bits/);
  assert.deepEqual(f.mutations, []);
});


test('merge Replace changed files skips content-identical existing files', async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.local, 'source', 'same'), 'identical bytes'); await fsp.writeFile(path.join(f.remote, 'copy', 'same'), 'identical bytes');
  await fsp.writeFile(path.join(f.local, 'source', 'changed'), 'new bytes'); await fsp.writeFile(path.join(f.remote, 'copy', 'changed'), 'old bytes');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'merge', conflictPolicy: 'replace' });
  assert.equal(plan.replaced, 1); assert.equal(plan.skipped, 1); assert.equal(plan.files, 1);
  assert.equal(plan.entries.find(entry => entry.relativePath === 'same').action, 'skip');
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error);
  assert.equal(f.mutations.filter(entry => entry[0] === 'rename' && entry[2] === '/copy/same').length, 0);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'same'), 'utf8'), 'identical bytes');
});

async function advancedTrees(f) {
  await fsp.mkdir(path.join(f.local, 'source', 'local-empty'), { recursive: true });
  await fsp.mkdir(path.join(f.remote, 'copy', 'remote-empty'), { recursive: true });
  await fsp.writeFile(path.join(f.local, 'source', 'local-only'), 'local payload');
  await fsp.writeFile(path.join(f.remote, 'copy', 'remote-only'), 'remote payload');
  for (const root of [path.join(f.local, 'source'), path.join(f.remote, 'copy')]) await fsp.writeFile(path.join(root, 'same'), 'same content');
}

test('two-way copies missing files and empty directories in both directions without deleting', async t => {
  const f = await fixture(t); await advancedTrees(f);
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'two-way' });
  assert.equal(plan.copied, 2); assert.equal(plan.directories, 2); assert.equal(plan.skipped, 1); assert.equal(plan.unresolved, 0);
  assert.equal(plan.entries.find(e => e.relativePath === 'remote-only').direction, 'download');
  assert.equal(plan.entries.find(e => e.relativePath === 'local-only').direction, 'upload');
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error);
  for (const root of [path.join(f.local, 'source'), path.join(f.remote, 'copy')]) {
    assert.equal(await fsp.readFile(path.join(root, 'local-only'), 'utf8'), 'local payload');
    assert.equal(await fsp.readFile(path.join(root, 'remote-only'), 'utf8'), 'remote payload');
    assert.deepEqual(await fsp.readdir(path.join(root, 'local-empty')), []);
    assert.deepEqual(await fsp.readdir(path.join(root, 'remote-empty')), []);
  }
  assert.equal(f.mutations.filter(e => e[0] === 'remove' || e[0] === 'rmdir').length, 0);
});

test('two-way conflicts never choose a winner implicitly and applying an unresolved plan performs no mutation', async t => {
  const f = await fixture(t); await advancedTrees(f);
  await fsp.writeFile(path.join(f.local, 'source', 'different'), 'local'); await fsp.writeFile(path.join(f.remote, 'copy', 'different'), 'remote');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'two-way', conflictPolicy: 'replace' });
  assert.equal(plan.conflicts, 1); assert.equal(plan.unresolved, 1); assert.equal(plan.entries.find(e => e.relativePath === 'different').action, 'conflict');
  await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /Resolve|conflict/);
  assert.deepEqual(f.mutations, []); assert.equal(f.approvals.length, 0);
});

test('two-way explicit local, remote, and skip choices only replace the reviewed selected files', async t => {
  const f = await fixture(t); await advancedTrees(f);
  for (const name of ['choose-local', 'choose-remote', 'skip']) {
    await fsp.writeFile(path.join(f.local, 'source', name), 'left'); await fsp.writeFile(path.join(f.remote, 'copy', name), 'right');
  }
  const resolutions = [{ relativePath: 'choose-local', source: 'local' }, { relativePath: 'choose-remote', source: 'remote' }, { relativePath: 'skip', source: 'skip' }];
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'two-way', resolutions });
  assert.equal(plan.conflicts, 3); assert.equal(plan.unresolved, 0); assert.equal(plan.replaced, 2);
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error);
  for (const root of [path.join(f.local, 'source'), path.join(f.remote, 'copy')]) {
    assert.equal(await fsp.readFile(path.join(root, 'choose-local'), 'utf8'), 'left');
    assert.equal(await fsp.readFile(path.join(root, 'choose-remote'), 'utf8'), 'right');
  }
  assert.equal(await fsp.readFile(path.join(f.local, 'source', 'skip'), 'utf8'), 'left');
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'skip'), 'utf8'), 'right');
});

test('two-way can create either missing root from the existing peer', async t => {
  const f = await fixture(t); await tree(f.local);
  const first = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'two-way' })); assert.equal(first.status, 'completed', first.error);
  const second = await f.run(await f.plan('download', 'copy', 'fresh', { mode: 'two-way' })); assert.equal(second.status, 'completed', second.error);
  assert.deepEqual(await fsp.readFile(path.join(f.local, 'fresh', 'nested', 'payload')), Buffer.alloc(150000, 67));
});

test('two-way rejects malformed, duplicate, stale and unrelated conflict resolutions', async t => {
  const f = await fixture(t); await advancedTrees(f);
  for (const resolutions of [[{ relativePath: '../escape', source: 'local' }], [{ relativePath: 'same', source: 'newest' }],
    [{ relativePath: 'same', source: 'local' }, { relativePath: 'same', source: 'remote' }], [{ relativePath: 'same', source: 'skip' }]]) {
    await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'two-way', resolutions }), /resolution|conflicting/);
  }
  assert.deepEqual(f.mutations, []);
});

test('two-way native denial and edits during approval leave trees unmodified by the transfer', async t => {
  let accepted = false; const f = await fixture(t, { confirm: async (_, __, { remote }) => {
    if (!accepted) return false; await fsp.writeFile(path.join(remote, 'copy', 'remote-only'), 'external change'); return true;
  } }); await advancedTrees(f);
  const first = await f.plan('upload', 'source', 'copy', { mode: 'two-way' });
  assert.deepEqual(await f.manager.startFolderTransfer({ planId: first.planId }), { cancelled: true });
  accepted = true; const second = await f.plan('upload', 'source', 'copy', { mode: 'two-way' });
  await assert.rejects(f.manager.startFolderTransfer({ planId: second.planId }), /changed after review/);
  assert.deepEqual(f.mutations, []);
});

test('two-way refuses type conflicts and missing trees before mutation', async t => {
  const f = await fixture(t); await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'two-way' }), /already exist/);
  await advancedTrees(f); await fsp.mkdir(path.join(f.local, 'source', 'collision')); await fsp.writeFile(path.join(f.remote, 'copy', 'collision'), 'file');
  await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'two-way' }), /conflicts/); assert.deepEqual(f.mutations, []);
});

for (const direction of ['upload', 'download']) test(`mirror ${direction} previews replacements and deletes target-only files and folders postorder`, async t => {
  const f = await fixture(t); const source = path.join(direction === 'upload' ? f.local : f.remote, 'source'); const target = path.join(direction === 'upload' ? f.remote : f.local, 'copy');
  await fsp.mkdir(path.join(source, 'kept'), { recursive: true }); await fsp.mkdir(path.join(target, 'extra', 'nested'), { recursive: true });
  await fsp.writeFile(path.join(source, 'changed'), 'replacement'); await fsp.writeFile(path.join(target, 'changed'), 'original');
  await fsp.writeFile(path.join(target, 'extra', 'nested', 'delete'), 'reviewed deletion'); await fsp.writeFile(path.join(target, 'extra-file'), 'delete');
  const plan = await f.plan(direction, 'source', 'copy', { mode: 'mirror' });
  assert.equal(plan.deletedFiles, 2); assert.equal(plan.deletedDirectories, 2); assert.equal(plan.replaced, 1); assert.equal(plan.kept, 0);
  const deletions = plan.entries.filter(e => e.action.startsWith('delete-'));
  assert(deletions.findIndex(e => e.relativePath === 'extra/nested/delete') < deletions.findIndex(e => e.relativePath === 'extra/nested'));
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(await fsp.readdir(target), ['changed', 'kept']); assert.equal(await fsp.readFile(path.join(target, 'changed'), 'utf8'), 'replacement');
  assert.equal(f.approvals[0].deletedFiles, 2);
});

test('mirror with an empty source removes only reviewed target descendants and retains the root', async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy', 'extra'), { recursive: true }); await fsp.writeFile(path.join(f.remote, 'copy', 'extra', 'file'), 'remove');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'mirror' }); assert.equal(plan.files, 0); assert.equal(plan.deletedFiles, 1);
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error); assert.deepEqual(await fsp.readdir(path.join(f.remote, 'copy')), []);
});

test('mirror native decline never deletes reviewed data', async t => {
  const f = await fixture(t, { defaultDeny: true }); await advancedTrees(f); const plan = await f.plan('upload', 'source', 'copy', { mode: 'mirror' });
  assert.equal(plan.deletedFiles, 1); assert.deepEqual(await f.manager.startFolderTransfer({ planId: plan.planId }), { cancelled: true });
  assert.deepEqual(f.mutations, []); assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'remote-only'), 'utf8'), 'remote payload');
});

test('mirror rejects target content changed during native approval including restored size and mtime', async t => {
  const f = await fixture(t, { confirm: async (_, __, { remote }) => { const file = path.join(remote, 'copy', 'extra'); const info = await fsp.stat(file); await fsp.writeFile(file, 'change'); await fsp.utimes(file, info.atime, info.mtime); return true; } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.remote, 'copy', 'extra'), 'before');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'mirror' }); await assert.rejects(f.manager.startFolderTransfer({ planId: plan.planId }), /changed after review/); assert.deepEqual(f.mutations, []);
});

test('mirror stops before deletion when destination content changes during preceding copy', async t => {
  let changed = false; const f = await fixture(t, { onWrite: async ({ remote }) => { if (!changed) { changed = true; const file = path.join(remote, 'copy', 'extra'); const stat = await fsp.stat(file); await fsp.writeFile(file, 'change'); await fsp.utimes(file, stat.atime, stat.mtime); } } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.local, 'source', 'copy-first'), 'payload'); await fsp.writeFile(path.join(f.remote, 'copy', 'extra'), 'before');
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'mirror' })); assert.equal(result.status, 'failed'); assert.match(result.error, /destination file content changed/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'extra'), 'utf8'), 'change'); assert.equal(f.mutations.filter(e => e[0] === 'remove').length, 0);
});

test('mirror retains newly added contents instead of recursively deleting an expanded directory', async t => {
  const f = await fixture(t, { onRemove: async ({ remote }) => { await fsp.writeFile(path.join(remote, 'copy', 'extra', 'new'), 'keep'); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy', 'extra'), { recursive: true }); await fsp.writeFile(path.join(f.remote, 'copy', 'extra', 'old'), 'reviewed');
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'mirror' })); assert.equal(result.status, 'failed'); assert.match(result.error, /no longer empty/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'extra', 'new'), 'utf8'), 'keep'); assert.equal(f.mutations.filter(e => e[0] === 'rmdir').length, 0);
});

test('mirror refuses target deletion when a matching source path appeared during the operation', async t => {
  const f = await fixture(t, { onWrite: async ({ local }) => { await fsp.writeFile(path.join(local, 'source', 'extra'), 'new source'); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.local, 'source', 'copy-first'), 'payload'); await fsp.writeFile(path.join(f.remote, 'copy', 'extra'), 'retain');
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'mirror' })); assert.equal(result.status, 'failed'); assert.match(result.error, /source path appeared/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'extra'), 'utf8'), 'retain'); assert.equal(f.mutations.filter(e => e[0] === 'remove').length, 0);
});

test('mirror deletion with missing acknowledgement closes the session and reports unknown outcome', async t => {
  const f = await fixture(t, { commitTimeoutMs: 50, afterRemove: async () => false }); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.remote, 'copy', 'extra'), 'delete');
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'mirror' })); assert.equal(result.status, 'failed'); assert.match(result.error, /outcome is unknown/);
  await assert.rejects(f.manager.listRemote({ id: f.connection.id, path: '/copy' }), /closed/);
});

test('advanced destructive and bidirectional plans explicitly reject folder resume', async t => {
  const f = await fixture(t); await advancedTrees(f);
  for (const mode of ['mirror', 'two-way']) await assert.rejects(f.plan('upload', 'source', 'copy', { mode, resumable: true }), /Resumable folder/);
  assert.deepEqual(f.mutations, []);
});

test('mirror cancellation waits for an issued deletion and reports completed irreversible work', async t => {
  let released; let entered; const pending = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { afterRemove: async () => { entered(); await new Promise(resolve => { released = resolve; }); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.remote, 'copy', 'a'), 'delete first'); await fsp.writeFile(path.join(f.remote, 'copy', 'b'), 'retain later');
  const prepared = await f.plan('upload', 'source', 'copy', { mode: 'mirror' }); const started = await f.manager.startFolderTransfer({ planId: prepared.planId });
  await pending; let cancelled = false; const stopping = f.manager.cancel(started.transferId).then(() => { cancelled = true; });
  await pause(20); assert.equal(cancelled, false); released(); await stopping;
  const result = await f.waitJob(started.transferId); assert.equal(result.status, 'cancelled'); assert.equal(result.deletedFiles, 1); assert.match(result.warning, /1 files.*deleted/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'b'), 'utf8'), 'retain later');
});

test('mirror refuses a symlink at a deletion candidate and never follows target-only links', { skip: process.platform === 'win32' && 'Windows symlink creation requires a platform privilege' }, async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.remote, 'outside'), 'outside bytes');
  await fsp.symlink('../outside', path.join(f.remote, 'copy', 'link')); await assert.rejects(f.plan('upload', 'source', 'copy', { mode: 'mirror' }), /symbolic links/);
  assert.deepEqual(f.mutations, []); assert.equal(await fsp.readFile(path.join(f.remote, 'outside'), 'utf8'), 'outside bytes');
});

test('mirror refuses a destination link substituted during preceding transfer', { skip: process.platform === 'win32' && 'Windows symlink creation requires a platform privilege' }, async t => {
  let changed = false; const f = await fixture(t, { onWrite: async ({ remote }) => { if (changed) return; changed = true; await fsp.unlink(path.join(remote, 'copy', 'extra')); await fsp.symlink('../outside', path.join(remote, 'copy', 'extra')); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.local, 'source', 'copy-first'), 'copy'); await fsp.writeFile(path.join(f.remote, 'copy', 'extra'), 'original'); await fsp.writeFile(path.join(f.remote, 'outside'), 'keep');
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'mirror' })); assert.equal(result.status, 'failed'); assert.match(result.error, /destination file changed/);
  assert.equal(await fsp.readFile(path.join(f.remote, 'outside'), 'utf8'), 'keep'); assert.equal(f.mutations.filter(e => e[0] === 'remove').length, 0);
});

test('two-way replaced file choices detect content changes during payload transfer', async t => {
  let changed = false; const f = await fixture(t, { onWrite: async ({ remote }) => { if (changed) return; changed = true; const name = path.join(remote, 'copy', 'conflict'); const info = await fsp.stat(name); await fsp.writeFile(name, 'third'); await fsp.utimes(name, info.atime, info.mtime); } });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy')); await fsp.writeFile(path.join(f.local, 'source', 'conflict'), 'first'); await fsp.writeFile(path.join(f.remote, 'copy', 'conflict'), 'other');
  const result = await f.run(await f.plan('upload', 'source', 'copy', { mode: 'two-way', resolutions: [{ relativePath: 'conflict', source: 'local' }] }));
  assert.equal(result.status, 'failed'); assert.match(result.error, /destination file content changed/); assert.equal(await fsp.readFile(path.join(f.remote, 'copy', 'conflict'), 'utf8'), 'third');
});

test('two-way skips identical files with zero mutation on an already converged tree', async t => {
  const f = await fixture(t); await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  await fsp.writeFile(path.join(f.local, 'source', 'same'), 'same'); await fsp.writeFile(path.join(f.remote, 'copy', 'same'), 'same');
  const plan = await f.plan('upload', 'source', 'copy', { mode: 'two-way' }); assert.equal(plan.files, 0); assert.equal(plan.conflicts, 0);
  const result = await f.run(plan); assert.equal(result.status, 'completed', result.error); assert.deepEqual(f.mutations, []);
});

test('mirror rechecks deletion target after the remote source-absence probe and retains concurrent edits', async t => {
  let edited = false;
  const f = await fixture(t, { onStat: async ({ name, local }) => {
    if (name !== '/source/extra' || edited) return;
    edited = true;
    const target = path.join(local, 'copy', 'extra');
    const before = await fsp.stat(target);
    await fsp.writeFile(target, 'edited!!');
    await fsp.utimes(target, before.atime, before.mtime);
  } });
  await fsp.mkdir(path.join(f.remote, 'source'));
  await fsp.mkdir(path.join(f.local, 'copy'));
  await fsp.writeFile(path.join(f.local, 'copy', 'extra'), 'original');
  const prepared = await f.plan('download', 'source', 'copy', { mode: 'mirror' });
  assert.equal(prepared.deletedFiles, 1);
  const result = await f.run(prepared);
  assert.equal(edited, true, 'The fixture must edit the target during the real SFTP absence probe.');
  assert.equal(result.status, 'failed', result.error);
  assert.match(result.error, /destination file (?:content )?changed/);
  assert.equal(result.deletedFiles, 0);
  assert.equal(await fsp.readFile(path.join(f.local, 'copy', 'extra'), 'utf8'), 'edited!!');
});

async function persistentFixture(t, options = {}) {
  const f = await fixture(t, { ...options, persistent: true });
  await fsp.mkdir(path.join(f.local, 'source')); await fsp.mkdir(path.join(f.remote, 'copy'));
  const localFile = name => path.join(f.local, 'source', name), remoteFile = name => path.join(f.remote, 'copy', name);
  const review = input => f.plan('upload', 'source', 'copy', { mode: 'two-way', persistentSync: true, ...input });
  async function initialize(files = { file: 'original' }) {
    for (const [name, value] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(localFile(name)), { recursive: true }); await fsp.mkdir(path.dirname(remoteFile(name)), { recursive: true });
      await fsp.writeFile(localFile(name), value); await fsp.writeFile(remoteFile(name), value);
    }
    const result = await f.run(await review({ pairName: 'Fixture pair' })); assert.equal(result.status, 'completed', result.error);
    const pairs = await f.manager.listSyncPairs({ id: f.connection.id }); assert.equal(pairs.length, 1); assert.equal(pairs[0].revision, 1);
    return pairs[0];
  }
  return { ...f, localFile, remoteFile, review, initialize, pairs: () => f.manager.listSyncPairs({ id: f.connection.id }) };
}

test('persistent sync saves only after apply and infers edits across consecutive verified generations', async t => {
  const f = await persistentFixture(t); await f.initialize();
  await fsp.writeFile(f.localFile('file'), 'local edit');
  let review = await f.review(); assert.equal(review.baselineUsed, true); assert.equal(review.conflicts, 0); assert.equal(review.replaced, 1);
  assert.equal(review.entries.find(e => e.relativePath === 'file').direction, 'upload');
  let result = await f.run(review); assert.equal(result.status, 'completed', result.error); assert.equal(await fsp.readFile(f.remoteFile('file'), 'utf8'), 'local edit');
  await fsp.writeFile(f.remoteFile('file'), 'remote edit');
  review = await f.review(); assert.equal(review.entries.find(e => e.relativePath === 'file').direction, 'download');
  result = await f.run(review); assert.equal(result.status, 'completed', result.error); assert.equal(await fsp.readFile(f.localFile('file'), 'utf8'), 'remote edit');
  assert.equal((await f.pairs())[0].revision, 3);
});

test('persistent sync treats first-run differing content as explicit conflict and discard creates no pair', async t => {
  const f = await persistentFixture(t); await fsp.writeFile(f.localFile('file'), 'local'); await fsp.writeFile(f.remoteFile('file'), 'remote');
  const review = await f.review(); assert.equal(review.baselineUsed, false); assert.equal(review.syncPair.isNew, true); assert.equal(review.unresolved, 1);
  assert.equal(review.entries.find(e => e.relativePath === 'file').conflictReason, 'initial-divergence');
  await f.manager.discardFolderTransfer({ planId: review.planId }); assert.deepEqual(await f.pairs(), []);
});

test('persistent sync keeps skipped both-edited conflict on the old common ancestor', async t => {
  const f = await persistentFixture(t); await f.initialize(); await fsp.writeFile(f.localFile('file'), 'local edit'); await fsp.writeFile(f.remoteFile('file'), 'remote edit');
  let review = await f.review({ resolutions: [{ relativePath: 'file', source: 'skip' }] }); assert.equal(review.conflicts, 1); assert.equal(review.unresolved, 0);
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error);
  await fsp.writeFile(f.localFile('file'), 'another edit');
  review = await f.review(); assert.equal(review.unresolved, 1); assert.equal(review.entries.find(e => e.relativePath === 'file').conflictReason, 'both-edited');
  await f.manager.discardFolderTransfer({ planId: review.planId });
  assert.equal(await fsp.readFile(f.remoteFile('file'), 'utf8'), 'remote edit');
});

test('persistent sync propagates reviewed one-sided file deletions in both directions', async t => {
  const f = await persistentFixture(t); await f.initialize({ one: '1', two: '2' });
  await fsp.unlink(f.localFile('one')); await fsp.unlink(f.remoteFile('two'));
  const review = await f.review(); assert.equal(review.deletedFiles, 2); assert.equal(review.conflicts, 0);
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error); assert.equal(result.deletedFiles, 2);
  await assert.rejects(fsp.stat(f.localFile('two')), { code: 'ENOENT' }); await assert.rejects(fsp.stat(f.remoteFile('one')), { code: 'ENOENT' });
  assert.equal((await f.pairs())[0].revision, 2);
});

test('persistent deletion-versus-edit conflict can preserve content or explicitly choose absence', async t => {
  const f = await persistentFixture(t); await f.initialize({ keep: '1', remove: '2' });
  await fsp.unlink(f.localFile('keep')); await fsp.writeFile(f.remoteFile('keep'), 'edited');
  await fsp.unlink(f.remoteFile('remove')); await fsp.writeFile(f.localFile('remove'), 'edited');
  let review = await f.review(); assert.equal(review.unresolved, 2); await f.manager.discardFolderTransfer({ planId: review.planId });
  review = await f.review({ resolutions: [{ relativePath: 'keep', source: 'remote' }, { relativePath: 'remove', source: 'remote' }] });
  assert.equal(review.copied, 1); assert.equal(review.deletedFiles, 1);
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error);
  assert.equal(await fsp.readFile(f.localFile('keep'), 'utf8'), 'edited'); await assert.rejects(fsp.stat(f.localFile('remove')), { code: 'ENOENT' });
});

test('persistent deleted directory groups changed and new descendants into one reviewed conflict', async t => {
  const f = await persistentFixture(t); await f.initialize({ 'nested/old': 'original' });
  await fsp.rm(f.localFile('nested'), { recursive: true }); await fsp.writeFile(f.remoteFile('nested/new'), 'new content');
  let review = await f.review(); assert.equal(review.conflicts, 1); const conflict = review.entries.find(e => e.conflict);
  assert.equal(conflict.relativePath, 'nested'); assert.equal(conflict.subtree, true); assert.equal(conflict.conflictReason, 'deletion-versus-edit');
  await f.manager.discardFolderTransfer({ planId: review.planId });
  review = await f.review({ resolutions: [{ relativePath: 'nested', source: 'local' }] }); assert.equal(review.deletedFiles, 2); assert.equal(review.deletedDirectories, 1);
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error);
  await assert.rejects(fsp.stat(f.remoteFile('nested')), { code: 'ENOENT' });
});

test('persistent unmodified directory deletion is postorder and a skipped subtree remains unresolved', async t => {
  const f = await persistentFixture(t); await f.initialize({ 'gone/sub/file': 'same', 'conflict/file': 'same' });
  await fsp.rm(f.localFile('gone'), { recursive: true }); await fsp.rm(f.localFile('conflict'), { recursive: true }); await fsp.writeFile(f.remoteFile('conflict/file'), 'changed');
  let review = await f.review({ resolutions: [{ relativePath: 'conflict', source: 'skip' }] });
  assert.equal(review.deletedFiles, 1); assert.equal(review.deletedDirectories, 2);
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error);
  assert.equal(await fsp.readFile(f.remoteFile('conflict/file'), 'utf8'), 'changed');
  review = await f.review(); assert.equal(review.conflicts, 1); assert.equal(review.entries.find(e => e.conflict).relativePath, 'conflict');
  await f.manager.discardFolderTransfer({ planId: review.planId });
});

test('persistent file-directory type changes require manual reconciliation and keep their old baseline', async t => {
  const f = await persistentFixture(t); await f.initialize(); await fsp.unlink(f.localFile('file')); await fsp.mkdir(f.localFile('file')); await fsp.writeFile(f.localFile('file/child'), 'child');
  let review = await f.review(); const conflict = review.entries.find(e => e.conflict); assert.equal(conflict.conflictReason, 'type-change'); assert.deepEqual(conflict.allowedResolutions, ['skip']);
  await f.manager.discardFolderTransfer({ planId: review.planId });
  await assert.rejects(f.review({ resolutions: [{ relativePath: 'file', source: 'local' }] }), /manual reconciliation/);
  review = await f.review({ resolutions: [{ relativePath: 'file', source: 'skip' }] });
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error);
  review = await f.review(); assert.equal(review.unresolved, 1); await f.manager.discardFolderTransfer({ planId: review.planId });
});

test('persistent review is invalidated by changed files and declined confirmation never saves a baseline', async t => {
  let accept = false; const f = await persistentFixture(t, { confirm: async () => accept });
  await fsp.writeFile(f.localFile('file'), 'before');
  let review = await f.review(); assert.deepEqual(await f.manager.startFolderTransfer({ planId: review.planId }), { cancelled: true }); assert.deepEqual(await f.pairs(), []);
  accept = true; review = await f.review(); await fsp.writeFile(f.localFile('file'), 'after');
  await assert.rejects(f.manager.startFolderTransfer({ planId: review.planId }), /changed after review/); assert.deepEqual(await f.pairs(), []);
});

test('persistent final verification refuses an unrelated concurrent addition and leaves baseline unchanged', async t => {
  let armed = false; const f = await persistentFixture(t, { onWrite: async ({ remote }) => { if (!armed) return; armed = false; await fsp.writeFile(path.join(remote, 'copy', 'unreviewed'), 'external'); } });
  await f.initialize(); await fsp.writeFile(f.localFile('file'), 'changed'); armed = true;
  const result = await f.run(await f.review()); assert.equal(result.status, 'failed'); assert.match(result.error, /final verification/);
  assert.equal((await f.pairs())[0].revision, 1); assert.equal(await fsp.readFile(f.remoteFile('unreviewed'), 'utf8'), 'external');
});

test('persistent pair binding rejects another account, host key, roots, and stale generation after forget', async t => {
  let account = 'fixture', fingerprint = 'key'; const f = await persistentFixture(t, { account: () => account, fingerprint: () => fingerprint });
  const saved = await f.initialize(); account = 'different'; assert.deepEqual(await f.pairs(), []);
  await assert.rejects(f.review({ syncPairId: saved.pairId }), /another authenticated/); account = 'fixture'; fingerprint = 'different'; assert.deepEqual(await f.pairs(), []);
  fingerprint = 'key'; await assert.rejects(f.review({ syncPairId: saved.pairId, remotePath: '/elsewhere' }), /different folders/);
  assert.equal(await f.manager.forgetSyncPair({ id: f.connection.id, pairId: saved.pairId, revision: saved.revision }), true);
  assert.deepEqual(await f.pairs(), []); assert.equal(await fsp.readFile(f.localFile('file'), 'utf8'), 'original');
  const review = await f.review(); assert.equal(review.baselineUsed, false); assert.notEqual(review.syncPair.pairId, saved.pairId); await f.manager.discardFolderTransfer({ planId: review.planId });
});

test('persistent baseline generation changed by another instance refuses launch before mutation', async t => {
  const { createSyncBaselines } = require('../app/sync-baselines.cjs'); const f = await persistentFixture(t); await f.initialize();
  await fsp.writeFile(f.localFile('file'), 'pending'); const review = await f.review(); const mutationCount = f.mutations.length;
  const store = createSyncBaselines(path.join(f.root, 'sync')); const [record] = await store.load(); const held = await store.begin(record); await held.commit(record.entries); await held.release();
  await assert.rejects(f.manager.startFolderTransfer({ planId: review.planId }), /baseline changed/);
  assert.equal(f.mutations.length, mutationCount); assert.equal(await fsp.readFile(f.remoteFile('file'), 'utf8'), 'original');
});

test('persistent cancelled payload releases lease and never advances baseline', async t => {
  let armed = false; let enter; const entered = new Promise(resolve => { enter = resolve; }); let unblock; const blocked = new Promise(resolve => { unblock = resolve; });
  const f = await persistentFixture(t, { onWrite: async () => { if (!armed) return; armed = false; enter(); await blocked; } }); await f.initialize();
  await fsp.writeFile(f.localFile('file'), Buffer.alloc(256 * 1024, 1)); armed = true;
  const job = await f.manager.startFolderTransfer({ planId: (await f.review()).planId }); await entered;
  const cancel = f.manager.cancel(job.transferId); unblock(); await cancel;
  const result = await f.waitJob(job.transferId); assert.equal(result.status, 'cancelled'); assert.equal((await f.pairs())[0].revision, 1);
  await assert.rejects(fsp.stat(path.join(f.root, 'sync', 'pairs.lock')), { code: 'ENOENT' });
  const review = await f.review(); assert.equal(review.replaced, 1); await f.manager.discardFolderTransfer({ planId: review.planId });
});

test('persistent missing root conflict can explicitly preserve a surviving changed subtree', async t => {
  const f = await persistentFixture(t); await f.initialize({ 'nested/file': 'original' }); await fsp.rm(path.join(f.local, 'source'), { recursive: true });
  await fsp.writeFile(f.remoteFile('nested/file'), 'remote changed');
  let review = await f.review(); assert.equal(review.entries.find(e => e.conflict).relativePath, ''); await f.manager.discardFolderTransfer({ planId: review.planId });
  review = await f.review({ resolutions: [{ relativePath: '', source: 'remote' }] }); assert.equal(review.directories, 2); assert.equal(review.copied, 1);
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error); assert.equal(await fsp.readFile(f.localFile('nested/file'), 'utf8'), 'remote changed');
});

test('persistent deletion confirmation refuses a destination edit performed after the absence probe', async t => {
  let armed = false; const f = await persistentFixture(t, { onStat: async ({ name, local }) => {
    if (!armed || name !== '/copy/file') return; armed = false; await fsp.writeFile(path.join(local, 'source', 'file'), 'concurrent edit');
  } }); await f.initialize(); await fsp.unlink(f.remoteFile('file')); const review = await f.review(); assert.equal(review.deletedFiles, 1);
  // The destination check after the missing-source probe must catch this edit.
  armed = true; const result = await f.run(review); assert.equal(result.status, 'failed'); assert.match(result.error, /changed/);
  assert.equal(await fsp.readFile(f.localFile('file'), 'utf8'), 'concurrent edit'); assert.equal((await f.pairs())[0].revision, 1);
});

test('persistent root deletion removes nested contents before the named root and saves an empty baseline', async t => {
  const f = await persistentFixture(t); await f.initialize({ 'nested/file': 'original' }); await fsp.rm(path.join(f.local, 'source'), { recursive: true });
  const review = await f.review(); assert.equal(review.deletedFiles, 1); assert.equal(review.deletedDirectories, 2); assert.equal(review.entries.at(-1).relativePath, '');
  const result = await f.run(review); assert.equal(result.status, 'completed', result.error);
  await assert.rejects(fsp.stat(path.join(f.remote, 'copy')), { code: 'ENOENT' });
  const next = await f.review(); assert.equal(next.baselineUsed, true); assert.equal(next.files, 0); assert.equal(next.conflicts, 0);
  const repeated = await f.run(next); assert.equal(repeated.status, 'completed', repeated.error);
});
