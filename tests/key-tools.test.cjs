'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { generateKeyPairSync, createPublicKey } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { utils } = require('ssh2');
const { createKeyTools, validateRequest, writeKeyPair, runPrivateKeyPty } = require('../app/key-tools.cjs');

const passphrase = 'fixture passphrase ! $()';
async function fixture(t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'termforge-key-tools-test-'));
  const destination = path.join(directory, 'chosen-key'), source = path.join(directory, 'source-key');
  const calls = [];
  const service = createKeyTools({
    tempRoot: directory,
    env: { ...process.env, SSH_AUTH_SOCK: '', SSH_ASKPASS: '/must/not/run', SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':99', WAYLAND_DISPLAY: 'fixture' },
    dialog: { showSaveDialog: async (_window, settings) => { calls.push(['save', settings]); return { canceled: false, filePath: destination }; }, showOpenDialog: async () => ({ canceled: false, filePaths: [source] }), showMessageBox: async () => ({ response: 0 }) },
    ...(options.spawn && !options.spawnPty ? { spawnPty: null } : {}),
    ...options,
  });
  t.after(async () => { await service.close(); await fsp.rm(directory, { recursive: true, force: true }); });
  return { service, directory, destination, source, calls };
}
function fakeChild({ output = '', code = 0, stderr = '', delay = 0, hanging = false, observe } = {}) {
  return (executable, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { observe?.({ signal }); queueMicrotask(() => child.emit('close', null)); return true; };
    observe?.({ executable, args, options, child });
    if (!hanging) setTimeout(() => { child.stdout.write(output); child.stderr.write(stderr); child.emit('close', code); }, delay);
    return child;
  };
}
async function noTemporary(directory) { assert.equal((await fsp.readdir(directory)).filter(name => name.startsWith('termforge-key-')).length, 0); }

test('creates an encrypted Ed25519 key through private native prompts without argument/environment secrets', async t => {
  const observed = [];
  const { service, destination, directory } = await fixture(t, {
    spawn(executable, args, options) { observed.push({ executable, args, options }); return spawn(executable, args, options); },
    spawnPty(executable, args, options) { observed.push({ executable, args, options }); return require('node-pty').spawn(executable, args, options); },
  });
  const result = await service.generate({ type: 'ed25519', comment: 'fixture; $(touch never)', passphrase });
  assert.equal(result.encrypted, true); assert.equal(result.privatePath, destination); assert.equal(result.publicPath, `${destination}.pub`); assert.match(result.fingerprint, /^SHA256:/u);
  const bytes = await fsp.readFile(destination);
  assert.ok(utils.parseKey(bytes) instanceof Error); const key = utils.parseKey(bytes, passphrase); assert.ok(!(key instanceof Error)); assert.equal(key.type, 'ssh-ed25519');
  const publicKey = utils.parseKey(await fsp.readFile(`${destination}.pub`)); assert.ok(publicKey.getPublicSSH().equals(key.getPublicSSH()));
  assert.equal(observed.length, 1); const [call] = observed;
  if (process.platform === 'win32') assert.equal(call.options.useConpty, true);
  else { assert.equal(call.options.shell, false); assert.equal(call.options.detached, true); }
  assert.equal(call.options.env.SSH_ASKPASS_REQUIRE, 'never');
  assert.equal(call.options.env.DISPLAY, undefined); assert.equal(call.options.env.WAYLAND_DISPLAY, undefined); assert.equal(call.options.env.SSH_ASKPASS, undefined);
  assert.ok(!JSON.stringify(call).includes(passphrase)); assert.ok(!call.args.includes('-N') && !call.args.includes('-P'));
  if (process.platform !== 'win32') assert.equal((await fsp.stat(destination)).mode & 0o777, 0o600);
  await noTemporary(directory);
});

test('generates RSA 3072 with encryption and a matching public key', async t => {
  const { service, destination } = await fixture(t);
  await service.generate({ type: 'rsa', comment: '', passphrase });
  const key = utils.parseKey(await fsp.readFile(destination), passphrase); assert.ok(!(key instanceof Error)); assert.equal(key.type, 'ssh-rsa');
  assert.equal(createPublicKey(key.getPublicPEM()).asymmetricKeyDetails.modulusLength, 3072);
  assert.ok(utils.parseKey(await fsp.readFile(`${destination}.pub`)).getPublicSSH().equals(key.getPublicSSH()));
});

test('unencrypted key generation requires explicit opt-in and a native approval', async t => {
  const declined = await fixture(t);
  await assert.rejects(declined.service.generate({ type: 'ed25519', comment: '', passphrase: '' }), /explicitly/u);
  assert.deepEqual(await declined.service.generate({ type: 'ed25519', comment: '', passphrase: '', allowUnencrypted: true }), { canceled: true });
  await assert.rejects(fsp.stat(declined.destination), { code: 'ENOENT' });
  let approvals = 0;
  const accepted = await fixture(t, { approve: async input => { approvals++; assert.match(input.message, /Anyone/u); return true; } });
  const result = await accepted.service.generate({ type: 'ed25519', comment: '', passphrase: '', allowUnencrypted: true });
  assert.equal(approvals, 1); assert.equal(result.encrypted, false); assert.ok(!(utils.parseKey(await fsp.readFile(accepted.destination)) instanceof Error));
});

test('converts a PEM key to encrypted OpenSSH, preserves identity and never changes the source', async t => {
  const { service, destination, source, directory } = await fixture(t);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  await fsp.writeFile(source, pair.privateKey, { mode: 0o600 });
  const result = await service.convert({ oldPassphrase: '', newPassphrase: passphrase }); assert.equal(result.encrypted, true);
  assert.equal(await fsp.readFile(source, 'utf8'), pair.privateKey);
  const output = await fsp.readFile(destination); assert.match(output.toString('ascii'), /^-----BEGIN OPENSSH PRIVATE KEY-----/u);
  assert.ok(utils.parseKey(output) instanceof Error); assert.ok(utils.parseKey(output, passphrase).getPublicSSH().equals(utils.parseKey(pair.privateKey).getPublicSSH()));
  await noTemporary(directory);
});

test('converts an encrypted OpenSSH key with a new passphrase, leaving its source untouched', async t => {
  const { service, destination, source } = await fixture(t);
  const pair = utils.generateKeyPairSync('ed25519', { cipher: 'aes256-cbc', passphrase: 'original fixture secret' });
  await fsp.writeFile(source, pair.private, { mode: 0o600 });
  await service.convert({ oldPassphrase: 'original fixture secret', newPassphrase: passphrase });
  assert.equal(await fsp.readFile(source, 'utf8'), pair.private);
  const output = await fsp.readFile(destination); assert.ok(utils.parseKey(output, 'original fixture secret') instanceof Error); assert.ok(!(utils.parseKey(output, passphrase) instanceof Error));
});

test('incorrect source passphrase fails before destination selection or launching OpenSSH', async t => {
  const { service, source, calls, directory } = await fixture(t, { spawn: () => assert.fail('Must not launch ssh-keygen for a bad source passphrase') });
  await fsp.writeFile(source, utils.generateKeyPairSync('ed25519', { cipher: 'aes256-cbc', passphrase }).private, { mode: 0o600 });
  await assert.rejects(service.convert({ oldPassphrase: 'wrong passphrase', newPassphrase: 'another fixture secret' }), /Cannot read/u);
  assert.equal(calls.length, 0); await noTemporary(directory);
});

test('rejects private or public destination collisions without modifying existing files', async t => {
  for (const suffix of ['', '.pub']) {
    const { service, destination } = await fixture(t, { spawn: () => assert.fail('Must not launch for a destination collision') });
    await fsp.writeFile(`${destination}${suffix}`, 'existing fixture content');
    await assert.rejects(service.generate({ type: 'ed25519', comment: '', passphrase }), /already exists/u);
    assert.equal(await fsp.readFile(`${destination}${suffix}`, 'utf8'), 'existing fixture content');
  }
});

test('exclusive pair write handles a last-moment public-file collision and removes only its own empty reservation', async t => {
  const { destination } = await fixture(t);
  await fsp.writeFile(`${destination}.pub`, 'raced fixture');
  await assert.rejects(writeKeyPair(destination, Buffer.from('private fixture'), 'public fixture'), /already exists/u);
  assert.equal(await fsp.readFile(`${destination}.pub`, 'utf8'), 'raced fixture');
  await assert.rejects(fsp.stat(destination), { code: 'ENOENT' });
});

test('symbolic source and destination files are refused', { skip: process.platform === 'win32' }, async t => {
  const { service, directory, source, destination } = await fixture(t);
  const real = path.join(directory, 'real-key'); await fsp.writeFile(real, utils.generateKeyPairSync('ed25519').private, { mode: 0o600 });
  await fsp.symlink(real, source);
  await assert.rejects(service.convert({ oldPassphrase: '', newPassphrase: passphrase }), /symbolic link/u);
  await fsp.symlink(real, destination);
  await assert.rejects(service.generate({ type: 'ed25519', comment: '', passphrase }), /already exists/u);
});

test('canceling a native path picker creates nothing and does not launch OpenSSH', async t => {
  const { service, directory } = await fixture(t, { dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) }, spawn: () => assert.fail('No subprocess after cancellation') });
  assert.deepEqual(await service.generate({ type: 'ed25519', comment: '', passphrase }), { canceled: true });
  assert.deepEqual(await service.convert({ oldPassphrase: '', newPassphrase: passphrase }), { canceled: true });
  assert.deepEqual(await fsp.readdir(directory), []);
});

test('invalid options and newline passphrases are rejected before subprocess or dialogs', () => {
  for (const input of [{ type: 'rsa', comment: '', passphrase: 'short' }, { type: 'ed25519', comment: '', passphrase: 'fixture\nsecret' }, { type: 'ed25519', comment: '', passphrase: 'fixture\x03secret' }, { type: 'ed25519', comment: '', passphrase: '😀'.repeat(260) }, { type: 'dsa', comment: '', passphrase }, { type: 'rsa', comment: 'injected\ncomment', passphrase }, { type: 'rsa', comment: '', passphrase, destination: '/unreviewed' }, { type: 'rsa', comment: '', passphrase, allowUnencrypted: 'yes' }]) assert.throws(() => validateRequest(input, false));
});

test('keygen failures discard diagnostic details and clean temporary source copies', async t => {
  const { service, directory, destination } = await fixture(t, { spawn: fakeChild({ code: 1, stderr: 'synthetic private content must not leak' }) });
  await assert.rejects(service.generate({ type: 'ed25519', comment: '', passphrase }), error => { assert.ok(!error.message.includes('synthetic')); return /could not complete/u.test(error.message); });
  await assert.rejects(fsp.stat(destination), { code: 'ENOENT' }); await noTemporary(directory);
});

test('a tool that fails to encrypt the key cannot save an unencrypted result', async t => {
  const unencrypted = utils.generateKeyPairSync('ed25519');
  const { service, destination, directory } = await fixture(t, { spawn: fakeChild({ observe: ({ args }) => { if (args) require('node:fs').writeFileSync(args[args.indexOf('-f') + 1], unencrypted.private, { mode: 0o600 }); } }) });
  await assert.rejects(service.generate({ type: 'ed25519', comment: '', passphrase }), /did not encrypt/u);
  await assert.rejects(fsp.stat(destination), { code: 'ENOENT' }); await noTemporary(directory);
});

test('agent list reads only SHA256 public fingerprints and never mutates the agent', async t => {
  const observed = [];
  const { service } = await fixture(t, { spawn: fakeChild({ output: '256 SHA256:abcdef012345 fixture key (ED25519)\nmalformed entry\n', observe: value => observed.push(value) }) });
  assert.deepEqual(await service.agentList(), { available: true, keys: [{ bits: 256, fingerprint: 'SHA256:abcdef012345', comment: 'fixture key', type: 'ED25519' }], message: 'Public fingerprints from the current OpenSSH agent. Adding and removing identities remains in your system SSH tools.' });
  assert.deepEqual(observed[0].args, ['-l', '-E', 'sha256']); assert.equal(observed[0].options.shell, false);
});

test('agent list distinguishes an empty agent from an unavailable one', async t => {
  const empty = await fixture(t, { spawn: fakeChild({ code: 1 }) }); assert.equal((await empty.service.agentList()).available, true);
  const absent = await fixture(t, { spawn: fakeChild({ code: 2 }) }); assert.equal((await absent.service.agentList()).available, false);
});

test('subprocess timeout and shutdown terminate owned tools and release the busy guard', async t => {
  let kills = 0;
  const { service } = await fixture(t, { timeoutMs: 20, spawn: fakeChild({ hanging: true, observe: entry => { if (entry.signal) kills++; } }) });
  const timed = service.agentList(); await assert.rejects(service.agentList(), /already running/u); await assert.rejects(timed, /did not finish/u); assert.equal(kills, 1);
  const active = service.agentList(); await new Promise(resolve => setTimeout(resolve, 5)); service.close(); await assert.rejects(active, /closing/u); assert.equal(kills, 2);
  await assert.rejects(service.agentList(), /closing/u);
});

test('registers only the bounded operations for the trusted IPC registrar', async t => {
  const handlers = new Map(); await fixture(t, { register: (name, fn) => handlers.set(name, fn) });
  assert.deepEqual([...handlers.keys()], ['keyToolsGenerate', 'keyToolsConvert', 'keyToolsAgentList']);
});

test('close drains delayed temporary-key cleanup before releasing the active count', async t => {
  let removing, resumeRemoval, cleanupDirectory;
  const cleanupEntered = new Promise(resolve => { removing = resolve; });
  const cleanupReleased = new Promise(resolve => { resumeRemoval = resolve; });
  const { service, directory } = await fixture(t, {
    spawn: fakeChild({ code: 1, observe: ({ args }) => { if (args) require('node:fs').writeFileSync(args[args.indexOf('-f') + 1], 'temporary synthetic key', { mode: 0o600 }); } }),
    removeTemporary: async temporary => { cleanupDirectory = temporary; removing(); await cleanupReleased; await fsp.rm(temporary, { recursive: true, force: true }); },
  });
  const result = service.generate({ type: 'ed25519', comment: '', passphrase }).catch(error => error);
  await cleanupEntered; assert.equal(service.count, 1); assert.ok((await fsp.stat(cleanupDirectory)).isDirectory());
  let drained = false;
  const closing = service.close().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(drained, false); assert.equal(service.count, 1);
  resumeRemoval(); await closing; await result;
  assert.equal(drained, true); assert.equal(service.count, 0); await noTemporary(directory);
});

test('close does not wait indefinitely for native pickers and ignores their late resolution', async t => {
  let releasePicker, entered;
  const pickerEntered = new Promise(resolve => { entered = resolve; });
  const picker = new Promise(resolve => { releasePicker = resolve; });
  const { service, destination, directory } = await fixture(t, { dialog: { showSaveDialog: () => { entered(); return picker; } }, spawn: () => assert.fail('No key generation after shutdown') });
  const result = service.generate({ type: 'ed25519', comment: '', passphrase }).catch(error => error);
  await pickerEntered; assert.equal(service.count, 1);
  await service.close(); assert.equal(service.count, 0); assert.match((await result).message, /closing/u);
  releasePicker({ canceled: false, filePath: destination });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.deepEqual(await fsp.readdir(directory), []);
});

test('close reports failed temporary-file cleanup instead of silently declaring it complete', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'termforge-key-cleanup-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const service = createKeyTools({ tempRoot: directory,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(directory, 'chosen-key') }) },
    spawn: fakeChild({ code: 1 }), spawnPty: null, removeTemporary: async () => { throw new Error('Synthetic cleanup failure'); },
  });
  await assert.rejects(service.generate({ type: 'ed25519', comment: '', passphrase }), /temporary files could not be removed/u);
  assert.equal(service.count, 0);
  await assert.rejects(service.close(), /temporary files could not be removed/u);
});

function privatePtyFixture({ timeoutMs = 1000, autoExitOnKill = true, killProcess } = {}) {
  const events = new EventEmitter(), writes = [], calls = [], controller = new AbortController(); let kills = 0;
  const child = { onData: callback => { events.on('data', callback); return { dispose: () => events.off('data', callback) }; }, onExit: callback => { events.on('exit', callback); return { dispose: () => events.off('exit', callback) }; }, write: value => writes.push(value), kill: () => { kills++; if (autoExitOnKill) queueMicrotask(() => events.emit('exit', { exitCode: 1 })); } };
  const start = responses => runPrivateKeyPty({ spawnPty: (...args) => { calls.push(args); return child; }, executable: '/synthetic/ssh-keygen', args: ['-q', '-p'], cwd: '/synthetic', env: { SSH_ASKPASS_REQUIRE: 'never' }, responses, timeoutMs, signal: controller.signal, killProcess });
  return { start, child, events, writes, calls, controller, get kills() { return kills; } };
}

test('private Windows prompts handle fragmented control sequences and send one answer only after each complete prompt', async () => {
  const fixture = privatePtyFixture();
  const result = fixture.start([{ prompt: 'old', value: 'old fixture secret' }, { prompt: 'new', value: passphrase }, { prompt: 'same', value: passphrase }]);
  assert.deepEqual(fixture.writes, []);
  fixture.events.emit('data', '\x1b[?25lEnter old pass'); assert.deepEqual(fixture.writes, []);
  fixture.events.emit('data', 'phrase: \x1b[?25h'); assert.deepEqual(fixture.writes, ['old fixture secret\r']);
  fixture.events.emit('data', '\r\nEnter new passphrase (empty for no passphrase): '); assert.equal(fixture.writes.length, 2);
  fixture.events.emit('data', '\r\nEnter same passphrase again: '); assert.equal(fixture.writes.length, 3);
  fixture.events.emit('exit', { exitCode: 0 }); assert.deepEqual(await result, { code: 0, output: '' });
  assert.ok(!JSON.stringify(fixture.calls).includes(passphrase)); assert.equal(fixture.calls[0][2].useConpty, true);
  assert.equal(fixture.events.listenerCount('data'), 0); assert.equal(fixture.events.listenerCount('exit'), 0);
});

test('private Windows generation accepts both OpenSSH prompt spellings and ConPTY cursor-rendered trailing blanks', async () => {
  for (const prompt of ['Enter passphrase (empty for no passphrase): ', 'Enter passphrase for "C:\\fixture\\private-key" (empty for no passphrase): ', 'Enter passphrase (empty for no passphrase):\x1b[1C']) {
    const fixture = privatePtyFixture(); const result = fixture.start([{ prompt: 'new', value: '' }, { prompt: 'same', value: '' }]);
    fixture.events.emit('data', prompt); fixture.events.emit('data', '\r\nEnter same passphrase again:\x1b[1C'); fixture.events.emit('exit', { exitCode: 0 });
    await result; assert.deepEqual(fixture.writes, ['\r', '\r']);
  }
});

test('a wrong private prompt never receives a secret and times out with no diagnostic disclosure', async () => {
  const fixture = privatePtyFixture({ timeoutMs: 15 }); const result = fixture.start([{ prompt: 'old', value: passphrase }]);
  fixture.events.emit('data', 'synthetic private diagnostic\r\nEnter same passphrase again: ');
  await assert.rejects(result, error => /did not finish/u.test(error.message) && !error.message.includes('synthetic'));
  assert.deepEqual(fixture.writes, []); assert.equal(fixture.kills, 1);
});

test('private prompt shutdown waits for the actual ConPTY exit and ignores later prompt output', async () => {
  const fixture = privatePtyFixture({ autoExitOnKill: false }); let finished = false;
  const result = fixture.start([{ prompt: 'new', value: passphrase }]).catch(error => { finished = true; return error; });
  fixture.controller.abort(); fixture.events.emit('data', 'Enter passphrase (empty for no passphrase): ');
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(finished, false); assert.equal(fixture.kills, 1); assert.deepEqual(fixture.writes, []);
  fixture.events.emit('exit', { exitCode: 1 }); assert.match((await result).message, /closing/u);
});

test('private prompt output is bounded and a successful exit with unanswered prompts cannot succeed', async () => {
  const fixture = privatePtyFixture(); const result = fixture.start([{ prompt: 'new', value: passphrase }]);
  fixture.events.emit('data', 'x'.repeat(128 * 1024 + 1)); await assert.rejects(result, /too much output/u); assert.equal(fixture.kills, 1); assert.deepEqual(fixture.writes, []);
  const early = privatePtyFixture(); const earlyResult = early.start([{ prompt: 'new', value: passphrase }]); early.events.emit('exit', { exitCode: 0 }); await assert.rejects(earlyResult, /could not complete/u);
});

test('private prompt subscription failures kill the child and await its exit before releasing the operation', async () => {
  for (const broken of ['onData', 'onExit']) {
    const fixture = privatePtyFixture({ autoExitOnKill: false }); let finished = false;
    fixture.child[broken] = () => { throw new Error('Synthetic subscription failure'); };
    fixture.child.on = (_event, callback) => fixture.events.on('legacy-exit', callback);
    fixture.child.removeListener = (_event, callback) => fixture.events.off('legacy-exit', callback);
    const result = fixture.start([{ prompt: 'new', value: passphrase }]).catch(error => { finished = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(finished, false); assert.equal(fixture.kills, 1); assert.deepEqual(fixture.writes, []);
    if (broken === 'onData') fixture.events.emit('exit', { exitCode: 1 }); else fixture.events.emit('legacy-exit', 1);
    assert.match((await result).message, /Could not initialize/u); assert.equal(fixture.events.listenerCount('legacy-exit'), 0);
  }
});

test('silent private Windows children are force-terminated before first output and drained on timeout or shutdown', async () => {
  for (const cause of ['timeout', 'shutdown']) {
    const terminated = [];
    const fixture = privatePtyFixture({ timeoutMs: 15, autoExitOnKill: false, killProcess: (pid, signal) => { terminated.push([pid, signal]); queueMicrotask(() => fixture.events.emit('exit', { exitCode: 1 })); } });
    fixture.child.pid = 424242; // Synthetic owned PID; the injected killer never touches OS processes.
    const result = fixture.start([{ prompt: 'new', value: passphrase }]);
    if (cause === 'shutdown') fixture.controller.abort();
    await assert.rejects(result, cause === 'timeout' ? /did not finish/u : /closing/u);
    assert.deepEqual(terminated, [[424242, 'SIGKILL']]); assert.equal(fixture.kills, 1); assert.deepEqual(fixture.writes, []);
    fixture.controller.abort(); fixture.events.emit('data', 'Enter passphrase (empty for no passphrase): ');
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(terminated.length, 1);
  }
});
