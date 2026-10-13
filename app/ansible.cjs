'use strict';

// Ansible is an explicitly trusted controller process, not a terminal command.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn: spawnProcess } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const MAX_FILE = 2 * 1024 * 1024;
const MAX_FRAME = 256 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_EVENTS = 10000;
const PLAN_TTL = 5 * 60 * 1000;
const WARNINGS = [
  'Trusted Ansible projects, inventory plugins, roles, lookups, and callbacks execute code with your controller account permissions, including during syntax checks.',
  'Only the saved playbook and inventory revisions are checked again before launch. Included files, roles, project configuration, collections, and external sources are not an immutable snapshot.',
  'Cancellation stops controller processes; it does not roll back changes already made or guarantee that remote tasks have stopped.',
];
const hash = data => createHash('sha256').update(data).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const text = (value, limit = 8192) => typeof value === 'string' ? value.slice(0, limit) : '';
const quote = value => /^[A-Za-z0-9_./:=,@%+-]+$/.test(value) ? value : JSON.stringify(value);

function controllerOptions(input = {}, platform = process.platform) {
  const controller = input.controller || (platform === 'win32' ? 'wsl' : 'local');
  if (!['local', 'wsl'].includes(controller)) throw new Error('Choose a local or WSL controller.');
  if (platform === 'win32' && controller === 'local') throw new Error('Ansible control nodes on Windows require WSL. Choose WSL and install Python, ansible-core, and ansible-runner inside it.');
  if (controller === 'wsl' && platform !== 'win32') throw new Error('The WSL controller is available on Windows. Choose Local on macOS or Linux.');
  const python = input.python === undefined || input.python === '' ? 'python3' : input.python;
  if (typeof python !== 'string') throw new Error('Python must be a Python executable name or an absolute interpreter path, without arguments.');
  const absolute = controller === 'wsl' ? path.posix.isAbsolute(python) : path.isAbsolute(python);
  if (typeof python !== 'string' || python.length > 4096 || /[\u0000-\u001f\u007f]/.test(python) || (!absolute && !/^python(?:3(?:\.\d{1,2})?)?$/.test(python))) throw new Error('Python must be a Python executable name or an absolute interpreter path, without arguments.');
  return { controller, python };
}

function relativeFile(value, label) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('-') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error(`${label} must be a file path inside the open project.`);
  return value;
}

function restrictedEnvironment(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']) if (typeof source[key] === 'string') env[key] = source[key];
  return { ...env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
}

function createAnsibleManager({ projects, send = () => {}, dataDirectory = path.join(os.tmpdir(), 'termforge'), spawn = spawnProcess, platform = process.platform, environment = process.env, now = Date.now, probeTimeoutMs = 15000, runTimeoutMs = 60 * 60 * 1000, cancelGraceMs = 2000, terminate, maxOutputBytes = MAX_OUTPUT, maxEvents = MAX_EVENTS } = {}) {
  if (!projects || typeof projects.getRoot !== 'function' || typeof projects.resolveFile !== 'function') throw new Error('Ansible requires an open-project manager.');
  const plans = new Map(); const running = new Map(); const probes = new Set();
  const env = restrictedEnvironment(environment);
  const base = path.resolve(dataDirectory, 'ansible-runs');
  let starting = false; let startingPlan = null; let closing = false;
  const notify = payload => { try { send('ansibleEvent', payload); } catch { /* Closing a renderer must not orphan a controller. */ } };
  const wslExe = path.win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'wsl.exe');

  async function privateDirectory() {
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(base)).isSymbolicLink()) throw new Error('The Ansible private-data directory cannot be a symbolic link.');
    await fs.chmod(base, 0o700);
    const directory = await fs.mkdtemp(path.join(base, 'run-')); await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, 'termforge_ansible.py'), await fs.readFile(path.join(__dirname, 'termforge_ansible.py')), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'probe.cfg'), '[defaults]\n', { mode: 0o600 });
    return directory;
  }
  function capture(command, args, { cwd, timeout = probeTimeoutMs, input, extraEnv = {} } = {}) {
    return new Promise((resolve, reject) => {
      let child; let done = false; let aborting = false; let bytes = 0; let pendingError; let timer; let forceTimer; let exitTimer; let resolveExit;
      const chunks = []; const errors = [];
      const entry = { exited: new Promise(resolve => { resolveExit = resolve; }), unverified: false };
      const signal = value => {
        if (platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 1) {
          try { process.kill(-child.pid, value); return; } catch { /* The group may already have exited. */ }
        }
        try { child.kill(value); } catch { /* Retain tracking until close or the bounded verification timeout. */ }
      };
      const finish = code => {
        clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(exitTimer); probes.delete(entry); resolveExit(true);
        if (done) return; done = true;
        pendingError ? reject(pendingError) : resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') });
      };
      entry.abort = error => {
        if (done || aborting) return; aborting = true; pendingError = error; clearTimeout(timer);
        // Install timers before signaling: a test double or very short process may close immediately.
        forceTimer = setTimeout(() => signal('SIGKILL'), 250);
        exitTimer = setTimeout(() => {
          done = true; entry.unverified = true;
          const failure = new Error('Controller probe or stop-helper shutdown could not be verified. Keep TermForge open and check controller processes.');
          failure.shutdownUnverified = true; resolveExit(false); reject(failure);
        }, 1500);
        signal('SIGTERM');
      };
      try { child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); probes.add(entry); }
      catch (error) { reject(error); return; }
      timer = setTimeout(() => entry.abort(new Error('Controller probe timed out. Check Python and the selected WSL distribution.')), timeout);
      for (const [stream, output] of [[child.stdout, chunks], [child.stderr, errors]]) stream.on('data', chunk => {
        if (done || aborting) return;
        bytes += Buffer.byteLength(chunk); if (bytes > MAX_FRAME) entry.abort(new Error('Controller probe returned too much output.')); else output.push(Buffer.from(chunk));
      });
      child.once('error', error => entry.abort(error));
      child.once('close', finish);
      child.stdin.on('error', error => entry.abort(error)); child.stdin.end(input || '');
    });
  }
  async function linuxPath(value, directory) {
    if (closing) throw new Error('The Ansible controller is closing.');
    const result = await capture(wslExe, ['--exec', 'wslpath', '-a', '-u', value], { cwd: directory });
    const converted = result.stdout.trim();
    if (result.code !== 0 || !converted.startsWith('/') || /[\r\n\u0000]/.test(converted)) throw new Error('WSL could not access this path. Use a project and application-data folder accessible from the default WSL distribution.');
    return converted;
  }
  async function launchOptions(options, directory) {
    const helper = path.join(directory, 'termforge_ansible.py');
    if (options.controller === 'local') return { command: options.python, prefix: ['-I', '-u', helper], helper, directory, config: path.join(directory, 'probe.cfg') };
    const converted = await linuxPath(directory, directory);
    return { command: wslExe, prefix: ['--exec', options.python, '-I', '-u', `${converted}/termforge_ansible.py`], helper: `${converted}/termforge_ansible.py`, directory: converted, config: `${converted}/probe.cfg` };
  }
  async function probe(input = {}) {
    const options = controllerOptions(input, platform);
    if (closing) throw new Error('The Ansible controller is closing.');
    if ([...probes].some(entry => entry.unverified)) throw new Error('A controller probe has not stopped. Resolve its process shutdown before checking another controller.');
    const directory = await privateDirectory(); let retainDirectory = false;
    try {
      if (closing) throw new Error('The Ansible controller is closing.');
      const launch = await launchOptions(options, directory);
      if (closing) throw new Error('The Ansible controller is closing.');
      const result = await capture(launch.command, [...launch.prefix, '--probe', launch.config], { cwd: directory, extraEnv: { ANSIBLE_CONFIG: launch.config } });
      let answer;
      try { answer = JSON.parse(result.stdout.trim()); } catch { throw new Error(text(result.stderr.trim()) || 'Python did not return a valid Ansible availability response.'); }
      return { ...options, available: result.code === 0 && answer.available === true, runnerVersion: text(answer.runnerVersion, 120), ansibleVersion: text(answer.ansibleVersion, 120), pythonVersion: text(answer.pythonVersion, 120), ...(answer.error ? { error: text(answer.error), hint: text(answer.hint) } : {}) };
    } catch (error) {
      retainDirectory = error.shutdownUnverified === true;
      return { ...options, available: false, error: text(error.message), hint: options.controller === 'wsl' ? 'Install WSL with a Linux distribution, then install Python, ansible-core and ansible-runner inside that distribution. Select its Python executable. TermForge does not install packages automatically.' : 'Install ansible-core and ansible-runner in a Python virtual environment, then select that environment’s Python executable. TermForge does not install packages automatically.' };
    } finally { if (!retainDirectory) await fs.rm(directory, { recursive: true, force: true }); }
  }
  async function reviewedFile(projectId, root, filename) {
    const absolute = await projects.resolveFile(projectId, filename);
    const real = await fs.realpath(absolute);
    if (!within(root, real) || real === root) throw new Error('Ansible input is outside the open project.');
    // Recheck every path component even with injected/custom project managers.
    let current = root;
    for (const part of path.relative(root, absolute).split(path.sep)) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Ansible input paths cannot contain symbolic links.'); }
    const file = await fs.open(real, 'r');
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Ansible inputs must be regular files of at most 2 MiB.');
      const data = await file.readFile(); if (data.length > MAX_FILE) throw new Error('Ansible input grew beyond 2 MiB while reading.');
      return { path: filename, absolute: real, revision: hash(data) };
    } finally { await file.close(); }
  }
  async function prepare(input = {}) {
    if (closing) throw new Error('The Ansible controller is closing.');
    if ([...probes].some(entry => entry.unverified)) throw new Error('A controller probe has not stopped. Resolve its process shutdown before preparing Ansible.');
    if (input.trusted !== true) throw new Error('Trust this project before preparing Ansible, including syntax and check modes.');
    if (typeof input.projectId !== 'string' || !input.projectId) throw new Error('Open a project before preparing Ansible.');
    const options = controllerOptions(input, platform);
    if (!['syntax', 'check', 'run'].includes(input.mode)) throw new Error('Choose syntax, check, or run mode.');
    const playbook = relativeFile(input.playbook, 'Playbook'); const inventory = relativeFile(input.inventory, 'Inventory');
    if (!/\.ya?ml$/i.test(playbook)) throw new Error('Choose a saved YAML playbook (.yml or .yaml).');
    const limit = input.limit === undefined ? '' : input.limit;
    if (typeof limit !== 'string' || limit.length > 1024 || /[\u0000-\u0020\u007f]/.test(limit) || limit.startsWith('-') || limit.startsWith('@')) throw new Error('Limit must be a host pattern without whitespace, leading options, or @file references.');
    const root = await fs.realpath(await projects.getRoot(input.projectId));
    if (within(root, base)) throw new Error('The Ansible private-data folder must be outside the project. Open a more specific project folder.');
    const files = await Promise.all([reviewedFile(input.projectId, root, playbook), reviewedFile(input.projectId, root, inventory)]);
    const args = ['ansible-playbook', '-i', inventory, ...(limit ? ['--limit', limit] : []), ...(input.mode === 'syntax' ? ['--syntax-check'] : input.mode === 'check' ? ['--check', '--diff'] : []), playbook];
    const warnings = [...WARNINGS, ...(input.mode === 'check' ? ['Check mode is not a safety guarantee: tasks can override check mode, plugins can execute code, and unsupported modules may skip validation.'] : [])];
    for (const [id, plan] of plans) if (now() - plan.createdAt > PLAN_TTL) plans.delete(id);
    if (plans.size >= 32) plans.delete(plans.keys().next().value);
    const planId = randomUUID();
    const response = { planId, projectId: input.projectId, ...options, mode: input.mode, playbook, inventory, limit, summary: `${input.mode === 'syntax' ? 'Syntax check' : input.mode === 'check' ? 'Check mode' : 'Run playbook'}: ${playbook} against ${inventory}${limit ? ` (limit ${limit})` : ''}`, command: args.map(quote).join(' '), files: files.map(({ path, revision }) => ({ path, revision })), warnings };
    plans.set(planId, { ...response, root, files, createdAt: now() });
    return response;
  }
  async function terminateEntry(entry) {
    if (entry.finished) return;
    try {
      if (terminate) await terminate(entry.child, { controller: entry.plan.controller, directory: entry.directory });
      else {
        const result = await capture(entry.launch.command, [...entry.launch.prefix, '--stop', entry.launch.directory], { cwd: entry.directory, timeout: 8000 });
        if (result.code !== 0) throw new Error(text(result.stderr || result.stdout) || 'Controller process-tree stop failed.');
      }
    } catch (error) {
      // Before the helper writes its identity it cannot have launched Runner.
      // A detached native process group is therefore a safe startup fallback.
      let early = false;
      try { await fs.access(path.join(entry.directory, 'controller.json')); } catch { early = true; }
      if (platform !== 'win32' && early && Number.isInteger(entry.child.pid) && entry.child.pid > 1) {
        try { process.kill(-entry.child.pid, 'SIGKILL'); return; } catch (failure) { if (failure.code === 'ESRCH') return; }
      }
      entry.shutdownUnverified = true;
      entry.error = `Could not verify controller shutdown: ${error.message}`; notify({ id: entry.id, type: 'error', error: entry.error });
      try { entry.child.kill('SIGKILL'); } catch { /* Already exited. */ }
    }
  }
  function stop(entry, reason) {
    if (entry.finished || entry.stopping) return;
    entry.stopping = true; if (reason) { entry.error = reason; notify({ id: entry.id, type: 'error', error: reason }); }
    notify({ id: entry.id, type: 'status', status: 'cancelling', message: 'Stopping the controller. Changes already made are not rolled back.' });
    try { entry.child.stdin.write('{"type":"cancel"}\n'); } catch { /* The process may already have closed stdin. */ }
    entry.stopTimer = setTimeout(() => { entry.shutdown = Promise.resolve().then(() => terminateEntry(entry)); }, cancelGraceMs);
  }
  function ingest(entry, frame) {
    if (entry.finished || entry.stopping) return;
    let event; try { event = JSON.parse(frame); } catch { stop(entry, 'Ansible helper returned invalid event data.'); return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { stop(entry, 'Ansible helper returned invalid event data.'); return; }
    if (event.type === 'status') {
      if (['starting', 'running'].includes(event.status)) notify({ id: entry.id, type: 'status', status: event.status });
      else if (['successful', 'failed', 'cancelled', 'timeout'].includes(event.status)) { entry.result = event; }
    } else if (event.type === 'error') { entry.error = text(event.error) || 'Ansible failed.'; notify({ id: entry.id, type: 'error', error: entry.error }); }
    else if (event.type === 'event') {
      if (++entry.events > maxEvents) { stop(entry, 'Ansible exceeded the 10,000-event result limit.'); return; }
      const result = { id: entry.id, type: 'event', event: text(event.event, 120), host: text(event.host, 512), task: text(event.task, 1024), message: text(event.message), changed: event.changed === true, failed: event.failed === true };
      if (typeof event.diff === 'string' && event.diff) result.diff = text(event.diff, 16384);
      if (event.stats && typeof event.stats === 'object' && !Array.isArray(event.stats)) {
        result.stats = {};
        for (const key of ['ok', 'changed', 'failures', 'dark', 'skipped', 'rescued', 'ignored', 'processed']) if (event.stats[key] && typeof event.stats[key] === 'object') result.stats[key] = Object.fromEntries(Object.entries(event.stats[key]).slice(0, 1000).filter(([host, count]) => host.length <= 512 && Number.isInteger(count) && count >= 0));
      }
      notify(result);
    } else { stop(entry, 'Ansible helper returned an unsupported event.'); }
  }
  async function start(input = {}) {
    if (input.confirmed !== true) throw new Error('Review and confirm the prepared Ansible command before starting.');
    if (closing || starting || running.size || [...probes].some(entry => entry.unverified)) throw new Error('Wait for the current Ansible controller to stop before starting another run.');
    const plan = plans.get(input.planId); if (!plan) throw new Error('Prepare and review a new Ansible run first.');
    plans.delete(input.planId); starting = true; startingPlan = plan;
    let directory;
    try {
      if (now() - plan.createdAt > PLAN_TTL) throw new Error('This Ansible review expired. Prepare a new run.');
      const root = await fs.realpath(await projects.getRoot(plan.projectId)); if (root !== plan.root) throw new Error('The project changed after review. Prepare a new run.');
      for (const expected of plan.files) {
        const actual = await reviewedFile(plan.projectId, root, expected.path);
        if (actual.absolute !== expected.absolute || actual.revision !== expected.revision) throw new Error(`${expected.path} changed after review. Save and prepare a new run.`);
      }
      directory = await privateDirectory(); const launch = await launchOptions(plan, directory);
      const translatedRoot = plan.controller === 'wsl' ? await linuxPath(root, directory) : root;
      const config = { projectRoot: translatedRoot, playbook: plan.playbook, inventory: plan.inventory, limit: plan.limit, mode: plan.mode, files: plan.files.map(({ path, revision }) => ({ path, revision })), privateDirectory: launch.directory, timeout: Math.ceil(runTimeoutMs / 1000) };
      await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify(config), { mode: 0o600 });
      if (closing) throw new Error('The Ansible controller is closing.');
      const child = spawn(launch.command, [...launch.prefix, '--run', `${launch.directory}/request.json`], { cwd: directory, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const id = randomUUID(); let resolveExit;
      const entry = { id, child, directory, launch, plan, events: 0, bytes: 0, buffer: '', decoder: new StringDecoder('utf8'), error: null, result: null, cancelled: false, stopping: false, finished: false, exited: new Promise(resolve => { resolveExit = resolve; }) };
      running.set(id, entry);
      const finish = async (code, signal) => {
        if (entry.finished) return; entry.finished = true; clearTimeout(entry.timeout); clearTimeout(entry.stopTimer);
        // The controller may exit before its separate tree-stopper finishes.
        // Keep its private state until that verification has actually completed.
        if (entry.shutdown) await entry.shutdown;
        if (entry.buffer.trim() && !entry.stopping) { entry.error = entry.error || 'Ansible helper ended with an incomplete event.'; }
        const status = entry.error ? 'failed' : entry.cancelled ? 'cancelled' : code === 0 && entry.result?.status === 'successful' ? 'successful' : 'failed';
        notify({ id, type: 'status', status, code, signal, ...(entry.error ? { error: entry.error } : {}), ...(entry.result?.rc !== undefined ? { rc: entry.result.rc } : {}) });
        if (!entry.shutdownUnverified) { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); running.delete(id); }
        resolveExit({ id, status, shutdownUnverified: Boolean(entry.shutdownUnverified) });
      };
      child.stdout.on('data', chunk => {
        if (entry.finished || entry.stopping) return;
        entry.bytes += Buffer.byteLength(chunk); if (entry.bytes > maxOutputBytes) { stop(entry, 'Ansible exceeded the 4 MiB result-output limit.'); return; }
        entry.buffer += entry.decoder.write(chunk);
        let index;
        while ((index = entry.buffer.indexOf('\n')) >= 0) {
          const line = entry.buffer.slice(0, index); entry.buffer = entry.buffer.slice(index + 1);
          if (Buffer.byteLength(line) > MAX_FRAME) { stop(entry, 'Ansible event exceeded the 256 KiB frame limit.'); return; }
          if (line.trim()) ingest(entry, line);
        }
        if (Buffer.byteLength(entry.buffer) > MAX_FRAME) stop(entry, 'Ansible event exceeded the 256 KiB frame limit.');
      });
      const stderr = new StringDecoder('utf8');
      child.stderr.on('data', chunk => {
        if (entry.finished || entry.stopping) return;
        entry.bytes += Buffer.byteLength(chunk); if (entry.bytes > maxOutputBytes) { stop(entry, 'Ansible exceeded the 4 MiB result-output limit.'); return; }
        notify({ id, type: 'output', stream: 'stderr', text: stderr.write(chunk).slice(0, 8192) });
      });
      child.stdin.on('error', error => { if (!entry.stopping) stop(entry, `Controller input closed: ${error.message}`); });
      child.once('error', error => { entry.error = `Ansible controller could not start: ${error.message}`; notify({ id, type: 'error', error: entry.error }); });
      child.once('close', finish);
      entry.timeout = setTimeout(() => stop(entry, 'Ansible exceeded its one-hour controller time limit.'), runTimeoutMs);
      notify({ id, type: 'status', status: 'starting', projectId: plan.projectId, mode: plan.mode });
      return { id };
    } catch (error) { if (directory && !error.shutdownUnverified) await fs.rm(directory, { recursive: true, force: true }); throw error; }
    finally { starting = false; startingPlan = null; }
  }
  async function cancel(id) {
    if (typeof id !== 'string') throw new Error('Ansible run ID is required.');
    const entry = running.get(id); if (!entry) return { id, cancelling: false };
    entry.cancelled = true; stop(entry); return { id, cancelling: true };
  }
  async function closeAll() {
    closing = true; plans.clear();
    const captures = [...probes]; for (const entry of captures) entry.abort(new Error('The Ansible controller is closing.'));
    const entries = [...running.values()]; for (const entry of entries) { entry.cancelled = true; stop(entry); }
    let timer;
    try {
      const results = await Promise.race([Promise.all(entries.map(entry => entry.exited)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Controller shutdown could not be verified. Keep TermForge open and check the controller processes.')), cancelGraceMs + 12000); })]);
      const capturesVerified = await Promise.all(captures.map(entry => entry.exited));
      if (results.some(result => result.shutdownUnverified) || capturesVerified.some(verified => !verified)) throw new Error('Controller process-tree shutdown could not be verified. Keep TermForge open and check the controller processes.');
    } finally { clearTimeout(timer); }
  }
  return { probe, prepare, start, cancel, closeAll, hasProject(projectId) { return startingPlan?.projectId === projectId || [...running.values()].some(entry => entry.plan.projectId === projectId); }, get activeProjectId() { return startingPlan?.projectId || [...running.values()][0]?.plan.projectId || null; }, get count() { return running.size || Number(starting) || probes.size; } };
}

module.exports = { createAnsibleManager, controllerOptions, restrictedEnvironment };
