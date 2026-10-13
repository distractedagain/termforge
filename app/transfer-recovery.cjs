'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_RECORDS = 100;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function cleanSnapshot(value) {
  // Node's numeric Stats can expose Windows filesystem IDs above 2^53.
  // Treat ino/dev as opaque integer identity values, matching the planner;
  // sizes and counts remain safe integers because transfer arithmetic uses them.
  if (value === null) return null;
  if (!value || !['file', 'directory'].includes(value.type) || !Number.isSafeInteger(value.size) || value.size < 0
    || !Number.isFinite(value.mtime) || !Number.isSafeInteger(value.mode)
    || ['uid','gid'].some(key=>value[key]!==undefined&&!Number.isSafeInteger(value[key]))
    || ['ino','dev'].some(key=>value[key]!==undefined&&!Number.isInteger(value[key]))
    || (value.ctime!==undefined&&!Number.isFinite(value.ctime)) || (value.permissions!==undefined&&!/^[0-7]{3}$/.test(value.permissions))) throw new Error('Invalid folder recovery metadata.');
  return Object.fromEntries(['type','size','mtime','mode','permissions','uid','gid','ino','dev','ctime'].filter(key => value[key] !== undefined).map(key => [key,value[key]]));
}
function cleanEntries(values) {
  if (!Array.isArray(values) || values.length > 2000) throw new Error('Invalid folder recovery inventory.');
  const names = new Set();
  return values.map(item => {
    if (!item || typeof item.relativePath !== 'string' || item.relativePath.length > 4096
      || (item.relativePath && item.relativePath.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part)))
      || names.has(item.relativePath) || !['file','directory'].includes(item.type) || !Number.isSafeInteger(item.size) || item.size < 0
      || (item.hash !== undefined && !/^[a-f0-9]{64}$/.test(item.hash))
      || (item.destinationHash !== undefined && !/^[a-f0-9]{64}$/.test(item.destinationHash))) throw new Error('Invalid folder recovery entry.');
    names.add(item.relativePath);
    if (item.action !== undefined && !['copy','replace','mkdir','skip'].includes(item.action)) throw new Error('Invalid folder recovery action.');
    const result = Object.fromEntries(['relativePath','type','size','hash','destinationHash','action'].filter(key => item[key] !== undefined).map(key=>[key,item[key]]));
    result.expected = cleanSnapshot(item.expected);
    if (item.destinationExpected !== undefined) result.destinationExpected = cleanSnapshot(item.destinationExpected);
    return result;
  });
}
function validateFolder(record) {
  if (record.version !== 2 || record.kind !== 'folder' || !UUID.test(record.transferId) || !['upload','download'].includes(record.direction)
    || !['retained','committing','indeterminate'].includes(record.phase) || !/^[a-f0-9]{64}$/.test(record.identity)
    || typeof record.host !== 'string' || !record.host || record.host.length > 253 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
    || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
    || !['copy','merge','sync'].includes(record.mode) || !['skip','replace'].includes(record.conflictPolicy)) throw new Error('Invalid folder recovery record.');
  for (const [key, api] of [['localPath', path], ['remotePath', path.posix]]) {
    const value=record[key];
    if (typeof value !== 'string' || !api.isAbsolute(value) || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)
      || value.split(/[\\/]/).some(part=>part==='.'||part==='..') || (key==='remotePath' && value.includes('\\'))) throw new Error('Invalid folder recovery path.');
  }
  const expected = record.expected;
  if (!expected || !Number.isSafeInteger(expected.totalBytes) || expected.totalBytes < 0 || expected.totalBytes > 1024 ** 4) throw new Error('Invalid folder recovery totals.');
  const entries=cleanEntries(expected.entries), destination=cleanEntries(expected.destination);
  if (!entries.length || entries[0].relativePath !== '' || entries[0].type !== 'directory' || entries.some(entry=>entry.type==='file'&&!entry.hash)) throw new Error('Incomplete folder recovery source fingerprints.');
  const completed=cleanEntries(record.completed), created=cleanEntries(record.created);
  if (!Array.isArray(expected.sourceParents) || !Array.isArray(expected.destinationParents)) throw new Error('Invalid folder recovery parents.');
  const parents=values=>values.map(item=>{
    if (!item || typeof item.path !== 'string' || item.type !== 'directory') throw new Error('Invalid folder recovery parent.');
    return Object.fromEntries(['path','type','mode','uid','gid','ino','dev'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
  });
  const cleanExpected={ entries,destination,sourceParents:parents(expected.sourceParents),destinationParents:parents(expected.destinationParents) };
  for(const key of ['files','directories','totalBytes','copied','replaced','skipped','kept','sourceFiles','sourceDirectories']) {
    if(!Number.isSafeInteger(expected[key])||expected[key]<0) throw new Error('Invalid folder recovery totals.');
    cleanExpected[key]=expected[key];
  }
  const byName=new Map(entries.map(item=>[item.relativePath,item]));
  for(const item of completed) { const source=byName.get(item.relativePath);if(!source||!['copy','replace'].includes(source.action)||item.type!=='file'||item.hash!==source.hash||item.size!==source.size)throw new Error('Invalid completed folder child.'); }
  for(const item of created) { const source=byName.get(item.relativePath);if(!source||source.action!=='mkdir'||item.type!=='directory')throw new Error('Invalid created folder.'); }
  const selected=entries.filter(item=>['copy','replace'].includes(item.action));
  if(selected.length!==expected.files || selected.reduce((n,item)=>n+item.size,0)!==expected.totalBytes || entries.filter(item=>item.action==='mkdir').length!==expected.directories)throw new Error('Inconsistent folder recovery totals.');
  const child=record.child ? validate(record.child) : null;
  if(child && (child.kind==='folder' || child.transferId !== record.transferId || child.identity !== record.identity)) throw new Error('Invalid folder child recovery record.');
  if(child) {
    const source=selected.find(item=>path.join(record.localPath,...item.relativePath.split('/'))===child.localPath&&path.posix.join(record.remotePath,item.relativePath)===child.remotePath);
    if(!source||child.direction!==record.direction||child.sourceHash!==source.hash||child.total!==source.size||completed.some(item=>item.relativePath===source.relativePath))throw new Error('Folder child is outside the reviewed operation.');
  }
  return {version:2,kind:'folder',transferId:record.transferId,direction:record.direction,phase:record.phase,identity:record.identity,
    host:record.host,port:record.port,localPath:record.localPath,remotePath:record.remotePath,mode:record.mode,conflictPolicy:record.conflictPolicy,
    expected:cleanExpected,completed,created,child,createdAt:record.createdAt,updatedAt:record.updatedAt};
}
function validate(record) {
  if (record?.kind === 'folder') return validateFolder(record);
  if (!record || (record.protocol !== undefined && !['sftp','scp'].includes(record.protocol)) || record.version !== 1 || !UUID.test(record.transferId) || !UUID.test(record.stageId)
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
  return Object.fromEntries(['version', 'protocol', 'transferId', 'stageId', 'direction', 'phase', 'identity', 'host', 'port',
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
    return serialize(async () => { await ensure(); await fsp.unlink(path.join(directory, `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; }); if(process.platform!=='win32'){const parent=await fsp.open(directory,fs.constants.O_RDONLY|NOFOLLOW);try{await parent.sync();}finally{await parent.close();}} });
  }
  return { load, save, remove };
}

module.exports = { createTransferRecovery };
