'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn: spawnChild } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');
const { utils } = require('ssh2');

const MAX_KEY_BYTES = 1024 * 1024;
function validatePassphrase(value, { optional = false, allowUnencrypted = false } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1000 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('A passphrase must be one line without control characters and at most 1000 UTF-8 bytes.');
  if (!optional && !value && !allowUnencrypted) throw new Error('Enter a passphrase or explicitly choose an unencrypted private key.');
  if (!optional && value && value.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  return value;
}
function validateRequest(input, converting) {
  const allowed = converting ? ['oldPassphrase', 'newPassphrase', 'allowUnencrypted'] : ['type', 'comment', 'passphrase', 'allowUnencrypted'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || (input.allowUnencrypted !== undefined && typeof input.allowUnencrypted !== 'boolean')) throw new Error('Invalid SSH key request.');
  if (converting) return { oldPassphrase: validatePassphrase(input.oldPassphrase ?? '', { optional: true }), passphrase: validatePassphrase(input.newPassphrase, input), allowUnencrypted: input.allowUnencrypted === true };
  if (!['ed25519', 'rsa'].includes(input.type)) throw new Error('Choose Ed25519 or RSA.');
  if (typeof input.comment !== 'string' || Buffer.byteLength(input.comment) > 240 || /[\u0000-\u001f\u007f]/u.test(input.comment)) throw new Error('A key comment must be a single line of at most 240 UTF-8 bytes.');
  return { type: input.type, comment: input.comment, passphrase: validatePassphrase(input.passphrase, input), allowUnencrypted: input.allowUnencrypted === true };
}
function validPath(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\u0000\r\n]/u.test(filename)) throw new Error('Choose an absolute SSH key filename.');
  return filename;
}
function privateKey(bytes, passphrase) {
  const key = utils.parseKey(bytes, passphrase || undefined);
  if (key instanceof Error || Array.isArray(key) || !key?.isPrivateKey()) throw new Error('Cannot read this private key. Check its passphrase and use an OpenSSH or PEM private key supported by OpenSSH.');
  return key;
}
async function readRegularFile(filename) {
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_KEY_BYTES) throw new Error('Choose a regular private key file of at most 1 MiB, not a symbolic link.');
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > MAX_KEY_BYTES || actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('The private key file changed while opening it.');
    const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_KEY_BYTES) { buffer.fill(0); throw new Error('The private key exceeds 1 MiB.'); }
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function unusedDestination(filename) {
  validPath(filename);
  for (const target of [filename, `${filename}.pub`]) {
    try { await fsp.lstat(target); throw new Error('The private key or its .pub file already exists. Choose a new filename; existing keys are never replaced.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// Reserve both names exclusively before writing. Never truncate an existing key,
// including a symlink or a file created after the destination was reviewed.
async function writeKeyPair(filename, privateBytes, publicText) {
  const opened = [];
  try {
    for (const [target, mode, data] of [[filename, 0o600, privateBytes], [`${filename}.pub`, 0o644, publicText]]) {
      const handle = await fsp.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
      opened.push({ target, handle, stat: await handle.stat(), data });
    }
    for (const file of opened) { await file.handle.writeFile(file.data); await file.handle.sync(); }
  } catch (error) {
    for (const file of opened) {
      await file.handle.close(); file.handle = null;
      const current = await fsp.lstat(file.target).catch(() => null);
      if (current && current.dev === file.stat.dev && current.ino === file.stat.ino) await fsp.unlink(file.target);
    }
    if (error.code === 'EEXIST') throw new Error('The private key or its .pub file already exists. Choose a new filename.');
    throw error;
  } finally { for (const file of opened) await file.handle?.close(); }
}
function publicDetails(key, comment = '') {
  const publicBytes = key.getPublicSSH();
  comment = comment.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240);
  return { publicKey: `${key.type} ${publicBytes.toString('base64')}${comment ? ` ${comment}` : ''}\n`, fingerprint: `SHA256:${createHash('sha256').update(publicBytes).digest('base64').replace(/=+$/u, '')}` };
}
function resolveTool(name, env, platform) {
  const executable = platform === 'win32' ? `${name}.exe` : name;
  const system = platform === 'win32' ? [path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'OpenSSH')] : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  for (const directory of [...system, ...(env.PATH || env.Path || '').split(path.delimiter)]) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executable);
    try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return candidate; } } catch { /* Try the next installed OpenSSH location. */ }
  }
  throw new Error(`${name} is unavailable. Install the OpenSSH client tools for this computer.`);
}

// Keep this adapter restricted to our private key-tool PTYs. node-pty 1.1.0's
// natural Windows exit leaves a conout Worker alive, and public kill() queries
// a possibly departed PID. Dispose only remaining owned resources; native exit
// may already have removed the captured ConPTY ID before the JS exit callback.
function ownPrivateWindowsPty(child) {
  const agent = child._agent, connection = agent?._conoutSocketWorker;
  if (!agent?._useConpty || agent._useConptyDll || typeof agent._ptyNative?.kill !== 'function' || typeof connection?._worker?.terminate !== 'function') throw new Error('The installed private Windows terminal adapter is unsupported.');
  const handle = agent._pty, native = agent._ptyNative, worker = connection._worker;
  let handleClosed = false, disposal;
  const closeHandle = () => { if (!handleClosed) { native.kill(handle, false); handleClosed = true; } };
  return {
    get pid() { return child.pid; },
    onData: callback => child.onData(callback), onExit: callback => child.onExit(callback),
    on: (...args) => child.on(...args), removeListener: (...args) => child.removeListener(...args),
    write: data => child.write(data), kill: closeHandle,
    dispose() {
      if (!disposal) disposal = Promise.resolve().then(async () => {
        closeHandle();
        clearTimeout(agent._closeTimeout); clearTimeout(connection._drainTimeout);
        agent._inSocket.destroy(); agent._outSocket.destroy();
        await worker.terminate();
      });
      return disposal;
    },
  };
}
function spawnPrivateWindowsPty(executable, args, options, dependencies = {}) {
  if ((dependencies.version ?? require('node-pty/package.json').version) !== '1.1.0') throw new Error('The private Windows terminal adapter requires node-pty 1.1.0.');
  const release = dependencies.release ?? os.release(), build = /^(\d+)\.(\d+)\.(\d+)/u.exec(release);
  if (!build || Number(build[3]) < 18309) throw new Error('Private SSH key tools require Windows 10 build 18309 or newer with ConPTY support.');
  // Check before spawning: node-pty otherwise silently falls back to winpty,
  // which does not support this private resource ownership/cleanup contract.
  return ownPrivateWindowsPty((dependencies.spawn ?? require('node-pty').spawn)(executable, args, options));
}

// Native Windows OpenSSH uses _getwch() rather than redirected stdin:
// https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/misc.c
// This private ConPTY is never attached to a terminal tab, logs or renderer.
// Supply exactly one answer after its complete expected prompt; typing early
// loses input because Windows readpassphrase() clears pending console input.
function runPrivateKeyPty({ spawnPty, executable, args, cwd, env, responses, timeoutMs, signal, killProcess = (pid, termination) => process.kill(pid, termination) }) {
  const pending = responses.map(response => ({ ...response }));
  return new Promise((resolve, reject) => {
    let child, ownedPid, timer, subscription, exitSubscription, failure, buffer = '', outputBytes = 0, answered = 0, done = false;
    const fail = error => {
      if (failure || done) return; failure = error;
      // node-pty's Windows kill() waits for the first output event. A silent
      // child still needs termination, so stop the captured owned process too.
      // Never retain a PID or signal it after the exit witness has fired.
      if (Number.isSafeInteger(ownedPid) && ownedPid > 0) {
        try { killProcess(ownedPid, 'SIGKILL'); } catch { /* The process may already be exiting; still drain the PTY exit. */ }
      }
      if (!done) { try { child?.kill(); } catch { /* Wait for owned process exit. */ } }
    };
    const aborted = () => fail(new Error('SSH key tools are closing.'));
    const finish = code => {
      if (done) return; done = true; ownedPid = undefined; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      subscription?.dispose(); exitSubscription?.dispose(); buffer = ''; for (const response of pending) response.value = '';
      const outcome = failure || (code !== 0 || answered !== pending.length ? new Error('ssh-keygen could not complete this operation. Check the key format, passphrase, and installed OpenSSH version.') : null);
      Promise.resolve().then(() => child?.dispose?.()).then(() => {
        if (outcome) reject(outcome); else resolve({ code, output: '' });
      }, () => {
        const error = new Error('Private Windows terminal resources could not be closed.'); error.code = 'KEY_TOOLS_CLEANUP_FAILED'; reject(error);
      });
    };
    if (signal?.aborted) { reject(new Error('SSH key tools are closing.')); return; }
    try {
      child = spawnPty(executable, args, { cwd, env, name: 'xterm', cols: 240, rows: 30, useConpty: true });
      ownedPid = child.pid;
      try { exitSubscription = child.onExit(({ exitCode }) => finish(exitCode)); }
      catch {
        // node-pty also exposes EventEmitter's exit event. Keep an exit witness
        // even if its typed subscription cannot initialize, before killing it.
        const exited = code => finish(code);
        child.on('exit', exited); exitSubscription = { dispose: () => child.removeListener('exit', exited) };
        throw new Error('Could not initialize private OpenSSH exit monitoring.');
      }
      subscription = child.onData(chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 128 * 1024) { fail(new Error('ssh-keygen returned too much output.')); return; }
        if (failure || answered >= pending.length) return;
        buffer = (buffer + chunk).slice(-8192);
        const visible = stripVTControlCharacters(buffer).replace(/[\r\n]/gu, '');
        const expected = pending[answered];
        // ConPTY may render the final blank as a cursor movement rather than a
        // literal space. The complete prompt text and colon are still required.
        const pattern = expected.prompt === 'old' ? /Enter old passphrase:[ \t]*$/u : expected.prompt === 'same' ? /Enter same passphrase again:[ \t]*$/u : /Enter (?:new )?passphrase(?: for "[^"]*")? \(empty for no passphrase\):[ \t]*$/u;
        if (pattern.test(visible)) {
          const answer = expected.value; expected.value = ''; answered++; buffer = '';
          try { child.write(`${answer}\r`); } catch { fail(new Error('Could not answer the private ssh-keygen prompt.')); }
        }
      });
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => fail(new Error(`ssh-keygen did not finish within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
      if (signal?.aborted) aborted();
    } catch {
      if (child) fail(new Error('Could not initialize private OpenSSH key prompts.'));
      else finish(-1);
    }
  });
}

function createKeyTools({ dialog, getWindow = () => undefined, register, approve, spawn = spawnChild, spawnPty = spawnPrivateWindowsPty, env = process.env, platform = process.platform, tempRoot = os.tmpdir(), timeoutMs = 60000, removeTemporary = directory => fsp.rm(directory, { recursive: true, force: true }) } = {}) {
  const children = new Set(), stopping = new AbortController(); let busy = false, closed = false, activeOperation = null, cleanupFailure = null;
  const live = () => { if (closed) throw new Error('SSH key tools are closing.'); };
  function exclusive(callback) {
    live(); if (busy) throw new Error('An SSH key tool is already running.'); busy = true;
    const operation = Promise.resolve().then(callback).finally(() => { busy = false; if (activeOperation === operation) activeOperation = null; });
    activeOperation = operation; return operation;
  }
  // File pickers have no portable cancellation API. Stop waiting on them during
  // shutdown, and consume any later resolution without resuming key operations.
  function waitLive(callback) {
    live();
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new Error('SSH key tools are closing.'));
      stopping.signal.addEventListener('abort', aborted, { once: true });
      const settle = (fn, value) => { stopping.signal.removeEventListener('abort', aborted); fn(value); };
      try { Promise.resolve(callback()).then(value => settle(resolve, value), error => settle(reject, error)); }
      catch (error) { settle(reject, error); }
    });
  }
  const childEnv = { LC_ALL: 'C', LANG: 'C', SSH_ASKPASS_REQUIRE: 'never' };
  // Native Windows OpenSSH requires ProgramData during startup (w32fd.c).
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ProgramData', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'SSH_AUTH_SOCK']) if (typeof env[key] === 'string') childEnv[key] = env[key];
  function runTool(name, args, input = '', acceptedCodes = [0]) {
    live();
    const executable = resolveTool(name, env, platform);
    return new Promise((resolve, reject) => {
      let child, output = '', outputBytes = 0, timer, failure;
      const fail = error => { failure ||= error; child?.kill('SIGKILL'); };
      try {
        // OpenSSH's RP_ALLOW_STDIN prompts fall back to stdin when no controlling
        // terminal or askpass exists. The passphrase only travels through this
        // private pipe, never process arguments, environment or a temporary file.
        // https://github.com/openssh/openssh-portable/blob/master/readpass.c
        child = spawn(executable, args, { cwd: tempRoot, env: childEnv, shell: false, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        children.add(child);
      } catch { reject(new Error(`Could not start ${name}. Check that OpenSSH client tools are installed.`)); return; }
      timer = setTimeout(() => fail(new Error(`${name} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
      child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > 128 * 1024) fail(new Error(`${name} returned too much output.`)); else output += chunk.toString('utf8'); });
      // Discard diagnostics: malformed source keys and comments must not be
      // echoed into application errors, logs, or the renderer.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('error', () => { failure ||= new Error(`Could not run ${name}. Check that OpenSSH client tools are installed.`); });
      child.on('close', code => {
        clearTimeout(timer); children.delete(child);
        if (closed) reject(new Error('SSH key tools are closing.'));
        else if (failure) reject(failure);
        else if (!acceptedCodes.includes(code)) reject(new Error(`${name} could not complete this operation. Check the key format, passphrase, and installed OpenSSH version.`));
        else resolve({ code, output });
      });
      child.stdin.end(input);
    });
  }
  function runKeygen(args, responses) {
    if (platform === 'win32' && spawnPty) return runPrivateKeyPty({ spawnPty, executable: resolveTool('ssh-keygen', env, platform), args, cwd: tempRoot, env: childEnv, responses, timeoutMs, signal: stopping.signal }).catch(error => { if (error.code === 'KEY_TOOLS_CLEANUP_FAILED') cleanupFailure = error; throw error; });
    return runTool('ssh-keygen', args, responses.map(response => `${response.value}\n`).join(''));
  }
  async function approvedUnencrypted(request) {
    if (request.passphrase) return true;
    const input = { title: 'Save an unencrypted private key?', message: 'Anyone who can read this file can use this private key.', detail: 'The private key will have no passphrase. Its protection depends on your computer account and storage permissions.', accept: 'Save unencrypted key' };
    if (approve) return waitLive(() => approve({ ...input, signal: stopping.signal }));
    const result = await waitLive(() => dialog.showMessageBox(getWindow(), { type: 'warning', title: input.title, message: input.message, detail: input.detail, buttons: ['Cancel', input.accept], defaultId: 0, cancelId: 0, noLink: true, signal: stopping.signal }));
    return result.response === 1;
  }
  async function chooseDestination(defaultPath) {
    const result = await waitLive(() => dialog.showSaveDialog(getWindow(), { title: 'Save private key — a matching .pub file will also be created', defaultPath, buttonLabel: 'Choose destination', properties: ['showOverwriteConfirmation'] }));
    live(); if (result.canceled || !result.filePath) return null;
    await unusedDestination(result.filePath); return result.filePath;
  }
  async function withTemporary(callback) {
    const directory = await fsp.mkdtemp(path.join(tempRoot, 'termforge-key-'));
    try { await fsp.chmod(directory, 0o700); return await callback(directory); }
    finally {
      try { await removeTemporary(directory); }
      catch { cleanupFailure = new Error('SSH key temporary files could not be removed. Check storage permissions before quitting.'); throw cleanupFailure; }
    }
  }
  async function saveChecked(filename, temporary, passphrase, expectedKey, comment) {
    const bytes = await readRegularFile(temporary);
    try {
      if (!bytes.toString('ascii', 0, 40).startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) throw new Error('OpenSSH did not produce the requested private-key format. No destination file was saved.');
      const key = privateKey(bytes, passphrase);
      if (passphrase && !(utils.parseKey(bytes) instanceof Error)) throw new Error('OpenSSH did not encrypt this key. No destination file was saved.');
      if (expectedKey && !expectedKey.equals(key.getPublicSSH())) throw new Error('Key conversion changed the public identity. No destination file was saved.');
      const details = publicDetails(key, comment ?? key.comment ?? '');
      live(); await writeKeyPair(filename, bytes, details.publicKey);
      return { canceled: false, privatePath: filename, publicPath: `${filename}.pub`, fingerprint: details.fingerprint, encrypted: Boolean(passphrase) };
    } finally { bytes.fill(0); }
  }
  async function generate(input) {
    const request = validateRequest(input, false);
    return exclusive(async () => {
      const destination = await chooseDestination(`id_${request.type}_termforge`);
      if (!destination || !(await approvedUnencrypted(request))) return { canceled: true };
      live();
      return withTemporary(async directory => {
        const temporary = path.join(directory, 'private-key');
        const args = ['-q', '-t', request.type, ...(request.type === 'rsa' ? ['-b', '3072'] : []), '-a', '64', '-C', request.comment, '-f', temporary];
        await runKeygen(args, [{ prompt: 'new', value: request.passphrase }, { prompt: 'same', value: request.passphrase }]);
        return saveChecked(destination, temporary, request.passphrase, null, request.comment);
      });
    });
  }
  async function convert(input) {
    const request = validateRequest(input, true);
    return exclusive(async () => {
      const selected = await waitLive(() => dialog.showOpenDialog(getWindow(), { title: 'Choose an OpenSSH or PEM private key to copy and convert', properties: ['openFile'] }));
      live(); if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
      const source = validPath(selected.filePaths[0]);
      const bytes = await readRegularFile(source);
      try {
        const key = privateKey(bytes, request.oldPassphrase);
        const encrypted = utils.parseKey(bytes) instanceof Error;
        const identity = key.getPublicSSH();
        const destination = await chooseDestination(`${source}.openssh`);
        if (!destination || !(await approvedUnencrypted(request))) return { canceled: true };
        live();
        return await withTemporary(async directory => {
          const temporary = path.join(directory, 'private-key');
          await fsp.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          // ssh-keygen -p rewrites its input, so it only ever receives our copy.
          await runKeygen(['-q', '-p', '-o', '-a', '64', '-f', temporary], [...(encrypted ? [{ prompt: 'old', value: request.oldPassphrase }] : []), { prompt: 'new', value: request.passphrase }, { prompt: 'same', value: request.passphrase }]);
          return saveChecked(destination, temporary, request.passphrase, identity, key.comment);
        });
      } finally { bytes.fill(0); }
    });
  }
  async function agentList() {
    return exclusive(async () => {
      const result = await runTool('ssh-add', ['-l', '-E', 'sha256'], '', [0, 1, 2]);
      if (result.code === 2) return { available: false, keys: [], message: 'No SSH authentication agent is available to TermForge.' };
      if (result.code === 1) return { available: true, keys: [], message: 'The SSH agent has no identities.' };
      const keys = result.output.split(/\r?\n/u).filter(Boolean).slice(0, 128).map(line => {
        const match = /^(\d+) (SHA256:[A-Za-z0-9+/]+) (.*) \(([^()]*)\)$/u.exec(line);
        return match ? { bits: Number(match[1]), fingerprint: match[2], comment: match[3].replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 500), type: match[4] } : null;
      }).filter(Boolean);
      return { available: true, keys, message: keys.length ? 'Public fingerprints from the current OpenSSH agent. Adding and removing identities remains in your system SSH tools.' : 'No readable public fingerprints were returned by the SSH agent.' };
    });
  }
  const result = { generate, convert, agentList, get count() { return busy ? 1 : 0; }, close() {
    closed = true; stopping.abort();
    for (const child of children) child.kill('SIGKILL');
    const drained = () => { if (cleanupFailure) throw cleanupFailure; };
    return activeOperation ? activeOperation.then(drained, drained) : Promise.resolve().then(drained);
  } };
  if (register) { register('keyToolsGenerate', generate); register('keyToolsConvert', convert); register('keyToolsAgentList', agentList); }
  return result;
}
module.exports = { createKeyTools, validateRequest, writeKeyPair, runPrivateKeyPty, spawnPrivateWindowsPty, ownPrivateWindowsPty };
