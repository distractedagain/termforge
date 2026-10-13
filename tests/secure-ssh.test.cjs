'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const { Server, AgentProtocol, utils } = require('ssh2');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { createSecureSsh, getConnectionIdentity } = require('../app/secure-ssh.cjs');
const { createTerminalManager } = require('../app/terminals.cjs');
const { generateEd25519Fixture } = require('../scripts/ssh-key-fixtures.cjs');
const leadingZeroEd25519 = require('./fixtures/leading-zero-ed25519.cjs');
const hostOne = generateEd25519Fixture().private;
const hostTwo = generateEd25519Fixture().private;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Loopback SSH test timed out.'); await delay(10); } }
async function temporary(t) { const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'termforge-secure-ssh-')); t.after(() => fsp.rm(dir, { recursive: true, force: true })); return dir; }
async function server(t, { hostKey = hostOne, port = 0, authenticate, shell, exec } = {}) {
  const peers = new Set(), methods = [], windows = [];
  const listener = new Server({ hostKeys: [hostKey] }, peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    peer.on('authentication', context => {
      methods.push({ method: context.method, username: context.username });
      if (authenticate) authenticate(context);
      else if (context.method === 'password' && context.username === 'fixture-user' && context.password === 'fixture-password') context.accept();
      else context.reject(['password', 'keyboard-interactive', 'publickey']);
    });
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept();
      session.on('pty', (accept, reject, options) => { windows.push(options); accept(); });
      session.on('window-change', (accept, reject, options) => { windows.push(options); accept?.(); });
      session.on('shell', accept => { const channel = accept(); if (shell) shell(channel); else { channel.write('fixture-ready> '); channel.on('data', data => channel.write(Buffer.concat([Buffer.from('echo:'), data]))); } });
      session.on('exec', (accept, reject, options) => { const channel = accept(); if (exec) exec(channel, options); else channel.end('fixture-command'); });
    }));
  });
  listener.listen(port, '127.0.0.1'); await once(listener, 'listening');
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; for (const peer of peers) peer.end(); await new Promise(resolve => listener.close(resolve)); };
  t.after(stop);
  return { port: listener.address().port, methods, windows, stop };
}
const profile = (port, extra = {}) => ({ host: '127.0.0.1', port, protocol: 'ssh', name: 'Synthetic fixture', username: 'fixture-user', credentialId: 'fixture-credential', ssh: { backend: 'managed', authOrder: ['password'] }, ...extra });
async function fixture(t, options = {}) {
  const directory = await temporary(t);
  const service = createSecureSsh({ directory, confirmHost: async () => true, getCredential: async () => ({ username: 'fixture-user', password: 'fixture-password' }), env: {}, ...options });
  t.after(() => service.closeAll());
  return { directory, service };
}

test('real SSH pins the reviewed host before decrypting credentials and never persists credentials', async t => {
  const endpoint = await server(t), calls = [];
  let actualFingerprint;
  const { directory, service } = await fixture(t, {
    confirmHost: async detail => { calls.push('trust'); assert.equal(detail.algorithm, 'ssh-ed25519'); actualFingerprint = detail.fingerprint; assert.match(actualFingerprint, /^SHA256:/); assert.ok(detail.signal instanceof AbortSignal); return true; },
    getCredential: async (session, { fingerprint, signal }) => { calls.push('credential'); assert.equal(fingerprint, actualFingerprint); assert.ok(!signal.aborted); assert.equal(session.credentialId, 'fixture-credential'); const hosts = JSON.parse(await fsp.readFile(path.join(directory, 'managed-known-hosts.json'), 'utf8')); assert.equal(hosts.hosts[0].fingerprint, fingerprint); return { username: 'fixture-user', password: 'fixture-password' }; },
  });
  const first = await service.connect(profile(endpoint.port)); first.end();
  assert.deepEqual(calls, ['trust', 'credential']);
  const second = await service.connect(profile(endpoint.port)); second.end();
  assert.deepEqual(calls, ['trust', 'credential', 'credential']);
  const content = await fsp.readFile(path.join(directory, 'managed-known-hosts.json'), 'utf8');
  assert.ok(!content.includes('fixture-user') && !content.includes('fixture-password'));
  if (process.platform !== 'win32') assert.equal((await fsp.stat(path.join(directory, 'managed-known-hosts.json'))).mode & 0o777, 0o600);
  assert.equal((await service.listHosts()).length, 1);
  assert.deepEqual(await service.forgetHost({ host: '127.0.0.1', port: endpoint.port }), { forgotten: true });
  assert.deepEqual(await service.listHosts(), []);
});

test('declining a new host blocks all authentication and vault access', async t => {
  const endpoint = await server(t); let vaultReads = 0, prompts = 0;
  const { service } = await fixture(t, { confirmHost: async () => false, getCredential: async () => { vaultReads++; }, requestAuthentication: async () => { prompts++; } });
  await assert.rejects(service.connect(profile(endpoint.port)), error => error.code === 'SSH_HOST_REJECTED');
  assert.equal(vaultReads, 0); assert.equal(prompts, 0); assert.deepEqual(endpoint.methods, []); assert.deepEqual(await service.listHosts(), []);
});

test('recovery identity reflects the authenticated account and verified key without credential material', async t => {
  const endpoint = await server(t); const { service } = await fixture(t);
  const client = await service.connect(profile(endpoint.port, { username: 'ignored-profile-user' }));
  const identity = getConnectionIdentity(client);
  assert.equal(identity.username, 'fixture-user'); assert.equal(identity.host, '127.0.0.1'); assert.equal(identity.port, endpoint.port);
  assert.equal(identity.algorithm, 'ssh-ed25519'); assert.match(identity.fingerprint, /^SHA256:/);
  assert.equal(Object.isFrozen(identity), true); assert.equal(JSON.stringify(identity).includes('fixture-password'), false);
  assert.equal(getConnectionIdentity({}), null); client.end();
});

test('a changed pinned host blocks before vault read or another trust prompt', async t => {
  let approvals = 0, vaultReads = 0;
  const { service } = await fixture(t, { confirmHost: async () => { approvals++; return true; }, getCredential: async () => { vaultReads++; return { username: 'fixture-user', password: 'fixture-password' }; } });
  const original = await server(t); const client = await service.connect(profile(original.port)); client.end(); await original.stop();
  const changed = await server(t, { port: original.port, hostKey: hostTwo });
  await assert.rejects(service.connect(profile(changed.port)), error => error.code === 'SSH_HOST_CHANGED');
  assert.equal(approvals, 1); assert.equal(vaultReads, 1); assert.deepEqual(changed.methods, []);
});

test('keyboard-interactive uses fresh user answers rather than the stored password', async t => {
  let received, asks = 0;
  const endpoint = await server(t, { authenticate: context => {
    if (context.method !== 'keyboard-interactive') return context.reject(['keyboard-interactive']);
    context.prompt([{ prompt: 'One-time token', echo: false }], 'Fixture', 'Enter token', answers => { received = answers; if (answers[0] === '654321') context.accept(); else context.reject(); });
  } });
  const { service } = await fixture(t, { requestAuthentication: async prompt => { asks++; assert.equal(prompt.kind, 'keyboard-interactive'); assert.equal(prompt.username, 'fixture-user'); assert.deepEqual(prompt.prompts, [{ prompt: 'One-time token', echo: false }]); return ['654321']; } });
  const client = await service.connect(profile(endpoint.port, { ssh: { backend: 'managed', authOrder: ['keyboard-interactive', 'password'] } })); client.end();
  assert.equal(asks, 1); assert.deepEqual(received, ['654321']);
});

test('manual username and password prompts begin only after host review', async t => {
  const endpoint = await server(t), actions = [];
  const { service } = await fixture(t, { confirmHost: async () => { actions.push('trust'); return true; }, getCredential: async () => assert.fail('No vault access for manual login'), requestAuthentication: async ({ kind }) => { actions.push(kind); return [kind === 'username' ? 'fixture-user' : 'fixture-password']; } });
  const client = await service.connect(profile(endpoint.port, { username: '', credentialId: '' })); client.end();
  assert.deepEqual(actions, ['trust', 'username', 'password']);
});

test('public-key authentication supports encrypted keys with a separately prompted passphrase', async t => {
  const key = generateEd25519Fixture({ cipher: 'aes256-cbc', passphrase: 'fixture-passphrase' });
  const publicKey = utils.parseKey(key.public), requests = [];
  const endpoint = await server(t, { authenticate: context => {
    if (context.method !== 'publickey' || !context.key.data.equals(publicKey.getPublicSSH())) return context.reject(['publickey']);
    if (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo)) context.accept(); else context.reject();
  } });
  const { directory, service } = await fixture(t, { requestAuthentication: async request => { requests.push(request.kind); return ['fixture-passphrase']; } });
  const identityFile = path.join(directory, 'fixture-private-key'); await fsp.writeFile(identityFile, key.private, { mode: 0o600 });
  const client = await service.connect(profile(endpoint.port, { credentialId: '', identityFile, ssh: { backend: 'managed', authOrder: ['publickey'] } })); client.end();
  assert.deepEqual(requests, ['key-passphrase']); assert.ok(endpoint.methods.every(method => method.method === 'publickey'));
});

test('public-key authentication accepts a correctly encoded Ed25519 identity with leading zero bytes', async t => {
  const key = leadingZeroEd25519(), publicKey = utils.parseKey(key.public); let signatures = 0;
  assert.equal(publicKey.getPublicSSH().subarray(-32, -30).toString('hex'), '0000');
  const endpoint = await server(t, { authenticate: context => {
    if (context.method !== 'publickey' || !context.key.data.equals(publicKey.getPublicSSH())) return context.reject(['publickey']);
    if (!context.signature) return context.accept();
    if (!publicKey.verify(context.blob, context.signature, context.hashAlgo)) return context.reject();
    signatures++; context.accept();
  } });
  const { directory, service } = await fixture(t, { requestAuthentication: async () => assert.fail('Unencrypted synthetic key needs no passphrase') });
  const identityFile = path.join(directory, 'leading-zero-test-identity'); await fsp.writeFile(identityFile, key.private, { mode: 0o600 });
  const client = await service.connect(profile(endpoint.port, { credentialId: '', identityFile, ssh: { backend: 'managed', authOrder: ['publickey'] } })); client.end();
  assert.equal(signatures, 1);
});

test('ordered methods fall back once and authentication rejection exposes no secret', async t => {
  const endpoint = await server(t, { authenticate: context => context.reject(['password', 'keyboard-interactive']) });
  const { service } = await fixture(t, { requestAuthentication: async () => ['fixture-answer'] });
  await assert.rejects(service.connect(profile(endpoint.port, { ssh: { backend: 'managed', authOrder: ['keyboard-interactive', 'password'] } })), error => /authentication failed/u.test(error.message) && !/fixture/u.test(error.message));
  assert.deepEqual(endpoint.methods.map(method => method.method), ['keyboard-interactive', 'password']);
});

test('cancelling pending host trust aborts the prompt and never loads credentials or persists approval', async t => {
  const endpoint = await server(t), abort = new AbortController(); let promptSignal, approve, vaultReads = 0;
  const { service } = await fixture(t, { confirmHost: ({ signal }) => { promptSignal = signal; return new Promise(resolve => { approve = resolve; }); }, getCredential: async () => { vaultReads++; } });
  const connecting = service.connect(profile(endpoint.port), { signal: abort.signal });
  const rejection = assert.rejects(connecting, error => error.code === 'SSH_CANCELLED');
  await until(() => approve); abort.abort(); await rejection; assert.equal(promptSignal.aborted, true);
  approve(true); await delay(20); assert.deepEqual(await service.listHosts(), []); assert.equal(vaultReads, 0);
});

test('closeAll cancels a pending credential permission request and ignores late secrets', async t => {
  const endpoint = await server(t); let complete, credentialSignal;
  const { service } = await fixture(t, { getCredential: async (profile, { signal }) => { credentialSignal = signal; return new Promise(resolve => { complete = resolve; }); } });
  const connecting = service.connect(profile(endpoint.port)); const rejection = assert.rejects(connecting, error => error.code === 'SSH_CANCELLED');
  await until(() => complete); service.closeAll(); await rejection;
  assert.ok(credentialSignal.aborted); complete({ username: 'fixture-user', password: 'fixture-password' }); await delay(20); assert.deepEqual(endpoint.methods, []);
});

test('prompt timeout fails closed and aborts the pending dialog', async t => {
  const endpoint = await server(t); let promptSignal;
  const { service } = await fixture(t, { promptTimeoutMs: 35, confirmHost: ({ signal }) => { promptSignal = signal; return new Promise(() => {}); } });
  await assert.rejects(service.connect(profile(endpoint.port)), error => error.code === 'SSH_TIMEOUT');
  assert.equal(promptSignal.aborted, true); assert.deepEqual(endpoint.methods, []);
});

test('terminal adapter exchanges real shell data, early input, resize and one close event', async t => {
  const endpoint = await server(t); const { service } = await fixture(t); let output = '', exits = [];
  const manager = createTerminalManager({ managedTransport: service.createTerminal, spawn: () => assert.fail('Managed credentials must never launch a system process'), emitData: event => { output += event.data; }, emitExit: event => exits.push(event) });
  t.after(() => manager.closeAll());
  const terminal = manager.open(profile(endpoint.port));
  manager.write({ id: terminal.id, data: 'early-λ\r' }); manager.resize({ id: terminal.id, cols: 122, rows: 43 });
  await until(() => output.includes('echo:early-λ\r'));
  assert.ok(!output.includes('fixture-password')); assert.ok(endpoint.windows.some(window => window.cols === 122 && window.rows === 43));
  manager.resize({ id: terminal.id, cols: 90, rows: 31 }); await until(() => endpoint.windows.some(window => window.cols === 90 && window.rows === 31));
  manager.close(terminal.id); manager.close(terminal.id); await until(() => exits.length);
  assert.equal(exits.length, 1); assert.equal(manager.count, 0);
});

test('managed SSH sends and captures all binary octets without UTF-8 round trips', async t => {
  let received = Buffer.alloc(0);
  const endpoint = await server(t, { shell: channel => channel.on('data', bytes => { received = Buffer.concat([received, bytes]); channel.write(bytes); }) });
  const { directory, service } = await fixture(t);
  const manager = createTerminalManager({ managedTransport: service.createTerminal }); t.after(() => manager.closeAll());
  const terminal = manager.open(profile(endpoint.port)), filename = path.join(directory, 'raw.bin');
  manager.enableLog(terminal.id, filename, { mode: 'raw' });
  const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  manager.writeBinary({ id: terminal.id, data: payload });
  await until(() => manager.readRaw(terminal.id).totalBytes === payload.length);
  assert.deepEqual(received, payload); assert.deepEqual(fs.readFileSync(filename), payload);
  assert.deepEqual(Buffer.from(manager.readRaw(terminal.id).base64, 'base64'), payload);
  manager.disableLog(terminal.id); manager.close(terminal.id);
});

test('terminal adapter supports remote command and remote exit code', async t => {
  const endpoint = await server(t, { exec: (stream, options) => { assert.equal(options.command, 'fixture-command'); stream.write('command-output'); stream.exit(7); stream.end(); } });
  const { service } = await fixture(t); let output = '', exit;
  const terminal = service.createTerminal(profile(endpoint.port, { ssh: { backend: 'managed', authOrder: ['password'], remoteCommand: 'fixture-command' } }));
  terminal.onData(chunk => { output += chunk; }); terminal.onExit(event => { exit = event; });
  await until(() => exit); assert.equal(exit.exitCode, 7); assert.equal(output, 'command-output');
});

test('terminal close during startup cancels authentication without emitting late output', async t => {
  const endpoint = await server(t); let promptStarted = false, output = '', exits = 0;
  const { service } = await fixture(t, { confirmHost: async () => { promptStarted = true; return new Promise(() => {}); } });
  const terminal = service.createTerminal(profile(endpoint.port)); terminal.onData(data => { output += data; }); terminal.onExit(() => { exits++; });
  await until(() => promptStarted); terminal.kill(); terminal.kill(); await delay(20);
  assert.equal(exits, 1); assert.equal(output, ''); assert.deepEqual(endpoint.methods, []);
});

test('unsupported advanced settings are rejected before opening a network connection', async t => {
  const { service } = await fixture(t);
  for (const extra of [{ jumpHost: 'fixture-bastion' }, { forwardings: [{ type: 'dynamic', listenPort: 1080 }] }, { ssh: { backend: 'managed', x11Forwarding: true } }, { ssh: { backend: 'managed', agentForwarding: true } }, { ssh: { backend: 'managed', certificateFile: '/fixture/cert.pub' } }, { ssh: { backend: 'managed', authMethod: 'gssapi' } }]) {
    await assert.rejects(service.connect(profile(1, extra)), /Managed SSH does not yet support/);
  }
});

test('corrupt or linked host stores fail closed without authentication', async t => {
  const endpoint = await server(t), { directory, service } = await fixture(t);
  const filename = path.join(directory, 'managed-known-hosts.json'); await fsp.writeFile(filename, '{broken');
  await assert.rejects(service.connect(profile(endpoint.port)), /could not be read safely/);
  assert.deepEqual(endpoint.methods, []);
  if (process.platform !== 'win32') {
    await fsp.unlink(filename); const target = path.join(directory, 'target.json'); await fsp.writeFile(target, JSON.stringify({ version: 1, hosts: [] })); await fsp.symlink(target, filename);
    await assert.rejects(service.connect(profile(endpoint.port)), /could not be read safely/);
    assert.equal(await fsp.readFile(target, 'utf8'), JSON.stringify({ version: 1, hosts: [] }));
  }
});

test('arbitrary library error strings never reach the terminal or invoke rejection', async t => {
  class BrokenClient extends EventEmitter {
    connect() { queueMicrotask(() => this.emit('error', new Error('secret-user secret-password from malformed provider'))); }
    destroy() { queueMicrotask(() => this.emit('close')); }
  }
  const { service } = await fixture(t, { Client: BrokenClient });
  await assert.rejects(service.connect(profile(1)), error => !error.message.includes('secret') && /SSH connection failed/u.test(error.message));
});


test('SSH agent signs through a local agent socket without loading a private key file', async t => {
  const key = utils.parseKey(generateEd25519Fixture().private);
  const directory = await temporary(t), sockets = new Set(); let signed = 0;
  const windowsPipe = String.raw`\\.\pipe\termforge-agent-${randomUUID()}`;
  assert.deepEqual([...Buffer.from(windowsPipe).subarray(0, 9)], [92, 92, 46, 92, 112, 105, 112, 101, 92], 'Windows pipe prefix must retain every literal backslash on every platform');
  const socketPath = process.platform === 'win32' ? windowsPipe : path.join(directory, 'agent.sock');
  const agent = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const protocol = new AgentProtocol(false); protocol.on('error', () => socket.destroy()); socket.on('error', () => {}); socket.pipe(protocol).pipe(socket);
    protocol.on('identities', request => protocol.getIdentitiesReply(request, [key]));
    protocol.on('sign', (request, requestedKey, data, options) => { signed++; protocol.signReply(request, key.sign(data)); });
  });
  agent.listen(socketPath); await once(agent, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => agent.close(resolve)); });
  const endpoint = await server(t, { authenticate: context => {
    if (context.method !== 'publickey' || !context.key.data.equals(key.getPublicSSH())) return context.reject(['publickey']);
    if (!context.signature || key.verify(context.blob, context.signature, context.hashAlgo)) context.accept(); else context.reject();
  } });
  const { service } = await fixture(t, { env: { SSH_AUTH_SOCK: socketPath } });
  const client = await service.connect(profile(endpoint.port, { credentialId: '', ssh: { backend: 'managed', authOrder: ['publickey'] } })); client.end();
  assert.equal(signed, 1);
});

test('keyboard-interactive limits repeated challenges and rejects excessive prompt arrays', async t => {
  let questions = 0;
  const endpoint = await server(t, { authenticate: context => {
    if (context.method !== 'keyboard-interactive') return context.reject(['keyboard-interactive']);
    const again = () => { questions++; context.prompt([{ prompt: 'Again?', echo: false }], () => again()); };
    again();
  } });
  const { service } = await fixture(t, { requestAuthentication: async () => ['fixture-answer'] });
  await assert.rejects(service.connect(profile(endpoint.port, { ssh: { backend: 'managed', authOrder: ['keyboard-interactive'] } })), /prompt limit/u);
  assert.equal(questions, 9);
  const excessive = await server(t, { authenticate: context => {
    if (context.method !== 'keyboard-interactive') return context.reject(['keyboard-interactive']);
    context.prompt(Array.from({ length: 9 }, () => ({ prompt: 'Invalid bulk prompt', echo: false })), () => context.reject());
  } });
  await assert.rejects(service.connect(profile(excessive.port, { ssh: { backend: 'managed', authOrder: ['keyboard-interactive'] } })), /prompt limit/u);
});


test('vault failure is actionable without exposing provider error details', async t => {
  const endpoint = await server(t);
  const { service } = await fixture(t, { getCredential: async () => { throw new Error('secret-credential-value'); } });
  await assert.rejects(service.connect(profile(endpoint.port)), error => /Open Credentials/u.test(error.message) && !error.message.includes('secret-credential-value'));
  assert.deepEqual(endpoint.methods, []);
});

test('terminal manager refuses managed SFTP before a system process can receive the profile', () => {
  const manager = createTerminalManager({ spawn: () => assert.fail('Must not spawn SFTP'), managedTransport: () => assert.fail('Must not open an SSH shell') });
  assert.throws(() => manager.open(profile(22, { protocol: 'sftp' })), /graphical file transfer/);
  assert.equal(manager.count, 0);
});
