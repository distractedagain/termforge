'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { createRemoteFiles } = require('./remote-files.cjs');
const { createFolderTransfers } = require('./folder-transfers.cjs');
const { createFolderRecovery } = require('./folder-recovery.cjs');
const { createTransferRecovery } = require('./transfer-recovery.cjs');
const { getConnectionIdentity: verifiedConnectionIdentity } = require('./secure-ssh.cjs');
const { createRemoteEditor } = require('./remote-editor.cjs');

const BLOCK = 64 * 1024;
const MAX_FILE = 1024 ** 4;
const MAX_JOBS = 100;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const DONE = new Set(['completed', 'failed', 'cancelled']);
const RETAINED = new Set(['paused', 'interrupted']);
const inactive = job => DONE.has(job.status) || RETAINED.has(job.status);

function cancelled() { const error = new Error('Transfer cancelled.'); error.name = 'AbortError'; return error; }
function check(signal) { if (signal?.aborted) throw cancelled(); }
function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..'
    && !/[\\/\x00-\x1f\x7f]/.test(name);
}
function validLocalName(name) {
  return validName(name) && (process.platform !== 'win32' || (!/[<>:"|?*]/.test(name) && !/[. ]$/.test(name)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)));
}
function remotePath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)) throw new Error('Invalid remote path.');
  const normalized = path.posix.normalize(value);
  if (!validName(path.posix.basename(normalized)) && normalized !== '/' && normalized !== '.') throw new Error('Invalid remote filename.');
  return normalized;
}
function localPath(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid local path.');
  return path.resolve(value);
}
function shellQuote(value) { return "'" + value.split("'").join(String.fromCharCode(39, 92, 39, 39)) + "'"; }
function kind(stat) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}
function summary(stat) {
  return { type: kind(stat), size: stat.size, mtime: stat.mtimeMs ?? stat.mtime * 1000,
    ...(Number.isInteger(stat.mode) ? { mode: stat.mode, permissions: (stat.mode & 0o777).toString(8).padStart(3, '0') } : {}),
    ...(Number.isInteger(stat.uid) ? { uid: stat.uid } : {}), ...(Number.isInteger(stat.gid) ? { gid: stat.gid } : {}) };
}
function same(a, b, moved = false) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.size === b.size && a.mtime === b.mtime
    && ['mode', 'permissions', 'uid', 'gid'].every(key => a[key] === undefined || a[key] === b[key])
    && (a.ino === undefined || (a.ino === b.ino && a.dev === b.dev && (moved || a.ctime === b.ctime)));
}
function localSnapshot(stat) { return { ...summary(stat), ino: stat.ino, dev: stat.dev, ctime: stat.ctimeMs }; }
function readableFile(stat) {
  if (kind(stat) !== 'file') throw new Error('Only regular files can be transferred; symbolic links and directories are not followed.');
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FILE) throw new Error('Files must be no larger than 1 TiB.');
  return stat;
}
function plainError(error) { return String(error?.message || error || 'Transfer failed.').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 700); }

function bounded(promise, signal, timeout = 30000) {
  check(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(Object.assign(new Error('File-transfer operation timed out.'), { code: 'TRANSFER_TIMEOUT' })), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}
function call(sftp, method, args = [], signal, timeout) {
  check(signal);
  return bounded(new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => {
      if (signal?.aborted && method === 'open' && value) { try { sftp.close(value, () => {}); } catch {} }
      error ? reject(error) : resolve(value);
    });
  }), signal, timeout);
}
async function remoteStat(sftp, filename, signal) {
  try { return await call(sftp, 'lstat', [filename], signal); }
  catch (error) { if (error.code === 2 || error.code === 'ENOENT') return null; throw error; }
}
async function localStat(filename) {
  try { return await fsp.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function quiet(fn) { try { await fn(); } catch {} }

// Reading SCP framing separately from payload keeps remote error text bounded and
// prevents an offered filename or a second file from selecting a local target.
class ScpReader {
  constructor(channel, signal) {
    this.channel = channel; this.signal = signal; this.chunks = []; this.length = 0;
    this.ended = false; this.error = null; this.waiter = null; this.exitCode = null; this.stderr = '';
    channel.on('data', chunk => {
      if(this.stopping)return;
      this.chunks.push(Buffer.from(chunk)); this.length += chunk.length;
      if (this.length > BLOCK * 4) channel.pause();
      this.wake();
    });
    channel.stderr?.on('data', chunk => { if (this.stderr.length < 1024) this.stderr += chunk.toString('utf8').slice(0, 1024 - this.stderr.length); });
    channel.on('exit', code => { this.exitCode = code; });
    channel.on('error', error => { this.error = error; this.wake(); });
    channel.on('close', () => { this.ended = true; this.wake(); });
    this.abort = () => { this.error = cancelled(); this.wake(); channel.destroy(); };
    signal.addEventListener('abort', this.abort, { once: true });
  }
  wake() { this.waiter?.(); this.waiter = null; }
  async available() {
    while (!this.length) {
      check(this.signal);
      if (this.error) throw this.error;
      if (this.ended) throw new Error('SCP ended before the complete file was received.');
      await bounded(new Promise(resolve => { this.waiter = resolve; }), this.signal);
    }
  }
  async read(count) {
    await this.available();
    const first = this.chunks[0]; const size = Math.min(count, first.length);
    const result = first.subarray(0, size);
    if (size === first.length) this.chunks.shift(); else this.chunks[0] = first.subarray(size);
    this.length -= size;
    if (this.length <= BLOCK) this.channel.resume();
    return result;
  }
  async byte() { return (await this.read(1))[0]; }
  async line() {
    const bytes = [];
    while (bytes.length <= 4096) { const byte = await this.byte(); if (byte === 10) return Buffer.from(bytes).toString('utf8'); bytes.push(byte); }
    throw new Error('SCP returned an oversized protocol record.');
  }
  async ack() {
    const code = await this.byte();
    if (code === 0) return;
    if (code === 1 || code === 2) throw new Error(`SCP: ${plainError(await this.line())}`);
    throw new Error('SCP returned an invalid acknowledgement.');
  }
  async finished() {
    while (!this.ended) {
      if (this.error) throw this.error;
      await bounded(new Promise(resolve => { this.waiter = resolve; }), this.signal);
    }
    if (this.error) throw this.error;
    if (this.exitCode !== 0) throw new Error(`SCP process failed${this.stderr ? `: ${plainError(this.stderr)}` : '.'}`);
    if (this.length) throw new Error('SCP returned unexpected additional file data.');
  }
  dispose() { this.signal.removeEventListener('abort', this.abort); this.channel.destroy(); }
}

async function writeChannel(channel, data, signal) {
  check(signal);
  if (channel.destroyed || !channel.writable) throw new Error('SCP channel is closed.');
  await bounded(new Promise((resolve, reject) => { channel.write(data, error => error ? reject(error) : resolve()); }), signal);
}

function createSecureTransfers({ connect, emit = () => {}, confirmOverwrite = async () => false, confirmRemoteOperation = async () => false,
  confirmFolderTransfer = async () => false, home = os.homedir(), commitTimeoutMs = 30000, remotePlanLifetimeMs = 60000,
  folderPlanLifetimeMs = 300000, recoveryDirectory, syncDirectory, confirmResume = async () => false, confirmDiscardPartial = async () => false,
  confirmRemoteEdit = async () => false, getConnectionIdentity = verifiedConnectionIdentity } = {}) {
  if (typeof connect !== 'function') throw new TypeError('A verified SSH connection factory is required.');
  if (!Number.isInteger(commitTimeoutMs) || commitTimeoutMs < 1 || commitTimeoutMs > 30000) throw new TypeError('Invalid commit operation timeout.');
  if (!Number.isInteger(remotePlanLifetimeMs) || remotePlanLifetimeMs < 1 || remotePlanLifetimeMs > 60000) throw new TypeError('Invalid remote operation plan lifetime.');
  const sessions = new Map(); const jobs = new Map(); const queue = []; const pendingOpens = new Set();
  const recovery = recoveryDirectory ? createTransferRecovery(recoveryDirectory) : null;
  let initialized = !recovery; let initializing; let recoveryError = '';
  let processing = false; let stopped = false;

  function identity(session) {
    const value = getConnectionIdentity(session.client);
    if (!value || typeof value.username !== 'string' || !value.username || !value.fingerprint || !value.algorithm
      || value.host.toLowerCase() !== session.host.toLowerCase() || value.port !== session.port) throw new Error('Authenticated SSH identity is unavailable for resumable transfers.');
    return createHash('sha256').update(JSON.stringify([value.host.toLowerCase(), value.port, value.username, value.algorithm, value.fingerprint])).digest('hex');
  }
  function initializeRecovery() {
    if (initializing) return initializing;
    initializing = (async () => {
      let checkpoints;
      try { checkpoints = recovery ? await recovery.load() : []; }
      catch (error) { recoveryError = `Transfer recovery could not be loaded safely. File-transfer changes are disabled: ${plainError(error)}`; initialized = true; return { error: recoveryError }; }
      for (const checkpoint of checkpoints) {
        const uncertain = checkpoint.phase !== 'retained';
        const job = { transferId: checkpoint.transferId, id: '', direction: checkpoint.direction, protocol: checkpoint.protocol || 'sftp',
          localPath: checkpoint.localPath, remotePath: checkpoint.remotePath, status: 'interrupted', resumable: true,
          bytes: checkpoint.kind === 'folder' ? checkpoint.completed.reduce((n,e)=>n+e.size,0)+(checkpoint.child?.bytes||0) : checkpoint.bytes, total: checkpoint.kind === 'folder' ? checkpoint.expected.totalBytes : checkpoint.total, checkpoint, controller: new AbortController(),
          error: uncertain ? 'The final commit outcome is unknown. Inspect the destination and retained files before discarding this record.' : '',
          warning: 'Retained transfer restored. Connect to the same authenticated server and account to resume.' };
        if (checkpoint.kind === 'folder') Object.assign(job, {kind:'folder', filesTotal:checkpoint.expected.files, filesCompleted:checkpoint.completed.length, directoriesTotal:checkpoint.expected.directories, directoriesCreated:checkpoint.created.length, currentPath:'', publish:()=>publish(job)});
        job.done = Promise.resolve(); job.resolveDone = () => {}; jobs.set(job.transferId, job);
      }
      initialized = true;
      return { error: '' };
    })();
    return initializing;
  }

  function getSession(id) { const session = sessions.get(id); if (!session || session.closed) throw new Error('The file-transfer session is closed.'); return session; }
  let folderFiles, editor;
  const remoteFiles = createRemoteFiles({ getSession, isTransferring: () => folderFiles?.busy || editor?.busy || [...jobs.values()].some(job => !inactive(job)),
    call, stat: remoteStat, summary, confirm: confirmRemoteOperation, timeout: commitTimeoutMs, planLifetimeMs: remotePlanLifetimeMs });
  folderFiles = createFolderTransfers({ getSession, syncDirectory, identityFor: identity, assertAvailable: () => remoteFiles.available(),
    isBusy: () => editor?.busy || [...jobs.values()].some(job => !inactive(job)), call, remoteStat,
    confirm: confirmFolderTransfer, timeout: commitTimeoutMs, planLifetimeMs: folderPlanLifetimeMs,
    enqueue: plan => {
      const job = { transferId: randomUUID(), ...plan.review, kind: 'folder', status: 'queued', bytes: 0,
        total: plan.expected.totalBytes, filesTotal: plan.expected.files, filesCompleted: 0,
        directoriesTotal: plan.expected.directories, directoriesCreated: 0, currentPath: '',
        controller: plan.controller, folderPlan: plan };
      if (plan.review.resumable) { if (!recovery) throw new Error('Folder recovery requires a private recovery directory.'); identity(plan.session); job.resumable=true; }
      job.publish = () => publish(job); enqueue(job); return job;
    },
    copy: async (folder, session, entry) => {
      const child = { id: folder.id, direction: entry.direction || folder.direction, protocol: 'sftp', localPath: entry.localPath,
        remotePath: entry.remotePath, bytes: 0, total: entry.size, controller: folder.controller, expectedAbsent: !entry.reviewedReplacement,
        beforeCommit: entry.validate, onProgress: count => progress(folder, count) };
      if (entry.reviewedReplacement) child.preapprovedDestination = entry.expectedDestination;
      if (child.direction === 'upload') await upload(child, session); else await download(child, session);
      if (child.warning) folder.warning = child.warning;
    } });
  const folderRecovery = recovery ? createFolderRecovery({ call, remoteStat, recovery, identityFor:identity, timeout:commitTimeoutMs,
    copy:async(folder,session,{entry,localPath,remotePath,validate,save,committed})=>{
      const child={internalChild:true,transferId:folder.transferId,id:folder.id,direction:folder.direction,protocol:'sftp',localPath,remotePath,
        bytes:folder.checkpoint.child?.bytes||0,total:entry.size,checkpoint:folder.checkpoint.child,controller:folder.controller,
        expectedAbsent:!entry.destinationExpected,beforeCommit:validate,onProgress:count=>progress(folder,count),saveCheckpoint:save,completeCheckpoint:committed,
        preapprovedDestination:entry.destinationExpected?{...entry.destinationExpected,permissions:(entry.destinationExpected.mode&0o777).toString(8).padStart(3,'0')}:null};
      Object.defineProperty(child,'pauseRequested',{get:()=>folder.pauseRequested});
      Object.defineProperty(child,'recoveryPhase',{get:()=>folder.recoveryPhase,set:value=>folder.recoveryPhase=value});
      Object.defineProperty(child,'commitStarted',{get:()=>folder.commitStarted,set:value=>folder.commitStarted=value});
      const base=folder.checkpoint.completed.reduce((n,item)=>n+item.size,0);
      child.onProgress=()=>{folder.bytes=base+child.bytes;publish(folder);};
      const result=await recoverableCopy(child,session);folder.bytes=base+child.bytes;folder.commitStarted=false;
      if(child.warning)folder.warning=child.warning;return result;
    } }) : null;
  editor = createRemoteEditor({ getSession, assertAvailable: () => {
    assertRecoveryAvailable(); remoteFiles.available(); folderFiles.available();
    if ([...jobs.values()].some(job => !inactive(job))) throw new Error('Wait for active file transfers before editing a remote file.');
  }, call, remoteStat, commitRemote, confirm: confirmRemoteEdit, timeout: commitTimeoutMs });
  function view(job) {
    return { transferId: job.transferId, id: job.id, sessionId: job.id, direction: job.direction, protocol: job.protocol,
      localPath: job.localPath, remotePath: job.remotePath, status: job.status, bytes: job.bytes, transferred: job.bytes,
      total: job.total, error: job.error || '', warning: job.warning || '', startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
      ...(job.resumable ? { resumable: true, resumeTransport:'sftp', payloadTransport:job.protocol, hybridResume:job.protocol==='scp', resumeAvailable: RETAINED.has(job.status) && job.checkpoint?.phase === 'retained' && (!job.checkpoint.child || job.checkpoint.child.phase === 'retained'),
        retainedBytes: job.kind === 'folder' ? (job.checkpoint?.completed.reduce((n,e)=>n+e.size,0)||0)+(job.checkpoint?.child?.bytes||0) : job.checkpoint?.bytes || 0, host: job.checkpoint?.host || '', port: job.checkpoint?.port || 22,
        forgetOnly: Boolean(job.checkpoint && (job.checkpoint.phase !== 'retained' || job.kind === 'folder')) } : {}),
      ...(job.kind === 'folder' ? { kind: 'folder', filesTotal: job.filesTotal, filesCompleted: job.filesCompleted,
        persistentSync: Boolean(job.persistentSync), syncPair: job.syncPair, baselineUsed: Boolean(job.baselineUsed), baselineUpdated: Boolean(job.baselineUpdated),
        mode:job.mode || job.checkpoint?.mode || 'copy', deletedFilesTotal:job.deletedFilesTotal||job.folderPlan?.expected.deletedFiles||0, deletedDirectoriesTotal:job.deletedDirectoriesTotal||job.folderPlan?.expected.deletedDirectories||0, directoriesTotal: job.directoriesTotal, directoriesCreated: job.directoriesCreated, deletedFiles:job.deletedFiles||0, deletedDirectories:job.deletedDirectories||0, currentPath: job.currentPath } : {}) };
  }
  function publish(job) { if (job.internalChild || !job.transferId) return; try { emit({ type: 'transfer', ...view(job) }); } catch {} }
  function progress(job, count) { job.bytes += count; job.onProgress?.(count); if (Date.now() - (job.lastProgress || 0) >= 100 || job.bytes === job.total) { job.lastProgress = Date.now(); publish(job); } }

  async function open(profile, { signal } = {}) {
    await initializeRecovery();
    if (recoveryError) throw new Error(recoveryError);
    if (stopped) throw new Error('The transfer manager is stopping.');
    if (sessions.size + pendingOpens.size >= 16) throw new Error('Close a file-transfer connection before opening another.');
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let finishPending;
    const pending = { controller, done: new Promise(resolve => { finishPending = resolve; }) };
    pendingOpens.add(pending);
    let client;
    try {
      const connecting = Promise.resolve().then(() => connect(profile, { signal }));
      connecting.then(result => { if (signal.aborted || stopped) result.end(); }, () => {});
      client = await bounded(connecting, signal, 10 * 60 * 1000); check(signal);
      const sftp = await bounded(new Promise((resolve, reject) => { client.sftp((error, value) => error ? reject(error) : resolve(value)); }), signal);
      const currentPath = remotePath(await call(sftp, 'realpath', ['.'], signal));
      if (stopped) throw new Error('The transfer manager is stopping.');
      const id = randomUUID();
      const session = { id, client, sftp, remotePath: currentPath, closed: false, host: profile.host || profile.hostname || '', port: profile.port || 22 };
      sessions.set(id, session);
      client.once('close', () => {
        session.closed = true; sessions.delete(id);
        remoteFiles.disconnected(id);
        folderFiles.disconnected(id);
        editor.disconnected(id);
        for (const job of jobs.values()) if (job.id === id && !inactive(job)) { job.disconnected = true; job.controller.abort(); }
        try { emit({ type: 'connection', id, status: 'closed' }); } catch {}
      });
      return { id, host: profile.host || profile.hostname || '', port: profile.port || 22, remotePath: currentPath };
    } catch (error) { client?.end(); throw error; }
    finally { pendingOpens.delete(pending); finishPending(); }
  }
  async function listLocal({ path: input = '' } = {}) {
    const requested = localPath(input || home);
    const resolved = await fsp.realpath(requested);
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    if (entries.length > 10000) throw new Error('This directory contains more than 10,000 entries.');
    const listed = [];
    for (const entry of entries) {
      if (!validName(entry.name)) continue;
      const stat = await localStat(path.join(resolved, entry.name));
      if (stat) listed.push({ name: entry.name, ...summary(stat) });
    }
    return { path: resolved, entries: sort(listed) };
  }
  async function listRemote({ id, path: input = '.' } = {}) {
    const { sftp } = getSession(id);
    const resolved = remotePath(await call(sftp, 'realpath', [remotePath(input)]));
    const entries = await call(sftp, 'readdir', [resolved]);
    if (!Array.isArray(entries) || entries.length > 10000) throw new Error('This directory contains more than 10,000 entries.');
    return { path: resolved, entries: sort(entries.filter(entry => validName(entry.filename)).map(entry => ({ name: entry.filename, ...summary(entry.attrs) }))) };
  }
  function sort(entries) { return entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)); }

  async function destination(job, local) {
    const filename = local ? job.localPath : job.remotePath;
    const stat = local ? await localStat(filename) : await remoteStat(getSession(job.id).sftp, filename, job.controller.signal);
    if (job.expectedAbsent && stat) throw new Error('A destination item appeared after folder review. Existing items are never replaced by a folder copy.');
    if (stat) readableFile(stat);
    const snapshot = stat ? (local ? localSnapshot(stat) : summary(stat)) : null;
    if (Object.hasOwn(job, 'preapprovedDestination')) {
      if (!same(job.preapprovedDestination, snapshot)) throw new Error('The reviewed destination changed before copying. Review the folder again.');
      if (job.preapprovedDestination?.mode & 0o7000) throw new Error('Reviewed replacements refuse destination files with special permission bits.');
      return snapshot;
    }
    if (stat && !(await bounded(confirmOverwrite({ direction: job.direction, source: local ? job.remotePath : job.localPath, destination: filename, signal: job.controller.signal }), job.controller.signal, 10 * 60 * 1000))) throw new Error('Overwrite was declined.');
    check(job.controller.signal);
    return snapshot;
  }

  async function localContext(filename) {
    const parent = path.dirname(filename); const name = path.basename(filename);
    if (!validLocalName(name)) throw new Error('Invalid local filename.');
    const canonical = await fsp.realpath(parent);
    const parentStat = await fsp.stat(canonical);
    if (!parentStat.isDirectory()) throw new Error('The local destination parent is not a directory.');
    return { parent, canonical, parentStat, target: path.join(canonical, name) };
  }
  async function checkParent(context) {
    const resolved = await fsp.realpath(context.parent); const stat = await fsp.stat(context.canonical);
    if (resolved !== context.canonical || stat.dev !== context.parentStat.dev || stat.ino !== context.parentStat.ino) throw new Error('The destination directory changed during transfer.');
  }
  async function commitLocal(stage, context, expected, job) {
    check(job.controller.signal); await checkParent(context);
    const target = context.target;
    if (expected) {
      // Some removable/network filesystems cannot create hard links. Verify
      // the exact operation used for commit and recovery before moving the
      // existing destination out of the way.
      const probe = path.join(context.canonical, `.termforge-${randomUUID()}.linkcheck`);
      let linked = false;
      try { await fsp.link(stage, probe); linked = true; }
      catch { throw new Error('This destination cannot create the hard links required for safe downloads. The existing file was left in place. Choose a different local folder or filesystem.'); }
      finally { if (linked) await fsp.unlink(probe); }
      await checkParent(context);
    }
    const existing = await localStat(target);
    if (!same(expected, existing ? localSnapshot(existing) : null)) throw new Error('The local destination changed after overwrite confirmation.');
    check(job.controller.signal); job.commitStarted = true;
    let backup = null;
    try {
      if (expected) {
        backup = path.join(context.canonical, `.termforge-${randomUUID()}.recovery`);
        await fsp.rename(target, backup);
        if (!same(expected, localSnapshot(await fsp.lstat(backup)), true)) throw new Error('The local destination changed before replacement.');
      }
      // link is exclusive: unlike rename, it cannot silently replace a file
      // created by somebody else between validation and the final commit.
      await fsp.link(stage, target);
      await fsp.unlink(stage);
      if (backup) await fsp.unlink(backup);
    } catch (error) {
      if (backup) {
        try { await fsp.link(backup, target); await fsp.unlink(backup); }
        catch { if (await localStat(backup)) throw new Error(`${plainError(error)} Previous destination preserved at ${backup}`); }
      }
      throw error;
    }
  }
  async function commitRemote(sftp, stage, target, expected, job) {
    check(job.controller.signal);
    const existing = await remoteStat(sftp, target, job.controller.signal);
    if (!same(expected, existing ? summary(existing) : null)) throw new Error('The remote destination changed after overwrite confirmation.');
    check(job.controller.signal); job.commitStarted = true;
    let backup = null; let backupMoved = false;
    function uncertain(error) {
      return Object.assign(new Error(`The remote commit outcome could not be verified. Check ${[target, stage, backup].filter(Boolean).join(', ')} before retrying. Remaining transfer and recovery files were retained. ${plainError(error)}`), { indeterminate: true, preserveStage: true });
    }
    async function rename(from, to) {
      try { await call(sftp, 'rename', [from, to], undefined, commitTimeoutMs); }
      catch (error) {
        // Numeric SFTP STATUS is a definite server refusal. A timeout or
        // disconnected transport says nothing about whether rename executed.
        if (!Number.isInteger(error.code)) throw uncertain(error);
        throw error;
      }
    }
    try {
      if (expected) {
        backup = path.posix.join(path.posix.dirname(target), `.termforge-${randomUUID()}.recovery`);
        await rename(target, backup); backupMoved = true;
        if (!same(expected, summary(await call(sftp, 'lstat', [backup], undefined, commitTimeoutMs)))) throw new Error('The remote destination changed before replacement.');
      }
      // Deliberately use SFTP v3 RENAME (which must fail if target exists),
      // never OpenSSH posix-rename, which unconditionally overwrites a target.
      // Once commit starts, cancellation waits for its outcome; abandoning an
      // in-flight mutation could otherwise race cleanup against server work.
      await rename(stage, target);
    } catch (error) {
      if (error.indeterminate) throw error;
      if (backupMoved) {
        try { await rename(backup, target); }
        catch (restoreError) {
          if (restoreError.indeterminate) throw restoreError;
          throw new Error(`${plainError(error)} Previous destination preserved at ${backup}`);
        }
      }
      throw error;
    }
    if (backupMoved) {
      try { await call(sftp, 'unlink', [backup], undefined, commitTimeoutMs); }
      catch { job.warning = `Transfer completed. The previous destination backup may remain at ${backup}.`; }
    }
  }

  async function scp(job, session, file, remote, upload, resumable = false) {
    const signal = job.controller.signal;
    const command = `scp ${upload ? '-t' : '-f'} -- ${shellQuote(remote)}`;
    const channel = await bounded(new Promise((resolve, reject) => session.client.exec(command, { pty: false }, (error, result) => {
      if (signal.aborted && result) result.destroy();
      error ? reject(error) : resolve(result);
    })), signal);
    const reader = new ScpReader(channel, signal);
    async function stopPartial() {
      // SCP has only file-level acknowledgement. Close its channel, then let
      // the recovery engine measure and hash the actual retained prefix.
      const ended=new Promise(resolve=>{ if(reader.ended)resolve();else channel.once('close',resolve); });
      reader.stopping=true;reader.chunks=[];reader.length=0;channel.resume();channel.end();channel.close();
      await bounded(ended,signal,commitTimeoutMs);return 'paused';
    }
    try {
      if (upload) {
        await reader.ack();
        await writeChannel(channel, `C0600 ${job.total} ${path.posix.basename(remote)}\n`, signal);
        await reader.ack();
        const buffer = Buffer.alloc(BLOCK);
        for (let position = 0; position < job.total;) {
          check(signal); if(resumable && job.pauseRequested) return await stopPartial();
          const { bytesRead } = await file.read(buffer, 0, Math.min(BLOCK, job.total - position), position);
          if (!bytesRead) throw new Error('The local source file changed during transfer.');
          await writeChannel(channel, buffer.subarray(0, bytesRead), signal); position += bytesRead; progress(job, bytesRead);
        }
        await writeChannel(channel, Buffer.from([0]), signal); await reader.ack(); channel.end();
      } else {
        await writeChannel(channel, Buffer.from([0]), signal);
        const header = await reader.line();
        const match = /^C[0-7]{4} (\d{1,16}) (.+)$/.exec(header);
        if (!match || !validName(match[2]) || match[2] !== path.posix.basename(remote)) throw new Error('SCP offered an invalid or unexpected filename.');
        const size = Number(match[1]);
        if (!Number.isSafeInteger(size) || size !== job.total) throw new Error('The remote source size changed before transfer.');
        await writeChannel(channel, Buffer.from([0]), signal);
        let position = 0;
        while (position < size) {
          if(resumable && job.pauseRequested) return await stopPartial();
          const chunk = await reader.read(Math.min(BLOCK, size - position)); check(signal);
          await writeFile(file, chunk, position); position += chunk.length; progress(job, chunk.length);
        }
        await reader.ack(); await writeChannel(channel, Buffer.from([0]), signal);
      }
      await reader.finished();
    } finally { reader.dispose(); }
  }
  async function writeFile(file, buffer, position) {
    let written = 0;
    while (written < buffer.length) {
      const result = await file.write(buffer, written, buffer.length - written, position + written);
      if (!result.bytesWritten) throw new Error('The local file could not be written.');
      written += result.bytesWritten;
    }
  }
  async function upload(job, session) {
    const { sftp } = session; const signal = job.controller.signal;
    const initial = readableFile(await fsp.lstat(job.localPath));
    const source = await fsp.open(job.localPath, fs.constants.O_RDONLY | NOFOLLOW);
    let handle; let stage; let preserveStage = false;
    try {
      if (!same(localSnapshot(initial), localSnapshot(readableFile(await source.stat())))) throw new Error('The local source changed before transfer.');
      job.total = initial.size; publish(job);
      const expected = await destination(job, false);
      stage = path.posix.join(path.posix.dirname(job.remotePath), `.termforge-${randomUUID()}.part`);
      handle = await call(sftp, 'open', [stage, 'wx', { mode: 0o600 }], signal);
      if (job.protocol === 'scp') {
        await call(sftp, 'close', [handle], signal); handle = null;
        await scp(job, session, source, stage, true);
      } else {
        const buffer = Buffer.alloc(BLOCK);
        for (let position = 0; position < job.total;) {
          check(signal);
          const { bytesRead } = await source.read(buffer, 0, Math.min(BLOCK, job.total - position), position);
          if (!bytesRead) throw new Error('The local source file changed during transfer.');
          await call(sftp, 'write', [handle, buffer, 0, bytesRead, position], signal);
          position += bytesRead; progress(job, bytesRead);
        }
        if (job.preapprovedDestination) await call(sftp, 'fsetstat', [handle, { mode: parseInt(job.preapprovedDestination.permissions, 8) }], signal);
        await call(sftp, 'close', [handle], signal); handle = null;
      }
      if (!same(localSnapshot(initial), localSnapshot(await source.stat()))) throw new Error('The local source file changed during transfer.');
      await job.beforeCommit?.();
      await commitRemote(sftp, stage, job.remotePath, expected, job); stage = null;
    } catch (error) {
      preserveStage = Boolean(error.preserveStage);
      if (error.indeterminate) { session.closed = true; session.client.end(); }
      throw error;
    } finally {
      await quiet(() => source.close());
      if (handle) await quiet(() => call(sftp, 'close', [handle], undefined, 3000));
      if (stage && !preserveStage) await quiet(() => call(sftp, 'unlink', [stage], undefined, 3000));
    }
  }
  async function download(job, session) {
    const { sftp } = session; const signal = job.controller.signal;
    const initial = readableFile(await call(sftp, 'lstat', [job.remotePath], signal));
    job.total = initial.size; publish(job);
    const context = await localContext(job.localPath);
    const expected = await destination(job, true);
    const stage = path.join(context.canonical, `.termforge-${randomUUID()}.part`);
    let source; let target; let committed = false;
    try {
      await checkParent(context);
      target = await fsp.open(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      if (job.protocol === 'scp') await scp(job, session, target, job.remotePath, false);
      else {
        source = await call(sftp, 'open', [job.remotePath, 'r'], signal);
        if (!same(summary(initial), summary(readableFile(await call(sftp, 'fstat', [source], signal))))) throw new Error('The remote source changed before transfer.');
        const buffer = Buffer.alloc(BLOCK);
        for (let position = 0; position < job.total;) {
          check(signal);
          const read = await call(sftp, 'read', [source, buffer, 0, Math.min(BLOCK, job.total - position), position], signal);
          if (!read) throw new Error('The remote source file changed during transfer.');
          await writeFile(target, buffer.subarray(0, read), position);
          position += read; progress(job, read);
        }
        await call(sftp, 'close', [source], signal); source = null;
      }
      if (!same(summary(initial), summary(await call(sftp, 'lstat', [job.remotePath], signal)))) throw new Error('The remote source file changed during transfer.');
      if (job.preapprovedDestination) await target.chmod(parseInt(job.preapprovedDestination.permissions, 8));
      await target.sync(); await target.close(); target = null;
      await job.beforeCommit?.();
      await commitLocal(stage, context, expected, job); committed = true;
    } finally {
      if (source) await quiet(() => call(sftp, 'close', [source], undefined, 3000));
      if (target) await quiet(() => target.close());
      if (!committed) await quiet(() => fsp.unlink(stage));
    }
  }

  // Retained transfers always verify the complete source and the retained
  // prefix. SFTP metadata alone cannot distinguish files with identical times.
  async function recoveryParents(filename, remote, session, signal) {
    const api = remote ? path.posix : path;
    const parent = api.dirname(filename);
    const canonical = remote ? await call(session.sftp, 'realpath', [parent], signal) : await fsp.realpath(parent);
    if (remote && canonical !== parent) throw new Error('Resumable remote paths must have canonical parents without symbolic links.');
    const root = api.parse(canonical).root; const names = [root];
    for (const part of canonical.slice(root.length).split(api.sep).filter(Boolean)) names.push(api.join(names.at(-1), part));
    if (names.length > 256) throw new Error('The transfer path has too many parent directories.');
    const result = [];
    for (const name of names) {
      check(signal);
      const stat = remote ? await call(session.sftp, 'lstat', [name], signal) : await fsp.lstat(name);
      if (kind(stat) !== 'directory') throw new Error('Transfer parents must be directories without symbolic links.');
      result.push({ path: name, type: 'directory', mode: stat.mode, uid: stat.uid, gid: stat.gid,
        ...(!remote ? { ino: stat.ino, dev: stat.dev } : {}) });
    }
    return result;
  }
  const equalParents = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stageIdentity = (stat, remote) => ({ type: kind(stat), mode: stat.mode, uid: stat.uid, gid: stat.gid,
    ...(!remote ? { ino: stat.ino, dev: stat.dev } : {}) });
  async function readPart(handle, remote, session, buffer, size, position, signal) {
    if (remote) return call(session.sftp, 'read', [handle, buffer, 0, size, position], signal);
    return (await handle.read(buffer, 0, size, position)).bytesRead;
  }
  async function hashPart(handle, remote, session, length, signal) {
    const hash = createHash('sha256'), buffer = Buffer.alloc(BLOCK);
    for (let position = 0; position < length;) {
      check(signal); const count = await readPart(handle, remote, session, buffer, Math.min(BLOCK, length - position), position, signal);
      if (!count) throw new Error('A retained transfer file changed while verifying its contents.');
      hash.update(buffer.subarray(0, count)); position += count;
    }
    return hash;
  }
  async function saveCheckpoint(job) {
    job.checkpoint.updatedAt = Date.now();
    if(job.saveCheckpoint) await job.saveCheckpoint(job.checkpoint); else await recovery.save(job.checkpoint);
  }
  async function recoverableCopy(job, session) {
    const upload = job.direction === 'upload', sourceRemote = !upload, signal = job.controller.signal;
    let source, target; let checkpoint = job.checkpoint; let prefix; const initialScp = !checkpoint && job.protocol === 'scp';
    const sourceName = () => upload ? job.localPath : job.remotePath;
    const snapshot = stat => sourceRemote ? summary(stat) : localSnapshot(stat);
    const closeSource = async () => { if (!source) return; const item = source; source = null; if (sourceRemote) await quiet(() => call(session.sftp, 'close', [item], undefined, 3000)); else await quiet(() => item.close()); };
    const closeTarget = async () => { if (!target) return; const item = target; target = null; if (upload) await quiet(() => call(session.sftp, 'close', [item], undefined, 3000)); else await quiet(() => item.close()); };
    async function currentSource() { return snapshot(readableFile(sourceRemote ? await call(session.sftp, 'lstat', [job.remotePath], signal) : await fsp.lstat(job.localPath))); }
    async function sourceHandleStat() { return snapshot(readableFile(sourceRemote ? await call(session.sftp, 'fstat', [source], signal) : await source.stat())); }
    async function validateParents() {
      const src = await recoveryParents(sourceName(), sourceRemote, session, signal);
      const dst = await recoveryParents(upload ? job.remotePath : job.localPath, upload, session, signal);
      if (!equalParents(src, checkpoint.sourceParents) || !equalParents(dst, checkpoint.destinationParents)) throw new Error('A retained transfer parent directory changed.');
    }
    try {
      job.recoveryPhase = 'hashing';
      if (identity(session) !== (checkpoint?.identity || identity(session))) throw new Error('Resume requires the same authenticated server and account.');
      const initial = await currentSource();
      if (checkpoint && !same(checkpoint.sourceSnapshot, initial)) throw new Error('The original source changed. Retained data cannot be resumed.');
      source = sourceRemote ? await call(session.sftp, 'open', [job.remotePath, 'r'], signal) : await fsp.open(job.localPath, fs.constants.O_RDONLY | NOFOLLOW);
      if (!same(initial, await sourceHandleStat())) throw new Error('The source changed while opening it.');
      job.total = initial.size; publish(job);
      const sourceHash = (await hashPart(source, sourceRemote, session, job.total, signal)).digest('hex');
      if (!same(initial, await sourceHandleStat()) || !same(initial, await currentSource())) throw new Error('The source changed while computing its transfer fingerprint.');
      if (checkpoint && checkpoint.sourceHash !== sourceHash) throw new Error('The source contents changed. Retained data cannot be resumed.');
      if (!checkpoint) {
        const expected = await destination(job, !upload);
        job.recoveryPhase = 'setup';
        const sourceParents = await recoveryParents(sourceName(), sourceRemote, session, signal);
        const destinationParents = await recoveryParents(upload ? job.remotePath : job.localPath, upload, session, signal);
        const stageId = randomUUID(); const api = upload ? path.posix : path;
        checkpoint = { version: 1, protocol:job.protocol, transferId: job.transferId, stageId, direction: job.direction, phase: 'retained',
          identity: identity(session), host: session.host, port: session.port, localPath: job.localPath, remotePath: job.remotePath,
          stagePath: api.join(destinationParents.at(-1).path, `.termforge-${stageId}.part`),
          sourceSnapshot: initial, destinationSnapshot: expected, sourceParents, destinationParents,
          sourceHash, prefixHash: createHash('sha256').digest('hex'), total: job.total, bytes: 0,
          createdAt: Date.now(), updatedAt: Date.now(), stageIdentity: null };
        // Persist ownership before creating the stage: crash recovery can then
        // report a missing stage without leaving an untracked partial file.
        job.checkpoint = checkpoint; await saveCheckpoint(job);
        target = upload ? await call(session.sftp, 'open', [checkpoint.stagePath, 'wx+', { mode: 0o600 }], signal)
          : await fsp.open(checkpoint.stagePath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
        const stat = upload ? await call(session.sftp, 'fstat', [target], signal) : await target.stat();
        checkpoint.stageIdentity = stageIdentity(stat, upload); await saveCheckpoint(job);
        prefix = createHash('sha256');
      } else {
        if (checkpoint.phase !== 'retained') throw new Error('The previous commit outcome is unknown. Inspect the destination before retrying.');
        await validateParents();
        const destinationStat = upload ? await remoteStat(session.sftp, job.remotePath, signal) : await localStat(job.localPath);
        const destinationSnapshot = destinationStat ? (upload ? summary(destinationStat) : localSnapshot(destinationStat)) : null;
        if (!same(checkpoint.destinationSnapshot, destinationSnapshot)) throw new Error('The destination changed since the original transfer approval.');
        const stat = readableFile(upload ? await call(session.sftp, 'lstat', [checkpoint.stagePath], signal) : await fsp.lstat(checkpoint.stagePath));
        if (!checkpoint.stageIdentity || !equalParents(checkpoint.stageIdentity, stageIdentity(stat, upload)) || stat.size > checkpoint.total) throw new Error('The retained partial file identity or length changed.');
        target = upload ? await call(session.sftp, 'open', [checkpoint.stagePath, 'r+'], signal)
          : await fsp.open(checkpoint.stagePath, fs.constants.O_RDWR | NOFOLLOW);
        const opened = readableFile(upload ? await call(session.sftp, 'fstat', [target], signal) : await target.stat());
        if (!equalParents(stageIdentity(opened, upload), checkpoint.stageIdentity) || opened.size !== stat.size) throw new Error('The retained partial file changed while opening.');
        // A dropped ACK may leave additional complete bytes on the server.
        // Compare the entire actual prefix, never trust an acknowledged offset.
        const stageHash = (await hashPart(target, upload, session, stat.size, signal)).digest('hex');
        prefix = await hashPart(source, sourceRemote, session, stat.size, signal);
        if (stageHash !== prefix.copy().digest('hex')) throw new Error('Retained partial bytes do not match the original source.');
        checkpoint.bytes = stat.size; checkpoint.prefixHash = stageHash; job.bytes = stat.size; await saveCheckpoint(job);
      }
      await validateParents();
      job.recoveryPhase = 'copying';
      if(initialScp) {
        if(upload) await closeTarget();
        await scp(job,session,upload?source:target,upload?checkpoint.stagePath:job.remotePath,upload,true);
        if(upload) {
          // Some Windows SCP sinks release their file lock just after channel
          // closure. Only retry this read-only reopen, never a payload/commit.
          const reopenDeadline=Date.now()+3000;
          for(let attempt=0;;attempt++) {
            try { target=await call(session.sftp,'open',[checkpoint.stagePath,'r'],signal,Math.max(1,reopenDeadline-Date.now()));break; }
            catch(error) {
              const busy=error.code==='EBUSY'||error.code===4&&/\b(?:EBUSY|resource busy|locked)\b/i.test(error.message||'');
              if(!busy||attempt>=7||Date.now()>=reopenDeadline)throw error;
              await bounded(new Promise(resolve=>setTimeout(resolve,Math.min(250,25*2**attempt,reopenDeadline-Date.now()))),signal);
            }
          }
        }
        else await target.sync();
        const actual=readableFile(upload?await call(session.sftp,'fstat',[target],signal):await target.stat());
        if(actual.size>job.total || !equalParents(stageIdentity(actual,upload),checkpoint.stageIdentity))throw new Error('The SCP staging identity or size changed.');
        const retainedHash=(await hashPart(target,upload,session,actual.size,signal)).digest('hex');
        prefix=await hashPart(source,sourceRemote,session,actual.size,signal);
        if(retainedHash!==prefix.copy().digest('hex'))throw new Error('The retained SCP payload does not match the original source.');
        checkpoint.bytes=actual.size;checkpoint.prefixHash=retainedHash;job.bytes=actual.size;await saveCheckpoint(job);publish(job);
        if(job.pauseRequested){await closeTarget();await closeSource();return 'paused';}
        if(actual.size!==job.total)throw new Error('The SCP transfer did not retain the complete file.');
      }
      let lastSaved = checkpoint.bytes;
      const buffer = Buffer.alloc(BLOCK);
      for (let position = checkpoint.bytes; position < job.total;) {
        check(signal);
        if (job.pauseRequested) break;
        const count = await readPart(source, sourceRemote, session, buffer, Math.min(BLOCK, job.total - position), position, signal);
        if (!count) throw new Error('The source changed during the transfer.');
        if (upload) await call(session.sftp, 'write', [target, buffer, 0, count, position], signal);
        else await writeFile(target, buffer.subarray(0, count), position);
        position += count; prefix.update(buffer.subarray(0, count)); checkpoint.bytes = position;
        checkpoint.prefixHash = prefix.copy().digest('hex'); progress(job, count);
        if (position - lastSaved >= 1024 * 1024) { if (!upload) await target.sync(); await saveCheckpoint(job); lastSaved = position; }
      }
      if (!upload) await target.sync();
      if (job.pauseRequested) {
        await closeTarget(); await closeSource(); await saveCheckpoint(job);
        return 'paused';
      }
      check(signal);
      job.recoveryPhase = 'hashing';
      if (!same(checkpoint.sourceSnapshot, await sourceHandleStat()) || !same(checkpoint.sourceSnapshot, await currentSource())) throw new Error('The source changed during the transfer.');
      const completeHash = (await hashPart(target, upload, session, job.total, signal)).digest('hex');
      if (completeHash !== checkpoint.sourceHash) throw new Error('The completed staging file does not match the original source fingerprint.');
      const finalStage = readableFile(upload ? await call(session.sftp, 'fstat', [target], signal) : await target.stat());
      if (finalStage.size !== job.total) throw new Error('The staging file length changed before commit.');
      await validateParents(); await closeTarget(); await closeSource();
      const namedStage = readableFile(upload ? await call(session.sftp, 'lstat', [checkpoint.stagePath], signal) : await fsp.lstat(checkpoint.stagePath));
      if (!equalParents(stageIdentity(namedStage, upload), checkpoint.stageIdentity)
        || !same(upload ? summary(finalStage) : localSnapshot(finalStage), upload ? summary(namedStage) : localSnapshot(namedStage))) throw new Error('The staging pathname changed before commit.');
      if (upload) {
        // SFTP v3 exposes no inode identity. Reopen the named stage and verify
        // its bytes immediately before RENAME rather than trusting an old handle.
        const namedHandle = await call(session.sftp, 'open', [checkpoint.stagePath, 'r'], signal);
        try {
          if ((await hashPart(namedHandle, true, session, job.total, signal)).digest('hex') !== checkpoint.sourceHash) throw new Error('The remote staging pathname contents changed before commit.');
        } finally { await quiet(() => call(session.sftp, 'close', [namedHandle], undefined, 3000)); }
      }
      await job.beforeCommit?.();
      if(job.preapprovedDestination) { if(upload) await call(session.sftp,'setstat',[checkpoint.stagePath,{mode:parseInt(job.preapprovedDestination.permissions,8)}],signal); else await fsp.chmod(checkpoint.stagePath,parseInt(job.preapprovedDestination.permissions,8)); }
      job.recoveryPhase = 'committing'; checkpoint.phase = 'committing'; await saveCheckpoint(job);
      if (upload) await commitRemote(session.sftp, checkpoint.stagePath, job.remotePath, checkpoint.destinationSnapshot, job);
      else await commitLocal(checkpoint.stagePath, await localContext(job.localPath), checkpoint.destinationSnapshot, job);
      if(job.completeCheckpoint) await job.completeCheckpoint(); else await recovery.remove(job.transferId); job.checkpoint = null; return 'completed';
    } catch (error) {
      if (checkpoint) {
        if (checkpoint.phase === 'committing') checkpoint.phase = 'indeterminate';
        // Once cancellation requested, preserve the checkpoint until explicit
        // verified discard. This also handles writes whose ACK was lost.
        try { await saveCheckpoint(job); } catch (saveError) { job.warning = `Recovery checkpoint could not be updated: ${plainError(saveError)}`; }
        error.recoverable = true;
      }
      if (error.indeterminate) { session.closed = true; session.client.end(); }
      throw error;
    } finally { await closeTarget(); await closeSource(); }
  }

  function assertRecoveryAvailable(exceptTransferId) {
    if (!initialized) throw new Error('Transfer recovery is still loading.');
    if (recoveryError) throw new Error(recoveryError);
    if ([...jobs.values()].some(job => job.transferId !== exceptTransferId && RETAINED.has(job.status) && job.checkpoint)) throw new Error('Resume or discard retained partial transfers before starting another file operation.');
  }
  async function pause(transferId) {
    const job = jobs.get(transferId);
    if (!job?.resumable || inactive(job)) return false;
    if (job.status === 'verifying' || job.status === 'discarding') { job.controller.abort(); await job.done; return false; }
    if (job.commitStarted) { if(job.kind==='folder')job.pauseRequested=true; await job.done; return job.kind==='folder'&&job.status==='paused'; }
    if (!job.checkpoint || job.recoveryPhase === 'hashing') {
      job.controller.abort();
      if (job.status === 'queued') { job.status = 'cancelled'; job.error = 'Transfer stopped before a resumable checkpoint was created. Start it again.'; job.finishedAt = Date.now(); publish(job); job.resolveDone(); }
      await job.done; return false;
    }
    job.pauseRequested = true;
    if (job.status === 'running') { job.status = 'pausing'; publish(job); }
    await job.done; return job.status === 'paused';
  }
  async function resume({ transferId, id } = {}) {
    await initializeRecovery(); if (stopped) throw new Error('The transfer manager is stopping.');
    const job = jobs.get(transferId), session = getSession(id);
    if (!job?.resumable || !RETAINED.has(job.status) || job.checkpoint?.phase !== 'retained' || (job.checkpoint.child && job.checkpoint.child.phase !== 'retained')) throw new Error('This transfer has no resumable retained partial file.');
    // Several queued jobs can be retained by a shutdown. They may be resumed
    // serially; each revalidates its full source, destination and owned stage.
    remoteFiles.available(); folderFiles.available();
    if (editor.busy) throw new Error('Finish the remote edit operation before resuming a transfer.');
    if ([...jobs.values()].some(item => !inactive(item))) throw new Error('Wait for active transfers before resuming a partial file.');
    if (job.checkpoint.identity !== identity(session)) throw new Error('Resume requires the original authenticated server and account.');
    const previous = job.status; job.id = id; job.controller = new AbortController(); job.status = 'verifying'; publish(job);
    let done; job.done = new Promise(resolve => { done = resolve; }); job.resolveDone = done;
    try {
      const accepted = await bounded(confirmResume({ ...view(job), host: session.host, port: session.port,
        source: job.direction === 'upload' ? job.localPath : job.remotePath,
        destination: job.direction === 'upload' ? job.remotePath : job.localPath }, { signal: job.controller.signal }), job.controller.signal, 10 * 60 * 1000);
      check(job.controller.signal); getSession(id);
      if (!accepted) { job.status = previous; publish(job); return { cancelled: true }; }
      job.id = id; job.status = 'queued'; job.pauseRequested = false; job.disconnected = false; job.commitStarted = false;
      job.error = ''; job.warning = ''; job.finishedAt = null;
      queue.push(job); publish(job); queueMicrotask(() => { void processQueue(); }); return view(job);
    } catch (error) { job.status = previous; publish(job); throw error; }
    finally { if (RETAINED.has(job.status)) done(); }
  }
  async function discardPartial({ transferId, id } = {}) {
    await initializeRecovery(); const job = jobs.get(transferId);
    if (!job?.checkpoint || !RETAINED.has(job.status)) return false;
    if (stopped) throw new Error('The transfer manager is stopping.');
    if ([...jobs.values()].some(item => !inactive(item)) || editor.busy || folderFiles.busy) throw new Error('Wait for active file operations before discarding a retained transfer.');
    remoteFiles.available();
    const cp = job.checkpoint, upload = cp.direction === 'upload';
    const previous = job.status;
    job.controller = new AbortController(); job.status = 'discarding';
    if (id) job.id = id;
    if ((!upload || cp.phase !== 'retained') && !sessions.has(job.id)) job.id = '';
    let done; job.done = new Promise(resolve => { done = resolve; }); job.resolveDone = done; publish(job);
    try {
    const forgetOnly = cp.phase !== 'retained' || cp.kind === 'folder';
    const accepted = await bounded(confirmDiscardPartial({ ...view(job), host: cp.host, port: cp.port, stagePath: cp.stagePath || cp.child?.stagePath || (upload?cp.remotePath:cp.localPath), forgetOnly }, { signal: job.controller.signal }), job.controller.signal, 10 * 60 * 1000);
    check(job.controller.signal);
    if (!accepted) return { cancelled: true };
    if (forgetOnly) {
      await recovery.remove(transferId); job.checkpoint = null; job.status = 'cancelled'; job.finishedAt = Date.now();
      const retainedFiles=[cp.stagePath||cp.child?.stagePath,upload?cp.remotePath:cp.localPath].filter(Boolean);
      job.warning = `Recovery record removed. Completed output and any staging/recovery files were left untouched. Inspect ${retainedFiles.join(' and ')}.`;
      publish(job); return { discarded: true, retainedFiles };
    }
    const session = upload ? getSession(id || job.id) : (sessions.get(id || job.id) || null);
    if (upload && identity(session) !== cp.identity) throw new Error('Discard requires the original authenticated server and account.');
    const signal = job.controller.signal;
    const parents = await recoveryParents(upload ? cp.remotePath : cp.localPath, upload, session, signal);
    if (!equalParents(parents, cp.destinationParents)) throw new Error('The retained transfer parent changed; no file was removed.');
    const stat = upload ? await remoteStat(session.sftp, cp.stagePath, signal) : await localStat(cp.stagePath);
    if (stat) {
      if (kind(stat) !== 'file' || !equalParents(stageIdentity(stat, upload), cp.stageIdentity) || stat.size !== cp.bytes) throw new Error('The retained partial file changed; inspect it manually. No file was removed.');
      const handle = upload ? await call(session.sftp, 'open', [cp.stagePath, 'r'], signal) : await fsp.open(cp.stagePath, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        if ((await hashPart(handle, upload, session, stat.size, signal)).digest('hex') !== cp.prefixHash) throw new Error('The retained partial contents changed; no file was removed.');
      } finally { if (upload) await quiet(() => call(session.sftp, 'close', [handle], undefined, 3000)); else await handle.close(); }
      const latest = upload ? await remoteStat(session.sftp, cp.stagePath, signal) : await localStat(cp.stagePath);
      if (!latest || !same(upload ? summary(stat) : localSnapshot(stat), upload ? summary(latest) : localSnapshot(latest))) throw new Error('The retained partial changed before cleanup; no file was removed.');
      check(job.controller.signal);
      if (upload) await call(session.sftp, 'unlink', [cp.stagePath], undefined, commitTimeoutMs); else await fsp.unlink(cp.stagePath);
    }
    check(signal); await recovery.remove(transferId); job.checkpoint = null; job.status = 'cancelled'; job.finishedAt = Date.now(); job.warning = ''; publish(job); return { discarded: true, retainedFiles: [] };
    } finally { if (job.status === 'discarding') { job.status = previous; publish(job); } done(); }
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        if (job.status === 'cancelled') continue;
        job.status = 'running'; job.startedAt = Date.now(); publish(job);
        try {
          check(job.controller.signal);
          const session = getSession(job.id);
          let result;
          if (job.resumable && job.kind === 'folder') result = await folderRecovery.run(job,session);
          else if (job.resumable) result = await recoverableCopy(job, session);
          else if (job.kind === 'folder') await folderFiles.run(job, session);
          else if (job.direction === 'upload') await upload(job, session); else await download(job, session);
          // Completion wins once the atomic commit has succeeded.
          job.status = result === 'paused' ? 'paused' : 'completed';
        } catch (error) {
          job.status = error.recoverable ? 'interrupted' : job.controller.signal.aborted && !job.commitStarted && !error.indeterminate ? 'cancelled' : 'failed'; job.error = plainError(error);
          if (job.kind === 'folder' && (job.filesCompleted || job.directoriesCreated || job.deletedFiles || job.deletedDirectories)) job.warning = `Partial folder operation: ${job.filesCompleted} of ${job.filesTotal} files completed; ${job.directoriesCreated} folders created; ${job.deletedFiles||0} files and ${job.deletedDirectories||0} folders deleted. Completed operations remain in place.`;
        }
        job.finishedAt = Date.now(); publish(job); job.resolveDone();
      }
    } finally { processing = false; }
  }
  function start(input = {}) {
    if (stopped) throw new Error('The transfer manager is stopping.');
    assertRecoveryAvailable();
    const session = getSession(input.id);
    remoteFiles.available(input.id);
    folderFiles.available();
    if (editor.busy) throw new Error('Finish the remote edit operation before starting a transfer.');
    if (!['upload', 'download'].includes(input.direction)) throw new Error('Choose upload or download.');
    if (!['sftp', 'scp'].includes(input.protocol)) throw new Error('Choose SFTP or SCP.');
    const job = { transferId: randomUUID(), id: session.id, direction: input.direction, protocol: input.protocol,
      localPath: localPath(input.localPath), remotePath: remotePath(input.remotePath), status: 'queued', bytes: 0, total: 0, controller: new AbortController() };
    if (input.resumable === true) {
      if (!recovery) throw new Error('Resumable transfers require SFTP support and a private recovery directory.');
      identity(session); job.resumable = true;
    }
    if (!validName(path.posix.basename(job.remotePath)) || !validLocalName(path.basename(job.localPath))) throw new Error('Select an individual regular file with a valid filename for this computer.');
    if (!path.posix.isAbsolute(job.remotePath)) job.remotePath = path.posix.join(session.remotePath, job.remotePath);
    enqueue(job); return view(job);
  }
  function enqueue(job) {
    for (const [id, previous] of jobs) { if (jobs.size < MAX_JOBS) break; if (DONE.has(previous.status)) jobs.delete(id); }
    if (jobs.size >= MAX_JOBS) throw new Error('The transfer queue is full (100 jobs).');
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    jobs.set(job.transferId, job); queue.push(job); publish(job);
    queueMicrotask(() => { void processQueue(); });
  }
  async function cancel(transferId) {
    const job = jobs.get(transferId); if (!job) return false;
    if (DONE.has(job.status)) return false;
    if (job.resumable) {
      if (!inactive(job)) await pause(transferId);
      if (RETAINED.has(job.status)) return discardPartial({ transferId, id: job.id });
      return false;
    }
    job.controller.abort();
    if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = Date.now(); publish(job); job.resolveDone(); }
    await job.done; return true;
  }
  async function close(id) {
    const session = sessions.get(id); if (!session) return false;
    await editor.closeConnection(id);
    await remoteFiles.close(id);
    await Promise.all([...jobs.values()].filter(job => job.id === id && !inactive(job)).map(job => job.resumable ? pause(job.transferId) : cancel(job.transferId)));
    await folderFiles.close(id);
    session.closed = true;
    sessions.delete(id); session.sftp.end(); session.client.end(); return true;
  }
  async function closeAll() {
    stopped = true;
    const pending = [...pendingOpens]; for (const item of pending) item.controller.abort();
    // A disconnected session leaves the map before its job's finally cleanup
    // has finished. Await those jobs independently of the live connections.
    const stoppingJobs = [...jobs.values()].filter(job => !inactive(job)).map(job => job.resumable ? pause(job.transferId) : cancel(job.transferId));
    await Promise.all(stoppingJobs);
    await Promise.all([...sessions.keys()].map(close).concat(pending.map(item => item.done), remoteFiles.closeAll(), folderFiles.closeAll(), editor.closeAll()));
  }

  function assertExternalAvailable() { assertRecoveryAvailable(); folderFiles.available(); remoteFiles.available(); if(editor.busy || [...jobs.values()].some(job=>!inactive(job)))throw new Error('Wait for active file operations before starting another transfer.'); }
  return { assertExternalAvailable, open, close, closeAll, listLocal, listRemote, start, cancel, pause, resume, discardPartial, initializeRecovery, assertRecoveryAvailable,
    prepareRemoteOperation: input => { assertRecoveryAvailable(); return remoteFiles.prepare(input); }, applyRemoteOperation: remoteFiles.apply, discardRemoteOperation: remoteFiles.discard,
    prepareFolderTransfer: input => { assertRecoveryAvailable(); return folderFiles.prepare(input); },
    startFolderTransfer: async input => { const result = await folderFiles.start(input); return result.cancelled ? result : view(result); },
    discardFolderTransfer: folderFiles.discard,
    listSyncPairs: input => { assertRecoveryAvailable(); return folderFiles.listSyncPairs(input); },
    forgetSyncPair: input => { assertRecoveryAvailable(); return folderFiles.forgetSyncPair(input); },
    remoteEditOpen: editor.open, remoteEditPrepareSave: editor.prepareSave, remoteEditSave: editor.save,
    remoteEditDiscardSave: editor.discardSave, remoteEditClose: editor.close,
    get remoteEditCount() { return editor.count; },
    get recoveryError() { return recoveryError; },
    listJobs: () => [...jobs.values()].map(view),
    get count() {
      const owned = new Set(sessions.keys());
      for (const job of jobs.values()) if (!inactive(job)) owned.add(job.id);
      for (const id of remoteFiles.activeIds) owned.add(id);
      for (const id of folderFiles.activeIds) owned.add(id);
      for (const id of editor.activeIds) owned.add(id);
      return owned.size + pendingOpens.size;
    } };
}

module.exports = { createSecureTransfers };
