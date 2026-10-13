'use strict';

const path = require('node:path').posix;
const { randomUUID, createHash } = require('node:crypto');
const MAX_TEXT = 1024 * 1024;
const BLOCK = 65536;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const abortError = () => Object.assign(new Error('Remote editor operation cancelled.'), { name: 'AbortError' });
function check(signal) { if (signal.aborted) throw abortError(); }
function filename(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(part => part === '.' || part === '..') || value.endsWith('/')) throw new Error('Choose an absolute remote file path without dot segments or control characters.');
  return path.normalize(value);
}
function metadata(stat) {
  if (!stat || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Remote editing requires regular files and directories without symbolic links.');
  if (![stat.size, stat.mode, stat.uid, stat.gid, stat.mtime].every(Number.isSafeInteger) || stat.size < 0) throw new Error('Complete remote file metadata is required.');
  return { type: stat.isFile() ? 'file' : 'directory', size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid, mtime: stat.mtime * 1000 };
}
function textBytes(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT || text.includes('\0')) throw new Error('Remote editing supports UTF-8 text up to 1 MiB without NUL characters.');
  const data = Buffer.from(text, 'utf8');
  if (data.length > MAX_TEXT || data.toString('utf8') !== text) throw new Error('Remote editing requires valid UTF-8 text up to 1 MiB.');
  return data;
}

// Remote documents are bounded in-memory buffers, never executable local projects.
// Save plans carry the original revision and are consumed exactly once.
function createRemoteEditor({ getSession, assertAvailable, call: invoke, remoteStat, commitRemote,
  confirm = async () => false, timeout = 30000, planLifetimeMs = 300000 }) {
  if (!Number.isInteger(planLifetimeMs) || planLifetimeMs < 1 || planLifetimeMs > 300000) throw new TypeError('Invalid remote save review lifetime.');
  const call = (sftp, method, args, signal, limit = timeout) => invoke(sftp, method, args, signal, limit);
  const documents = new Map(); let pending = null; let operation = null; let stopping = false;
  function available() {
    if (stopping) throw new Error('Remote editor is closing.');
    if (operation || pending) throw new Error('Finish or discard the remote save review first.');
    assertAvailable();
  }
  async function run(id, fn) {
    if (operation) throw new Error('A remote editor operation is already active.');
    const session = getSession(id); const controller = new AbortController(); let done;
    const owner = { id, controller, done: new Promise(resolve => { done = resolve; }), commitStarted: false };
    operation = owner;
    try { return await fn(session, owner); } finally { owner.controller.abort(); if (operation === owner) operation = null; done(); }
  }
  async function parents(session, target, signal) {
    const entries = []; let cursor = '/';
    for (const component of ['', ...path.dirname(target).split('/').filter(Boolean)]) {
      if (component) cursor = path.join(cursor, component);
      const stat = metadata(await remoteStat(session.sftp, cursor, signal));
      if (stat.type !== 'directory') throw new Error('Remote file ancestors must be directories.');
      const { size, mtime, ...identity } = stat; entries.push({ path: cursor, ...identity });
    }
    if (await call(session.sftp, 'realpath', [path.dirname(target)], signal) !== path.dirname(target)) throw new Error('Remote file ancestry changed or contains a symbolic link.');
    return entries;
  }
  async function read(session, target, signal) {
    const ancestry = await parents(session, target, signal);
    const before = metadata(await remoteStat(session.sftp, target, signal));
    if (before.type !== 'file' || before.size > MAX_TEXT) throw new Error('Remote editing supports regular UTF-8 files up to 1 MiB.');
    let handle; const data = Buffer.alloc(before.size);
    try {
      handle = await call(session.sftp, 'open', [target, 'r'], signal);
      if (!equal(before, metadata(await call(session.sftp, 'fstat', [handle], signal)))) throw new Error('Remote file changed while opening.');
      for (let offset = 0; offset < data.length;) {
        const count = await call(session.sftp, 'read', [handle, data, offset, Math.min(BLOCK, data.length - offset), offset], signal);
        if (!Number.isInteger(count) || count < 1 || count > Math.min(BLOCK, data.length - offset)) throw new Error('Remote file changed while reading.'); offset += count;
      }
      if (!equal(before, metadata(await call(session.sftp, 'fstat', [handle], signal)))
        || !equal(before, metadata(await remoteStat(session.sftp, target, signal)))
        || !equal(ancestry, await parents(session, target, signal))) throw new Error('Remote file changed while reading.');
    } finally { if (handle) await call(session.sftp, 'close', [handle], undefined, timeout).catch(() => {}); }
    check(signal);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new Error('Remote file is not valid UTF-8 text.'); }
    textBytes(text);
    return { text, revision: digest(data), metadata: before, ancestry };
  }
  function document(id) { const value = documents.get(id); if (!value) throw new Error('Remote document is closed.'); return value; }
  function view(doc) { return { documentId: doc.documentId, text: doc.text, revision: doc.revision, host: doc.host, port: doc.port, path: doc.path }; }
  function forgetPlan() { if (pending) clearTimeout(pending.timer); pending = null; }
  async function open({ id, path: target } = {}) {
    available(); if (documents.size >= 8) throw new Error('Close a remote document before opening another (limit 8).');
    target = filename(target);
    return run(id, async (session, owner) => {
      const loaded = await read(session, target, owner.controller.signal);
      const doc = { ...loaded, id, session, documentId: randomUUID(), host: session.host, port: session.port, path: target };
      documents.set(doc.documentId, doc); return view(doc);
    });
  }
  async function fresh(doc, session, signal) {
    if (session !== doc.session) throw new Error('Remote document connection changed. Reopen the file before saving.');
    const latest = await read(session, doc.path, signal);
    if (latest.revision !== doc.revision || !equal(latest.metadata, doc.metadata) || !equal(latest.ancestry, doc.ancestry)) throw new Error('Remote file changed on the server. Your edits were not saved; keep your buffer and compare with a freshly opened file.');
  }
  async function prepareSave({ documentId, text, revision } = {}) {
    available(); const doc = document(documentId); textBytes(text);
    if (doc.metadata.mode & 0o7000) throw new Error('Remote editing refuses files with special permission bits.');
    if (revision !== doc.revision) throw new Error('The remote document revision changed. Review the current buffer again.');
    return run(doc.id, async (session, owner) => {
      await fresh(doc, session, owner.controller.signal);
      const plan = { planId: randomUUID(), doc, text, before: doc.text, after: text, host: doc.host, port: doc.port, path: doc.path, expiresAt: Date.now() + planLifetimeMs };
      plan.timer = setTimeout(() => { if (pending === plan) forgetPlan(); }, planLifetimeMs); plan.timer.unref?.(); pending = plan;
      return { planId: plan.planId, before: plan.before, after: text, host: doc.host, port: doc.port, path: doc.path, expiresAt: plan.expiresAt };
    });
  }
  function approval(plan, owner) {
    const signal = owner.controller.signal;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value === true); };
      const abort = () => finish(abortError());
      const timer = setTimeout(() => { finish(new Error('Remote save review expired.')); owner.controller.abort(); }, Math.max(1, plan.expiresAt - Date.now()));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { check(signal); return confirm({ host: plan.host, port: plan.port, path: plan.path, bytes: Buffer.byteLength(plan.text), previousBytes: Buffer.byteLength(plan.before) }, { signal }); }).then(value => finish(null, value), error => finish(error));
    });
  }
  function checkReview(plan, owner) {
    check(owner.controller.signal);
    if (Date.now() >= plan.expiresAt) throw new Error('Remote save review expired. Review the buffer again.');
  }
  async function save({ planId } = {}) {
    const plan = pending;
    if (!plan || plan.planId !== planId || Date.now() >= plan.expiresAt) throw new Error('Remote save review is missing, expired or already used.');
    forgetPlan(); const doc = document(plan.doc.documentId);
    return run(doc.id, async (session, owner) => {
      if (!await approval(plan, owner)) return { cancelled: true };
      checkReview(plan, owner); await fresh(doc, session, owner.controller.signal); checkReview(plan, owner);
      const data = textBytes(plan.text); const stage = path.join(path.dirname(doc.path), `.termforge-${randomUUID()}.part`);
      let handle; let attempted = false; let committed = false;
      try {
        attempted = true;
        handle = await call(session.sftp, 'open', [stage, 'wx+', { mode: 0o600 }], owner.controller.signal);
        for (let offset = 0; offset < data.length; offset += BLOCK) await call(session.sftp, 'write', [handle, data, offset, Math.min(BLOCK, data.length - offset), offset], owner.controller.signal);
        // Read back the same owned handle before commit; success acknowledgments
        // alone cannot prove that a server stored the intended bytes.
        const verified = Buffer.alloc(data.length);
        for (let offset = 0; offset < verified.length;) {
          checkReview(plan, owner);
          const length = Math.min(BLOCK, verified.length - offset);
          const count = await call(session.sftp, 'read', [handle, verified, offset, length, offset], owner.controller.signal);
          if (!Number.isInteger(count) || count < 1 || count > length) throw new Error('The remote staging file could not be verified.');
          offset += count;
        }
        if (!verified.equals(data)) throw new Error('The remote staging content differs from the reviewed edit.');
        const permissions = doc.metadata.mode & 0o777;
        await call(session.sftp, 'fchmod', [handle, permissions], owner.controller.signal);
        const staged = metadata(await call(session.sftp, 'fstat', [handle], owner.controller.signal));
        if (staged.type !== 'file' || staged.size !== data.length || (staged.mode & 0o7777) !== permissions
          || !equal(staged, metadata(await remoteStat(session.sftp, stage, owner.controller.signal)))) throw new Error('The remote staging file or its permissions could not be verified.');
        await call(session.sftp, 'close', [handle], owner.controller.signal); handle = null;
        await fresh(doc, session, owner.controller.signal); checkReview(plan, owner);
        const expected = { type: 'file', size: doc.metadata.size, mtime: doc.metadata.mtime, permissions: (doc.metadata.mode & 0o777).toString(8).padStart(3, '0') };
        await commitRemote(session.sftp, stage, doc.path, expected, owner); committed = true;
        // Keep the acknowledged save even if a later refresh is interrupted.
        doc.text = plan.text; doc.revision = digest(data);
        try {
          const refreshed = await read(session, doc.path, new AbortController().signal);
          if (refreshed.revision !== doc.revision) throw new Error('Remote content changed immediately after saving.');
          Object.assign(doc, refreshed);
          return { saved: true, ...view(doc), warning: owner.warning || '' };
        } catch { documents.delete(doc.documentId); return { saved: true, ...view(doc), closed: true, warning: 'The save was acknowledged, but the remote revision could not be refreshed. Reopen the file before another save.' }; }
      } catch (error) {
        owner.controller.abort(); // Close any handle returned after a timed-out open.
        if (error.indeterminate) { session.closed = true; session.client.end(); }
        if (attempted && !committed) error.message += ` A staging file may remain at ${stage}; inspect it before cleanup.`;
        throw error;
      } finally {
        if (handle) await call(session.sftp, 'close', [handle], undefined, timeout).catch(() => {});
        // A remote path cannot be proved to still identify our stage after a
        // failed request. Retain it and report the path rather than unlink it.
      }
    });
  }
  function discardSave({ planId } = {}) { if (pending?.planId !== planId) return false; forgetPlan(); return true; }
  async function close({ documentId } = {}) {
    const doc = documents.get(documentId); if (!doc) return false;
    if (operation?.id === doc.id) throw new Error('Wait for the remote editor operation before closing.');
    if (pending?.doc === doc) forgetPlan(); return documents.delete(documentId);
  }
  function disconnected(id) { if (pending?.doc.id === id) forgetPlan(); if (operation?.id === id) operation.controller.abort(); }
  async function closeConnection(id) { const work = operation?.id === id ? operation : null; disconnected(id); if (work) await work.done; }
  async function closeAll() { stopping = true; forgetPlan(); const work = operation; work?.controller.abort(); if (work) await work.done; documents.clear(); }
  return { open, prepareSave, save, discardSave, close, disconnected, closeConnection, closeAll,
    get busy() { return Boolean(operation || pending); }, get count() { return documents.size; },
    get activeIds() { return [...new Set([...documents.values()].map(doc => doc.id).concat(operation ? [operation.id] : []))]; } };
}

module.exports = { createRemoteEditor };
