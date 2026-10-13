'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_ENTRIES = 2000;
const MAX_DEPTH = 32;
const MAX_BYTES = 1024 ** 4;
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 255
  && value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/.test(value);
const localName = value => validName(value) && (process.platform !== 'win32' || (!/[<>:"|?*]/.test(value)
  && !/[. ]$/.test(value) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)));
function aborted() { return Object.assign(new Error('Folder transfer cancelled.'), { name: 'AbortError' }); }
function checkSignal(signal) { if (signal.aborted) throw aborted(); }
function plainPath(value, remote) {
  const api = remote ? path.posix : path;
  if (typeof value !== 'string' || !api.isAbsolute(value) || value.length > (remote ? 4096 : 32768)
    || /[\x00-\x1f\x7f]/.test(value) || (remote && value.includes('\\'))
    || value.split(remote ? '/' : /[\\/]/).some(part => part === '.' || part === '..')) throw new Error('Choose absolute folder paths without dot or control characters.');
  const normalized = api.normalize(value);
  if (normalized === api.parse(normalized).root || !(remote ? validName : localName)(api.basename(normalized))) throw new Error('Choose a named folder, not a filesystem root.');
  return normalized.replace(remote ? /\/$/ : /[\\/]$/, '');
}
function snapshot(stat, remote) {
  if (!stat) return null;
  const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  const mtime = remote ? stat.mtime * 1000 : stat.mtimeMs;
  if (![stat.mode, stat.uid, stat.gid, stat.size].every(Number.isSafeInteger) || !Number.isFinite(mtime)
    || stat.size < 0) throw new Error('Complete folder/file metadata is required for a reviewed copy.');
  return { type, size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid, mtime,
    ...(!remote ? { ino: stat.ino, dev: stat.dev, ctime: stat.ctimeMs } : {}) };
}
function identity(info) { const { size, mtime, ctime, ...rest } = info; return rest; }
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// A folder is a reviewed sequence of new-only file commits, not an atomic
// directory transaction. Completed files and created folders survive errors.
function createFolderTransfers({ getSession, assertAvailable, isBusy, call, remoteStat, confirm = async () => false,
  enqueue, copy, timeout = 30000, planLifetimeMs = 300000 }) {
  if (!Number.isInteger(planLifetimeMs) || planLifetimeMs < 1 || planLifetimeMs > 300000) throw new TypeError('Invalid folder review lifetime.');
  let active = null;
  function available() {
    if (active && !active.applying && Date.now() >= active.expires) { active.controller.abort(); if (active.preparingFinished) release(active); }
    if (active) throw new Error('Finish or cancel the reviewed folder copy before starting another transfer or file operation.');
  }
  function release(plan) { clearTimeout(plan.timer); if (active === plan) active = null; }
  function check(plan, expiry = true) {
    checkSignal(plan.controller.signal);
    if (getSession(plan.review.id) !== plan.session) throw new Error('The folder transfer connection changed.');
    if (expiry && Date.now() >= plan.expires) throw new Error('The folder copy review expired. Review the folder again.');
  }
  async function stat(plan, filename, remote) {
    checkSignal(plan.controller.signal);
    if (remote) { const result = await remoteStat(plan.session.sftp, filename, plan.controller.signal); checkSignal(plan.controller.signal); return snapshot(result, true); }
    try { const result = await fsp.lstat(filename); checkSignal(plan.controller.signal); return snapshot(result, false); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function parents(plan, filename, remote) {
    const api = remote ? path.posix : path; const root = api.parse(filename).root; const chain = [root];
    for (const part of filename.slice(root.length).split(api.sep).filter(Boolean)) chain.push(api.join(chain.at(-1), part));
    const result = [];
    for (const item of chain) {
      const info = await stat(plan, item, remote);
      if (info?.type !== 'directory') throw new Error('Folder parent paths must be existing directories without symbolic links.');
      result.push({ path: item, ...identity(info) });
    }
    const canonical = remote ? await call(plan.session.sftp, 'realpath', [filename], plan.controller.signal) : await fsp.realpath(filename);
    if (canonical !== filename) throw new Error('A folder parent path changed or contains a symbolic link.');
    return result;
  }
  async function inspect(plan) {
    check(plan);
    const upload = plan.review.direction === 'upload'; const sourceRemote = !upload;
    const sourceApi = sourceRemote ? path.posix : path; const destinationApi = upload ? path.posix : path;
    const sourceParents = await parents(plan, sourceApi.dirname(plan.review.sourceRoot), sourceRemote);
    const destinationParents = await parents(plan, destinationApi.dirname(plan.review.destinationRoot), upload);
    if (await stat(plan, plan.review.destinationRoot, upload)) throw new Error('The destination folder already exists. Choose a new folder name; merging and replacement are not supported.');
    const entries = []; const names = new Set(); let files = 0; let directories = 0; let totalBytes = 0;
    async function walk(filename, relativePath, depth) {
      check(plan);
      if (depth > MAX_DEPTH) throw new Error(`Folder copies support at most ${MAX_DEPTH} nested levels.`);
      if (entries.length >= MAX_ENTRIES) throw new Error(`Folder copies support at most ${MAX_ENTRIES} entries including the root.`);
      const info = await stat(plan, filename, sourceRemote);
      if (!info || !['file', 'directory'].includes(info.type) || (!relativePath && info.type !== 'directory')) throw new Error('Folder copies include only regular files and directories; symbolic links and special files are not followed.');
      if (info.type === 'file' && (info.size > MAX_BYTES || totalBytes + info.size > MAX_BYTES)) throw new Error('A reviewed folder copy must be no larger than 1 TiB, including all files.');
      const portable = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
      if (names.has(portable)) throw new Error('Folder names collide after case or Unicode normalization. Rename the conflicting entries before copying.');
      names.add(portable); entries.push({ relativePath, type: info.type, size: info.type === 'file' ? info.size : 0, expected: info });
      if (info.type === 'file') { files++; totalBytes += info.size; return; }
      directories++;
      const children = sourceRemote ? await call(plan.session.sftp, 'readdir', [filename], plan.controller.signal) : await fsp.readdir(filename);
      if (!Array.isArray(children) || children.length > MAX_ENTRIES - entries.length) throw new Error(`Folder copies support at most ${MAX_ENTRIES} entries including the root.`);
      const childNames = children.map(child => sourceRemote ? child.filename : child);
      const seen = new Set();
      for (const name of childNames) {
        if (!validName(name) || (!upload && !localName(name)) || seen.has(name)) throw new Error('The folder contains an unsafe or duplicate filename.');
        seen.add(name);
      }
      childNames.sort();
      for (const name of childNames) {
        const childRelative = relativePath ? `${relativePath}/${name}` : name;
        const source = sourceApi.join(filename, name); const destination = destinationApi.join(plan.review.destinationRoot, ...childRelative.split('/'));
        if (source.length > (sourceRemote ? 4096 : 32768) || destination.length > (upload ? 4096 : 32768)) throw new Error('A nested path is too long.');
        await walk(source, childRelative, depth + 1);
      }
      if (!equal(info, await stat(plan, filename, sourceRemote))) throw new Error('The source folder changed while it was being reviewed. Review it again.');
    }
    await walk(plan.review.sourceRoot, '', 0);
    check(plan);
    return { sourceParents, destinationParents, entries, files, directories, totalBytes };
  }
  function review(plan) {
    return { ...plan.review, entries: plan.expected.entries.map(({ expected, ...item }) => ({ ...item })),
      files: plan.expected.files, directories: plan.expected.directories, totalBytes: plan.expected.totalBytes, expiresAt: plan.expires };
  }
  async function prepare(input = {}) {
    available(); assertAvailable();
    if (isBusy()) throw new Error('Wait for queued or running transfers before reviewing a folder copy.');
    const session = getSession(input.id);
    if (!['upload', 'download'].includes(input.direction)) throw new Error('Choose upload or download.');
    const localPath = plainPath(input.localPath, false); const remotePath = plainPath(input.remotePath, true);
    const upload = input.direction === 'upload';
    const plan = { session, controller: new AbortController(), expires: Date.now() + planLifetimeMs, applying: false,
      review: { planId: randomUUID(), id: input.id, direction: input.direction, protocol: 'sftp', host: session.host, port: session.port,
        localPath, remotePath, sourceRoot: upload ? localPath : remotePath, destinationRoot: upload ? remotePath : localPath } };
    let finishPreparing; plan.preparingDone = new Promise(resolve => { finishPreparing = resolve; });
    active = plan;
    plan.timer = setTimeout(() => { if (!plan.applying) { plan.controller.abort(); if (plan.preparingFinished) release(plan); } }, planLifetimeMs); plan.timer.unref?.();
    try { plan.expected = await inspect(plan); return review(plan); } catch (error) { release(plan); throw error; }
    finally { plan.preparingFinished = true; finishPreparing(); }
  }
  async function start({ planId } = {}) {
    const plan = active;
    if (!plan || !plan.expected || plan.review.planId !== planId || plan.applying) throw new Error('This folder review is missing, expired or already used.');
    plan.applying = true; clearTimeout(plan.timer);
    let resolveDone; plan.done = new Promise(resolve => { resolveDone = resolve; });
    try {
      check(plan);
      const accepted = await new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(aborted()); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('The folder review expired. Review the folder again.')); plan.controller.abort(); }, Math.max(1, plan.expires - Date.now()));
        const cleanup = () => { clearTimeout(timer); plan.controller.signal.removeEventListener('abort', abort); };
        plan.controller.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { check(plan); return confirm(review(plan), { signal: plan.controller.signal }); }).then(value => { cleanup(); resolve(value === true); }, error => { cleanup(); reject(error); });
      });
      if (!accepted) { release(plan); return { cancelled: true }; }
      check(plan);
      if (!equal(plan.expected, await inspect(plan))) throw new Error('The source tree or destination parent changed after review. Review the folder again.');
      check(plan);
      const job = enqueue(plan);
      plan.job = job; job.done.finally(() => release(plan));
      return job;
    } catch (error) { release(plan); throw error; }
    finally { resolveDone(); }
  }
  function discard({ planId } = {}) {
    if (!active || active.review.planId !== planId || active.applying) return false;
    active.controller.abort(); release(active); return true;
  }
  async function run(job, session) {
    const plan = job.folderPlan; const upload = job.direction === 'upload'; const sourceRemote = !upload;
    const sourceApi = sourceRemote ? path.posix : path; const destinationApi = upload ? path.posix : path;
    const created = new Map(); const expectedEntries = new Map(plan.expected.entries.map(entry => [entry.relativePath, entry]));
    const pathFor = (root, relative, api) => relative ? api.join(root, ...relative.split('/')) : root;
    async function validate(entry) {
      check(plan, false);
      if (!equal(plan.expected.sourceParents, await parents(plan, sourceApi.dirname(plan.review.sourceRoot), sourceRemote))
        || !equal(plan.expected.destinationParents, await parents(plan, destinationApi.dirname(plan.review.destinationRoot), upload))) throw new Error('A folder parent changed during the copy.');
      const source = pathFor(plan.review.sourceRoot, entry.relativePath, sourceApi);
      const sourceChain = entry.relativePath ? entry.relativePath.split('/').slice(0, -1) : [];
      const ancestors = ['']; for (const part of sourceChain) ancestors.push(ancestors.at(-1) ? `${ancestors.at(-1)}/${part}` : part);
      for (const relative of new Set(ancestors)) {
        const expected = expectedEntries.get(relative);
        if (!equal(expected.expected, await stat(plan, pathFor(plan.review.sourceRoot, relative, sourceApi), sourceRemote))) throw new Error('The source folder changed during the copy.');
      }
      if (!equal(entry.expected, await stat(plan, source, sourceRemote))) throw new Error('A reviewed source file or folder changed during the copy.');
      for (const relative of new Set(ancestors)) {
        const filename = pathFor(plan.review.destinationRoot, relative, destinationApi); const expected = created.get(filename);
        if (!expected) continue;
        const info = await stat(plan, filename, upload);
        if (!info || !equal(expected, identity(info))) throw new Error('A created destination folder changed during the copy.');
        const canonical = upload ? await call(session.sftp, 'realpath', [filename], plan.controller.signal) : await fsp.realpath(filename);
        if (canonical !== filename) throw new Error('A created destination folder changed during the copy.');
      }
      check(plan, false);
    }
    for (const entry of plan.expected.entries) {
      await validate(entry);
      const destination = pathFor(plan.review.destinationRoot, entry.relativePath, destinationApi);
      job.currentPath = entry.relativePath || sourceApi.basename(plan.review.sourceRoot); job.publish();
      if (await stat(plan, destination, upload)) throw new Error('A destination item appeared after review. Existing items are never replaced by a folder copy.');
      if (entry.type === 'directory') {
        if (upload) {
          try { await call(session.sftp, 'mkdir', [destination, { mode: 0o700 }], undefined, timeout); }
          catch (error) {
            if (!Number.isInteger(error.code)) {
              session.closed = true; session.client.end();
              throw Object.assign(new Error(`The folder creation outcome is unknown. Reconnect and inspect ${destination} before retrying. Completed files and created folders were retained.`), { indeterminate: true });
            }
            throw error;
          }
        } else await fsp.mkdir(destination, { mode: 0o700 });
        job.directoriesCreated++;
        const info = await stat(plan, destination, upload);
        if (info?.type !== 'directory') throw new Error('The new destination folder could not be verified.');
        created.set(destination, identity(info)); job.publish();
      } else {
        const localPath = pathFor(job.localPath, entry.relativePath, path);
        const remotePath = pathFor(job.remotePath, entry.relativePath, path.posix);
        await copy(job, session, { localPath, remotePath, size: entry.size, validate: () => validate(entry) });
        job.filesCompleted++; job.publish();
      }
    }
    job.currentPath = ''; job.publish();
  }
  function disconnected(id) { if (active?.review.id === id) { active.controller.abort(); if (!active.applying && active.preparingFinished) release(active); } }
  async function close(id) {
    const plan = active?.review.id === id ? active : null; if (!plan) return;
    disconnected(id); await plan.preparingDone; if (plan.done) await plan.done; if (!plan.job) release(plan);
  }
  async function closeAll() { if (active) await close(active.review.id); }
  return { prepare, start, discard, available, run, close, closeAll, disconnected,
    get busy() { return Boolean(active); }, get activeIds() { return active ? [active.review.id] : []; } };
}

module.exports = { createFolderTransfers };
