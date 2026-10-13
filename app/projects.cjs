'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn: spawnChild } = require('node:child_process');

const MAX_FILE = 2 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_BACKUPS = 20;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => target === root || (!path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)));

function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Invalid project request.');
}
function relativePath(value, empty = false) {
  if (typeof value !== 'string' || value.length > 4096 || (!empty && !value) || /[\\:\u0000-\u001f\u007f]/u.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Choose a relative project path.');
  if (empty && value === '') return '';
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) throw new Error('Traversal, .git and ambiguous project paths are not allowed.');
  return value;
}
function textBytes(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('Choose a UTF-8 text file.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_FILE) throw new Error('Project text files are limited to 2 MiB.');
  if (bytes.toString('utf8') !== text) throw new Error('Choose valid UTF-8 text.');
  return bytes;
}
function decode(bytes) {
  if (bytes.length > MAX_FILE) throw new Error('Project text files are limited to 2 MiB.');
  const text = bytes.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) throw new Error('This file is not UTF-8 text.');
  return text;
}
async function canonicalFuture(filename) {
  let current = path.resolve(filename); const missing = [];
  for (;;) {
    try { return path.join(await fsp.realpath(current), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      missing.unshift(path.basename(current)); current = parent;
    }
  }
}

function createProjectManager({ dataDirectory, spawn = spawnChild, gitTimeoutMs = 15000, gitOutputLimit = MAX_GIT_OUTPUT } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw new Error('An absolute private data directory is required.');
  const backupRoot = path.join(dataDirectory, 'project-backups');
  const projects = new Map();
  const locks = new Map();

  function project(id) {
    if (typeof id !== 'string' || !projects.has(id)) throw new Error('The project is no longer open.');
    return projects.get(id);
  }
  async function resolve(entry, relative, { directory = false, missing = false } = {}) {
    const rootStat = await fsp.lstat(entry.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fsp.realpath(entry.root) !== entry.root) throw new Error('The project directory changed. Open it again.');
    let current = entry.root;
    const parts = relative ? relative.split('/') : [];
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat;
      try { stat = await fsp.lstat(current); } catch (error) {
        if (error.code === 'ENOENT' && missing && index === parts.length - 1) return { absolute: current, stat: null };
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in project file paths.');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('A project path component is not a directory.');
      if (index === parts.length - 1 && (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(directory ? 'Choose a project directory.' : 'Choose a regular project file.');
    }
    if (!inside(entry.root, await fsp.realpath(current))) throw new Error('The path leaves the selected project.');
    return { absolute: current, stat: await fsp.lstat(current) };
  }
  async function readFile(entry, relative) {
    const target = await resolve(entry, relative);
    if (target.stat.size > MAX_FILE) throw new Error('Project text files are limited to 2 MiB.');
    const handle = await fsp.open(target.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Choose a regular text file of at most 2 MiB.');
      // Bound allocation even if another process grows the file during a read.
      const buffer = Buffer.alloc(MAX_FILE + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      const text = decode(bytes);
      return { path: relative, text, revision: hash(bytes), mode: stat.mode & 0o777 };
    } finally { await handle.close(); }
  }
  async function backupDirectory(entry, relative, create = false) {
    if (create) await fsp.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    let dataRoot;
    try { dataRoot = await fsp.realpath(dataDirectory); } catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
    if (inside(entry.root, dataRoot)) throw new Error('Private backups must be stored outside the project. Choose a narrower project folder.');
    let directory = dataRoot;
    for (const name of ['project-backups', hash(entry.root), hash(relative)]) {
      directory = path.join(directory, name);
      if (create) await fsp.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      let stat;
      try { stat = await fsp.lstat(directory); } catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private backup storage is not a regular directory.');
      if (create && process.platform !== 'win32') await fsp.chmod(directory, 0o700);
    }
    return directory;
  }
  async function backups(entry, relative) {
    const directory = await backupDirectory(entry, relative);
    if (!directory) return [];
    const records = [];
    for (const name of (await fsp.readdir(directory)).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).slice(0, 1000)) {
      const filename = path.join(directory, name);
      const stat = await fsp.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid private backup record.');
      const item = JSON.parse(await fsp.readFile(filename, 'utf8'));
      if (item.id !== name.slice(0, -5) || item.path !== relative || !/^[a-f0-9]{64}$/u.test(item.revision) || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('Invalid private backup record.');
      records.push(item);
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async function backup(entry, relative, old) {
    const directory = await backupDirectory(entry, relative, true);
    const id = randomUUID();
    const previous = await backups(entry, relative);
    const createdAt = new Date(Math.max(Date.now(), (Date.parse(previous[0]?.createdAt) || 0) + 1)).toISOString();
    const record = { id, path: relative, createdAt, revision: old.revision, bytes: Buffer.byteLength(old.text, 'utf8') };
    await fsp.writeFile(path.join(directory, `${id}.txt`), old.text, { flag: 'wx', mode: 0o600 });
    try { await fsp.writeFile(path.join(directory, `${id}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await fsp.unlink(path.join(directory, `${id}.txt`)); throw error; }
    for (const item of (await backups(entry, relative)).slice(MAX_BACKUPS)) {
      await fsp.unlink(path.join(directory, `${item.id}.json`));
      await fsp.unlink(path.join(directory, `${item.id}.txt`));
    }
    return id;
  }
  async function locked(key, action) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }

  async function repository(entry) {
    await resolve(entry, '', { directory: true });
    const gitDir = path.join(entry.root, '.git');
    let stat;
    try { stat = await fsp.lstat(gitDir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose the root of a regular Git repository. Linked worktrees and submodules are not supported yet.');
    // Git status/diff can invoke clean filters from repository configuration.
    // Accept only a small, passive config subset before starting Git; global
    // and system configuration are disabled separately for every subprocess.
    for (const name of ['config', 'HEAD', 'index']) {
      const filename = path.join(gitDir, name);
      let item;
      try { item = await fsp.lstat(filename); } catch (error) { if (error.code === 'ENOENT' && name !== 'config') continue; throw error; }
      if (!item.isFile() || item.isSymbolicLink()) throw new Error('Linked Git metadata is not supported for project inspection.');
      if (name !== 'config') continue;
      if (item.size > 65536) throw new Error('Git configuration is too large to inspect safely.');
      const config = await fsp.readFile(filename, 'utf8');
      let section = '';
      for (const line of config.split(/\r?\n/u)) {
        if (/^\s*(?:[#;].*)?$/u.test(line)) continue;
        if (/\\\s*$/u.test(line)) throw new Error('Git configuration continuations are not supported for project inspection.');
        if (/^\s*\[/u.test(line)) {
          const match = /^\s*\[([a-zA-Z][a-zA-Z0-9.-]*)(?:\s+"(?:[^"\\]|\\.)*")?\]\s*(?:[#;].*)?$/u.exec(line);
          section = match?.[1].toLowerCase().split('.')[0];
          if (!['core', 'remote', 'branch', 'user', 'init', 'color', 'pull', 'push', 'fetch', 'credential'].includes(section)) throw new Error('Git inspection does not load repository includes, filters, aliases or extension configuration.');
        } else if (!section || !/^\s*[a-zA-Z][a-zA-Z0-9-]*(?:\s*=.*)?\s*$/u.test(line)) throw new Error('Git configuration could not be inspected safely.');
      }
    }
    return gitDir;
  }
  async function git(entry, gitDir, args) {
    // Explicit flags disable executable helpers and lazy network fetching.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: '', LC_ALL: 'C' });
    // Never let the selected project supply a git executable through a relative
    // PATH entry or Windows' current-directory executable lookup.
    let executable;
    for (const directory of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      try {
        const candidate = await fsp.realpath(path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
        if (inside(entry.root, candidate) || !(await fsp.stat(candidate)).isFile()) continue;
        await fsp.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        executable = candidate; break;
      } catch { /* Continue to the next installed executable. */ }
    }
    if (!executable) throw new Error('Git is not available. Install Git to use project changes.');
    const argv = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', `--git-dir=${gitDir}`, `--work-tree=${entry.root}`, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', `safe.directory=${entry.root}`, ...args];
    return new Promise((resolveResult, reject) => {
      let child;
      try { child = spawn(executable, argv, { cwd: entry.root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(new Error('Git is not available. Install Git to use project changes.')); return; }
      const chunks = []; let size = 0; let settled = false; let failure = null; let forceTimer;
      const stop = message => {
        failure ||= new Error(message);
        try { child.kill(); } catch { /* Exit will report the failure. */ }
        if (!forceTimer) forceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Process may already have exited. */ } }, 1000);
      };
      const timer = setTimeout(() => stop('Git exceeded its time limit.'), gitTimeoutMs);
      const collect = chunk => { size += chunk.length; if (size > gitOutputLimit) stop('Git output exceeded its size limit.'); };
      child.stdout.on('data', chunk => { collect(chunk); if (!failure) chunks.push(Buffer.from(chunk)); });
      child.stderr.on('data', collect);
      child.once('error', () => { failure = new Error('Git is not available. Install Git to use project changes.'); });
      child.once('close', code => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forceTimer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error('Git could not inspect this repository. No project files were changed.'));
        else resolveResult(Buffer.concat(chunks).toString('utf8'));
      });
    });
  }

  return {
    async open(root) {
      if (typeof root !== 'string' || !path.isAbsolute(root) || /[\u0000\r\n]/u.test(root)) throw new Error('Choose an absolute project directory.');
      const resolved = await fsp.realpath(root);
      if (!(await fsp.stat(resolved)).isDirectory()) throw new Error('Choose a project directory.');
      if (resolved.split(path.sep).some(part => part.toLowerCase() === '.git')) throw new Error('The .git directory is not a project file workspace.');
      if (inside(resolved, await canonicalFuture(backupRoot))) throw new Error('Private backups must be outside the project. Choose a narrower project folder.');
      for (const entry of projects.values()) if (entry.root === resolved) return { ...entry };
      if (projects.size >= 8) throw new Error('Close a project before opening another.');
      const entry = { id: randomUUID(), name: path.basename(resolved) || resolved, root: resolved };
      projects.set(entry.id, entry); return { ...entry };
    },
    close(id) { return projects.delete(project(id).id); },
    getRoot(id) { return project(id).root; },
    async resolveFile(id, relative) { return (await resolve(project(id), relativePath(relative))).absolute; },
    async list(input) {
      fields(input, ['projectId', 'path']);
      const relative = relativePath(input.path ?? '', true);
      const target = await resolve(project(input.projectId), relative, { directory: true });
      const entries = [];
      const directory = await fsp.opendir(target.absolute);
      for await (const entry of directory) {
        if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
        const filePath = relative ? `${relative}/${entry.name}` : entry.name;
        try { relativePath(filePath); } catch { continue; }
        entries.push({ name: entry.name, path: filePath, type: entry.isDirectory() ? 'directory' : 'file' });
        if (entries.length > MAX_ENTRIES) throw new Error('This directory exceeds the 2,000-entry limit. Open a narrower folder.');
      }
      return entries.sort((a, b) => Number(a.type !== 'directory') - Number(b.type !== 'directory') || a.name.localeCompare(b.name));
    },
    async read(input) {
      fields(input, ['projectId', 'path']);
      const { mode, ...result } = await readFile(project(input.projectId), relativePath(input.path)); return result;
    },
    async save(input) {
      fields(input, ['projectId', 'path', 'text', 'revision']);
      const entry = project(input.projectId); const relative = relativePath(input.path); const bytes = textBytes(input.text);
      if (input.revision !== null && (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(input.revision))) throw new Error('A current file revision is required before saving.');
      return locked(`${entry.root}\0${relative}`, async () => {
        project(input.projectId);
        const target = await resolve(entry, relative, { missing: true });
        const old = target.stat ? await readFile(entry, relative) : null;
        if ((old?.revision ?? null) !== input.revision) throw new Error('The file changed on disk. Reload and review it before saving.');
        if (old?.text === input.text) return { path: relative, text: input.text, revision: old.revision };
        const backupId = old ? await backup(entry, relative, old) : undefined;
        const temporary = path.join(path.dirname(target.absolute), `.termforge-save-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), old?.mode ?? 0o600);
          if (old && process.platform !== 'win32') await handle.chmod(old.mode);
          await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
          project(input.projectId);
          await resolve(entry, relative, { missing: true });
          if (old) {
            if ((await readFile(entry, relative)).revision !== input.revision) throw new Error('The file changed on disk. Reload and review it before saving.');
            await fsp.rename(temporary, target.absolute);
          } else {
            // Hard-link publication is exclusive: a concurrently created file
            // must never be replaced by a save that expected no file.
            await fsp.link(temporary, target.absolute);
          }
        } catch (error) {
          if (error.code === 'EEXIST') throw new Error('The file changed on disk. Reload and review it before saving.');
          throw error;
        } finally { await handle?.close(); await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return { path: relative, text: input.text, revision: hash(bytes), ...(backupId ? { backupId } : {}) };
      });
    },
    async listBackups(input) { fields(input, ['projectId', 'path']); return backups(project(input.projectId), relativePath(input.path)); },
    async readBackup(input) {
      fields(input, ['projectId', 'path', 'backupId']);
      const entry = project(input.projectId); const relative = relativePath(input.path);
      if (typeof input.backupId !== 'string' || !/^[a-f0-9-]{36}$/u.test(input.backupId)) throw new Error('Invalid backup identifier.');
      const record = (await backups(entry, relative)).find(item => item.id === input.backupId);
      if (!record) throw new Error('Backup is no longer available.');
      const filename = path.join(await backupDirectory(entry, relative), `${record.id}.txt`);
      const stat = await fsp.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw new Error('Invalid private backup file.');
      const bytes = await fsp.readFile(filename);
      if (hash(bytes) !== record.revision) throw new Error('The backup contents changed.');
      return { text: decode(bytes) };
    },
    async gitStatus(input) {
      fields(input, ['projectId']); const entry = project(input.projectId);
      try {
        const gitDir = await repository(entry);
        if (!gitDir) return { available: false, branch: '', entries: [], reason: 'Open the root of a Git repository to inspect changes.' };
        const output = await git(entry, gitDir, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all']);
        const records = output.split('\0'); const header = records.shift() || '';
        const branch = header.replace(/^## (?:No commits yet on |Initial commit on )?/u, '').split('...')[0];
        const entries = [];
        for (let index = 0; index < records.length; index++) {
          const row = records[index]; if (!row) continue;
          const status = row.slice(0, 2); const filePath = row.slice(3);
          if (/[RC]/u.test(status)) index++;
          try { relativePath(filePath.replace(/\/$/u, '')); } catch { continue; }
          entries.push({ path: filePath, status });
          if (entries.length > MAX_ENTRIES) throw new Error('Git status exceeds the 2,000-entry limit.');
        }
        return { available: true, branch, entries };
      } catch (error) { return { available: false, branch: '', entries: [], reason: error.message }; }
    },
    async gitDiff(input) {
      fields(input, ['projectId', 'path']); const entry = project(input.projectId); const relative = relativePath(input.path);
      await resolve(entry, relative, { missing: true });
      const gitDir = await repository(entry); if (!gitDir) throw new Error('This project is not a Git repository.');
      const options = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-color', '--no-renames', '--', relative];
      // Separate staged/unstaged sections work on repositories without HEAD.
      const staged = await git(entry, gitDir, ['diff', '--cached', ...options]);
      const unstaged = await git(entry, gitDir, ['diff', ...options]);
      const diff = `${staged ? `Staged changes\n${staged}` : ''}${staged && unstaged ? '\n' : ''}${unstaged ? `Working tree changes\n${unstaged}` : ''}`;
      if (Buffer.byteLength(diff) > MAX_GIT_OUTPUT) throw new Error('Git diff exceeded its size limit.');
      return { diff };
    },
  };
}

module.exports = { createProjectManager };
