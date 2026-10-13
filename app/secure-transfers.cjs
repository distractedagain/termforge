'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const BLOCK = 64 * 1024;
const MAX_FILE = 1024 ** 4;
const MAX_JOBS = 100;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const DONE = new Set(['completed', 'failed', 'cancelled']);

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
  return { type: kind(stat), size: stat.size, mtime: stat.mtimeMs ?? stat.mtime * 1000 };
}
function same(a, b, moved = false) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.size === b.size && a.mtime === b.mtime
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

function createSecureTransfers({ connect, emit = () => {}, confirmOverwrite = async () => false, home = os.homedir(), commitTimeoutMs = 30000 } = {}) {
  if (typeof connect !== 'function') throw new TypeError('A verified SSH connection factory is required.');
  if (!Number.isInteger(commitTimeoutMs) || commitTimeoutMs < 1 || commitTimeoutMs > 30000) throw new TypeError('Invalid commit operation timeout.');
  const sessions = new Map(); const jobs = new Map(); const queue = []; const pendingOpens = new Set();
  let processing = false; let stopped = false;

  function getSession(id) { const session = sessions.get(id); if (!session || session.closed) throw new Error('The file-transfer session is closed.'); return session; }
  function view(job) {
    return { transferId: job.transferId, id: job.id, sessionId: job.id, direction: job.direction, protocol: job.protocol,
      localPath: job.localPath, remotePath: job.remotePath, status: job.status, bytes: job.bytes, transferred: job.bytes,
      total: job.total, error: job.error || '', warning: job.warning || '', startedAt: job.startedAt || null, finishedAt: job.finishedAt || null };
  }
  function publish(job) { try { emit({ type: 'transfer', ...view(job) }); } catch {} }
  function progress(job, count) { job.bytes += count; if (Date.now() - (job.lastProgress || 0) >= 100 || job.bytes === job.total) { job.lastProgress = Date.now(); publish(job); } }

  async function open(profile, { signal } = {}) {
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
      const session = { id, client, sftp, remotePath: currentPath, closed: false };
      sessions.set(id, session);
      client.once('close', () => {
        session.closed = true; sessions.delete(id);
        for (const job of jobs.values()) if (job.id === id && !DONE.has(job.status)) job.controller.abort();
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
    if (stat) readableFile(stat);
    const snapshot = stat ? (local ? localSnapshot(stat) : summary(stat)) : null;
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
    const target = context.target; const existing = await localStat(target);
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

  async function scp(job, session, file, remote, upload) {
    const signal = job.controller.signal;
    const command = `scp ${upload ? '-t' : '-f'} -- ${shellQuote(remote)}`;
    const channel = await bounded(new Promise((resolve, reject) => session.client.exec(command, { pty: false }, (error, result) => {
      if (signal.aborted && result) result.destroy();
      error ? reject(error) : resolve(result);
    })), signal);
    const reader = new ScpReader(channel, signal);
    try {
      if (upload) {
        await reader.ack();
        await writeChannel(channel, `C0600 ${job.total} ${path.posix.basename(remote)}\n`, signal);
        await reader.ack();
        const buffer = Buffer.alloc(BLOCK);
        for (let position = 0; position < job.total;) {
          check(signal);
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
        await call(sftp, 'close', [handle], signal); handle = null;
      }
      if (!same(localSnapshot(initial), localSnapshot(await source.stat()))) throw new Error('The local source file changed during transfer.');
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
      await target.sync(); await target.close(); target = null;
      await commitLocal(stage, context, expected, job); committed = true;
    } finally {
      if (source) await quiet(() => call(sftp, 'close', [source], undefined, 3000));
      if (target) await quiet(() => target.close());
      if (!committed) await quiet(() => fsp.unlink(stage));
    }
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
          if (job.direction === 'upload') await upload(job, session); else await download(job, session);
          // Completion wins once the atomic commit has succeeded.
          job.status = 'completed';
        } catch (error) { job.status = job.controller.signal.aborted && !job.commitStarted ? 'cancelled' : 'failed'; job.error = plainError(error); }
        job.finishedAt = Date.now(); publish(job); job.resolveDone();
      }
    } finally { processing = false; }
  }
  function start(input = {}) {
    const session = getSession(input.id);
    if (!['upload', 'download'].includes(input.direction)) throw new Error('Choose upload or download.');
    if (!['sftp', 'scp'].includes(input.protocol)) throw new Error('Choose SFTP or SCP.');
    for (const [id, job] of jobs) { if (jobs.size < MAX_JOBS) break; if (DONE.has(job.status)) jobs.delete(id); }
    if (jobs.size >= MAX_JOBS) throw new Error('The transfer queue is full (100 files).');
    const job = { transferId: randomUUID(), id: session.id, direction: input.direction, protocol: input.protocol,
      localPath: localPath(input.localPath), remotePath: remotePath(input.remotePath), status: 'queued', bytes: 0, total: 0, controller: new AbortController() };
    if (!validName(path.posix.basename(job.remotePath)) || !validLocalName(path.basename(job.localPath))) throw new Error('Select an individual regular file with a valid filename for this computer.');
    if (!path.posix.isAbsolute(job.remotePath)) job.remotePath = path.posix.join(session.remotePath, job.remotePath);
    job.done = new Promise(resolve => { job.resolveDone = resolve; });
    jobs.set(job.transferId, job); queue.push(job); publish(job);
    queueMicrotask(() => { void processQueue(); });
    return view(job);
  }
  async function cancel(transferId) {
    const job = jobs.get(transferId); if (!job) return false;
    if (DONE.has(job.status)) return false;
    job.controller.abort();
    if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = Date.now(); publish(job); job.resolveDone(); }
    await job.done; return true;
  }
  async function close(id) {
    const session = sessions.get(id); if (!session) return false;
    session.closed = true;
    await Promise.all([...jobs.values()].filter(job => job.id === id && !DONE.has(job.status)).map(job => cancel(job.transferId)));
    sessions.delete(id); session.sftp.end(); session.client.end(); return true;
  }
  async function closeAll() {
    stopped = true;
    const pending = [...pendingOpens]; for (const item of pending) item.controller.abort();
    // A disconnected session leaves the map before its job's finally cleanup
    // has finished. Await those jobs independently of the live connections.
    const stoppingJobs = [...jobs.values()].filter(job => !DONE.has(job.status)).map(job => cancel(job.transferId));
    await Promise.all([...sessions.keys()].map(close).concat(pending.map(item => item.done), stoppingJobs));
  }

  return { open, close, closeAll, listLocal, listRemote, start, cancel, listJobs: () => [...jobs.values()].map(view),
    get count() {
      const owned = new Set(sessions.keys());
      for (const job of jobs.values()) if (!DONE.has(job.status)) owned.add(job.id);
      return owned.size + pendingOpens.size;
    } };
}

module.exports = { createSecureTransfers };
