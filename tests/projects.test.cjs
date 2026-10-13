'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createProjectManager } = require('../app/projects.cjs');

const digest = text => createHash('sha256').update(text).digest('hex');
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termforge-projects-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); const dataDirectory = path.join(directory, 'private');
  await fs.mkdir(root);
  const manager = createProjectManager({ dataDirectory, ...options });
  const project = await manager.open(root);
  return { directory, root, dataDirectory, manager, project, request: relative => ({ projectId: project.id, path: relative }) };
}
function git(root, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function initialize(root) {
  git(root, ['init', '-b', 'main']);
  await fs.writeFile(path.join(root, 'playbook.yml'), '---\n- name: original\n');
  git(root, ['add', '--', 'playbook.yml']); git(root, ['commit', '-m', 'Fixture']);
}

test('opening and listing a project perform no commands, omit .git, and preserve stable handles', async t => {
  let commands = 0;
  const { manager, project, root, request, dataDirectory } = await fixture(t, { spawn: () => { commands++; throw new Error('Must not run'); } });
  await fs.mkdir(path.join(root, 'roles')); await fs.mkdir(path.join(root, '.git')); await fs.writeFile(path.join(root, 'inventory.ini'), '[lab]\n');
  assert.deepEqual(await manager.open(root), project);
  assert.deepEqual(await manager.list(request('')), [{ name: 'roles', path: 'roles', type: 'directory' }, { name: 'inventory.ini', path: 'inventory.ini', type: 'file' }]);
  assert.equal(manager.getRoot(project.id), await fs.realpath(root));
  assert.equal(commands, 0); await assert.rejects(fs.stat(dataDirectory), { code: 'ENOENT' });
  assert.equal(manager.close(project.id), true);
  assert.throws(() => manager.getRoot(project.id), /no longer open/);
  await assert.rejects(manager.read(request('inventory.ini')), /no longer open/);
});

test('UTF-8 reads use content revisions and exclusive creation preserves text', async t => {
  const { manager, request, root } = await fixture(t);
  const text = '\ufeff---\nname: rütér 日本語\r\n';
  const saved = await manager.save({ ...request('new.yml'), revision: null, text });
  assert.deepEqual(saved, { path: 'new.yml', text, revision: digest(text) });
  assert.deepEqual(await manager.read(request('new.yml')), saved);
  assert.equal(await manager.resolveFile(request('').projectId, 'new.yml'), path.join(await fs.realpath(root), 'new.yml'));
  await assert.rejects(manager.save({ ...request('new.yml'), revision: null, text: 'overwrite' }), /changed on disk/);
  assert.equal(await fs.readFile(path.join(root, 'new.yml'), 'utf8'), text);
});

test('saves back up the previous contents privately and can restore through an ordinary reviewed save', async t => {
  const { manager, request, root, dataDirectory } = await fixture(t);
  const before = await manager.save({ ...request('config.yml'), text: 'old\n', revision: null });
  const after = await manager.save({ ...request('config.yml'), text: 'new\n', revision: before.revision });
  const backups = await manager.listBackups(request('config.yml'));
  assert.equal(backups.length, 1); assert.equal(backups[0].id, after.backupId); assert.equal(backups[0].revision, before.revision);
  assert(Number.isFinite(Date.parse(backups[0].createdAt)));
  const restored = await manager.readBackup({ ...request('config.yml'), backupId: after.backupId });
  assert.deepEqual(restored, { text: 'old\n' });
  await manager.save({ ...request('config.yml'), revision: after.revision, text: restored.text });
  assert.equal(await fs.readFile(path.join(root, 'config.yml'), 'utf8'), 'old\n');
  assert.deepEqual(await fs.readdir(root), ['config.yml']);
  const backupBase = path.join(dataDirectory, 'project-backups');
  const projectDirectory = path.join(backupBase, (await fs.readdir(backupBase))[0]);
  const fileDirectory = path.join(projectDirectory, (await fs.readdir(projectDirectory))[0]);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(fileDirectory)).mode & 0o777, 0o700);
    for (const name of await fs.readdir(fileDirectory)) assert.equal((await fs.stat(path.join(fileDirectory, name))).mode & 0o777, 0o600);
  }
  await assert.rejects(manager.readBackup({ ...request('another.yml'), backupId: after.backupId }), /no longer available/);
});

test('external modifications and concurrent saves fail rather than replace an unreviewed revision', async t => {
  const { manager, request, root } = await fixture(t);
  const initial = await manager.save({ ...request('config.yml'), text: 'first', revision: null });
  await fs.writeFile(path.join(root, 'config.yml'), 'external');
  await assert.rejects(manager.save({ ...request('config.yml'), text: 'stale edit', revision: initial.revision }), /changed on disk/);
  assert.equal(await fs.readFile(path.join(root, 'config.yml'), 'utf8'), 'external');
  const current = await manager.read(request('config.yml'));
  const saves = await Promise.allSettled(['A', 'B'].map(text => manager.save({ ...request('config.yml'), text, revision: current.revision })));
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(saves.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual((await manager.listBackups(request('config.yml'))).map(item => item.revision), [current.revision]);
});

test('unchanged saves avoid backups and backups retain at most twenty previous versions', async t => {
  const { manager, request } = await fixture(t);
  let file = await manager.save({ ...request('rolling.txt'), text: '0', revision: null });
  assert.deepEqual(await manager.save({ ...request('rolling.txt'), text: file.text, revision: file.revision }), file);
  assert.deepEqual(await manager.listBackups(request('rolling.txt')), []);
  for (let number = 1; number <= 22; number++) file = await manager.save({ ...request('rolling.txt'), text: String(number), revision: file.revision });
  const backups = await manager.listBackups(request('rolling.txt'));
  assert.equal(backups.length, 20);
  const texts = await Promise.all(backups.map(item => manager.readBackup({ ...request('rolling.txt'), backupId: item.id })));
  assert.equal(new Set(texts.map(item => item.text)).size, 20);
});

test('file paths reject traversal, .git, absolute and ambiguous Windows forms', async t => {
  const { manager, request, directory } = await fixture(t);
  const invalid = ['../outside', 'a/../outside', '.git/config', 'a/.GIT/config', '/absolute', 'C:/absolute', 'a\\outside', 'file:stream', 'a//b', './a', 'file.', 'file ', 'a\0b', 'CON', 'aux.txt', 'COM1.py'];
  for (const relative of invalid) {
    await assert.rejects(manager.read(request(relative)), /path|Traversal|\.git/);
    await assert.rejects(manager.save({ ...request(relative), text: 'bad', revision: null }), /path|Traversal|\.git/);
  }
  await assert.rejects(manager.open(directory), /backups must be outside/);
});

test('symlink files and directory escapes are inaccessible and cannot replace outside content', { skip: process.platform === 'win32' }, async t => {
  const { manager, request, root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
  await fs.symlink(outside, path.join(root, 'escape')); await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  await assert.rejects(manager.read(request('escape/secret.txt')), /Symbolic links/);
  await assert.rejects(manager.read(request('link.txt')), /Symbolic links/);
  await assert.rejects(manager.list(request('escape')), /Symbolic links/);
  await assert.rejects(manager.save({ ...request('link.txt'), revision: null, text: 'new' }), /Symbolic links/);
  assert.deepEqual(await manager.list(request('')), []);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside secret');
});

test('binary, malformed UTF-8, oversized files and invalid requests are rejected', async t => {
  const { manager, request, root } = await fixture(t);
  for (const [name, bytes] of [['binary', Buffer.from([0, 1])], ['invalid', Buffer.from([0xff])], ['large', Buffer.alloc(2 * 1024 * 1024 + 1, 65)]]) {
    await fs.writeFile(path.join(root, name), bytes); await assert.rejects(manager.read(request(name)), /UTF-8|2 MiB/);
  }
  await assert.rejects(manager.save({ ...request('bad'), text: '\ud800', revision: null }), /UTF-8/);
  await assert.rejects(manager.save({ ...request('large'), text: 'a'.repeat(2 * 1024 * 1024 + 1), revision: null }), /2 MiB/);
  await assert.rejects(manager.save({ ...request('x'), text: 'valid' }), /revision/);
  await assert.rejects(manager.read({ ...request('x'), command: 'anything' }), /Invalid project/);
  await assert.rejects(manager.list({ ...request(''), recursive: true }), /Invalid project/);
});

test('a replaced project root is rejected instead of following a new link', { skip: process.platform === 'win32' }, async t => {
  const { manager, request, root, directory } = await fixture(t);
  await fs.rename(root, path.join(directory, 'old-project'));
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, root);
  await assert.rejects(manager.list(request('')), /directory changed/);
});

test('Git status and staged/unstaged diffs use real isolated repositories without modifying files or index', async t => {
  const { manager, project, request, root } = await fixture(t);
  await initialize(root);
  await fs.writeFile(path.join(root, 'playbook.yml'), '---\n- name: staged\n'); git(root, ['add', '--', 'playbook.yml']);
  await fs.writeFile(path.join(root, 'playbook.yml'), '---\n- name: working\n'); await fs.writeFile(path.join(root, 'untracked.yml'), 'new');
  const indexBefore = await fs.readFile(path.join(root, '.git', 'index'));
  const status = await manager.gitStatus({ projectId: project.id });
  assert.equal(status.available, true); assert.equal(status.branch, 'main');
  assert.deepEqual(status.entries, [{ path: 'playbook.yml', status: 'MM' }, { path: 'untracked.yml', status: '??' }]);
  const { diff } = await manager.gitDiff(request('playbook.yml'));
  assert.match(diff, /Staged changes/); assert.match(diff, /Working tree changes/); assert.match(diff, /name: original/); assert.match(diff, /name: working/);
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), indexBefore);
  assert.equal(await fs.readFile(path.join(root, 'playbook.yml'), 'utf8'), '---\n- name: working\n');
});

test('Git supports renamed/deleted files and staged content before the initial commit', async t => {
  const { manager, project, request, root } = await fixture(t);
  git(root, ['init', '-b', 'main']); await fs.writeFile(path.join(root, 'new.yml'), 'new'); git(root, ['add', '--', 'new.yml']);
  assert.match((await manager.gitDiff(request('new.yml'))).diff, /new file mode/);
  git(root, ['commit', '-m', 'Fixture']); git(root, ['mv', 'new.yml', 'renamed.yml']);
  let status = await manager.gitStatus({ projectId: project.id }); assert.deepEqual(status.entries, [{ path: 'renamed.yml', status: 'R ' }]);
  await fs.unlink(path.join(root, 'renamed.yml'));
  assert.match((await manager.gitDiff(request('renamed.yml'))).diff, /deleted file mode/);
  status = await manager.gitStatus({ projectId: project.id }); assert.equal(status.entries[0].status, 'RD');
});

test('projects outside repositories do not discover a parent repository or run Git', async t => {
  let commands = 0;
  const { manager, project, directory } = await fixture(t, { spawn: () => { commands++; throw new Error('Not expected'); } });
  git(directory, ['init', '-b', 'main']);
  assert.equal((await manager.gitStatus({ projectId: project.id })).available, false);
  assert.equal(commands, 0);
});

test('Git rejects repository filters/includes before any command can run', async t => {
  let commands = 0;
  const { manager, project, request, root } = await fixture(t, { spawn: () => { commands++; throw new Error('Must not run helper'); } });
  await initialize(root);
  await fs.appendFile(path.join(root, '.git', 'config'), '\n[filter "malicious"]\n clean = execute-something\n');
  const status = await manager.gitStatus({ projectId: project.id });
  assert.equal(status.available, false); assert.match(status.reason, /filters/);
  await assert.rejects(manager.gitDiff(request('playbook.yml')), /filters/);
  assert.equal(commands, 0);
});

test('Git subprocesses disable helpers, prompts, optional writes, external configuration and network protocols', async t => {
  let captured;
  const { manager, project, root } = await fixture(t, { spawn: (command, args, options) => {
    captured = { command, args, options };
    return spawn(process.execPath, ['-e', 'process.stdout.write("## main\\0 M playbook.yml\\0")'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } });
  await initialize(root); assert.equal((await manager.gitStatus({ projectId: project.id })).available, true);
  assert(path.isAbsolute(captured.command)); assert.equal(path.basename(captured.command).toLowerCase(), process.platform === 'win32' ? 'git.exe' : 'git'); assert.equal(captured.options.shell, false);
  for (const argument of ['--no-pager', '--no-optional-locks', '--literal-pathspecs', 'core.fsmonitor=false', 'protocol.allow=never', '--ignore-submodules=all']) assert(captured.args.includes(argument));
  assert.equal(captured.options.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(captured.options.env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(captured.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(captured.options.env.GIT_NO_LAZY_FETCH, '1');
});

test('Git output limits and timeouts stop the process and provider stderr is not exposed', async t => {
  const large = await fixture(t, { gitOutputLimit: 100, spawn: () => spawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000));setTimeout(()=>{},10000)'], { stdio: ['ignore', 'pipe', 'pipe'] }) });
  await initialize(large.root);
  assert.match((await large.manager.gitStatus({ projectId: large.project.id })).reason, /size limit/);
  const slow = await fixture(t, { gitTimeoutMs: 30, spawn: () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: ['ignore', 'pipe', 'pipe'] }) });
  await initialize(slow.root);
  assert.match((await slow.manager.gitStatus({ projectId: slow.project.id })).reason, /time limit/);
  const failed = await fixture(t, { spawn: () => spawn(process.execPath, ['-e', 'process.stderr.write("PRIVATE_TOKEN");process.exit(1)'], { stdio: ['ignore', 'pipe', 'pipe'] }) });
  await initialize(failed.root);
  const result = await failed.manager.gitStatus({ projectId: failed.project.id });
  assert.equal(result.available, false); assert(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
});
