'use strict';

// FTP has no portable conditional rename or authenticated file identity. This
// adapter stages files, reviews replacements, rechecks metadata, and retains
// backups. Reviewed folder copies and content-verified recovery are separate
// workflows; FTP server metadata cannot provide remote no-follow guarantees.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const tls = require('node:tls');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { Client } = require('basic-ftp');
const { createFtpWorkflows } = require('./ftp-workflows.cjs');

const MAX_FILE = 1024 ** 4;
const MAX_ENTRIES = 10000;
const FINISHED = new Set(['completed', 'failed', 'cancelled', 'paused', 'interrupted']);
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
function cancelled() { return Object.assign(new Error('FTP operation cancelled.'), { name: 'AbortError' }); }
function check(signal) { if (signal?.aborted) throw cancelled(); }
function cleanError(error) { if (error?.name === 'FTPError' && Number.isInteger(error.code)) return `FTP server rejected the operation (reply ${error.code}).`; return String(error?.message || error || 'FTP operation failed.').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 650); }
function name(value) { return typeof value === 'string' && value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/.test(value); }
function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split('/').slice(1).some((part, i, parts) => part === '.' || part === '..' || (!part && i !== parts.length - 1) || part && !name(part))) throw new Error('Use an absolute FTP path without dot segments, control characters, or backslashes.');
  return value === '/' ? value : value.replace(/\/$/, '');
}
function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use an absolute local file path.');
  const base = path.basename(value);
  if (!name(base) || process.platform === 'win32' && (/[<>:"|?*]/.test(base) || /[. ]$/.test(base) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base))) throw new Error('Invalid local filename.');
  return path.resolve(value);
}
function credential(value, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid FTP ${label}.`);
  return value;
}
function profileInput(input) {
  if (!input || !['ftp', 'ftps', 'ftps-implicit'].includes(input.protocol)) throw new Error('Choose FTP, explicit FTPS, or implicit FTPS.');
  const host = input.host || input.hostname;
  if (typeof host !== 'string' || !host || host.length > 253 || /[\s/@\\\x00-\x1f\x7f]/.test(host)) throw new Error('Invalid FTP server hostname.');
  const port = input.port === undefined || input.port === '' ? (input.protocol === 'ftps-implicit' ? 990 : 21) : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FTP port.');
  // TLS options and passwords supplied by a renderer are intentionally ignored.
  return { protocol: input.protocol, host, port, username: input.username ? credential(input.username, 'username') : '' };
}
function fileSize(value) { if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FILE) throw new Error('FTP files must be no larger than 1 TiB.'); return value; }
function localSnapshot(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular files can be transferred. Symbolic links are not followed.');
  return { type: 'file', size: fileSize(stat.size), mtime: stat.mtimeMs, ctime: stat.ctimeMs, mode: stat.mode, dev: stat.dev, ino: stat.ino };
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function localStat(filename) { try { return localSnapshot(await fsp.lstat(filename)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function localParent(filename) {
  const parent = path.dirname(filename); const canonical = await fsp.realpath(parent); const stat = await fsp.lstat(parent);
  if (canonical !== parent || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a local directory without symbolic-link parents.');
  return { parent, dev: stat.dev, ino: stat.ino };
}
function bounded(promise, signal, timeout = 120000, onAbort = () => {}) {
  check(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { onAbort(); finish(cancelled()); };
    const timer = setTimeout(() => { onAbort(); finish(new Error('FTP operation timed out.')); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}

function createFtpTransfers({ emit = () => {}, requestAuthentication = async () => null, confirmPlaintext = async () => false,
  confirmOverwrite = async () => false, home = os.homedir(), timeoutMs = 30000, tlsCa, ClientClass = Client,
  recoveryDirectory, confirmResume, confirmDiscardPartial, confirmFolderTransfer } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid FTP timeout.');
  const sessions = new Map(); const jobs = new Map(); const pending = new Set(); const browsing = new Set(); const queue = [];
  let stopped = false; let processing = false;
  const send = value => { try { emit(value); } catch {} };
  const get = id => { const session = sessions.get(id); if (!session || session.closed || session.client.closed) throw new Error('The FTP connection is closed. Reconnect before continuing.'); return session; };
  const jobView = job => ({ transferId: job.transferId, id: job.id, sessionId: job.id, host: job.host, port: job.port, protocol: job.protocol, direction: job.direction,
    localPath: job.localPath, remotePath: job.remotePath, status: job.status, bytes: job.bytes, transferred: job.bytes, total: job.total, error: job.error || '', warning: job.warning || '', ...workflows.decorate(job),
    startedAt: job.startedAt || null, finishedAt: job.finishedAt || null });
  const publish = job => send({ type: 'transfer', ...jobView(job) });
  const workflows = createFtpWorkflows({jobs,get,publish,jobView,enqueue,listing,parents,remoteStat,localParent,localPath,remotePath,cleanError,bounded,confirmOverwrite,
    hasBrowsing:()=>browsing.size>0,stopped:()=>stopped},{recoveryDirectory,confirmResume,confirmDiscardPartial,confirmFolderTransfer});
  function disconnected(session) {
    if (session.closed) return;
    session.closed = true; sessions.delete(session.id);
    for (const job of jobs.values()) if (job.id === session.id && !FINISHED.has(job.status)) job.controller.abort();
    send({ type: 'connection', id: session.id, status: 'closed' });
  }
  async function open(input, { signal: outside } = {}) {
    if (stopped) throw new Error('The FTP manager is stopping.');
    await workflows.initializeRecovery();
    if (stopped) throw new Error('The FTP manager is stopping.');
    if (sessions.size + pending.size >= 16) throw new Error('Close a file-transfer connection before opening another.');
    const profile = profileInput(input); const controller = new AbortController();
    const signal = outside ? AbortSignal.any([outside, controller.signal]) : controller.signal;
    let resolveDone; const record = { controller, done: new Promise(resolve => { resolveDone = resolve; }) }; pending.add(record);
    let client; let password;
    try {
      check(signal);
      if (profile.protocol === 'ftp' && !await bounded(Promise.resolve().then(() => confirmPlaintext({ ...profile, signal }, { signal })), signal)) throw new Error('Plaintext FTP was declined. Choose FTPS to encrypt credentials and files.');
      check(signal);
      const prompt = async (kind, echo) => {
        const answers = await bounded(Promise.resolve().then(() => requestAuthentication({ host: profile.host, port: profile.port, username: profile.username,
          protocol: profile.protocol, kind, instructions: profile.protocol === 'ftp' ? 'Plaintext FTP: this server receives the login and file contents without encryption.' : 'FTPS verifies the server certificate before sending this login.', prompts: [{ prompt: kind === 'username' ? 'Username' : 'Password', echo }], signal })), signal);
        check(signal); if (answers === null) throw cancelled();
        if (!Array.isArray(answers) || answers.length !== 1) throw new Error('Invalid FTP authentication response.');
        return credential(answers[0], kind, kind === 'password');
      };
      if (!profile.username) profile.username = await prompt('username', true);
      password = await prompt('password', false);
      client = new ClientClass(timeoutMs, { allowSeparateTransferHost: false, maxListingBytes: 2 * 1024 * 1024 });
      client.ftp.verbose = false;
      const secure = profile.protocol === 'ftps-implicit' ? 'implicit' : profile.protocol === 'ftps';
      const secureOptions = { rejectUnauthorized: true, minVersion: 'TLSv1.2', host: profile.host,
        ...(!net.isIP(profile.host) ? { servername: profile.host } : {}), checkServerIdentity: (_host, cert) => tls.checkServerIdentity(profile.host, cert), ...(tlsCa ? { ca: tlsCa } : {}) };
      await bounded(client.access({ host: profile.host, port: profile.port, user: profile.username, password, secure, secureOptions }), signal, 120000, () => client.close());
      password = undefined;
      if (secure) { await bounded(client.send('PBSZ 0'), signal, timeoutMs, () => client.close()); await bounded(client.send('PROT P'), signal, timeoutMs, () => client.close()); }
      const currentPath = remotePath(await bounded(client.pwd(), signal, timeoutMs, () => client.close()));
      check(signal); if (stopped) throw cancelled();
      const certificateIdentity = secure ? client.ftp.socket.getPeerCertificate()?.fingerprint256 : '';
      if (secure && !certificateIdentity) throw new Error('FTPS peer certificate identity is unavailable.');
      const id = randomUUID(); const session = { ...profile, id, client, certificateIdentity, closed: false, busy: false };
      sessions.set(id, session); client.ftp.socket.once('close', () => disconnected(session));
      return { id, host: profile.host, port: profile.port, protocol: profile.protocol, remotePath: currentPath,
        capabilities: workflows.capabilities() };
    } catch (error) { client?.close(); const message = cleanError(error); throw new Error(password ? message.split(password).join('[redacted]') : message); }
    finally { password = undefined; controller.abort(); pending.delete(record); resolveDone(); }
  }
  function entry(item) {
    if (!name(item.name)) throw new Error('The FTP server returned an unsafe directory entry.');
    const type = item.isSymbolicLink || item.type === 3 ? 'symlink' : item.isDirectory || item.type === 2 ? 'directory' : item.isFile || item.type === 1 ? 'file' : 'other';
    return { name: item.name, type, size: type === 'file' ? fileSize(item.size) : 0, mtime: item.modifiedAt instanceof Date ? item.modifiedAt.getTime() : null,
      rawModified: String(item.rawModifiedAt || '').slice(0, 100) };
  }
  async function listing(session, requested) {
    const items = await session.client.list(requested);
    if (!Array.isArray(items) || items.length > MAX_ENTRIES) throw new Error('This FTP directory contains more than 10,000 entries.');
    const entries = items.filter(item => !['.', '..'].includes(item.name)).map(entry); const names = new Set();
    for (const item of entries) { if (names.has(item.name)) throw new Error('The FTP server returned duplicate directory entries.'); names.add(item.name); }
    return entries;
  }
  async function parents(session, filename) {
    let current = '/';
    for (const part of path.posix.dirname(filename).split('/').filter(Boolean)) {
      const item = (await listing(session, current)).find(item => item.name === part);
      if (!item || item.type !== 'directory') throw new Error('FTP transfers require directory parents without symbolic links.');
      current = path.posix.join(current, part);
    }
  }
  async function remoteStat(session, filename) { return (await listing(session, path.posix.dirname(filename))).find(item => item.name === path.posix.basename(filename)) || null; }
  async function listRemote({ id, path: requested = '/' } = {}) {
    const session = get(id); requested = remotePath(requested);
    if (workflows.busy || session.busy || [...jobs.values()].some(job => job.id === id && !FINISHED.has(job.status))) throw new Error('Wait for the active FTP operation before browsing.');
    session.busy = true; let finishBrowse; const ownership = {id, done:new Promise(resolve => { finishBrowse = resolve; })}; browsing.add(ownership);
    try { if (requested !== '/') await parents(session, `${requested}/__listing__`); return { path: requested, entries: await listing(session, requested) }; }
    catch (error) { if (session.client.closed) disconnected(session); throw new Error(cleanError(error)); }
    finally { session.busy = false; browsing.delete(ownership); finishBrowse(); }
  }
  async function listLocal({ path: requested = home } = {}) {
    const resolved = await fsp.realpath(requested || home); const items = await fsp.readdir(resolved, { withFileTypes: true });
    if (items.length > MAX_ENTRIES) throw new Error('This directory contains more than 10,000 entries.');
    const entries = [];
    for (const item of items) if (name(item.name)) { const stat = await fsp.lstat(path.join(resolved, item.name)); entries.push({ name: item.name, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, mtime: stat.mtimeMs }); }
    return { path: resolved, entries };
  }
  function start(input) {
    if (stopped) throw new Error('The FTP manager is stopping.');
    workflows.assertAvailable();
    const session = get(input?.id);
    if (session.busy) throw new Error('Wait for FTP browsing to finish before transferring.');
    if (!['upload', 'download'].includes(input.direction) || input.protocol && input.protocol !== session.protocol) throw new Error('Invalid FTP transfer request.');
    if (input.resumable && !recoveryDirectory) throw new Error('FTP recovery directory is not configured.');
    if ([...jobs.values()].filter(job => !FINISHED.has(job.status)).length >= 100) throw new Error('The FTP transfer queue is full.');
    while (jobs.size >= 100) { const oldest = [...jobs.values()].find(job => FINISHED.has(job.status) && !job.checkpoint); if (!oldest) break; jobs.delete(oldest.transferId); }
    const job = { transferId: randomUUID(), id: session.id, host: session.host, port: session.port, protocol: session.protocol, direction: input.direction,
      localPath: localPath(input.localPath), remotePath: remotePath(input.remotePath), bytes: 0, total: 0, status: 'queued', kind:'file', resumable:Boolean(input.resumable), advanced:Boolean(input.resumable), controller: new AbortController() };
    if (job.remotePath === '/') throw new Error('Choose an FTP filename.');
    enqueue(job); return jobView(job);
  }
  function enqueue(job) {
    if (stopped) throw new Error('The FTP manager is stopping.');
    if (!jobs.has(job.transferId) && jobs.size >= 100) { const old=[...jobs.values()].find(j=>FINISHED.has(j.status)&&!j.checkpoint); if(old)jobs.delete(old.transferId);else throw new Error('The FTP transfer queue is full.'); }
    job.done=new Promise(resolve=>{job.resolveDone=resolve;});jobs.set(job.transferId,job);queue.push(job);publish(job);queueMicrotask(()=>void pump());
  }
  async function target(job, session) {
    const value = job.direction === 'upload' ? await remoteStat(session, job.remotePath) : await localStat(job.localPath);
    if (value && value.type !== 'file') throw new Error('The FTP destination must be a regular file.');
    if (value && !await bounded(Promise.resolve().then(() => confirmOverwrite({ direction: job.direction, protocol: job.protocol,
      source: job.direction === 'upload' ? job.localPath : job.remotePath, destination: job.direction === 'upload' ? job.remotePath : job.localPath,
      host: job.host, port: job.port, signal: job.controller.signal })), job.controller.signal)) throw new Error('Overwrite was declined.');
    check(job.controller.signal); return value;
  }
  function progress(job, count) { job.bytes += count; if (job.bytes > job.total) throw new Error('FTP source exceeded its reviewed size.'); if (Date.now() - (job.lastProgress || 0) > 100 || job.bytes === job.total) { job.lastProgress = Date.now(); publish(job); } }
  async function run(job, session) {
    const signal = job.controller.signal; const parent = await localParent(job.localPath); await parents(session, job.remotePath); check(signal);
    const expected = await target(job, session); const stage = job.direction === 'upload' ? path.posix.join(path.posix.dirname(job.remotePath), `.termforge-${randomUUID()}.part`) : path.join(parent.parent, `.termforge-${randomUUID()}.part`);
    let stageCreated = false; let handle; let source; let sink;
    const abort = () => { source?.destroy(cancelled()); sink?.destroy(cancelled()); session.client.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      check(signal);
      if (job.direction === 'upload') {
        handle = await fsp.open(job.localPath, fs.constants.O_RDONLY | NOFOLLOW); const before = localSnapshot(await handle.stat()); job.total = before.size; publish(job);
        if (await remoteStat(session, stage)) throw new Error('The FTP staging filename already exists.');
        source = handle.createReadStream({ autoClose: false });
        const counter = new Transform({ transform(chunk, _encoding, callback) { try { progress(job, chunk.length); callback(null, chunk); } catch (error) { callback(error); } } });
        source.on('error', error => counter.destroy(error)); counter.on('error', () => source.destroy());
        stageCreated = true;
        await session.client.uploadFrom(source.pipe(counter), stage); check(signal);
        if (job.bytes !== job.total || !same(before, localSnapshot(await handle.stat())) || !same(before, await localStat(job.localPath))) throw new Error('The local source changed during FTP upload.');
        const staged = await remoteStat(session, stage); if (!staged || staged.type !== 'file' || staged.size !== job.total) throw new Error('The FTP server did not acknowledge the complete staged file.');
        await parents(session, job.remotePath);
        if (!same(expected, await remoteStat(session, job.remotePath))) throw new Error('The FTP destination changed during transfer.');
        check(signal); job.commitStarted = true;
        if (expected) {
          const backup = path.posix.join(path.posix.dirname(job.remotePath), `.termforge-${randomUUID()}.backup`);
          if (await remoteStat(session, backup)) throw new Error('The FTP backup filename already exists.');
          await session.client.rename(job.remotePath, backup);
          job.warning = `The previous remote file is retained at ${backup}. FTP cannot guarantee an atomic conditional rename; inspect concurrent server changes before cleanup.`;
          if (await remoteStat(session, job.remotePath)) throw new Error('An FTP destination appeared before commit. The previous file is retained in its backup.');
        }
        await session.client.rename(stage, job.remotePath); stageCreated = false;
      } else {
        const before = await remoteStat(session, job.remotePath); if (!before || before.type !== 'file') throw new Error('The FTP source must be a regular file.');
        job.total = before.size; publish(job); handle = await fsp.open(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600); stageCreated = true;
        let position = 0;
        sink = new Writable({ write(chunk, _encoding, callback) { (async () => { check(signal); if (position + chunk.length > job.total) throw new Error('FTP source exceeded its reviewed size.'); let offset = 0; while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset, position + offset); if (!result.bytesWritten) throw new Error('Local write made no progress.'); offset += result.bytesWritten; } position += chunk.length; progress(job, chunk.length); })().then(() => callback(), callback); } });
        await session.client.downloadTo(sink, job.remotePath); check(signal);
        if (job.bytes !== job.total || !same(before, await remoteStat(session, job.remotePath))) throw new Error('The FTP source changed during download.');
        await handle.sync(); const staged = localSnapshot(await handle.stat());
        if (!same(staged, await localStat(stage))) throw new Error('The local staging file changed during FTP download.');
        await handle.close(); handle = null;
        if (!same(parent, await localParent(job.localPath)) || !same(expected, await localStat(job.localPath))) throw new Error('The local destination changed during FTP download.');
        check(signal); job.commitStarted = true;
        if (expected) {
          const backup = path.join(parent.parent, `.termforge-${randomUUID()}.backup`); await fsp.link(job.localPath, backup);
          const afterLink = await localStat(job.localPath);
          if (!afterLink || !same({ ...expected, ctime: afterLink.ctime }, afterLink)) throw new Error('The local destination changed before commit.');
          await fsp.unlink(job.localPath); job.warning = `The previous local file is retained at ${backup}.`;
        }
        await fsp.link(stage, job.localPath); await fsp.unlink(stage); stageCreated = false;
      }
    } catch (error) {
      if (stageCreated) job.warning = `${job.warning ? `${job.warning} ` : ''}A partial file may remain at ${stage}; inspect it before cleanup.`;
      if (job.commitStarted) job.warning = `${job.warning ? `${job.warning} ` : ''}The final commit may be incomplete. Inspect the destination before retrying.`;
      throw error;
    } finally { signal.removeEventListener('abort', abort); source?.destroy(); sink?.destroy(); await handle?.close().catch(() => {}); }
  }
  async function pump() {
    if (processing) return; processing = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try { check(job.controller.signal); workflows.assertRunnable(job.transferId); const session = get(job.id); job.status = 'running'; job.startedAt = Date.now(); publish(job); await (job.advanced ? workflows.run(job, session) : run(job, session)); job.status = 'completed'; }
        catch (error) { if (!['paused','interrupted'].includes(job.status)) job.status = job.controller.signal.aborted && !job.commitStarted ? 'cancelled' : 'failed'; job.error = cleanError(error); }
        finally { job.finishedAt = Date.now(); publish(job); job.resolveDone(); const session = sessions.get(job.id); if (session?.client.closed) disconnected(session); }
      }
    } finally { processing = false; }
  }
  async function cancel(transferId) { const job = jobs.get(transferId); if (!job) throw new Error('Unknown FTP transfer.'); if(job.resumable) { if(!FINISHED.has(job.status))await workflows.pause(transferId);if(job.checkpoint)return workflows.discardPartial({transferId,id:job.id});return jobView(job); } if (!FINISHED.has(job.status)) job.controller.abort(); await job.done; return jobView(job); }
  async function close(id) { await workflows.close(id); const session = sessions.get(id); if (session) { session.client.close(); disconnected(session); } await Promise.all([...jobs.values()].filter(job => job.id === id).map(job => job.done).concat([...browsing].filter(owner => owner.id === id).map(owner => owner.done))); return true; }
  async function closeAll() { stopped = true; await workflows.closeAll(); for (const request of pending) request.controller.abort(); await Promise.all([...sessions.keys()].map(close)); await Promise.all([...pending].map(request => request.done)); await Promise.all([...jobs.values()].map(job => job.done).concat([...browsing].map(owner => owner.done))); }
  return { initializeRecovery:workflows.initializeRecovery,assertExternalAvailable:workflows.assertExternalAvailable,ownsPlan:workflows.ownsPlan,
    prepareFolderTransfer:workflows.prepareFolderTransfer,startFolderTransfer:workflows.startFolderTransfer,discardFolderTransfer:workflows.discardFolderTransfer,
    pause:workflows.pause,resume:workflows.resume,discardPartial:workflows.discardPartial,listRecovery:()=>[...jobs.values()].filter(j=>j.checkpoint).map(jobView),get recoveryError(){return workflows.recoveryError;},
    open, listLocal, listRemote, start, cancel, close, closeAll, listJobs: () => [...jobs.values()].map(jobView), ownsJob: id => jobs.has(id), owns: id => sessions.has(id) || [...jobs.values()].some(job => job.id === id || job.transferId === id),
    get count() { return new Set([...sessions.keys(), ...workflows.ownedIds, ...[...jobs.values()].filter(job => !FINISHED.has(job.status)).map(job => job.id), ...[...browsing].map(owner => owner.id)]).size + pending.size; }, get activeCount() { return workflows.busy + browsing.size + [...jobs.values()].filter(job => !FINISHED.has(job.status)).length; }, get connectionIds() { return [...sessions.keys()]; } };
}
module.exports = { createFtpTransfers };
