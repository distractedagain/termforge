'use strict';

// Only common, verified content belongs in a baseline. These records contain
// paths and digests, never credentials or file contents.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function relative(value) {
  return typeof value === 'string' && value.length <= 4096 && (value === '' || value.split('/').every(p => p && p !== '.' && p !== '..' && p.length <= 255 && !/[\\\x00-\x1f\x7f]/.test(p)));
}
function cleanPath(value, remote) {
  const api = remote ? path.posix : path;
  if (typeof value !== 'string' || !api.isAbsolute(value) || value.length > (remote ? 4096 : 32768)
    || /[\x00-\x1f\x7f]/.test(value) || (remote && value.includes('\\')) || value.split(/[\\/]/).some(p => p === '.' || p === '..')
    || api.normalize(value) !== value || value === api.parse(value).root) throw new Error('Invalid saved synchronization root.');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a synchronization pair name of 1–120 characters.');
  return value.trim();
}
function cleanRecord(record) {
  if (!record || !UUID.test(record.pairId) || !HASH.test(record.identity) || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !Number.isFinite(record.lastSyncedAt) || record.lastSyncedAt < 0 || !Array.isArray(record.entries) || record.entries.length > 2000) throw new Error('Invalid saved synchronization baseline.');
  const names = new Set();
  const entries = record.entries.map(item => {
    if (!item || !relative(item.relativePath) || !['directory', 'file'].includes(item.type) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 1024 ** 4
      || (item.type === 'file' ? !HASH.test(item.hash) : item.size !== 0 || item.hash !== undefined)) throw new Error('Invalid saved synchronization entry.');
    const key = item.relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (names.has(key)) throw new Error('Duplicate saved synchronization path.');
    names.add(key);
    return { relativePath: item.relativePath, type: item.type, size: item.size, ...(item.type === 'file' ? { hash: item.hash } : {}) };
  });
  // A skipped conflict can leave holes in the common baseline, intentionally.
  return { pairId: record.pairId, identity: record.identity, localPath: cleanPath(record.localPath, false), remotePath: cleanPath(record.remotePath, true),
    name: name(record.name), revision: record.revision, lastSyncedAt: record.lastSyncedAt, entries };
}
function binding(record) { return JSON.stringify([record.identity, record.localPath, record.remotePath]); }
function createSyncBaselines(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute synchronization storage directory is required.');
  const filename = path.join(directory, 'pairs.json'); const lockPath = path.join(directory, 'pairs.lock');
  const owns = info => process.platform === 'win32' || info.uid === process.getuid();
  async function ensure() {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fsp.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !owns(info) || await fsp.realpath(directory) !== directory) throw new Error('Synchronization storage must be a private directory without symbolic links.');
    if (process.platform !== 'win32') await fsp.chmod(directory, 0o700);
  }
  async function readJson(file, max = MAX_BYTES) {
    let handle;
    try {
      handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const info = await handle.stat(); const linked = await fsp.lstat(file);
      if (!info.isFile() || linked.isSymbolicLink() || info.ino !== linked.ino || info.dev !== linked.dev || !owns(info) || info.nlink !== 1 || info.size > max
        || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Unsafe synchronization storage file.');
      const buffer = Buffer.alloc(Math.min(max + 1, info.size + 1)); let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break; length += read.bytesRead;
      }
      const final = await handle.stat(); const current = await fsp.lstat(file);
      if (length !== info.size || final.size !== info.size || final.mtimeMs !== info.mtimeMs || final.ctimeMs !== info.ctimeMs
        || current.isSymbolicLink() || current.ino !== info.ino || current.dev !== info.dev) throw new Error('Synchronization storage changed while reading.');
      return JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } finally { await handle?.close(); }
  }
  async function load() {
    await ensure(); let value;
    try { value = await readJson(filename); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!value || value.version !== 1 || !Array.isArray(value.pairs) || value.pairs.length > 100) throw new Error('Unsupported or invalid synchronization baseline schema.');
    const records = value.pairs.map(cleanRecord); const ids = new Set(); const bindings = new Set();
    for (const record of records) {
      if (ids.has(record.pairId) || bindings.has(binding(record))) throw new Error('Duplicate synchronization pair.');
      ids.add(record.pairId); bindings.add(binding(record));
    }
    return records;
  }
  async function lease() {
    await ensure();
    // Exclusive file creation is atomic across processes. Never steal a lock:
    // check-then-unlink stale-lock recovery races a new owner on ordinary
    // filesystems. A crashed process therefore requires explicit inspection.
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = { version: 1, pid: process.pid, nonce: randomUUID() }; let handle;
      try {
        handle = await fsp.open(lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(token)); await handle.sync(); const owned = await handle.stat(); await handle.close(); handle = null;
        let released = false;
        async function assertOwned() {
          if (released) throw new Error('Synchronization storage lease was released.');
          const info = await fsp.lstat(lockPath);
          if (info.ino !== owned.ino || info.dev !== owned.dev || !same(token, await readJson(lockPath, 1024))) throw new Error('Synchronization storage lease changed.');
        }
        return { assertOwned, async release() { if (released) return; await assertOwned(); await fsp.unlink(lockPath); released = true; } };
      } catch (error) {
        await handle?.close();
        if (error.code !== 'EEXIST') throw error;
        const owner = await readJson(lockPath, 1024);
        if (owner?.version !== 1 || !Number.isInteger(owner.pid) || owner.pid < 1 || !UUID.test(owner.nonce)) throw new Error('Synchronization lock is incomplete. Inspect storage before retrying.');
        try { process.kill(owner.pid, 0); throw new Error('Another synchronization is using saved pairs. Wait for it to finish.'); }
        catch (alive) { if (alive.code !== 'ESRCH') throw alive; }
        throw new Error('A previous synchronization process stopped while holding storage. Inspect both trees and the saved baseline before removing the stale pairs.lock and retrying.');
      }
    }
    throw new Error('Synchronization storage is busy.');
  }
  async function save(records, held) {
    await held.assertOwned();
    const value = JSON.stringify({ version: 1, pairs: records.map(cleanRecord) });
    if (Buffer.byteLength(value) > MAX_BYTES || records.length > 100) throw new Error('Synchronization storage limit exceeded.');
    const temporary = path.join(directory, `.pairs-${randomUUID()}.tmp`); let handle;
    try {
      handle = await fsp.open(temporary, 'wx', 0o600); await handle.writeFile(value); await handle.sync(); await handle.close(); handle = null;
      await held.assertOwned(); await fsp.rename(temporary, filename);
      // Flush the containing directory where the platform supports it.
      if (process.platform !== 'win32') { const parent = await fsp.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
    } finally { await handle?.close(); await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  function expect(records, reference) {
    const existing = records.find(record => record.pairId === reference.pairId);
    if (reference.revision === 0 ? Boolean(existing) || records.some(record => binding(record) === binding(reference))
      : !existing || existing.revision !== reference.revision || binding(existing) !== binding(reference)) throw new Error('The saved synchronization baseline changed. Review the pair again.');
    return existing;
  }
  async function begin(reference) {
    const held = await lease();
    try { expect(await load(), reference); }
    catch (error) { await held.release(); throw error; }
    return { release: held.release, async commit(entries) {
      await held.assertOwned(); const records = await load(); expect(records, reference);
      const updated = cleanRecord({ ...reference, entries, revision: reference.revision + 1, lastSyncedAt: Date.now() });
      await save([...records.filter(record => record.pairId !== reference.pairId), updated], held); return updated;
    } };
  }
  async function forget(reference) {
    const held = await lease();
    try { const records = await load(); expect(records, reference); await save(records.filter(record => record.pairId !== reference.pairId), held); return true; }
    finally { await held.release(); }
  }
  return { load, begin, forget };
}
module.exports = { createSyncBaselines, cleanRecord, binding, cleanName: name };
