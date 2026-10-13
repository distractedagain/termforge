'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSyncBaselines } = require('../app/sync-baselines.cjs');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'forgecrt-baseline-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'sync'); const store = createSyncBaselines(directory);
  const reference = { pairId: randomUUID(), identity: 'a'.repeat(64), name: 'Fixtures', localPath: path.join(root, 'local'), remotePath: '/remote', revision: 0, lastSyncedAt: null, entries: [] };
  return { root, directory, store, reference };
}
const entries = [{ relativePath: '', type: 'directory', size: 0 }, { relativePath: 'file', type: 'file', size: 3, hash: 'b'.repeat(64) }];
test('new and existing v1 profiles round trip without credentials; commit advances revision atomically', async t => {
  const f = await fixture(t); assert.deepEqual(await f.store.load(), []);
  const held = await f.store.begin({ ...f.reference, password: 'must-not-persist' });
  const saved = await held.commit(entries); await held.release();
  assert.equal(saved.revision, 1); assert.ok(saved.lastSyncedAt > 0);
  const reopened = createSyncBaselines(f.directory); assert.deepEqual(await reopened.load(), [saved]);
  assert.ok(!(await fs.readFile(path.join(f.directory, 'pairs.json'), 'utf8')).includes('must-not-persist'));
  const next = await reopened.begin(saved); const second = await next.commit(entries); await next.release(); assert.equal(second.revision, 2);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(f.directory, 'pairs.json'))).mode & 0o777, 0o600);
  }
});
test('separate store instances cannot overlap mutations or lose a reviewed generation', async t => {
  const f = await fixture(t), other = createSyncBaselines(f.directory);
  const first = await f.store.begin(f.reference);
  await assert.rejects(other.begin(f.reference), /Another synchronization/);
  const saved = await first.commit(entries); await first.release();
  await assert.rejects(other.begin(f.reference), /baseline changed/);
  const second = await other.begin(saved); await second.commit(entries); await second.release();
  await assert.rejects(f.store.forget(saved), /baseline changed/);
  assert.equal((await f.store.load())[0].revision, 2);
});
test('same folder binding cannot be saved twice under another pair ID', async t => {
  const f = await fixture(t); const held = await f.store.begin(f.reference); await held.commit(entries); await held.release();
  await assert.rejects(f.store.begin({ ...f.reference, pairId: randomUUID() }), /baseline changed/);
});
test('forget uses identity, roots and revision then preserves unrelated pairs', async t => {
  const f = await fixture(t); let held = await f.store.begin(f.reference); const saved = await held.commit(entries); await held.release();
  const second = { ...f.reference, pairId: randomUUID(), remotePath: '/other' };
  held = await f.store.begin(second); const other = await held.commit(entries); await held.release();
  await assert.rejects(f.store.forget({ ...saved, identity: 'c'.repeat(64) }), /baseline changed/);
  await f.store.forget(saved); assert.deepEqual(await f.store.load(), [other]);
});
test('invalid entries cannot replace a previously valid baseline', async t => {
  const f = await fixture(t); let held = await f.store.begin(f.reference); const saved = await held.commit(entries); await held.release();
  for (const invalid of [
    [{ relativePath: '../escape', type: 'file', size: 1, hash: 'b'.repeat(64) }],
    [{ relativePath: 'x\\y', type: 'file', size: 1, hash: 'b'.repeat(64) }],
    [{ relativePath: 'x', type: 'file', size: 1, hash: 'invalid' }],
    [{ relativePath: 'x', type: 'directory', size: 1 }],
    [{ relativePath: 'X', type: 'directory', size: 0 }, { relativePath: 'x', type: 'directory', size: 0 }],
  ]) {
    held = await f.store.begin(saved); await assert.rejects(held.commit(invalid), /Invalid|Duplicate/); await held.release();
    assert.deepEqual(await f.store.load(), [saved]);
  }
});
test('unknown schema versions and malformed persisted metadata fail closed without migration guesses', async t => {
  const f = await fixture(t); await f.store.load();
  const filename = path.join(f.directory, 'pairs.json');
  for (const record of [{ version: 2, pairs: [] }, { version: 1, pairs: [{ ...f.reference, revision: 1, lastSyncedAt: 1, localPath: path.join(f.root, 'a', '..', 'b') + '/..', entries }] }, { version: 1, pairs: [{ ...f.reference, revision: 1, lastSyncedAt: 1, remotePath: '/a/../b', entries }] }]) {
    await fs.writeFile(filename, JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(f.store.load(), /Unsupported|Invalid/);
  }
  await fs.writeFile(filename, '{broken', { mode: 0o600 }); await assert.rejects(f.store.load(), SyntaxError);
});
test('baseline files reject symlinks, hardlinks and nonprivate permissions', async t => {
  const f = await fixture(t); await f.store.load(); const outside = path.join(f.root, 'outside.json'); const filename = path.join(f.directory, 'pairs.json');
  await fs.writeFile(outside, JSON.stringify({ version: 1, pairs: [] }), { mode: 0o600 });
  if (process.platform !== 'win32') { await fs.symlink(outside, filename); await assert.rejects(f.store.load()); await fs.unlink(filename); }
  await fs.link(outside, filename); await assert.rejects(f.store.load(), /Unsafe/); await fs.unlink(filename);
  if (process.platform !== 'win32') { await fs.writeFile(filename, '{}', { mode: 0o644 }); await assert.rejects(f.store.load(), /Unsafe/); }
});
test('an incomplete or dead-owner lease is not silently stolen', async t => {
  const f = await fixture(t); await f.store.load(); const filename = path.join(f.directory, 'pairs.lock');
  await fs.writeFile(filename, '{}', { mode: 0o600 }); await assert.rejects(f.store.begin(f.reference), /incomplete/);
  await fs.writeFile(filename, JSON.stringify({ version: 1, pid: 2147483647, nonce: randomUUID() }), { mode: 0o600 });
  await assert.rejects(f.store.begin(f.reference), /previous synchronization|operation not permitted/i);
  assert.ok(await fs.stat(filename));
});
