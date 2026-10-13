'use strict';
// A private, bounded, credential-free journal. Payloads are never deleted here.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMIT = 4 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
function fail() { throw new Error('Invalid FTP recovery record. Inspect retained files before forgetting this checkpoint.'); }
function absolute(value, remote) { if (typeof value !== 'string' || value.length > (remote ? 4096 : 32768) || !(remote ? path.posix : path).isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.split(/[\\/]/).some(p => p === '.' || p === '..') || remote && /\\|\/\//.test(value)) fail(); return value; }
function relative(value) { if (typeof value !== 'string' || value.length > 4096 || value && value.split('/').some(p => !p || p === '.' || p === '..' || p.length > 255 || /[\\\x00-\x1f\x7f]/.test(p))) fail(); return value; }
function integer(value, max = 1024 ** 4) { if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(); return value; }
function fingerprint(value) { if (value === null) return null; if (!value || !['file','directory'].includes(value.type)) fail(); const out = {type:value.type, size:integer(value.size)}; if (value.type === 'file') { if (!HASH.test(value.hash)) fail(); out.hash = value.hash; } if (value.localIdentity !== undefined) { if (!Array.isArray(value.localIdentity) || value.localIdentity.length !== 2 || !value.localIdentity.every(Number.isInteger)) fail(); out.localIdentity = value.localIdentity.slice(); } return out; }
function inventory(value) { if (!Array.isArray(value) || value.length > 2000) fail(); const seen = new Set(); return value.map(item => { const key = relative(item.relativePath); if (seen.has(key)) fail(); seen.add(key); return {relativePath:key,...fingerprint(item)}; }); }
function validate(record, child = false) {
  if (!record || record.version !== 1 || !UUID.test(record.transferId) || !['file','folder'].includes(record.kind) || child && record.kind !== 'file' || !['ftp','ftps','ftps-implicit'].includes(record.protocol) || !['upload','download'].includes(record.direction) || !['retained','committing','indeterminate'].includes(record.phase) || !HASH.test(record.identity) || typeof record.host !== 'string' || !record.host || record.host.length > 253 || /[\s/@\\\x00-\x1f\x7f]/.test(record.host) || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) fail();
  const out = Object.fromEntries(['version','kind','transferId','protocol','direction','phase','identity','host','port','createdAt','updatedAt'].map(k => [k,record[k]]));
  out.localPath = absolute(record.localPath, false); out.remotePath = absolute(record.remotePath, true);
  if (out.remotePath === '/') fail();
  if (!record.localParent || !Number.isInteger(record.localParent.dev) || !Number.isInteger(record.localParent.ino) || absolute(record.localParent.parent,false) !== path.dirname(out.localPath)) fail();
  out.localParent = {parent:record.localParent.parent,dev:record.localParent.dev,ino:record.localParent.ino};
  if (out.kind === 'file') {
    out.source = fingerprint(record.source); out.destination = fingerprint(record.destination);
    if (out.source?.type !== 'file' || out.destination && out.destination.type !== 'file' || !UUID.test(record.stageId)) fail();
    out.total = integer(record.total); out.bytes = integer(record.bytes, out.total); if (out.total !== out.source.size) fail();
    out.stageId = record.stageId; out.stagePath = absolute(record.stagePath,out.direction === 'upload');
    const api = out.direction === 'upload' ? path.posix : path;
    const parent = api.dirname(out.direction === 'upload' ? out.remotePath : out.localPath);
    if (out.stagePath !== api.join(parent,`.termforge-${out.stageId}.part`)) fail();
    if (record.backupPath !== null && (typeof record.backupPath !== 'string' || !/^\.termforge-[a-f0-9-]{36}\.backup$/.test(api.basename(record.backupPath)) || api.dirname(record.backupPath) !== parent)) fail();
    out.backupPath = record.backupPath; if (typeof record.stageStarted !== 'boolean') fail(); out.stageStarted = record.stageStarted;
    out.stageIdentity = record.stageIdentity === null ? null : fingerprint({type:'directory',size:0,localIdentity:record.stageIdentity}).localIdentity;
    if (record.stageIdentity !== null && !out.stageIdentity) fail();
  } else {
    if (!['copy','merge'].includes(record.mode) || !['skip','replace'].includes(record.conflictPolicy)) fail();
    out.mode = record.mode; out.conflictPolicy = record.conflictPolicy;
    out.source = inventory(record.source); out.destination = inventory(record.destination);
    if (!out.source.length || out.source[0].relativePath !== '' || out.source[0].type !== 'directory') fail();
    out.completed = inventory(record.completed); out.created = inventory(record.created);
    const src = new Map(out.source.map(item => [item.relativePath,item]));
    for (const item of out.completed) if (item.type !== 'file' || !src.has(item.relativePath) || src.get(item.relativePath).hash !== item.hash || src.get(item.relativePath).size !== item.size) fail();
    for (const item of out.created) if (item.type !== 'directory' || src.get(item.relativePath)?.type !== 'directory') fail();
    if (!Array.isArray(record.artifacts) || record.artifacts.length > 2000) fail();
    out.artifacts = record.artifacts.map(item => { const relativePath = relative(item.relativePath); if (!/^\.termforge-[a-f0-9-]{36}\.backup$/.test(path.posix.basename(relativePath))) fail(); return {relativePath,...fingerprint(item)}; });
    out.child = record.child ? validate(record.child,true) : null;
    if (out.child) { const cp = out.child; const entry = out.source.find(item => item.type === 'file' && path.join(out.localPath,...item.relativePath.split('/')) === cp.localPath && path.posix.join(out.remotePath,item.relativePath) === cp.remotePath); if (!entry || cp.transferId !== out.transferId || cp.identity !== out.identity || cp.protocol !== out.protocol || cp.direction !== out.direction || cp.source.hash !== entry.hash || out.completed.some(item => item.relativePath === entry.relativePath)) fail(); }
  }
  return out;
}
function createFtpRecovery(directory) {
  if (!path.isAbsolute(directory)) throw new Error('FTP recovery needs an absolute private directory.');
  let tail = Promise.resolve();
  function serialize(fn) { const promise = tail.then(fn); tail = promise.catch(() => {}); return promise; }
  async function ensure() { await fsp.mkdir(directory,{recursive:true,mode:0o700}); const stat = await fsp.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(directory) !== path.resolve(directory)) throw new Error('FTP recovery directory cannot contain symbolic links.'); if (process.platform !== 'win32') { if (stat.uid !== process.getuid()) throw new Error('FTP recovery directory has another owner.'); await fsp.chmod(directory,0o700); } }
  async function syncParent() { if (process.platform !== 'win32') { const h = await fsp.open(directory,fs.constants.O_RDONLY | NOFOLLOW); try { await h.sync(); } finally { await h.close(); } } }
  async function load() { await ensure(); const names = (await fsp.readdir(directory)).filter(n => n.endsWith('.json')); if (names.length > 100) throw new Error('Too many FTP recovery records.'); const out = []; for (const name of names) { if (!UUID.test(name.slice(0,-5))) fail(); const filename = path.join(directory,name), stat = await fsp.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMIT || process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077)) fail(); const h = await fsp.open(filename,fs.constants.O_RDONLY | NOFOLLOW); try { const opened = await h.stat(); if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail(); const buffer = Buffer.alloc(LIMIT + 1); let size = 0; while (size < buffer.length) { const r = await h.read(buffer,size,buffer.length-size,null); if (!r.bytesRead) break; size += r.bytesRead; } if (size > LIMIT) fail(); const record = validate(JSON.parse(buffer.subarray(0,size).toString('utf8'))); if (`${record.transferId}.json` !== name) fail(); out.push(record); } finally { await h.close(); } } return out; }
  function save(record) { const data = JSON.stringify(validate(record)); if (Buffer.byteLength(data) > LIMIT) throw new Error('FTP recovery record exceeds 4 MiB.'); return serialize(async () => { await ensure(); const temp = path.join(directory,`.${randomUUID()}.tmp`); const h = await fsp.open(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|NOFOLLOW,0o600); try { await h.writeFile(data); await h.sync(); } finally { await h.close(); } try { await fsp.rename(temp,path.join(directory,`${record.transferId}.json`)); await syncParent(); } finally { await fsp.unlink(temp).catch(()=>{}); } }); }
  function remove(id) { if (!UUID.test(id)) fail(); return serialize(async()=>{ await ensure(); await fsp.unlink(path.join(directory,`${id}.json`)); await syncParent(); }); }
  return {load,save,remove};
}
module.exports = {createFtpRecovery,validate};
