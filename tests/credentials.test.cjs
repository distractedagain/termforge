'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCredentialVault } = require('../app/credentials.cjs');
const { createAuthPrompts } = require('../app/auth-prompts.cjs');
const { createStore, validateSession, buildLaunch } = require('../app/core.cjs');
const fingerprint = 'SHA256:' + crypto.createHash('sha256').update('synthetic-server').digest('base64').replace(/=+$/u, '');
const target = { host: 'example.test', port: 22 };
// A synthetic OS provider tests vault behavior, not a claim that native
// Keychain/DPAPI/keyring access has been exercised on this machine.
function provider() {
  const key = crypto.randomBytes(32);
  const api = { backend: 'gnome_libsecret', available: true, calls: 0,
    getSelectedStorageBackend: () => api.backend,
    isEncryptionAvailable: () => api.available,
    isAsyncEncryptionAvailable: async () => api.available,
    encryptString: value => { api.calls++; const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decryptString: value => { api.calls++; const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return cipher.update(value.subarray(28), undefined, 'utf8') + cipher.final('utf8'); },
  };
  api.encryptStringAsync = async value => api.encryptString(value);
  api.decryptStringAsync = async value => ({ result: api.decryptString(value), shouldReEncrypt: false });
  return api;
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const safeStorage = provider();
  const approvals = [];
  const vault = createCredentialVault({ directory, safeStorage, platform: 'darwin', confirmUse: async input => { approvals.push(input); return true; }, ...options });
  return { directory, safeStorage, approvals, vault };
}
const secret = { name: 'Lab access', username: 'synthetic-user', password: 'Synthetic-pa$$word-123!' };

test('real v0.8 configuration loads unchanged and saves new fields without losing profiles or snapshots', t => {
  const { directory } = fixture(t); const filename = path.join(directory, 'config.json');
  // Generated using the tagged v0.8.0 core module and synthetic session data.
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/config-v0.8.json'), 'utf8');
  fs.writeFileSync(filename, original);
  const store = createStore(directory); const migrated = store.load();
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  const prior = JSON.parse(original); const saved = migrated.sessions.find(item => item.id === 'upgrade-lab');
  assert.equal(saved.ssh.backend, 'openssh'); assert.equal(saved.credentialId, ''); assert.equal(saved.username, 'demo');
  assert.deepEqual(migrated.snapshots, prior.snapshots); assert.deepEqual(migrated.commandHistory, prior.commandHistory);
  store.saveSession({ ...saved, credentialId: 'new-local-vault', ssh: { ...saved.ssh, backend: 'managed', authMethod: 'auto' } });
  const loaded = store.load(); assert.equal(loaded.sessions.length, prior.sessions.length);
  assert.deepEqual(loaded.snapshots, prior.snapshots); assert.deepEqual(loaded.snippets, prior.snippets);
  const current = loaded.sessions.find(item => item.id === saved.id); assert.equal(current.username, ''); assert.equal(current.terminal.colorScheme, 'solarized-dark'); assert.equal(current.ssh.compression, true);
});

test('vault encrypts both username and password, returns metadata only, persists private ciphertext', async t => {
  const { directory, vault, approvals } = fixture(t);
  const saved = await vault.save(secret);
  assert.deepEqual(Object.keys(saved).sort(), ['id', 'name', 'updatedAt']);
  assert.deepEqual(await vault.list(), [saved]);
  const stored = fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8');
  assert(!stored.includes(secret.username)); assert(!stored.includes(secret.password)); assert(stored.includes(secret.name));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'credentials.json')).mode & 0o777, 0o600);
  assert.deepEqual(await vault.use(saved.id, target, { fingerprint }), { username: secret.username, password: secret.password });
  assert.equal(approvals.length, 1);
  await vault.use(saved.id, { ...target, host: 'EXAMPLE.TEST' }, { fingerprint }); assert.equal(approvals.length, 1);
  assert(!JSON.stringify(await vault.list()).includes(secret.username));
});
test('credential approvals bind hostname, port and verified key and persist across reopen', async t => {
  const { directory, vault, approvals, safeStorage } = fixture(t);
  const saved = await vault.save(secret);
  await vault.use(saved.id, target, { fingerprint });
  const again = createCredentialVault({ directory, safeStorage, platform: 'darwin', confirmUse: async input => { approvals.push(input); return true; } });
  await again.use(saved.id, target, { fingerprint }); assert.equal(approvals.length, 1);
  await again.use(saved.id, { ...target, port: 2222 }, { fingerprint });
  await again.use(saved.id, { ...target, host: 'other.test' }, { fingerprint });
  await again.use(saved.id, target, { fingerprint: 'SHA256:' + 'a'.repeat(43) });
  assert.equal(approvals.length, 4);
  await assert.rejects(again.use(saved.id, target), /verified SSH/);
});
test('denial and abort release no credential and create no host grant', async t => {
  let allow = false;
  const { vault, directory } = fixture(t, { confirmUse: async () => allow });
  const saved = await vault.save(secret); const original = fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8');
  await assert.rejects(vault.use(saved.id, target, { fingerprint }), /cancelled/);
  assert.equal(fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8'), original);
  allow = true; const controller = new AbortController(); controller.abort();
  await assert.rejects(vault.use(saved.id, target, { fingerprint, signal: controller.signal }), /cancelled/);
  assert.equal(fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8'), original);
});
test('replacement requires all secrets and clears grants; deletion does not require keychain access', async t => {
  const { vault, approvals, safeStorage } = fixture(t);
  const saved = await vault.save(secret); await vault.use(saved.id, target, { fingerprint });
  await assert.rejects(vault.save({ id: saved.id, name: 'Rename' }), /Username/);
  await vault.save({ ...secret, id: saved.id, password: 'replacement' });
  assert.equal((await vault.use(saved.id, target, { fingerprint })).password, 'replacement'); assert.equal(approvals.length, 2);
  safeStorage.available = false; assert.deepEqual(await vault.delete(saved.id), { deleted: true }); assert.deepEqual(await vault.list(), []);
});
test('Linux basic_text, unknown and unavailable providers fail closed without calling encrypt', async t => {
  const { directory, safeStorage } = fixture(t);
  const vault = createCredentialVault({ directory, safeStorage, platform: 'linux' });
  for (const backend of ['basic_text', 'unknown', 'future-unverified-provider']) {
    safeStorage.backend = backend;
    assert.equal((await vault.status()).available, false);
    await assert.rejects(vault.save(secret), /Secure OS storage/);
  }
  assert.equal(safeStorage.calls, 0); assert.equal(fs.existsSync(path.join(directory, 'credentials.json')), false);
  safeStorage.backend = 'gnome_libsecret'; const saved = await vault.save(secret);
  assert(saved.id); assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'credentials.json'))).entries[0].format, 'sync');
  safeStorage.backend = 'basic_text'; await assert.rejects(vault.use(saved.id, target, { fingerprint }), /Secure OS storage/);
});
test('failed encryption, corrupt data and moved ciphertext do not overwrite the vault or echo secrets', async t => {
  const { directory, vault, safeStorage } = fixture(t);
  const saved = await vault.save(secret); const filename = path.join(directory, 'credentials.json'); const original = fs.readFileSync(filename, 'utf8');
  safeStorage.encryptStringAsync = async () => { throw new Error(secret.password); };
  await assert.rejects(vault.save({ ...secret, id: saved.id }), error => !error.message.includes(secret.password) && /encrypt/.test(error.message));
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  const changed = JSON.parse(original); changed.entries[0].name = 'Changed label'; fs.writeFileSync(filename, JSON.stringify(changed));
  await assert.rejects(vault.use(saved.id, target, { fingerprint }), /could not unlock/);
  fs.writeFileSync(filename, secret.password); await assert.rejects(vault.list(), error => !error.message.includes(secret.password));
  assert.equal(fs.readFileSync(filename, 'utf8'), secret.password);
});
test('vault serializes concurrent writes without losing entries', async t => {
  const { vault } = fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => vault.save({ ...secret, name: `Entry ${index}` })));
  assert.equal((await vault.list()).length, 12);
});
test('vault refuses symbolic files and directories', { skip: process.platform === 'win32' }, async t => {
  const { directory, safeStorage } = fixture(t);
  const outside = path.join(directory, 'untouched'); fs.writeFileSync(outside, 'original');
  fs.symlinkSync(outside, path.join(directory, 'credentials.json'));
  const vault = createCredentialVault({ directory, safeStorage, platform: 'darwin' });
  await assert.rejects(vault.save(secret), /Cannot read/); assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
  const linked = path.join(directory, 'linked'); fs.symlinkSync(directory, linked);
  await assert.rejects(createCredentialVault({ directory: linked, safeStorage, platform: 'darwin' }).list(), /Cannot read/);
});
test('session configuration stores references only, strips usernames for credentials, and scrubs imported/exported refs', t => {
  const { directory } = fixture(t); const store = createStore(directory);
  const session = validateSession({ id: 'test-session', name: 'Lab', ...target, username: secret.username, credentialId: 'vault-entry', ssh: { backend: 'managed' } });
  assert.equal(session.username, ''); store.saveSession(session);
  assert.equal(store.load().sessions.find(item => item.id === session.id).credentialId, 'vault-entry');
  const exported = store.exportConfig(); assert.equal(exported.sessions.find(item => item.id === session.id).credentialId, '');
  store.importConfig({ sessions: [{ ...session, id: 'import-session' }] });
  assert.equal(store.load().sessions.find(item => item.id === 'import-session').credentialId, '');
  assert(!fs.readFileSync(path.join(directory, 'config.json'), 'utf8').includes(secret.username));
  assert.throws(() => validateSession({ ...session, password: secret.password }), /unsupported field/);
  assert.throws(() => validateSession({ ...session, ssh: { backend: 'openssh' } }), /managed/);
  assert.throws(() => buildLaunch(session), /system command/);
});
test('authentication broker keeps secrets out of emitted events and validates answer count', async () => {
  const events = []; const broker = createAuthPrompts({ send: (name, value) => events.push({ name, value }) });
  const waiting = broker.request({ ...target, kind: 'password', prompts: [{ prompt: 'Password', echo: false }] });
  const id = events[0].value.id;
  assert.throws(() => broker.respond({ id, answers: [] }), /Invalid/);
  assert.equal(broker.respond({ id, answers: [secret.password] }), true);
  assert.deepEqual(await waiting, [secret.password]); assert(!JSON.stringify(events).includes(secret.password));
  assert.equal(broker.respond({ id, answers: [secret.password] }), false);
});
test('authentication broker expires, aborts and closes pending prompts', async () => {
  const events = []; const broker = createAuthPrompts({ send: (name, value) => events.push({ name, value }), timeoutMs: 20 });
  const controller = new AbortController(); const input = { ...target, prompts: [{ prompt: 'Code', echo: false }] };
  const aborted = broker.request({ ...input, signal: controller.signal }); controller.abort(); assert.equal(await aborted, null);
  const closing = broker.request(input); broker.closeAll(); assert.equal(await closing, null);
  const expired = broker.request(input); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(await expired, null);
  assert.equal(events.filter(item => item.name === 'authPromptClosed').length, 3);
});
test('authentication cleanup completes even when the renderer disappears', async () => {
  let broken = true;
  const events = []; const broker = createAuthPrompts({ send: (name, value) => { if (broken) throw new Error('Renderer gone'); events.push({ name, value }); } });
  const input = { ...target, prompts: [{ prompt: 'Password', echo: false }] };
  assert.equal(await broker.request(input), null);
  broken = false; const waiting = broker.request(input); broken = true;
  broker.closeAll(); assert.equal(await waiting, null);
  assert.equal(broker.respond({ id: events[0].value.id, answers: [secret.password] }), false);
});
