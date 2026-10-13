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
      action('OPENDIR', async (id, name) => stream.handle(id, remember({ directory: target(name), sent: false })));
      action('READDIR', async (id, handle) => {
        const item = lookup(handle); if (item.sent) return stream.status(id, STATUS_CODE.EOF); item.sent = true;
        const original = await fsp.readdir(item.directory); const names = options.directoryNames ? options.directoryNames(original, item.directory) : original;
        const entries = await Promise.all(names.map(async name => ({ filename: name, longname: '', attrs: attrs(await fsp.lstat(path.join(item.directory, name))) })));
        entries.length ? stream.name(id, entries) : stream.status(id, STATUS_CODE.EOF);
      });
      action('OPEN', async (id, name, flags, attributes) => {
        let mode = flags & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
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
    confirmFolderTransfer: options.defaultDeny ? undefined : async (review, meta) => {
      approvals.push(review); return options.confirm ? options.confirm(review, meta, { local, remote }) : true;
    },
    connect: () => new Promise((resolve, reject) => {
      const client = new Client(); client.once('error', reject); client.once('ready', () => resolve(client));
      client.connect({ host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'test-only', hostVerifier: () => true });
    }) });
  const connection = await manager.open({ host: '127.0.0.1', port: server.address().port });
  t.after(async () => { await manager.closeAll(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); await fsp.rm(root, { recursive: true, force: true }); });
  async function plan(direction = 'upload', name = 'source', destination = 'copy') {
    return manager.prepareFolderTransfer({ id: connection.id, direction,
      localPath: path.join(local, direction === 'upload' ? name : destination), remotePath: '/' + (direction === 'upload' ? destination : name) });
  }
  async function waitJob(id) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const job = manager.listJobs().find(item => item.transferId === id); if (['completed', 'failed', 'cancelled'].includes(job?.status)) return job; await pause(10); }
    throw new Error('Folder job did not finish.');
  }
  async function run(prepared) { return waitJob((await manager.startFolderTransfer({ planId: prepared.planId })).transferId); }
  return { local, remote, manager, connection, plan, run, waitJob, mutations, events, approvals,
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
  assert.equal(result.status, 'failed'); assert.match(result.error, /destination changed|appeared/); assert.match(result.warning, /Partial folder copy/);
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
  assert.match(job.warning, /folders remain/); assert((await fsp.stat(path.join(f.remote, 'copy'))).isDirectory());
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
