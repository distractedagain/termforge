'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { createFtpTransfers } = require('../app/ftp-transfers.cjs');
const { createFtpRecovery, validate } = require('../app/ftp-recovery.cjs');
const { startFtpFixture, good } = require('./helpers/ftp-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'forgecrt-ftp-review-')));
  const local = path.join(root, 'local'), remote = path.join(root, 'remote'), recoveryDirectory = path.join(root, 'recovery');
  await fsp.mkdir(local); await fsp.mkdir(remote); const peer = await startFtpFixture(remote, options.peer); const managers = []; let service;
  function make(extra = {}) {
    service = createFtpTransfers({ tlsCa: good.cert, timeoutMs: 1500, recoveryDirectory,
      requestAuthentication: async () => ['synthetic-password'], confirmPlaintext: async () => true, confirmOverwrite: async () => true,
      confirmResume: async () => true, confirmDiscardPartial: async () => true, confirmFolderTransfer: async () => true,
      emit: event => options.emit?.(event, service), ...extra }); managers.push(service); return service;
  }
  make(options.service);
  t.after(async () => { for (const manager of managers) await manager.closeAll(); await peer.close(); await fsp.rm(root, { recursive: true, force: true }); });
  const journalPath = id => path.join(recoveryDirectory, 'ftp', `${id}.json`);
  return { root, local, remote, peer, recoveryDirectory, make, get service() { return service; },
    journalPath, journal: async id => JSON.parse(await fsp.readFile(journalPath(id), 'utf8')),
    open: (protocol = 'ftps') => service.open({ host: 'localhost', port: peer.port, username: 'fixture', protocol }) };
}
async function settled(f, transferId) {
  for (let count = 0; count < 2000; count++) {
    const job = f.service.listJobs().find(item => item.transferId === transferId);
    if (job && ['completed', 'failed', 'cancelled', 'paused', 'interrupted'].includes(job.status)) return job;
    await pause(10);
  }
  throw new Error('Synthetic FTP job did not settle.');
}
test('an applied FTP rename with a lost acknowledgement stays inspect-only after restart and forget preserves its output', async t => {
  const f = await fixture(t, { peer: { dropCommitAfter: true } }); let connection = await f.open();
  await fsp.writeFile(path.join(f.local, 'file'), 'verified contents');
  const job = f.service.start({ id: connection.id, direction: 'upload', resumable: true, localPath: path.join(f.local, 'file'), remotePath: '/file' });
  const stopped = await settled(f, job.transferId); assert.equal(stopped.status, 'interrupted', stopped.error); assert.equal(stopped.resumeAvailable, false);
  assert.equal(await fsp.readFile(path.join(f.remote, 'file'), 'utf8'), 'verified contents');
  assert.equal((await f.journal(job.transferId)).phase, 'indeterminate');
  await f.service.closeAll(); f.make(); await f.service.initializeRecovery(); connection = await f.open();
  await assert.rejects(f.service.resume({ transferId: job.transferId, id: connection.id }), /cannot safely resume/);
  await f.service.discardPartial({ transferId: job.transferId });
  assert.equal(await fsp.readFile(path.join(f.remote, 'file'), 'utf8'), 'verified contents');
  await assert.rejects(fsp.stat(f.journalPath(job.transferId)), { code: 'ENOENT' });
});
for (const replacement of ['changed-content', 'same-content-new-inode']) test(`a resumed FTP folder refuses a completed child replaced with ${replacement}`, async t => {
  let requested = false;
  const f = await fixture(t, { emit: (event, service) => {
    if (!requested && event.kind === 'folder' && event.status === 'running' && event.filesCompleted === 1 && event.bytes > 4) { requested = true; void service.pause(event.transferId); }
  } });
  let connection = await f.open(); await fsp.mkdir(path.join(f.remote, 'tree'));
  await fsp.writeFile(path.join(f.remote, 'tree', 'a'), 'done'); await fsp.writeFile(path.join(f.remote, 'tree', 'b'), Buffer.alloc(512 * 1024, 0x32));
  f.peer.tuning.downloadDelayMs = 2;
  const review = await f.service.prepareFolderTransfer({ id: connection.id, direction: 'download', mode: 'copy', localPath: path.join(f.local, 'tree'), remotePath: '/tree', resumable: true });
  const job = await f.service.startFolderTransfer({ planId: review.planId }); const stopped = await settled(f, job.transferId);
  assert.equal(stopped.status, 'paused', stopped.error); const cp = await f.journal(job.transferId); assert.equal(cp.completed.length, 1);
  const child = path.join(f.local, 'tree', 'a');
  if (replacement === 'same-content-new-inode') { await fsp.rename(child, child + '.outside-receipt'); await fsp.writeFile(child, 'done'); await fsp.unlink(child + '.outside-receipt'); }
  else await fsp.writeFile(child, 'edit');
  const retained = await fsp.readFile(cp.child.stagePath);
  await f.service.closeAll(); f.make(); await f.service.initializeRecovery(); connection = await f.open(); f.peer.tuning.downloadDelayMs = 0;
  await f.service.resume({ transferId: job.transferId, id: connection.id }); const result = await settled(f, job.transferId);
  assert.equal(result.status, 'interrupted'); assert.match(result.error, /destination tree|completed file/);
  assert.deepEqual(await fsp.readFile(cp.child.stagePath), retained); assert.equal(await fsp.readFile(child, 'utf8'), replacement === 'changed-content' ? 'edit' : 'done');
  await assert.rejects(fsp.stat(path.join(f.local, 'tree', 'b')), { code: 'ENOENT' });
});
test('native folder decline creates no checkpoint or destination and releases reservation', async t => {
  const f = await fixture(t, { service: { confirmFolderTransfer: async () => false } }); const connection = await f.open();
  await fsp.mkdir(path.join(f.local, 'tree')); await fsp.writeFile(path.join(f.local, 'tree', 'file'), 'content');
  const review = await f.service.prepareFolderTransfer({ id: connection.id, direction: 'upload', mode: 'copy', localPath: path.join(f.local, 'tree'), remotePath: '/tree', resumable: true });
  assert.throws(() => f.service.assertExternalAvailable(), /pending/);
  assert.deepEqual(await f.service.startFolderTransfer({ planId: review.planId }), { cancelled: true });
  assert.deepEqual(f.service.listJobs(), []); assert.deepEqual(await fsp.readdir(path.join(f.recoveryDirectory, 'ftp')), []);
  assert.equal(f.service.assertExternalAvailable(), undefined); await assert.rejects(fsp.stat(path.join(f.remote, 'tree')), { code: 'ENOENT' });
});
function record(root) {
  const transferId = randomUUID(), stageId = randomUUID();
  return { version: 1, kind: 'file', transferId, protocol: 'ftps', direction: 'download', phase: 'retained', identity: 'a'.repeat(64), host: 'fixture', port: 21,
    createdAt: 1, updatedAt: 1, localPath: path.join(root, 'file'), remotePath: '/file', localParent: { parent: root, dev: 1, ino: 2 },
    source: { type: 'file', size: 3, hash: createHash('sha256').update('abc').digest('hex') }, destination: null,
    total: 3, bytes: 2, stageId, stagePath: path.join(root, `.termforge-${stageId}.part`), backupPath: null, stageStarted: true, stageIdentity: [1, 3] };
}
test('FTP checkpoint validation refuses path escapes, invalid lengths, and conflicting child ownership', async t => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'forgecrt-ftp-schema-'))); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const original = record(root); assert.deepEqual(validate(original), original);
  for (const patch of [{ version: 2 }, { bytes: 4 }, { stagePath: path.join(root, 'unrelated') }, { remotePath: '/a/../file' }, { localPath: root + '/../outside' }, { source: { type: 'file', size: 3, hash: 'invalid' } }]) assert.throws(() => validate({ ...original, ...patch }), /Invalid FTP recovery/);
  const folder = { ...original, kind: 'folder', localPath: path.join(root, 'tree'), remotePath: '/tree', localParent: { parent: root, dev: 1, ino: 2 }, mode: 'copy', conflictPolicy: 'skip',
    source: [{ relativePath: '', type: 'directory', size: 0 }, { relativePath: 'file', ...original.source }], destination: [], completed: [], created: [], artifacts: [], child: original };
  assert.throws(() => validate(folder), /Invalid FTP recovery/);
  folder.child = { ...original, localPath: path.join(root, 'tree', 'file'), remotePath: '/tree/file', localParent: { parent: path.join(root, 'tree'), dev: 1, ino: 2 }, stagePath: path.join(root, 'tree', `.termforge-${original.stageId}.part`), transferId: randomUUID() };
  assert.throws(() => validate(folder), /Invalid FTP recovery/);
});
test('FTP journal refuses symlinks, hard links, oversized and unknown-schema records before restoring jobs', async t => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'forgecrt-ftp-private-'))); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'ftp'), storage = createFtpRecovery(directory); const cp = record(root); await storage.save(cp);
  const filename = path.join(directory, `${cp.transferId}.json`), external = path.join(root, 'external'); const valid = await fsp.readFile(filename);
  await fsp.writeFile(external, valid, { mode: 0o600 }); await fsp.unlink(filename);
  if (process.platform !== 'win32') { await fsp.symlink(external, filename); await assert.rejects(storage.load(), /Invalid/); await fsp.unlink(filename); }
  await fsp.link(external, filename); await assert.rejects(storage.load(), /Invalid/); await fsp.unlink(filename);
  await fsp.writeFile(filename, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20), { mode: 0o600 }); await assert.rejects(storage.load(), /Invalid/);
  await fsp.writeFile(filename, JSON.stringify({ ...cp, version: 99 }), { mode: 0o600 }); await assert.rejects(storage.load(), /Invalid/);
});

test('a resumable FTP download refuses a same-content staging inode substituted after payload completion', async t => {
  const f = await fixture(t); const connection = await f.open(); await fsp.writeFile(path.join(f.remote, 'file'), 'private payload');
  const originalOpen = fsp.open; let replaced = false; let replacementPath;
  fsp.open = async function(filename, flags, ...args) {
    const handle = await originalOpen.call(this, filename, flags, ...args);
    if (typeof filename === 'string' && path.dirname(filename) === f.local && filename.endsWith('.part') && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (!replaced) { replaced = true; replacementPath = filename; const contents = await fsp.readFile(filename); await fsp.rename(filename, filename + '.original'); await fsp.writeFile(filename, contents, { mode: 0o644 }); }
      };
    }
    return handle;
  };
  try {
    const job = f.service.start({ id: connection.id, direction: 'download', localPath: path.join(f.local, 'file'), remotePath: '/file', resumable: true });
    const result = await settled(f, job.transferId); assert.equal(replaced, true); assert.equal(result.status, 'interrupted', result.error);
    await assert.rejects(fsp.stat(path.join(f.local, 'file')), { code: 'ENOENT' });
    assert.equal(await fsp.readFile(replacementPath, 'utf8'), 'private payload');
  } finally { fsp.open = originalOpen; }
});
