'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

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

// A folder is a reviewed sequence of guarded file commits, not an atomic
// directory transaction. Completed files and created folders survive errors.
// Merge and one-way sync retain every destination-only item; neither deletes.
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
  async function digest(plan, filename, remote, expected) {
    const signal = plan.controller.signal; const hash = createHash('sha256'); const buffer = Buffer.alloc(65536);
    let handle; let position = 0;
    try {
      check(plan, !plan.job);
      handle = remote ? await call(plan.session.sftp, 'open', [filename, 'r'], signal)
        : await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const initial = remote ? snapshot(await call(plan.session.sftp, 'fstat', [handle], signal), true) : snapshot(await handle.stat(), false);
      if (!equal(expected, initial) || initial.type !== 'file') throw new Error('A file changed while its content was being compared.');
      while (position < expected.size) {
        check(plan, !plan.job);
        const length = Math.min(buffer.length, expected.size - position);
        const count = remote ? await call(plan.session.sftp, 'read', [handle, buffer, 0, length, position], signal)
          : (await handle.read(buffer, 0, length, position)).bytesRead;
        if (!Number.isInteger(count) || count < 1 || count > length) throw new Error('A file changed while its content was being compared.');
        hash.update(buffer.subarray(0, count)); position += count;
      }
      const final = remote ? snapshot(await call(plan.session.sftp, 'fstat', [handle], signal), true) : snapshot(await handle.stat(), false);
      if (!equal(expected, final) || !equal(expected, await stat(plan, filename, remote))) throw new Error('A file changed while its content was being compared.');
      return hash.digest('hex');
    } finally {
      if (handle) {
        if (remote) { try { await call(plan.session.sftp, 'close', [handle], undefined, timeout); } catch {} }
        else await handle.close();
      }
    }
  }
  async function inventory(plan, root, remote, { missing = false, hashes = false } = {}) {
    const api = remote ? path.posix : path; const entries = []; const names = new Set(); let totalBytes = 0;
    async function walk(filename, relativePath, depth) {
      check(plan);
      if (depth > MAX_DEPTH) throw new Error(`Folder copies support at most ${MAX_DEPTH} nested levels.`);
      if (entries.length >= MAX_ENTRIES) throw new Error(`Folder copies support at most ${MAX_ENTRIES} entries including the root.`);
      const info = await stat(plan, filename, remote);
      if (!info && missing && !relativePath) return;
      if (!info || !['file', 'directory'].includes(info.type) || (!relativePath && info.type !== 'directory')) throw new Error('Folder copies include only regular files and directories; symbolic links and special files are not followed.');
      if (info.type === 'file' && (info.size > MAX_BYTES || totalBytes + info.size > MAX_BYTES)) throw new Error('A reviewed folder tree must be no larger than 1 TiB, including all files.');
      const portable = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
      if (names.has(portable)) throw new Error('Folder names collide after case or Unicode normalization. Rename the conflicting entries before copying.');
      names.add(portable);
      const entry = { relativePath, type: info.type, size: info.type === 'file' ? info.size : 0, expected: info };
      entries.push(entry);
      if (info.type === 'file') { totalBytes += info.size; if (hashes) entry.hash = await digest(plan, filename, remote, info); return; }
      const children = remote ? await call(plan.session.sftp, 'readdir', [filename], plan.controller.signal) : await fsp.readdir(filename);
      if (!Array.isArray(children) || children.length > MAX_ENTRIES - entries.length) throw new Error(`Folder copies support at most ${MAX_ENTRIES} entries including the root.`);
      const childNames = children.map(child => remote ? child.filename : child); const seen = new Set();
      for (const name of childNames) {
        if (!validName(name) || (!remote && !localName(name)) || (plan.review.direction === 'download' && !localName(name)) || seen.has(name)) throw new Error('The folder contains an unsafe or duplicate filename.');
        seen.add(name);
      }
      childNames.sort();
      for (const name of childNames) {
        const childRelative = relativePath ? `${relativePath}/${name}` : name;
        const child = api.join(filename, name);
        const localChild = path.join(plan.review.localPath, ...childRelative.split('/')); const remoteChild = path.posix.join(plan.review.remotePath, childRelative);
        if (localChild.length > 32768 || remoteChild.length > 4096) throw new Error('A nested path is too long.');
        await walk(child, childRelative, depth + 1);
      }
      if (!equal(info, await stat(plan, filename, remote))) throw new Error('The source or destination folder changed while it was being reviewed. Review it again.');
    }
    await walk(root, '', 0); return entries;
  }
  async function inspect(plan) {
    check(plan);
    const upload = plan.review.direction === 'upload'; const sourceRemote = !upload; const merging = plan.review.mode !== 'copy';
    const sourceApi = sourceRemote ? path.posix : path; const destinationApi = upload ? path.posix : path;
    const sourceParents = await parents(plan, sourceApi.dirname(plan.review.sourceRoot), sourceRemote);
    const destinationParents = await parents(plan, destinationApi.dirname(plan.review.destinationRoot), upload);
    if (!merging && await stat(plan, plan.review.destinationRoot, upload)) throw new Error('The destination folder already exists. Choose a new folder name or select Merge.');
    const source = await inventory(plan, plan.review.sourceRoot, sourceRemote, { hashes: merging });
    const destination = merging ? await inventory(plan, plan.review.destinationRoot, upload, { missing: true, hashes: true }) : [];
    const destinations = new Map(destination.map(entry => [entry.relativePath, entry]));
    const portable = new Map();
    for (const entry of [...source, ...destination]) {
      const normalized = entry.relativePath.normalize('NFC').toLocaleLowerCase('en-US');
      if (portable.has(normalized) && portable.get(normalized) !== entry.relativePath) throw new Error('Source and destination names collide after case or Unicode normalization. Rename the conflicting entries before copying.');
      portable.set(normalized, entry.relativePath);
    }
    let copied = 0; let replaced = 0; let skipped = 0; let directories = 0; let totalBytes = 0;
    const entries = source.map(entry => {
      const target = destinations.get(entry.relativePath);
      if (target && target.type !== entry.type) throw new Error('A source file conflicts with a destination directory (or vice versa). Rename or move the conflicting item before reviewing again.');
      let action;
      if (entry.type === 'directory') { action = target ? 'skip' : 'mkdir'; if (!target) directories++; }
      else if (!target) { action = 'copy'; copied++; totalBytes += entry.size; }
      else if (entry.hash === target.hash || (plan.review.mode === 'merge' && plan.review.conflictPolicy === 'skip')) { action = 'skip'; skipped++; }
      else {
        if (target.expected.mode & 0o7000) throw new Error('Replacement refuses destination files with special permission bits. Change those permissions deliberately before reviewing again.');
        action = 'replace'; replaced++; totalBytes += entry.size;
      }
      return { ...entry, action, destinationExpected: target?.expected || null, ...(target?.hash ? { destinationHash: target.hash } : {}) };
    });
    const sourceNames = new Set(source.map(entry => entry.relativePath));
    const kept = destination.filter(entry => !sourceNames.has(entry.relativePath)).length;
    check(plan);
    return { sourceParents, destinationParents, entries, destination, files: copied + replaced, directories, totalBytes,
      copied, replaced, skipped, kept, sourceFiles: source.filter(entry => entry.type === 'file').length,
      sourceDirectories: source.filter(entry => entry.type === 'directory').length };
  }
  function review(plan) {
    const { files, directories, totalBytes, copied, replaced, skipped, kept, sourceFiles, sourceDirectories } = plan.expected;
    return { ...plan.review, entries: plan.expected.entries.map(({ expected, destinationExpected, hash, destinationHash, ...item }) => ({ ...item })),
      files, directories, totalBytes, copied, replaced, skipped, kept, sourceFiles, sourceDirectories, expiresAt: plan.expires };
  }
  async function prepare(input = {}) {
    available(); assertAvailable();
    if (isBusy()) throw new Error('Wait for queued or running transfers before reviewing a folder copy.');
    const session = getSession(input.id);
    if (!['upload', 'download'].includes(input.direction)) throw new Error('Choose upload or download.');
    const localPath = plainPath(input.localPath, false); const remotePath = plainPath(input.remotePath, true);
    const mode = input.mode ?? 'copy'; const conflictPolicy = input.conflictPolicy ?? 'skip';
    if (!['copy', 'merge', 'sync'].includes(mode) || !['skip', 'replace'].includes(conflictPolicy)) throw new Error('Choose a supported folder operation and conflict policy.');
    const upload = input.direction === 'upload';
    const plan = { session, controller: new AbortController(), expires: Date.now() + planLifetimeMs, applying: false,
      review: { planId: randomUUID(), id: input.id, direction: input.direction, mode, conflictPolicy, protocol: 'sftp', host: session.host, port: session.port,
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
      if (entry.hash && entry.hash !== await digest(plan, source, sourceRemote, entry.expected)) throw new Error('The source file content changed after review.');
      for (const relative of new Set(ancestors)) {
        const filename = pathFor(plan.review.destinationRoot, relative, destinationApi);
        const expected = created.get(filename) || (expectedEntries.get(relative)?.destinationExpected ? identity(expectedEntries.get(relative).destinationExpected) : null);
        if (!expected) continue;
        const info = await stat(plan, filename, upload);
        if (!info || !equal(expected, identity(info))) throw new Error('A destination folder changed during the copy.');
        const canonical = upload ? await call(session.sftp, 'realpath', [filename], plan.controller.signal) : await fsp.realpath(filename);
        if (canonical !== filename) throw new Error('A destination folder changed during the copy.');
      }
      const destination = pathFor(plan.review.destinationRoot, entry.relativePath, destinationApi);
      const current = await stat(plan, destination, upload);
      if (entry.type === 'directory') {
        if (entry.destinationExpected ? !current || !equal(identity(entry.destinationExpected), identity(current)) : Boolean(current)) throw new Error('A destination folder changed or appeared after review.');
      } else {
        if (!equal(entry.destinationExpected, current)) throw new Error('The destination file changed or appeared after review.');
        if (entry.destinationHash && entry.destinationHash !== await digest(plan, destination, upload, entry.destinationExpected)) throw new Error('The destination file content changed after review.');
      }
      check(plan, false);
    }
    for (const entry of plan.expected.entries) {
      await validate(entry);
      const destination = pathFor(plan.review.destinationRoot, entry.relativePath, destinationApi);
      job.currentPath = entry.relativePath || sourceApi.basename(plan.review.sourceRoot); job.publish();
      if (entry.action === 'skip') continue;
      if (entry.action === 'mkdir') {
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
        const info = entry.destinationExpected;
        const expectedDestination = info ? { type: info.type, size: info.size, mtime: info.mtime, mode: info.mode, permissions: (info.mode & 0o777).toString(8).padStart(3, '0'),
          ...(!upload ? { ino: info.ino, dev: info.dev, ctime: info.ctime } : {}) } : null;
        await copy(job, session, { localPath, remotePath, size: entry.size, expectedDestination,
          reviewedReplacement: entry.action === 'replace', validate: () => validate(entry) });
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
