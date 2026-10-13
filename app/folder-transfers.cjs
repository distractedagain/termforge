'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createSyncBaselines, binding, cleanName } = require('./sync-baselines.cjs');

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
const depthOf = relativePath => relativePath ? relativePath.split('/').length : 0;

// A folder is a reviewed sequence of guarded file commits, not an atomic
// directory transaction. Completed files and created folders survive errors.
// Merge and one-way sync retain destination-only items. Mirror deletes only
// explicitly reviewed target-only regular files and then empty directories.
function createFolderTransfers({ getSession, assertAvailable, isBusy, call, remoteStat, confirm = async () => false,
  enqueue, copy, timeout = 30000, planLifetimeMs = 300000, syncDirectory, identityFor }) {
  if (!Number.isInteger(planLifetimeMs) || planLifetimeMs < 1 || planLifetimeMs > 300000) throw new TypeError('Invalid folder review lifetime.');
  let active = null;
  const baselines = syncDirectory ? createSyncBaselines(syncDirectory) : null;
  const common = entry => entry ? { relativePath: entry.relativePath, type: entry.type, size: entry.type === 'file' ? entry.size : 0,
    ...(entry.type === 'file' ? { hash: entry.hash } : {}) } : null;
  const contentEqual = (a, b) => equal(common(a), common(b));
  const inside = (name, root) => root === '' || name === root || name.startsWith(root + '/');
  function syncIdentity(session) {
    const result = identityFor?.(session);
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Authenticated SSH identity is required for saved synchronization pairs.');
    return result;
  }
  const pairSummary = record => ({ pairId: record.pairId, name: record.name, revision: record.revision,
    lastSyncedAt: record.lastSyncedAt, localPath: record.localPath, remotePath: record.remotePath });
  async function listSyncPairs({ id } = {}) {
    if (!baselines) throw new Error('Saved synchronization storage is unavailable.');
    const identity = syncIdentity(getSession(id));
    return (await baselines.load()).filter(record => record.identity === identity).map(pairSummary);
  }
  async function forgetSyncPair({ id, pairId, revision } = {}) {
    available(); assertAvailable(); if (isBusy()) throw new Error('Wait for transfers before forgetting a synchronization baseline.');
    if (!baselines) throw new Error('Saved synchronization storage is unavailable.');
    const identity = syncIdentity(getSession(id));
    const record = (await baselines.load()).find(item => item.pairId === pairId && item.identity === identity && item.revision === revision);
    if (!record) throw new Error('The saved synchronization pair changed or belongs to another authenticated connection.');
    return baselines.forget(record);
  }
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
      check(plan, !plan.job);
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
        if (!validName(name) || (!remote && !localName(name)) || ((plan.review.direction === 'download' || plan.review.mode === 'two-way') && !localName(name)) || seen.has(name)) throw new Error('The folder contains an unsafe or duplicate filename.');
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
    if (plan.review.mode === 'two-way') return inspectTwoWay(plan);
    const upload = plan.review.direction === 'upload'; const sourceRemote = !upload; const merging = plan.review.mode !== 'copy';
    const sourceApi = sourceRemote ? path.posix : path; const destinationApi = upload ? path.posix : path;
    const sourceParents = await parents(plan, sourceApi.dirname(plan.review.sourceRoot), sourceRemote);
    const destinationParents = await parents(plan, destinationApi.dirname(plan.review.destinationRoot), upload);
    if (!merging && await stat(plan, plan.review.destinationRoot, upload)) throw new Error('The destination folder already exists. Choose a new folder name or select Merge.');
    const source = await inventory(plan, plan.review.sourceRoot, sourceRemote, { hashes: merging || plan.review.resumable });
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
    const destinationOnly = destination.filter(entry => !sourceNames.has(entry.relativePath));
    let deletedFiles = 0; let deletedDirectories = 0;
    if (plan.review.mode === 'mirror') {
      for (const entry of destinationOnly.sort((a, b) => depthOf(b.relativePath) - depthOf(a.relativePath) || a.relativePath.localeCompare(b.relativePath))) {
        if (entry.type === 'file') deletedFiles++; else deletedDirectories++;
        entries.push({ ...entry, action: entry.type === 'file' ? 'delete-file' : 'delete-directory', direction: plan.review.direction,
          destinationExpected: entry.expected, destinationHash: entry.hash });
      }
    }
    if (entries.length > MAX_ENTRIES) throw new Error(`Folder reviews support at most ${MAX_ENTRIES} combined actions including the root.`);
    const kept = plan.review.mode === 'mirror' ? 0 : destinationOnly.length;
    check(plan);
    return { sourceParents, destinationParents, entries, destination, files: copied + replaced, directories, totalBytes,
      copied, replaced, skipped, kept, deletedFiles, deletedDirectories, sourceFiles: source.filter(entry => entry.type === 'file').length,
      sourceDirectories: source.filter(entry => entry.type === 'directory').length };
  }
  async function inspectTwoWay(plan) {
    const localParents = await parents(plan, path.dirname(plan.review.localPath), false);
    const remoteParents = await parents(plan, path.posix.dirname(plan.review.remotePath), true);
    const local = await inventory(plan, plan.review.localPath, false, { missing: true, hashes: true });
    const remote = await inventory(plan, plan.review.remotePath, true, { missing: true, hashes: true });
    if (!local.length && !remote.length && !plan.syncRecord?.revision) throw new Error('At least one two-way folder must already exist.');
    const locals = new Map(local.map(entry => [entry.relativePath, entry]));
    const remotes = new Map(remote.map(entry => [entry.relativePath, entry]));
    const portable = new Map();
    for (const entry of [...local, ...remote]) {
      const normalized = entry.relativePath.normalize('NFC').toLocaleLowerCase('en-US');
      if (portable.has(normalized) && portable.get(normalized) !== entry.relativePath) throw new Error('Source and destination names collide after case or Unicode normalization.');
      portable.set(normalized, entry.relativePath);
    }
    if (plan.syncRecord) return inspectPersistent(plan, { localParents, remoteParents, local, remote, locals, remotes });
    const names = [...new Set([...locals.keys(), ...remotes.keys()])].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    if (names.length > MAX_ENTRIES) throw new Error(`Two-way folder reviews support at most ${MAX_ENTRIES} combined entries.`);
    const entries = []; let copied = 0; let replaced = 0; let skipped = 0; let directories = 0; let totalBytes = 0; let conflicts = 0; let unresolved = 0;
    const used = new Set();
    for (const relativePath of names) {
      const left = locals.get(relativePath); const right = remotes.get(relativePath);
      if (left && right && left.type !== right.type) throw new Error('A local file conflicts with a remote directory (or vice versa). Rename or move the conflicting item before reviewing again.');
      let source = left || right; let target = left ? right : left; let direction = left ? 'upload' : 'download'; let action;
      if (source.type === 'directory') { action = left && right ? 'skip' : 'mkdir'; if (action === 'mkdir') directories++; }
      else if (!target) { action = 'copy'; copied++; totalBytes += source.size; }
      else if (left.hash === right.hash) { action = 'skip'; skipped++; }
      else {
        conflicts++; const choice = plan.resolutionMap.get(relativePath);
        if (choice) used.add(relativePath);
        if (!choice) { action = 'conflict'; unresolved++; }
        else if (choice === 'skip') { action = 'skip'; skipped++; }
        else {
          direction = choice === 'local' ? 'upload' : 'download'; source = choice === 'local' ? left : right; target = choice === 'local' ? right : left;
          if (target.expected.mode & 0o7000) throw new Error('Replacement refuses destination files with special permission bits.');
          action = 'replace'; replaced++; totalBytes += source.size;
        }
      }
      if (totalBytes > MAX_BYTES) throw new Error('A reviewed folder transfer must be no larger than 1 TiB.');
      entries.push({ ...source, action, direction, destinationExpected: target?.expected || null,
        ...(target?.hash ? { destinationHash: target.hash } : {}),
        ...(left && right && source.type === 'file' && left.hash !== right.hash ? { conflict: true, resolution: plan.resolutionMap.get(relativePath) || null, localSize: left.size, remoteSize: right.size } : {}) });
    }
    if ([...plan.resolutionMap.keys()].some(name => !used.has(name))) throw new Error('A two-way resolution no longer refers to a conflicting file. Review the changed trees again.');
    check(plan);
    return { localParents, remoteParents, local, remote, entries, files: copied + replaced, directories, totalBytes,
      copied, replaced, skipped, kept: 0, deletedFiles: 0, deletedDirectories: 0, conflicts, unresolved,
      sourceFiles: entries.filter(entry => entry.type === 'file').length, sourceDirectories: entries.filter(entry => entry.type === 'directory').length };
  }
  function inspectPersistent(plan, state) {
    const { localParents, remoteParents, local, remote, locals, remotes } = state;
    const baseline = new Map(plan.syncRecord.entries.map(entry => [entry.relativePath, entry]));
    const names = [...new Set([...locals.keys(), ...remotes.keys(), ...baseline.keys()])].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    if (names.length > MAX_ENTRIES) throw new Error(`Saved synchronization reviews support at most ${MAX_ENTRIES} combined entries.`);
    const entries = [], covered = [], used = new Set(); let conflicts = 0, unresolved = 0;
    function add(relativePath, side, metadata = {}) {
      const source = (side === 'local' ? locals : remotes).get(relativePath);
      const target = (side === 'local' ? remotes : locals).get(relativePath);
      if (!source && !target) return;
      const direction = side === 'local' ? 'upload' : 'download'; let action;
      if (!source) action = target.type === 'file' ? 'delete-file' : 'delete-directory';
      else if (source.type === 'directory') action = target ? 'skip' : 'mkdir';
      else action = !target ? 'copy' : contentEqual(source, target) ? 'skip' : 'replace';
      if (action === 'replace' && (target.expected.mode & 0o7000)) throw new Error('Replacement refuses destination files with special permission bits.');
      entries.push({ ...(source || target), action, direction, destinationExpected: target?.expected || null,
        ...(target?.hash ? { destinationHash: target.hash } : {}), ...metadata });
    }
    function conflict(relativePath, reason, subtree = false, typeChange = false) {
      const left = locals.get(relativePath), right = remotes.get(relativePath); const choice = plan.resolutionMap.get(relativePath);
      conflicts++; if (choice) used.add(relativePath); else unresolved++;
      if (typeChange && choice && choice !== 'skip') throw new Error('File/directory type changes require manual reconciliation; only Skip is available.');
      const metadata = { conflict: true, conflictReason: reason, resolution: choice || null, localPresent: Boolean(left), remotePresent: Boolean(right),
        localSize: left?.size ?? null, remoteSize: right?.size ?? null, subtree, allowedResolutions: typeChange ? ['skip'] : ['local', 'remote', 'skip'] };
      if (subtree) covered.push(relativePath);
      if (!choice || choice === 'skip') {
        entries.push({ ...(left || right), ...metadata, action: choice ? 'skip' : 'conflict', direction: left ? 'upload' : 'download',
          destinationExpected: left ? right?.expected || null : left?.expected || null,
          retainedConflict: true, localExpected: left?.expected || null, remoteExpected: right?.expected || null,
          localHash: left?.hash, remoteHash: right?.hash });
      } else {
        const selectedNames = subtree ? names.filter(name => inside(name, relativePath)) : [relativePath];
        for (const name of selectedNames) add(name, choice, name === relativePath ? metadata : {});
      }
    }
    for (const relativePath of names) {
      if (covered.some(root => inside(relativePath, root))) continue;
      const left = locals.get(relativePath), right = remotes.get(relativePath), before = baseline.get(relativePath);
      if (!left && !right) continue;
      if (contentEqual(left, right)) { add(relativePath, 'local'); continue; }
      if (left && right && left.type !== right.type) { conflict(relativePath, 'type-change', true, true); continue; }
      // A deleted directory is one decision for the entire subtree. New or
      // changed descendants on its surviving side turn deletion into conflict.
      if (before?.type === 'directory' && (!left || !right)) {
        const present = left || right;
        if (present.type !== 'directory') { conflict(relativePath, 'type-change', true, true); continue; }
        const existing = left ? locals : remotes;
        const changed = names.some(name => inside(name, relativePath) && existing.has(name) && !contentEqual(existing.get(name), baseline.get(name)));
        if (changed) { conflict(relativePath, 'deletion-versus-edit', true); continue; }
        covered.push(relativePath);
        for (const name of names.filter(name => inside(name, relativePath))) add(name, left ? 'remote' : 'local');
        continue;
      }
      if (before && ((left && left.type !== before.type) || (right && right.type !== before.type))) { conflict(relativePath, 'type-change', true, true); continue; }
      if (!before) {
        if (!left || !right) add(relativePath, left ? 'local' : 'remote');
        else conflict(relativePath, 'initial-divergence');
      } else if (contentEqual(left, before)) add(relativePath, 'remote');
      else if (contentEqual(right, before)) add(relativePath, 'local');
      else conflict(relativePath, !left || !right ? 'deletion-versus-edit' : 'both-edited');
    }
    if ([...plan.resolutionMap.keys()].some(name => !used.has(name))) throw new Error('A two-way resolution no longer refers to a conflict. Review the changed trees again.');
    // Preserve creation ordering; apply reviewed deletions deepest first.
    const deletions = entries.filter(entry => entry.action.startsWith('delete-')).sort((a, b) => depthOf(b.relativePath) - depthOf(a.relativePath) || a.relativePath.localeCompare(b.relativePath));
    const ordered = [...entries.filter(entry => !entry.action.startsWith('delete-')), ...deletions];
    const count = action => entries.filter(entry => entry.action === action).length;
    const totalBytes = entries.filter(entry => ['copy', 'replace'].includes(entry.action)).reduce((total, entry) => total + entry.size, 0);
    if (totalBytes > MAX_BYTES) throw new Error('A reviewed folder transfer must be no larger than 1 TiB.');
    return { localParents, remoteParents, local, remote, entries: ordered, files: count('copy') + count('replace'), directories: count('mkdir'), totalBytes,
      copied: count('copy'), replaced: count('replace'), skipped: count('skip'), kept: 0, deletedFiles: count('delete-file'), deletedDirectories: count('delete-directory'), conflicts, unresolved,
      sourceFiles: entries.filter(entry => entry.type === 'file').length, sourceDirectories: entries.filter(entry => entry.type === 'directory').length };
  }
  async function finishSync(plan) {
    check(plan, false);
    if (syncIdentity(plan.session) !== plan.syncRecord.identity) throw new Error('Authenticated synchronization identity changed. The baseline was not advanced.');
    if (!equal(plan.expected.localParents, await parents(plan, path.dirname(plan.review.localPath), false))
      || !equal(plan.expected.remoteParents, await parents(plan, path.posix.dirname(plan.review.remotePath), true))) throw new Error('A synchronization root parent changed. The baseline was not advanced.');
    const predicted = { local: new Map(plan.expected.local.map(entry => [entry.relativePath, common(entry)])), remote: new Map(plan.expected.remote.map(entry => [entry.relativePath, common(entry)])) };
    for (const entry of plan.expected.entries) {
      const target = entry.direction === 'upload' ? predicted.remote : predicted.local;
      if (entry.action.startsWith('delete-')) target.delete(entry.relativePath);
      else if (['copy', 'replace', 'mkdir'].includes(entry.action)) target.set(entry.relativePath, common(entry));
    }
    const actualLocal = await inventory(plan, plan.review.localPath, false, { missing: true, hashes: true });
    const actualRemote = await inventory(plan, plan.review.remotePath, true, { missing: true, hashes: true });
    const sorted = values => [...values].map(common).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    if (!equal(sorted(predicted.local.values()), sorted(actualLocal)) || !equal(sorted(predicted.remote.values()), sorted(actualRemote))) throw new Error('A synchronization tree changed during final verification. Completed changes remain; the baseline was not advanced.');
    const retained = plan.expected.entries.filter(entry => entry.retainedConflict).map(entry => ({ root: entry.relativePath, subtree: entry.subtree }));
    const preserve = name => retained.some(item => item.subtree ? inside(name, item.root) : name === item.root);
    const next = new Map(plan.syncRecord.entries.filter(entry => preserve(entry.relativePath)).map(entry => [entry.relativePath, entry]));
    for (const [name, left] of predicted.local) if (!preserve(name) && contentEqual(left, predicted.remote.get(name))) next.set(name, left);
    check(plan, false);
    const updated = await plan.syncLease.commit([...next.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
    plan.review.syncPair = { ...pairSummary(updated), isNew: false };
    plan.job.syncPair = plan.review.syncPair; plan.job.baselineUpdated = true;
  }
  async function runAdvanced(job, session) {
    const plan = job.folderPlan; const twoWay = plan.review.mode === 'two-way';
    const localTree = twoWay ? plan.expected.local : job.direction === 'upload' ? plan.expected.entries.filter(e => !e.action.startsWith('delete-')) : plan.expected.destination;
    const remoteTree = twoWay ? plan.expected.remote : job.direction === 'upload' ? plan.expected.destination : plan.expected.entries.filter(e => !e.action.startsWith('delete-'));
    const localMap = new Map(localTree.map(entry => [entry.relativePath, entry]));
    const remoteMap = new Map(remoteTree.map(entry => [entry.relativePath, entry]));
    const created = { local: new Map(), remote: new Map() };
    const pathFor = (relative, remote) => { const root = remote ? job.remotePath : job.localPath; return relative ? (remote ? path.posix : path).join(root, ...relative.split('/')) : root; };
    async function guardParents(relativePath, remote) {
      const api = remote ? path.posix : path; const root = remote ? job.remotePath : job.localPath;
      const outside = twoWay ? remote ? plan.expected.remoteParents : plan.expected.localParents
        : remote === (job.direction === 'upload') ? plan.expected.destinationParents : plan.expected.sourceParents;
      if (!equal(outside, await parents(plan, api.dirname(root), remote))) throw new Error('A reviewed folder parent changed during the operation.');
      const parts = relativePath.split('/').slice(0, -1); const ancestors = relativePath ? [''] : [];
      for (const part of parts) ancestors.push(ancestors.at(-1) ? `${ancestors.at(-1)}/${part}` : part);
      const known = remote ? remoteMap : localMap; const added = remote ? created.remote : created.local;
      for (const ancestor of ancestors) {
        const filename = pathFor(ancestor, remote); const expected = added.get(ancestor) || (known.get(ancestor) ? identity(known.get(ancestor).expected) : null);
        const current = await stat(plan, filename, remote);
        if (!expected || current?.type !== 'directory' || !equal(expected, identity(current))) throw new Error('A reviewed ancestor folder changed during the operation.');
        const canonical = remote ? await call(session.sftp, 'realpath', [filename], plan.controller.signal) : await fsp.realpath(filename);
        if (canonical !== filename) throw new Error('A reviewed ancestor folder changed during the operation.');
      }
    }
    async function validate(entry) {
      check(plan, false); const deleting = entry.action.startsWith('delete-'); const destinationRemote = (entry.direction || job.direction) === 'upload';
      if (entry.retainedConflict) {
        for (const remote of [false, true]) {
          const expected = remote ? entry.remoteExpected : entry.localExpected;
          const current = await stat(plan, pathFor(entry.relativePath, remote), remote);
          if (expected?.type === 'directory' ? !current || !equal(identity(expected), identity(current)) : !equal(expected, current)) throw new Error('A skipped synchronization conflict changed after review.');
          const hash = remote ? entry.remoteHash : entry.localHash;
          if (hash && hash !== await digest(plan, pathFor(entry.relativePath, remote), remote, expected)) throw new Error('A skipped synchronization conflict changed after review.');
        }
        return;
      }
      // Probe source absence first: this may traverse many remote ancestors.
      // The destination snapshot and content hash must be the final checks
      // before deletion so edits made during those probes are retained.
      if (deleting) await guardParentsMissing(entry.relativePath, !destinationRemote);
      await guardParents(entry.relativePath, destinationRemote);
      const destination = pathFor(entry.relativePath, destinationRemote);
      const current = await stat(plan, destination, destinationRemote);
      if (entry.type === 'directory') {
        if (entry.destinationExpected ? !current || !equal(identity(entry.destinationExpected), identity(current)) : Boolean(current)) throw new Error('A destination folder changed or appeared after review.');
      } else {
        if (!equal(entry.destinationExpected, current)) throw new Error('A reviewed destination file changed or appeared during the operation.');
        if (entry.destinationHash && entry.destinationHash !== await digest(plan, destination, destinationRemote, entry.destinationExpected)) throw new Error('A reviewed destination file content changed during the operation.');
      }
      if (!deleting) {
        await guardParents(entry.relativePath, !destinationRemote);
        const source = pathFor(entry.relativePath, !destinationRemote); const info = await stat(plan, source, !destinationRemote);
        const matches = entry.type === 'directory' ? info && equal(identity(entry.expected), identity(info)) : equal(entry.expected, info);
        if (!matches) throw new Error('A reviewed source file or folder changed during the operation.');
        if (entry.hash && entry.hash !== await digest(plan, source, !destinationRemote, entry.expected)) throw new Error('A reviewed source file content changed during the operation.');
      }
      check(plan, false);
    }
    async function guardParentsMissing(relativePath, remote) {
      const api = remote ? path.posix : path; const root = remote ? job.remotePath : job.localPath;
      const outside = twoWay ? remote ? plan.expected.remoteParents : plan.expected.localParents
        : remote === (job.direction === 'upload') ? plan.expected.destinationParents : plan.expected.sourceParents;
      if (!equal(outside, await parents(plan, api.dirname(root), remote))) throw new Error('A mirror source parent changed.');
      const known = remote ? remoteMap : localMap; let missing = false; const parts = relativePath.split('/');
      const chain = ['']; for (const part of parts.filter(Boolean)) chain.push(chain.at(-1) ? `${chain.at(-1)}/${part}` : part);
      for (const relative of chain) {
        if (missing) break;
        const info = await stat(plan, pathFor(relative, remote), remote); const expected = known.get(relative);
        if (!expected) { if (info) throw new Error('A mirror source path appeared after review.'); missing = true; }
        else if (info?.type !== 'directory' || !equal(identity(expected.expected), identity(info))) throw new Error('A mirror source folder changed.');
      }
      if (!missing) throw new Error('A mirror source path appeared after review.');
    }
    async function mutateRemote(method, args, filename) {
      try { await call(session.sftp, method, args, undefined, timeout); }
      catch (error) {
        if (!Number.isInteger(error.code)) {
          session.closed = true; session.client.end();
          throw Object.assign(new Error(`The ${method} outcome is unknown. Reconnect and inspect ${filename} before retrying. Completed changes were retained.`), { indeterminate: true });
        }
        throw error;
      }
    }
    for (const entry of plan.expected.entries) {
      if (entry.action === 'conflict') throw new Error('Unresolved two-way conflicts cannot be applied.');
      await validate(entry);
      const direction = entry.direction || job.direction; const remote = direction === 'upload'; const destination = pathFor(entry.relativePath, remote);
      job.currentPath = entry.relativePath || path.basename(job.localPath); job.publish();
      if (entry.action === 'skip') continue;
      if (entry.action === 'mkdir') {
        if (remote) await mutateRemote('mkdir', [destination, { mode: 0o700 }], destination); else await fsp.mkdir(destination, { mode: 0o700 });
        job.directoriesCreated++; const info = await stat(plan, destination, remote);
        if (info?.type !== 'directory') throw new Error('The new destination folder could not be verified.');
        (remote ? created.remote : created.local).set(entry.relativePath, identity(info));
      } else if (entry.action.startsWith('delete-')) {
        if (entry.type === 'directory') {
          const children = remote ? await call(session.sftp, 'readdir', [destination], plan.controller.signal) : await fsp.readdir(destination);
          if (!Array.isArray(children) || children.length) throw new Error('A reviewed mirror directory is no longer empty. Its new contents were retained.');
          await validate(entry);
          if (remote) await mutateRemote('rmdir', [destination], destination); else await fsp.rmdir(destination);
          job.deletedDirectories = (job.deletedDirectories || 0) + 1;
        } else {
          if (remote) await mutateRemote('unlink', [destination], destination); else await fsp.unlink(destination);
          job.deletedFiles = (job.deletedFiles || 0) + 1;
        }
        if (await stat(plan, destination, remote)) throw new Error('A mirror destination appeared again after deletion. The new entry was retained.');
      } else {
        const info = entry.destinationExpected;
        const expectedDestination = info ? { type: info.type, size: info.size, mtime: info.mtime, mode: info.mode,
          permissions: (info.mode & 0o777).toString(8).padStart(3, '0'), ...(!remote ? { ino: info.ino, dev: info.dev, ctime: info.ctime } : {}) } : null;
        await copy(job, session, { direction, localPath: pathFor(entry.relativePath, false), remotePath: pathFor(entry.relativePath, true), size: entry.size,
          expectedDestination, reviewedReplacement: entry.action === 'replace', validate: () => validate(entry) });
        job.filesCompleted++;
      }
      job.publish();
    }
    // Directory identities must survive the operation even when their content
    // is identical; external root/ancestor substitution is not a new baseline.
    if (plan.syncRecord) {
      for (const remote of [false, true]) {
        const known = remote ? remoteMap : localMap; const added = remote ? created.remote : created.local;
        const deleted = new Set(plan.expected.entries.filter(entry => entry.action === 'delete-directory' && (entry.direction === 'upload') === remote).map(entry => entry.relativePath));
        for (const [name, entry] of known) if (entry.type === 'directory' && !deleted.has(name)) {
          const current = await stat(plan, pathFor(name, remote), remote);
          if (current?.type !== 'directory' || !equal(identity(entry.expected), identity(current))) throw new Error('A synchronization directory changed. The baseline was not advanced.');
        }
        for (const [name, expected] of added) {
          const current = await stat(plan, pathFor(name, remote), remote);
          if (current?.type !== 'directory' || !equal(expected, identity(current))) throw new Error('A created synchronization directory changed. The baseline was not advanced.');
        }
      }
    }
    job.currentPath = ''; job.publish();
  }
  function review(plan) {
    const { files, directories, totalBytes, copied, replaced, skipped, kept, sourceFiles, sourceDirectories, deletedFiles = 0, deletedDirectories = 0, conflicts = 0, unresolved = 0 } = plan.expected;
    return { ...plan.review, entries: plan.expected.entries.map(({ expected, destinationExpected, hash, destinationHash, localExpected, remoteExpected, localHash, remoteHash, retainedConflict, ...item }) => ({ ...item })),
      files, directories, totalBytes, copied, replaced, skipped, kept, sourceFiles, sourceDirectories, deletedFiles, deletedDirectories, conflicts, unresolved, expiresAt: plan.expires };
  }
  async function prepare(input = {}) {
    available(); assertAvailable();
    if (isBusy()) throw new Error('Wait for queued or running transfers before reviewing a folder copy.');
    const session = getSession(input.id);
    if (!['upload', 'download'].includes(input.direction)) throw new Error('Choose upload or download.');
    const localPath = plainPath(input.localPath, false); const remotePath = plainPath(input.remotePath, true);
    const mode = input.mode ?? 'copy'; const conflictPolicy = input.conflictPolicy ?? 'skip';
    if (!['copy', 'merge', 'sync', 'two-way', 'mirror'].includes(mode) || !['skip', 'replace'].includes(conflictPolicy)) throw new Error('Choose a supported folder operation and conflict policy.');
    if (input.resumable !== undefined && typeof input.resumable !== 'boolean') throw new Error('Choose a valid folder recovery option.');
    if (input.resumable && ['two-way', 'mirror'].includes(mode)) throw new Error('Resumable folder operations currently support copy, merge, and one-way synchronization.');
    if ((input.persistentSync !== undefined && typeof input.persistentSync !== 'boolean') || (mode !== 'two-way' && (input.persistentSync || input.syncPairId || input.pairName))) throw new Error('Saved synchronization pairs require two-way synchronization.');
    if (input.syncPairId && !input.persistentSync) throw new Error('Select saved synchronization to use a pair.');
    if (input.persistentSync && !baselines) throw new Error('Saved synchronization storage is unavailable.');
    const resolutions = input.resolutions ?? [];
    if (!Array.isArray(resolutions) || resolutions.length > MAX_ENTRIES || (mode !== 'two-way' && resolutions.length)) throw new Error('Choose valid per-file two-way resolutions.');
    const resolutionMap = new Map();
    for (const choice of resolutions) {
      if (!choice || typeof choice.relativePath !== 'string' || (!choice.relativePath && !input.persistentSync) || (choice.relativePath && !choice.relativePath.split('/').every(localName))
        || !['local', 'remote', 'skip'].includes(choice.source) || resolutionMap.has(choice.relativePath)) throw new Error('Choose a unique local, remote, or skip resolution for each conflicting file.');
      resolutionMap.set(choice.relativePath, choice.source);
    }
    const upload = input.direction === 'upload';
    const plan = { session, resolutionMap, controller: new AbortController(), expires: Date.now() + planLifetimeMs, applying: false,
      review: { planId: randomUUID(), id: input.id, direction: input.direction, mode, conflictPolicy, resumable: input.resumable === true, protocol: 'sftp', host: session.host, port: session.port,
        localPath, remotePath, sourceRoot: upload ? localPath : remotePath, destinationRoot: upload ? remotePath : localPath } };
    let finishPreparing; plan.preparingDone = new Promise(resolve => { finishPreparing = resolve; });
    active = plan;
    plan.timer = setTimeout(() => { if (!plan.applying) { plan.controller.abort(); if (plan.preparingFinished) release(plan); } }, planLifetimeMs); plan.timer.unref?.();
    try {
      if (input.persistentSync) {
        const identity = syncIdentity(session); const records = await baselines.load();
        const reference = { identity, localPath, remotePath };
        const previous = input.syncPairId ? records.find(record => record.pairId === input.syncPairId) : records.find(record => binding(record) === binding(reference));
        if ((input.syncPairId && !previous) || (previous && binding(previous) !== binding(reference))) throw new Error('The saved pair belongs to different folders or another authenticated SSH connection.');
        plan.syncRecord = previous || { ...reference, pairId: randomUUID(), name: cleanName(input.pairName || path.basename(localPath)), revision: 0, lastSyncedAt: null, entries: [] };
        if (input.pairName !== undefined) plan.syncRecord = { ...plan.syncRecord, name: cleanName(input.pairName) };
        plan.review.persistentSync = true; plan.review.baselineUsed = Boolean(previous);
        plan.review.syncPair = { ...pairSummary(plan.syncRecord), isNew: !previous };
      }
      plan.expected = await inspect(plan); return review(plan);
    } catch (error) { release(plan); throw error; }
    finally { plan.preparingFinished = true; finishPreparing(); }
  }
  async function start({ planId } = {}) {
    const plan = active;
    if (!plan || !plan.expected || plan.review.planId !== planId || plan.applying) throw new Error('This folder review is missing, expired or already used.');
    plan.applying = true; clearTimeout(plan.timer);
    let resolveDone; plan.done = new Promise(resolve => { resolveDone = resolve; });
    try {
      check(plan);
      if (plan.expected.unresolved) throw new Error('Resolve or explicitly skip each two-way conflict before applying this review.');
      const accepted = await new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(aborted()); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('The folder review expired. Review the folder again.')); plan.controller.abort(); }, Math.max(1, plan.expires - Date.now()));
        const cleanup = () => { clearTimeout(timer); plan.controller.signal.removeEventListener('abort', abort); };
        plan.controller.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { check(plan); return confirm(review(plan), { signal: plan.controller.signal }); }).then(value => { cleanup(); resolve(value === true); }, error => { cleanup(); reject(error); });
      });
      if (!accepted) { release(plan); return { cancelled: true }; }
      check(plan);
      if (plan.syncRecord) plan.syncLease = await baselines.begin(plan.syncRecord);
      if (!equal(plan.expected, await inspect(plan))) throw new Error('The source tree or destination parent changed after review. Review the folder again.');
      check(plan);
      const job = enqueue(plan);
      plan.job = job;
      plan.releaseDone = job.done.finally(async () => { try { await plan.syncLease?.release(); } finally { release(plan); } });
      plan.releaseDone.catch(() => {});
      return job;
    } catch (error) { await plan.syncLease?.release(); release(plan); throw error; }
    finally { resolveDone(); }
  }
  function discard({ planId } = {}) {
    if (!active || active.review.planId !== planId || active.applying) return false;
    active.controller.abort(); release(active); return true;
  }
  async function run(job, session) {
    const plan = job.folderPlan;
    if (['two-way', 'mirror'].includes(plan.review.mode)) {
      try { await runAdvanced(job, session); if (plan.syncRecord) await finishSync(plan); }
      finally { await plan.syncLease?.release(); }
      return;
    }
    const upload = job.direction === 'upload'; const sourceRemote = !upload;
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
    disconnected(id); await plan.preparingDone; if (plan.done) await plan.done; if (plan.releaseDone) await plan.releaseDone; if (!plan.job) release(plan);
  }
  async function closeAll() { if (active) await close(active.review.id); }
  return { prepare, start, discard, available, run, close, closeAll, disconnected, listSyncPairs, forgetSyncPair,
    get busy() { return Boolean(active); }, get activeIds() { return active ? [active.review.id] : []; } };
}

module.exports = { createFolderTransfers };
