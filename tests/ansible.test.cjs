'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createAnsibleManager, controllerOptions, restrictedEnvironment } = require('../app/ansible.cjs');

async function until(predicate) { for (let n = 0; n < 100; n += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Expected controller event did not arrive'); }
function fakeProcess() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 999999;
  child.kills = []; child.closed = false;
  child.close = (code = 0) => { if (!child.closed) { child.closed = true; child.emit('close', code, null); } };
  child.kill = signal => { child.kills.push(signal); setImmediate(() => child.close(null)); };
  child.event = value => child.stdout.write(JSON.stringify(value) + '\n');
  return child;
}
async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'termforge-ansible-test-')));
  const root = path.join(base, 'project'); const dataDirectory = path.join(base, 'private'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'playbook.yml'), '- hosts: all\n  gather_facts: false\n  tasks: []\n');
  await fs.writeFile(path.join(root, 'inventory.ini'), '[local]\nlocalhost ansible_connection=local\n');
  const children = []; const events = []; const stops = []; let open = true;
  const projects = { getRoot: id => { if (id !== 'project' || !open) throw new Error('Project is closed'); return root; }, resolveFile: (id, filename) => path.resolve(projects.getRoot(id), filename) };
  const spawn = (command, args, config) => {
    const child = fakeProcess(); children.push({ command, args, config, child });
    if (args.includes('--probe')) setImmediate(() => { child.event({ available: true, runnerVersion: '2.fixture', ansibleVersion: '2.fixture', pythonVersion: '3.fixture' }); child.close(); });
    if (args.includes('wslpath')) setImmediate(() => { child.stdout.write('/mnt/c/fixture\n'); child.close(); });
    return child;
  };
  const manager = createAnsibleManager({ projects, dataDirectory, spawn, send: (channel, event) => { assert.equal(channel, 'ansibleEvent'); events.push(event); }, platform: 'linux', cancelGraceMs: 1, terminate: async child => { stops.push(child); child.close(); }, ...options });
  t.after(async () => { for (const { child } of children) child.close(); await manager.closeAll().catch(() => {}); await fs.rm(base, { recursive: true, force: true }); });
  const input = { projectId: 'project', controller: 'local', playbook: 'playbook.yml', inventory: 'inventory.ini', limit: '', mode: 'check', trusted: true };
  return { base, root, dataDirectory, projects, children, events, stops, manager, input, closeProject: () => { open = false; } };
}

test('Ansible creation and preparation never spawn a process; trust and review are explicit', async t => {
  const f = await fixture(t); assert.equal(f.children.length, 0);
  await assert.rejects(f.manager.prepare({ ...f.input, trusted: false }), /Trust/);
  const plan = await f.manager.prepare(f.input);
  assert.equal(f.children.length, 0); assert.match(plan.command, /--check --diff/); assert.match(plan.warnings.join(' '), /override check mode/);
  assert.match(plan.warnings.join(' '), /not an immutable snapshot/); assert.equal(plan.files.length, 2);
  assert.equal(plan.files[0].revision, createHash('sha256').update(await fs.readFile(path.join(f.root, 'playbook.yml'))).digest('hex'));
  await assert.rejects(f.manager.start({ planId: plan.planId }), /confirm/); assert.equal(f.children.length, 0);
});

test('Syntax preparation also requires trust and a bounded file inventory', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.prepare({ ...f.input, mode: 'syntax', trusted: false }), /Trust/);
  const plan = await f.manager.prepare({ ...f.input, mode: 'syntax' }); assert.match(plan.command, /--syntax-check/); assert.doesNotMatch(plan.command, /--diff/);
  assert.equal(f.children.length, 0);
});

test('Controller options reject shell commands and unsupported native Windows control nodes', () => {
  for (const python of ['python3 -c x', '--help', 'python;touch bad', '../python', 'python3\n', false, 42, {}, []]) assert.throws(() => controllerOptions({ python }, 'linux'), /Python/);
  assert.throws(() => controllerOptions({ controller: 'local' }, 'win32'), /require WSL/);
  assert.throws(() => controllerOptions({ controller: 'wsl' }, 'darwin'), /available on Windows/);
  assert.equal(controllerOptions({ python: '/opt/my venv/bin/python3' }, 'linux').python, '/opt/my venv/bin/python3');
});

test('Ansible inputs reject traversal, options, embedded control bytes and file-based limits', async t => {
  const f = await fixture(t);
  for (const playbook of ['../outside.yml', '/tmp/a.yml', '-evil.yml', '.git/config', 'C:/file.yml', 'x\\file.yml', 'x\n.yml', 'a/../b.yml', 'a//b.yml']) await assert.rejects(f.manager.prepare({ ...f.input, playbook }), /inside the open project/);
  for (const limit of ['--extra-vars=x', '@secrets.txt', 'host --diff', 'x\n', false, 42, {}, []]) await assert.rejects(f.manager.prepare({ ...f.input, limit }), /Limit/);
  await assert.rejects(f.manager.prepare({ ...f.input, inventory: 'localhost,' }), /ENOENT/);
  assert.equal(f.children.length, 0);
});

test('Symlinks and inputs larger than 2 MiB are rejected before a controller starts', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.base, 'outside.yml'), 'secret');
  try { await fs.symlink(path.join(f.base, 'outside.yml'), path.join(f.root, 'link.yml')); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  if (await fs.lstat(path.join(f.root, 'link.yml')).catch(() => null)) await assert.rejects(f.manager.prepare({ ...f.input, playbook: 'link.yml' }), /outside|symbolic/);
  await fs.writeFile(path.join(f.root, 'large.yml'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(f.manager.prepare({ ...f.input, playbook: 'large.yml' }), /2 MiB/); assert.equal(f.children.length, 0);
});

test('Changed playbook or inventory rejects a reviewed plan without spawning', async t => {
  const f = await fixture(t);
  for (const filename of ['playbook.yml', 'inventory.ini']) {
    const plan = await f.manager.prepare(f.input); await fs.appendFile(path.join(f.root, filename), '\n# changed');
    await assert.rejects(f.manager.start({ planId: plan.planId, confirmed: true }), /changed after review/);
  }
  assert.equal(f.children.length, 0);
});

test('Closed projects and expired plans cannot launch', async t => {
  let clock = 1000; const f = await fixture(t, { now: () => clock });
  const expired = await f.manager.prepare(f.input); clock += 6 * 60 * 1000;
  await assert.rejects(f.manager.start({ planId: expired.planId, confirmed: true }), /expired/);
  const closed = await f.manager.prepare(f.input); f.closeProject();
  await assert.rejects(f.manager.start({ planId: closed.planId, confirmed: true }), /closed/); assert.equal(f.children.length, 0);
});

test('Launch binds exact reviewed options, has no shell, and keeps artifacts outside the project', async t => {
  const f = await fixture(t); const plan = await f.manager.prepare({ ...f.input, limit: 'routers:&lab:!offline' });
  plan.mode = 'run'; plan.inventory = 'other'; plan.files[0].revision = 'modified renderer copy';
  const { id } = await f.manager.start({ planId: plan.planId, confirmed: true, mode: 'run', inventory: 'other' });
  const spawned = f.children.at(-1); assert.equal(spawned.config.shell, false); assert.equal(spawned.args[0], '-I'); assert.equal(spawned.config.detached, true);
  assert.equal(f.manager.count, 1); assert.equal(f.manager.hasProject('project'), true); assert.equal(f.manager.activeProjectId, 'project');
  assert.ok(!spawned.config.cwd.startsWith(f.root));
  const request = JSON.parse(await fs.readFile(path.join(spawned.config.cwd, 'request.json'), 'utf8'));
  assert.equal(request.mode, 'check'); assert.equal(request.inventory, 'inventory.ini'); assert.equal(request.limit, 'routers:&lab:!offline');
  assert.match(request.files[0].revision, /^[a-f0-9]{64}$/);
  spawned.child.event({ type: 'status', status: 'successful', rc: 0 }); spawned.child.close(); await until(() => f.manager.count === 0);
  assert.equal(f.events.at(-1).status, 'successful'); assert.equal(f.events.at(-1).id, id);
  await assert.rejects(fs.access(spawned.config.cwd), /ENOENT/);
  await assert.rejects(f.manager.start({ planId: plan.planId, confirmed: true }), /Prepare/);
});

test('Runner JSONL preserves split UTF-8, host/task stats and diff while ignoring unexpected fields', async t => {
  const f = await fixture(t); const plan = await f.manager.prepare(f.input); const { id } = await f.manager.start({ planId: plan.planId, confirmed: true });
  const child = f.children.at(-1).child;
  const bytes = Buffer.from(JSON.stringify({ type: 'event', event: 'runner_on_ok', host: 'lab', task: 'Résumé 日本', message: '<img onerror=alert(1)>', diff: 'before → after', changed: true, arbitrary: 'excluded' }) + '\n');
  const cut = bytes.indexOf(Buffer.from('é')) + 1; child.stdout.write(bytes.subarray(0, cut)); child.stdout.write(bytes.subarray(cut));
  child.event({ type: 'event', event: 'playbook_on_stats', stats: { ok: { lab: 1 }, changed: { lab: 1 }, failures: { lab: 0 }, secrets: { x: 1 } } });
  const event = f.events.find(event => event.type === 'event'); assert.equal(event.id, id); assert.equal(event.task, 'Résumé 日本'); assert.equal(event.diff, 'before → after'); assert.equal(event.arbitrary, undefined); assert.match(event.message, /<img/);
  assert.deepEqual(f.events.at(-1).stats, { ok: { lab: 1 }, changed: { lab: 1 }, failures: { lab: 0 } });
  child.event({ type: 'status', status: 'successful', rc: 0 }); child.close(); await until(() => f.manager.count === 0);
});

test('A zero exit without a successful final result never reports success', async t => {
  const f = await fixture(t); const plan = await f.manager.prepare(f.input); await f.manager.start({ planId: plan.planId, confirmed: true });
  f.children.at(-1).child.close(0); await until(() => f.manager.count === 0); assert.equal(f.events.at(-1).status, 'failed');
});

test('Cancel signals one run, falls back to process-tree stop, and does not claim rollback', async t => {
  const f = await fixture(t); const plan = await f.manager.prepare(f.input); const { id } = await f.manager.start({ planId: plan.planId, confirmed: true });
  const child = f.children.at(-1).child; let input = ''; child.stdin.on('data', chunk => { input += chunk; });
  const response = await f.manager.cancel(id); assert.equal(response.cancelling, true);
  await until(() => f.manager.count === 0); assert.match(input, /cancel/); assert.deepEqual(f.stops, [child]); assert.equal(f.events.at(-1).status, 'cancelled');
  assert.match(f.events.find(event => event.status === 'cancelling').message, /not rolled back/);
  child.event({ type: 'event', event: 'late', message: 'stale' }); assert.equal(f.events.some(event => event.event === 'late'), false);
});

test('Malformed or oversized helper output stops the controller with an explicit error', async t => {
  const f = await fixture(t, { maxOutputBytes: 128 });
  for (const frame of ['not-json\n', 'x'.repeat(129)]) {
    const plan = await f.manager.prepare(f.input); await f.manager.start({ planId: plan.planId, confirmed: true }); f.children.at(-1).child.stdout.write(frame);
    await until(() => f.manager.count === 0); assert.equal(f.events.at(-1).status, 'failed');
  }
  assert.ok(f.events.some(event => /invalid event/.test(event.error || ''))); assert.ok(f.events.some(event => /output limit/.test(event.error || '')));
});

test('Event and runtime limits stop a run and closeAll prevents further launch', async t => {
  const f = await fixture(t, { maxEvents: 1, runTimeoutMs: 30 });
  let plan = await f.manager.prepare(f.input); await f.manager.start({ planId: plan.planId, confirmed: true });
  f.children.at(-1).child.event({ type: 'event', event: 'one' }); f.children.at(-1).child.event({ type: 'event', event: 'two' });
  await until(() => f.manager.count === 0); assert.match(f.events.at(-1).error, /event/);
  plan = await f.manager.prepare(f.input); await f.manager.start({ planId: plan.planId, confirmed: true }); await until(() => f.manager.count === 0); assert.match(f.events.at(-1).error, /time limit/);
  await f.manager.closeAll(); await assert.rejects(f.manager.prepare(f.input), /closing/);
});

test('Concurrent starts are rejected without consuming the next reviewed plan', async t => {
  const f = await fixture(t); const first = await f.manager.prepare(f.input); const second = await f.manager.prepare(f.input);
  const pending = f.manager.start({ planId: first.planId, confirmed: true }); await assert.rejects(f.manager.start({ planId: second.planId, confirmed: true }), /current/);
  const { id } = await pending; await f.manager.cancel(id); await until(() => f.manager.count === 0);
  await f.manager.start({ planId: second.planId, confirmed: true }); assert.equal(f.manager.count, 1);
});

test('Probe uses isolated Python away from the project and leaves no private directory', async t => {
  const f = await fixture(t, { environment: { PATH: '/usr/bin', HOME: '/test-home', PYTHONPATH: '/evil', ANSIBLE_CONFIG: '/evil/config', API_KEY: 'secret' } });
  const result = await f.manager.probe({ controller: 'local', python: '/safe venv/bin/python3' });
  assert.equal(result.available, true); assert.equal(result.runnerVersion, '2.fixture'); assert.equal(f.events.length, 0);
  const spawned = f.children.at(-1); assert.equal(spawned.command, '/safe venv/bin/python3'); assert.equal(spawned.args[0], '-I'); assert.equal(spawned.config.env.PYTHONPATH, undefined); assert.equal(spawned.config.env.API_KEY, undefined); assert.notEqual(spawned.config.env.ANSIBLE_CONFIG, '/evil/config');
  assert.ok(!spawned.config.cwd.startsWith(f.root)); await assert.rejects(fs.access(spawned.config.cwd), /ENOENT/);
});

test('Missing interpreter probe is actionable and never installs packages', async t => {
  const f = await fixture(t, { spawn: () => { const child = fakeProcess(); setImmediate(() => { child.emit('error', new Error('spawn ENOENT')); child.close(1); }); return child; } });
  const result = await f.manager.probe(); assert.equal(result.available, false); assert.match(result.hint, /virtual environment/); assert.match(result.hint, /does not install/); assert.match(result.error, /ENOENT/);
});

test('WSL probe uses argument arrays and translates the private helper path', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const result = await f.manager.probe({ controller: 'wsl' }); assert.equal(result.available, true);
  assert.deepEqual(f.children[0].args.slice(0, 4), ['--exec', 'wslpath', '-a', '-u']);
  assert.deepEqual(f.children[1].args.slice(0, 5), ['--exec', 'python3', '-I', '-u', '/mnt/c/fixture/termforge_ansible.py']);
  assert.ok(f.children.every(child => child.config.shell === false));
});

test('Closing during probe directory preparation never launches a local or WSL process afterward', async t => {
  for (const [platform, controller] of [['linux', 'local'], ['win32', 'wsl']]) {
    const f = await fixture(t, { platform });
    const pending = f.manager.probe({ controller });
    // probe has reached its first filesystem await; shutdown completes before
    // private-directory preparation can resume and attempt a process launch.
    await f.manager.closeAll();
    const result = await pending;
    assert.equal(result.available, false); assert.match(result.error, /closing/);
    assert.equal(f.children.length, 0); assert.equal(f.manager.count, 0);
    assert.deepEqual(await fs.readdir(path.join(f.dataDirectory, 'ansible-runs')), []);
  }
});

test('Closing after WSL path translation prevents the subsequent Python probe launch', async t => {
  const calls = []; let manager; let shutdown;
  const f = await fixture(t, { platform: 'win32', spawn: (command, args) => {
    calls.push({ command, args }); const child = fakeProcess();
    setImmediate(() => {
      child.stdout.write('/mnt/c/fixture\n'); child.close();
      // The capture promise has resolved, but launchOptions has not resumed.
      shutdown = manager.closeAll();
    });
    return child;
  } });
  manager = f.manager;
  const result = await manager.probe({ controller: 'wsl' });
  await shutdown;
  assert.equal(result.available, false); assert.match(result.error, /closing/);
  assert.equal(calls.length, 1); assert.ok(calls[0].args.includes('wslpath'));
  assert.ok(calls.every(call => !call.args.includes('--probe')));
  assert.equal(manager.count, 0); assert.deepEqual(await fs.readdir(path.join(f.dataDirectory, 'ansible-runs')), []);
});

test('Timed-out probes stay tracked until TERM then KILL produces an actual exit', async t => {
  let child; let directory;
  const f = await fixture(t, { probeTimeoutMs: 10, spawn: (_command, _args, options) => {
    directory = options.cwd; child = fakeProcess();
    child.kill = signal => { child.kills.push(signal); if (signal === 'SIGKILL') setImmediate(() => child.close(1)); };
    return child;
  } });
  const checking = f.manager.probe();
  await until(() => child?.kills.includes('SIGTERM'));
  assert.equal(f.manager.count, 1); await fs.access(directory);
  const result = await checking;
  assert.equal(result.available, false); assert.match(result.error, /timed out/);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']); assert.equal(f.manager.count, 0);
  await assert.rejects(fs.access(directory), /ENOENT/);
});

test('An unverified probe exit retains state and makes application shutdown fail explicitly', async t => {
  let child; let directory;
  const f = await fixture(t, { probeTimeoutMs: 5, spawn: (_command, _args, options) => {
    directory = options.cwd; child = fakeProcess(); child.kill = signal => { child.kills.push(signal); }; return child;
  } });
  const result = await f.manager.probe();
  assert.equal(result.available, false); assert.match(result.error, /shutdown could not be verified/);
  assert.equal(f.manager.count, 1); await fs.access(directory);
  await assert.rejects(f.manager.prepare(f.input), /probe has not stopped/);
  await assert.rejects(f.manager.closeAll(), /could not be verified/);
  child.close(1); assert.equal(f.manager.count, 0);
});

test('Unverified process-tree shutdown rejects closeAll instead of claiming successful cleanup', async t => {
  const f = await fixture(t, { platform: 'win32', terminate: async () => { throw new Error('synthetic tree failure'); } });
  const plan = await f.manager.prepare({ ...f.input, controller: 'wsl' });
  await f.manager.start({ planId: plan.planId, confirmed: true });
  await assert.rejects(f.manager.closeAll(), /could not be verified/); assert.equal(f.manager.count, 1); assert.equal(f.events.at(-1).status, 'failed');
});

test('Restricted launch environment excludes credentials and arbitrary Python/Ansible configuration', () => {
  const env = restrictedEnvironment({ HOME: '/home/test', PATH: '/usr/bin', SSH_AUTH_SOCK: '/agent', ANSIBLE_PASSWORD: 'secret', ANSIBLE_CONFIG: '/bad', PYTHONPATH: '/bad', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require=bad' });
  assert.equal(env.HOME, '/home/test'); assert.equal(env.SSH_AUTH_SOCK, '/agent');
  for (const name of ['ANSIBLE_PASSWORD', 'ANSIBLE_CONFIG', 'PYTHONPATH', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
});

test('Controller close waits for tree verification even if its parent exits first', async t => {
  let finishStop;
  const f = await fixture(t, { platform: 'win32', terminate: async child => {
    child.close();
    await new Promise(resolve => { finishStop = resolve; });
    throw new Error('a descendant survived');
  } });
  const plan = await f.manager.prepare({ ...f.input, controller: 'wsl' });
  await f.manager.start({ planId: plan.planId, confirmed: true });
  const closing = f.manager.closeAll();
  await until(() => typeof finishStop === 'function');
  assert.equal(f.manager.count, 1);
  assert.equal(f.events.some(event => event.status === 'cancelled'), false);
  finishStop();
  await assert.rejects(closing, /could not be verified/);
  assert.equal(f.events.at(-1).status, 'failed');
});

const helperPython = process.platform === 'win32' ? 'python' : 'python3';
const helperPythonAvailable = spawnSync(helperPython, ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).status === 0;
function pythonHelper(code, args = []) {
  const result = spawnSync(helperPython, ['-I', '-c', `import runpy,sys,json,hashlib\nfrom pathlib import Path\nh = runpy.run_path(sys.argv[1])\n${code}`, path.join(__dirname, '../app/termforge_ansible.py'), ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return JSON.parse(result.stdout);
}

test('Python event adapter suppresses no_log output and diffs and bounds ordinary results', { skip: !helperPythonAvailable }, () => {
  const result = pythonHelper(`
output = []
for hidden in ({'_ansible_no_log': True}, {'censored': 'hidden'}):
    output.append(h['sanitized_event']({'event':'runner_on_ok', 'stdout':'PRIVATE VALUE', 'event_data':{'host':'localhost', 'task':'Test', 'res':dict(hidden, diff={'after':'PRIVATE VALUE'})}}))
output.append(h['sanitized_event']({'event':'runner_on_failed', 'stdout':'x'*9000, 'event_data':{'res':{'diff':{'after':'y'*18000}}}}))
print(json.dumps(output))`);
  for (const event of result.slice(0, 2)) { assert.match(event.message, /no_log/); assert.equal(event.diff, undefined); assert.doesNotMatch(JSON.stringify(event), /PRIVATE VALUE/); }
  assert.equal(result[2].failed, true); assert.equal(result[2].message.length, 8192); assert.equal(result[2].diff.length, 16384);
});

test('Python launch validation independently rejects changed inputs and confines reviewed paths', { skip: !helperPythonAvailable }, async t => {
  const f = await fixture(t); const plan = await f.manager.prepare(f.input);
  const result = pythonHelper(`
root=Path(sys.argv[2]); item=json.loads(sys.argv[3]); results=[]
results.append(str(h['validate_file'](root,item)))
(root/item['path']).write_text('changed',encoding='utf-8')
for bad in (item, {'path':'../outside.yml','revision':'x'}, {'path':str(root/item['path']),'revision':'x'}):
    try:
        h['validate_file'](root,bad); results.append('accepted')
    except RuntimeError as error: results.append(str(error))
print(json.dumps(results))`, [f.root, JSON.stringify(plan.files[0])]);
  assert.equal(result[0], path.join(f.root, 'playbook.yml'));
  assert.match(result[1], /changed after review/); assert.match(result[2], /Invalid reviewed/); assert.match(result[3], /Invalid reviewed/);
});

test('Python tree stop refuses reused process identities and limits signals to recorded descendants', { skip: !helperPythonAvailable }, async t => {
  const f = await fixture(t);
  const result = pythonHelper(`
directory=Path(sys.argv[2]); metadata=directory/'controller.json'
metadata.write_text(json.dumps({'pid':12345,'started':'original'}),encoding='utf-8')
g=h['stop_tree'].__globals__; signals=[]; alive={12345:'reused',12346:'child',12347:'grandchild',99999:'unrelated'}
# This models the POSIX controller used by both native Unix and WSL. Windows
# Python has no SIGKILL constant; this test never sends an operating-system signal.
from types import SimpleNamespace
g['signal']=SimpleNamespace(SIGTERM=15,SIGKILL=9)
def started(pid):
    if pid not in alive: raise g['subprocess'].CalledProcessError(1,['ps'])
    return alive[pid]
def kill(pid,sig):
    signals.append([pid,int(sig)])
    if sig == g['signal'].SIGKILL: alive.pop(pid,None)
g['process_start']=started; g['process_table']=lambda:[(12346,12345),(12347,12346),(99999,99998)]
g['process_alive']=lambda pid,identity:alive.get(pid)==identity
g['os'].kill=kill; g['time'].sleep=lambda seconds:None
try:
    h['stop_tree'](directory); refused=False
except RuntimeError: refused=True
before=list(signals); alive[12345]='original'; code=h['stop_tree'](directory)
print(json.dumps({'refused':refused,'before':before,'signals':signals,'alive':list(alive),'code':code}))`, [f.base]);
  assert.equal(result.refused, true); assert.deepEqual(result.before, []); assert.equal(result.code, 0);
  assert.deepEqual(result.signals.map(signal => signal[0]), [12347, 12346, 12345, 12347, 12346, 12345]);
  assert.deepEqual(result.alive, [99999]);
});
