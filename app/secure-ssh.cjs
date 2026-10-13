'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { Client: SshClient, BaseAgent, createAgent, utils } = require('ssh2');
const { validateSession } = require('./core.cjs');
const { writePrivateFile } = require('./files.cjs');

const MAX_FILE = 1024 * 1024;
const MAX_HOSTS = 2048;
const MAX_INPUT = 256 * 1024;
const MAX_QUEUE = 1024 * 1024;
const safeFailures = new WeakSet();
// Authentication identity is main-process state, never renderer-supplied metadata.
const connectionIdentities = new WeakMap();
function getConnectionIdentity(client) { return connectionIdentities.get(client) || null; }
function failure(message, code = 'SSH_FAILED') { const error = Object.assign(new Error(message), { code }); safeFailures.add(error); return error; }
function cancelled() { return failure('SSH connection cancelled.', 'SSH_CANCELLED'); }
function text(value, limit = 2048) { return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, limit); }
function cleanUsername(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u0020\u007f]/u.test(value)) throw failure('Enter a valid SSH username.');
  return value;
}
function safeError(error) {
  if (error && safeFailures.has(error)) return error;
  if (error?.level === 'client-authentication') return failure('SSH authentication failed. Check the enabled methods and credentials.');
  if (error?.code === 'ECONNREFUSED') return failure('The SSH server refused the connection.');
  if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') return failure('The SSH hostname could not be resolved.');
  if (error?.code === 'ETIMEDOUT') return failure('The SSH connection timed out.');
  return failure('The SSH connection failed or closed unexpectedly.');
}
async function readRegular(filename, max = MAX_FILE) {
  const entry = await fsp.lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink()) throw failure('SSH settings or key file must not be a symbolic link.');
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw failure('SSH settings or key file is not a bounded regular file.');
    // Bound the read even if another process grows the file after fstat.
    const bytes = Buffer.alloc(max + 1); let length = 0;
    while (length <= max) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > max) throw failure('SSH settings or key file exceeds the size limit.');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
function hostIdentity(key) {
  if (!Buffer.isBuffer(key) || key.length < 5 || key.length > 65536) throw failure('The SSH server supplied an invalid host key.');
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 128 || length + 4 > key.length) throw failure('The SSH server supplied an invalid host key.');
  const algorithm = key.subarray(4, 4 + length).toString('ascii');
  if (!/^[A-Za-z0-9@._+-]+$/u.test(algorithm)) throw failure('The SSH server supplied an invalid host key.');
  return { algorithm, fingerprint: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}` };
}
// Limit agent enumeration so a large local agent cannot cause an unbounded
// sequence of public-key offers to a remote server. Forwarding is unsupported.
class LimitedAgent extends BaseAgent {
  constructor(socket) { super(); this.agent = createAgent(socket); }
  getIdentities(callback) { this.agent.getIdentities((error, keys) => callback(error, Array.isArray(keys) ? keys.slice(0, 8) : [])); }
  sign(key, data, options, callback) { this.agent.sign(key, data, options, callback); }
}
function validateManaged(input) {
  const profile = validateSession(input);
  if (!['ssh', 'sftp'].includes(profile.protocol)) throw failure('Managed SSH requires an SSH or SFTP session.');
  const unsupported = [];
  if (profile.jumpHost) unsupported.push('jump hosts');
  if (profile.forwardings.length) unsupported.push('port forwarding');
  if (profile.ssh.agentForwarding) unsupported.push('agent forwarding');
  if (profile.ssh.x11Forwarding) unsupported.push('X11 forwarding');
  if (profile.ssh.certificateFile) unsupported.push('SSH certificates');
  if (profile.ssh.authMethod === 'gssapi') unsupported.push('GSSAPI');
  if (unsupported.length) throw failure(`Managed SSH does not yet support ${unsupported.join(', ')}. Use an OpenSSH terminal session for these options.`);
  return profile;
}

function createSecureSsh({ directory, getCredential = async () => null, requestAuthentication = async () => null, confirmHost = async () => false, env = process.env, Client = SshClient, promptTimeoutMs = 120000 } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute SSH settings directory is required.');
  if (!Number.isInteger(promptTimeoutMs) || promptTimeoutMs < 1 || promptTimeoutMs > 300000) throw new Error('Invalid authentication prompt timeout.');
  const filename = path.join(directory, 'managed-known-hosts.json');
  const connections = new Set();
  let mutations = Promise.resolve();
  const serialized = task => { const result = mutations.then(task); mutations = result.catch(() => {}); return result; };
  async function ensureDirectory() {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('SSH settings directory must not be a symbolic link.');
  }
  async function readHosts() {
    await ensureDirectory();
    let data;
    try { data = JSON.parse((await readRegular(filename)).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw failure('Saved SSH host keys could not be read safely.'); }
    if (data?.version !== 1 || !Array.isArray(data.hosts) || data.hosts.length > MAX_HOSTS) throw failure('Saved SSH host keys are invalid.');
    const keys = new Set();
    for (const host of data.hosts) {
      if (!host || typeof host.host !== 'string' || !host.host || host.host.length > 253 || /[\u0000-\u0020\u007f]/u.test(host.host) || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535 || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(host.fingerprint) || !/^[A-Za-z0-9@._+-]{1,128}$/u.test(host.algorithm) || typeof host.addedAt !== 'string' || !Number.isFinite(Date.parse(host.addedAt))) throw failure('Saved SSH host keys are invalid.');
      const key = `${host.host.toLowerCase()}:${host.port}`;
      if (keys.has(key)) throw failure('Saved SSH host keys contain duplicate entries.');
      keys.add(key);
    }
    return data.hosts.map(({ host, port, fingerprint, algorithm, addedAt }) => ({ host, port, fingerprint, algorithm, addedAt }));
  }
  const findHost = (hosts, profile) => hosts.find(item => item.host.toLowerCase() === profile.host.toLowerCase() && item.port === profile.port);
  async function verifyHost(profile, key, check, ask) {
    const identity = hostIdentity(key);
    const saved = findHost(await readHosts(), profile);
    check();
    if (saved) {
      if (saved.fingerprint !== identity.fingerprint || saved.algorithm !== identity.algorithm) throw failure('SSH host key changed. Connection blocked. Verify the server fingerprint independently before forgetting its saved key.', 'SSH_HOST_CHANGED');
      return identity;
    }
    const accepted = await ask(signal => confirmHost({ host: profile.host, port: profile.port, ...identity, signal }));
    check();
    if (accepted !== true) throw failure('The SSH host key was not trusted.', 'SSH_HOST_REJECTED');
    await serialized(async () => {
      check();
      const hosts = await readHosts(), concurrent = findHost(hosts, profile);
      if (concurrent && (concurrent.fingerprint !== identity.fingerprint || concurrent.algorithm !== identity.algorithm)) throw failure('SSH host key changed while confirming trust. Connection blocked.', 'SSH_HOST_CHANGED');
      if (!concurrent) {
        if (hosts.length >= MAX_HOSTS) throw failure('The saved SSH host limit has been reached.');
        hosts.push({ host: profile.host.toLowerCase(), port: profile.port, ...identity, addedAt: new Date().toISOString() });
        check();
        await writePrivateFile(filename, JSON.stringify({ version: 1, hosts }, null, 2));
      }
    });
    check();
    return identity;
  }
  function connect(input, { signal } = {}) {
    let profile;
    try { profile = validateManaged(input); } catch (error) { return Promise.reject(error); }
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const client = new Client(), authenticationAbort = new AbortController();
      let verifiedIdentity;
      let finished = false, authenticated = false, trusted = false, timer, promptTimer, credential, username, credentialLoaded = false, authIndex = 0, rounds = 0;
      const record = { client, cancel: () => fail(cancelled()) };
      connections.add(record);
      const cleanupTimers = () => { clearTimeout(timer); clearTimeout(promptTimer); };
      const check = () => { if (finished || signal?.aborted) throw cancelled(); };
      function fail(error) {
        if (finished) return;
        finished = true; cleanupTimers(); credential = null; authenticationAbort.abort();
        signal?.removeEventListener('abort', record.cancel);
        connections.delete(record);
        // destroy terminates incomplete handshakes as well as established sockets.
        client.destroy();
        if (!authenticated) reject(safeError(error));
      }
      function networkTimer() { clearTimeout(timer); if (!finished && !authenticated) timer = setTimeout(() => fail(failure('The SSH connection timed out.', 'SSH_TIMEOUT')), profile.ssh.connectTimeout * 1000); }
      async function ask(task) {
        check(); clearTimeout(timer);
        let abortPrompt;
        try {
          return await Promise.race([Promise.resolve().then(() => { check(); return task(authenticationAbort.signal); }), new Promise((_, rejectPrompt) => {
            abortPrompt = () => rejectPrompt(cancelled()); authenticationAbort.signal.addEventListener('abort', abortPrompt, { once: true });
            promptTimer = setTimeout(() => rejectPrompt(failure('SSH authentication or trust prompt timed out.', 'SSH_TIMEOUT')), promptTimeoutMs);
          })]);
        } finally { clearTimeout(promptTimer); authenticationAbort.signal.removeEventListener('abort', abortPrompt); networkTimer(); }
      }
      async function prompt(kind, prompts, extra = {}) {
        check();
        if (++rounds > 8 || !Array.isArray(prompts) || prompts.length > 8 || prompts.some(item => !item || typeof item.prompt !== 'string' || item.prompt.length > 2048 || typeof item.echo !== 'boolean')) throw failure('SSH authentication exceeded the prompt limit.');
        const answers = await ask(signal => requestAuthentication({ signal, host: profile.host, port: profile.port, kind, username: username || '', prompts: prompts.map(item => ({ prompt: text(item.prompt), echo: item.echo })), ...extra }));
        check();
        if (answers === null) throw cancelled();
        if (!Array.isArray(answers) || answers.length !== prompts.length || answers.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) throw failure('SSH authentication returned invalid answers.');
        return answers;
      }
      async function loadIdentity() {
        check();
        if (!trusted) throw failure('SSH authentication cannot begin before host verification.');
        if (!credentialLoaded) {
          credentialLoaded = true;
          try { credential = profile.credentialId ? await ask(signal => getCredential(profile, { fingerprint: verifiedIdentity.fingerprint, signal })) : null; }
          catch (error) {
            check();
            if (safeFailures.has(error)) throw error;
            throw failure('Saved credential could not be unlocked or approved. Open Credentials to review it, or choose a prompted login.');
          }
          check();
          if (profile.credentialId && !credential) throw failure('The saved credential is unavailable. Unlock or select a credential before connecting.');
          username = credential?.username || profile.username;
          if (!username) username = (await prompt('username', [{ prompt: 'Username', echo: true }]))[0];
          username = cleanUsername(username);
        }
      }
      const order = profile.ssh.authMethod !== 'auto' ? [profile.ssh.authMethod] : profile.ssh.authOrder || ['publickey', 'keyboard-interactive', 'password'];
      const attempts = order.flatMap(method => method === 'publickey' ? [...(profile.identityFile ? ['publickey'] : []), ...(env.SSH_AUTH_SOCK ? ['agent'] : [])] : [method]);
      async function nextAuth(methodsLeft) {
        await loadIdentity();
        while (authIndex < attempts.length) {
          const method = attempts[authIndex++];
          if (methodsLeft && !methodsLeft.includes(method === 'agent' ? 'publickey' : method)) continue;
          if (method === 'agent') return { type: 'agent', username, agent: new LimitedAgent(env.SSH_AUTH_SOCK) };
          if (method === 'publickey') {
            let keyPath = profile.identityFile;
            if (/^~(?:[/\\]|$)/u.test(keyPath)) { const home = env.HOME || env.USERPROFILE; if (!home) throw failure('The home directory for the SSH key is unavailable.'); keyPath = path.join(home, keyPath.slice(2)); }
            if (!path.isAbsolute(keyPath)) throw failure('Choose an absolute path for the SSH private key.');
            let bytes;
            try { bytes = await readRegular(keyPath); } catch { throw failure('The SSH private key could not be read safely.'); }
            check();
            let key = utils.parseKey(bytes);
            try {
              if (key instanceof Error && /encrypted|passphrase/iu.test(key.message)) key = utils.parseKey(bytes, (await prompt('key-passphrase', [{ prompt: 'Private key passphrase', echo: false }]))[0]);
              if (key instanceof Error || Array.isArray(key) || !key.isPrivateKey()) throw failure('The SSH private key or passphrase is invalid.');
              return { type: 'publickey', username, key };
            } finally { bytes.fill(0); }
          }
          if (method === 'password') {
            const password = credential && typeof credential.password === 'string' ? credential.password : (await prompt('password', [{ prompt: 'Password', echo: false }]))[0];
            if (password.length > 4096 || password.includes('\0')) throw failure('The saved SSH password is invalid.');
            return { type: 'password', username, password };
          }
          if (method === 'keyboard-interactive') return { type: method, username, prompt: (name, instructions, language, prompts, finish) => {
            // Servers control challenge text. Never infer that a challenge should
            // receive the vault password; every challenge requires fresh input.
            prompt('keyboard-interactive', prompts, { name: text(name), instructions: text(instructions, 4096) }).then(answers => { check(); finish(answers); networkTimer(); }).catch(fail);
          } };
        }
        return false;
      }
      client.on('error', error => { if (!authenticated) fail(error); });
      client.once('close', () => {
        if (!finished && !authenticated) fail(failure('The SSH connection closed before authentication completed.'));
        finished = true; credential = null; authenticationAbort.abort(); cleanupTimers(); connections.delete(record); signal?.removeEventListener('abort', record.cancel);
      });
      client.once('ready', () => {
        if (finished || !trusted) return fail(cancelled());
        authenticated = true; credential = null; cleanupTimers();
        connectionIdentities.set(client, Object.freeze({ host: profile.host.toLowerCase(), port: profile.port,
          username, ...verifiedIdentity }));
        resolve(client);
      });
      signal?.addEventListener('abort', record.cancel, { once: true });
      networkTimer();
      const algorithms = { compress: profile.ssh.compression ? ['zlib@openssh.com', 'none'] : ['none'] };
      for (const [field, option] of [['ciphers', 'cipher'], ['keyExchanges', 'kex'], ['macs', 'hmac']]) if (profile.ssh[field].length) algorithms[option] = profile.ssh[field];
      try {
        client.connect({ host: profile.host, port: profile.port, username: '', readyTimeout: 0, keepaliveInterval: profile.ssh.keepAliveInterval * 1000, keepaliveCountMax: profile.ssh.keepAliveCountMax, algorithms,
          hostVerifier: (key, callback) => {
            verifyHost(profile, key, check, ask).then(identity => { check(); verifiedIdentity = identity; trusted = true; callback(true); networkTimer(); }).catch(error => { fail(error); try { callback(false); } catch { /* A rejected handshake may already be closed. */ } });
          },
          authHandler: (methodsLeft, partialSuccess, callback) => {
            nextAuth(methodsLeft).then(value => { check(); callback(value); networkTimer(); }).catch(fail);
          },
        });
      } catch (error) { fail(error); }
    });
  }
  function createTerminal(input) {
    const profile = validateManaged(input);
    const abort = new AbortController(), dataListeners = new Set(), rawListeners = new Set(), exitListeners = new Set();
    const decoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8');
    let client, channel, stopped = false, queue = [], queuedBytes = 0, blocked = false, cols = 100, rows = 30;
    const receiveBytes = (bytes, decoder) => {
      if (stopped) return;
      for (const listener of rawListeners) listener(Buffer.from(bytes));
      output(decoder.write(bytes));
    };
    const output = value => { if (value && !stopped) for (const listener of dataListeners) listener(value); };
    function finish(event = { exitCode: 0, signal: null }) {
      if (stopped) return;
      output(decoder.end()); output(errorDecoder.end());
      stopped = true; queue = []; queuedBytes = 0; abort.abort(); channel?.destroy(); client?.destroy();
      for (const listener of exitListeners) listener(event);
      dataListeners.clear(); rawListeners.clear(); exitListeners.clear();
    }
    function flush() {
      try { while (!stopped && channel && !blocked && queue.length) { const value = queue.shift(); queuedBytes -= Buffer.byteLength(value); blocked = !channel.write(value); } }
      catch { output('\r\n[ForgeCRT: The SSH terminal could not send input.]\r\n'); finish({ exitCode: 1, signal: 'error' }); }
    }
    queueMicrotask(async () => {
      try {
        client = await connect(profile, { signal: abort.signal });
        if (stopped) { client.destroy(); return; }
        client.on('error', () => { output('\r\n[ForgeCRT: SSH connection failed.]\r\n'); finish({ exitCode: 1, signal: 'error' }); });
        client.on('close', () => finish());
        const window = { term: profile.terminal.terminalType, cols, rows, width: 0, height: 0 };
        const ready = (error, stream) => {
          if (error) { output('\r\n[ForgeCRT: The SSH server could not open the terminal.]\r\n'); finish({ exitCode: 1, signal: 'error' }); return; }
          if (stopped) { stream.destroy(); return; }
          channel = stream;
          stream.on('data', bytes => receiveBytes(bytes, decoder));
          stream.stderr.on('data', bytes => receiveBytes(bytes, errorDecoder));
          stream.on('drain', () => { blocked = false; flush(); });
          stream.on('error', () => { output('\r\n[ForgeCRT: The SSH terminal stream failed.]\r\n'); finish({ exitCode: 1, signal: 'error' }); });
          stream.on('close', (code, signal) => finish({ exitCode: Number.isInteger(code) ? code : 0, signal: typeof signal === 'string' ? text(signal, 32) : null }));
          try { stream.setWindow(rows, cols, 0, 0); flush(); } catch { finish({ exitCode: 1, signal: 'error' }); }
        };
        if (profile.ssh.remoteCommand) client.exec(profile.ssh.remoteCommand, { pty: window }, ready);
        else client.shell(window, ready);
      } catch (error) {
        if (!stopped) { output(`\r\n[ForgeCRT: ${safeError(error).message}]\r\n`); finish({ exitCode: error.code === 'SSH_CANCELLED' ? 0 : 1, signal: error.code === 'SSH_CANCELLED' ? 'closed' : 'error' }); }
      }
    });
    return {
      write(value) {
        if (stopped) throw new Error('SSH terminal is no longer open.');
        if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_INPUT) throw new Error('Terminal input must be a string of at most 256 KiB.');
        if (queuedBytes + Buffer.byteLength(value) > MAX_QUEUE) throw new Error('SSH terminal input queue exceeds 1 MiB.');
        queue.push(value); queuedBytes += Buffer.byteLength(value); flush();
      },
      writeBytes(bytes) {
        if (stopped) throw new Error('SSH terminal is no longer open.');
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INPUT) throw new Error('Binary input must contain at most 256 KiB.');
        if (queuedBytes + bytes.byteLength > MAX_QUEUE) throw new Error('SSH terminal input queue exceeds 1 MiB.');
        const value = Buffer.from(bytes); queue.push(value); queuedBytes += value.length; flush();
      },
      resize(nextCols, nextRows) { if (!Number.isInteger(nextCols) || nextCols < 1 || nextCols > 500 || !Number.isInteger(nextRows) || nextRows < 1 || nextRows > 300) throw new Error('Invalid terminal dimensions.'); cols = nextCols; rows = nextRows; if (!stopped && channel) channel.setWindow(rows, cols, 0, 0); },
      kill() { finish({ exitCode: 0, signal: 'closed' }); },
      onRawData(listener) {
        if (typeof listener !== 'function') throw new Error('Raw data callback is required.');
        rawListeners.add(listener); return { dispose() { rawListeners.delete(listener); } };
      },
      onData(listener) { dataListeners.add(listener); return { dispose() { dataListeners.delete(listener); } }; },
      onExit(listener) { exitListeners.add(listener); return { dispose() { exitListeners.delete(listener); } }; },
    };
  }
  return {
    connect, createTerminal,
    listHosts: () => serialized(readHosts),
    forgetHost({ host, port } = {}) {
      if (typeof host !== 'string' || !Number.isInteger(port)) return Promise.reject(new Error('Host and port are required.'));
      return serialized(async () => { const hosts = await readHosts(), remaining = hosts.filter(item => item.host.toLowerCase() !== host.toLowerCase() || item.port !== port); if (remaining.length !== hosts.length) await writePrivateFile(filename, JSON.stringify({ version: 1, hosts: remaining }, null, 2)); return { forgotten: remaining.length !== hosts.length }; });
    },
    closeAll() { for (const connection of [...connections]) connection.cancel(); return { closed: true }; },
  };
}
module.exports = { createSecureSsh, getConnectionIdentity };
