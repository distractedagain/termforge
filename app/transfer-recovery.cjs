'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RECORD = 128 * 1024;
const MAX_RECORDS = 100;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function validate(record) {
  if (!record || record.version !== 1 || !UUID.test(record.transferId) || !UUID.test(record.stageId)
    || !['upload', 'download'].includes(record.direction) || !['retained', 'committing', 'indeterminate'].includes(record.phase)
    || !/^[a-f0-9]{64}$/.test(record.identity) || !/^[a-f0-9]{64}$/.test(record.sourceHash) || !/^[a-f0-9]{64}$/.test(record.prefixHash)
    || !Number.isSafeInteger(record.total) || record.total < 0 || record.total > 1024 ** 4
    || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > record.total
    || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
    || typeof record.host !== 'string' || !record.host || record.host.length > 253
    || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw new Error('Invalid transfer recovery record.');
  for (const [key, remote] of [['localPath', false], ['remotePath', true], ['stagePath', record.direction === 'upload']]) {
    const value = record[key], api = remote ? path.posix : path;
    if (typeof value !== 'string' || !api.isAbsolute(value) || value.length > (remote ? 4096 : 32768)
      || /[\x00-\x1f\x7f]/.test(value) || (remote && value.includes('\\'))) throw new Error('Invalid recovery path.');
  }
  if (!record.sourceSnapshot || record.sourceSnapshot.type !== 'file' || record.sourceSnapshot.size !== record.total
    || !Array.isArray(record.sourceParents) || !record.sourceParents.length || record.sourceParents.length > 256
    || !Array.isArray(record.destinationParents) || !record.destinationParents.length || record.destinationParents.length > 256) throw new Error('Invalid recovery identities.');
  for (const item of [...record.sourceParents, ...record.destinationParents]) {
    if (!item || typeof item.path !== 'string' || !item.path || item.path.length > 32768 || item.type !== 'directory') throw new Error('Invalid recovery directory.');
  }
  const api = record.direction === 'upload' ? path.posix : path;
  const parent = record.destinationParents.at(-1).path;
  if (record.stagePath !== api.join(parent, `.termforge-${record.stageId}.part`)) throw new Error('Recovery staging path does not match its destination.');
  // Explicit schema: do not accidentally journal profiles or credentials later.
  return Object.fromEntries(['version', 'transferId', 'stageId', 'direction', 'phase', 'identity', 'host', 'port',
    'localPath', 'remotePath', 'stagePath', 'sourceSnapshot', 'destinationSnapshot', 'sourceParents',
    'destinationParents', 'stageIdentity', 'sourceHash', 'prefixHash', 'total', 'bytes', 'createdAt', 'updatedAt'].map(key => [key, record[key]]));
}

function createTransferRecovery(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute transfer recovery directory is required.');
  let serial = Promise.resolve();
  const serialize = fn => { const result = serial.then(fn); serial = result.catch(() => {}); return result; };
  async function ensure() {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Transfer recovery directory must not be a symbolic link.');
    if (process.platform !== 'win32') { if (stat.uid !== process.getuid()) throw new Error('Transfer recovery directory has a different owner.'); await fsp.chmod(directory, 0o700); }
  }
  async function load() {
    await ensure(); const names = (await fsp.readdir(directory)).filter(name => name.endsWith('.json'));
    if (names.length > MAX_RECORDS) throw new Error('Too many retained transfer recovery records.');
    const records = [];
    for (const name of names) {
      if (!UUID.test(name.slice(0, -5))) throw new Error('Unexpected transfer recovery record filename.');
      const filename = path.join(directory, name); const before = await fsp.lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD || (process.platform !== 'win32' && (before.uid !== process.getuid() || (before.mode & 0o077)))) throw new Error('Transfer recovery record is not a private bounded file.');
      const handle = await fsp.open(filename, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        const stat = await handle.stat(); if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('Transfer recovery record changed while opening.');
        const buffer = Buffer.alloc(MAX_RECORD + 1); let length = 0;
        while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
        if (length > MAX_RECORD) throw new Error('Transfer recovery record is too large.');
        const record = validate(JSON.parse(buffer.subarray(0, length).toString('utf8')));
        if (`${record.transferId}.json` !== name) throw new Error('Transfer recovery record identity mismatch.');
        records.push(record);
      } finally { await handle.close(); }
    }
    return records;
  }
  async function save(record) {
    const data = JSON.stringify(validate(record));
    if (Buffer.byteLength(data) > MAX_RECORD) throw new Error('Transfer recovery record is too large.');
    return serialize(async () => {
      await ensure(); const filename = path.join(directory, `${record.transferId}.json`);
      const temp = path.join(directory, `.${randomUUID()}.tmp`);
      const handle = await fsp.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      try {
        await fsp.rename(temp, filename);
        if (process.platform !== 'win32') {
          const parent = await fsp.open(directory, fs.constants.O_RDONLY | NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
        }
      } finally { await fsp.unlink(temp).catch(() => {}); }
    });
  }
  async function remove(id) {
    if (!UUID.test(id)) throw new Error('Invalid recovery transfer identity.');
    return serialize(async () => { await ensure(); await fsp.unlink(path.join(directory, `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; }); });
  }
  return { load, save, remove };
}

module.exports = { createTransferRecovery };
