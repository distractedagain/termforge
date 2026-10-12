'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSession, validateSettings, buildLaunch, createStore } = require('../app/core.cjs');
function storeFor(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-options-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return { directory, store: createStore(directory) }; }

test('serial/TCP profiles validate device options and never fall through to an SSH process', () => {
  assert.equal(validateSession({ name: 'Console', protocol: 'serial', serial: { path: '/dev/cu.example', baudRate: '115200', dataBits: '8', stopBits: '1', parity: 'none', flowControl: 'rtscts' } }).serial.baudRate, 115200);
  assert.equal(validateSession({ name: 'Legacy', host: 'localhost', protocol: 'telnet' }).port, 23);
  assert.equal(validateSession({ name: 'TCP', host: '[::1]', protocol: 'raw', port: 1234 }).host, '::1');
  assert.throws(() => validateSession({ protocol: 'serial' }), /Serial device/);
  assert.throws(() => validateSession({ protocol: 'serial', serial: { path: 'COM1', baudRate: 0 } }), /Baud/);
  assert.throws(() => validateSession({ protocol: 'serial', serial: { path: 'COM1', dataBits: 9 } }), /Data bits/);
  assert.throws(() => buildLaunch({ protocol: 'raw', host: 'localhost' }), /socket transport/);
});

test('SSH advanced fields produce discrete OpenSSH options while keeping explicit host checking', () => {
  const launch = buildLaunch({ name: 'Server', host: 'example.test', ssh: { compression: true, keepAliveInterval: 45, keepAliveCountMax: 5, connectTimeout: 10, authMethod: 'publickey', agentForwarding: true, x11Forwarding: true, certificateFile: '/keys/certificate with spaces.pub', remoteCommand: 'printf "hello world"', ciphers: ['aes256-gcm@openssh.com'], keyExchanges: ['curve25519-sha256'], macs: ['hmac-sha2-256'] }, terminal: { terminalType: 'vt100' } });
  for (const arg of ['StrictHostKeyChecking=ask', 'Compression=yes', 'ServerAliveInterval=45', 'ServerAliveCountMax=5', 'ConnectTimeout=10', 'PreferredAuthentications=publickey', 'CertificateFile=/keys/certificate with spaces.pub', 'Ciphers=aes256-gcm@openssh.com', 'KexAlgorithms=curve25519-sha256', 'MACs=hmac-sha2-256', '-A', 'ForwardX11=yes']) assert.ok(launch.args.includes(arg), arg);
  assert.deepEqual(launch.args.slice(-3), ['--', 'example.test', 'printf "hello world"']);
  assert.equal(launch.options.env.TERM, 'vt100');
  for (const ssh of [{ compression: 'yes' }, { ciphers: ['-oProxyCommand=id'] }, { ciphers: ['aes256-ctr,none'] }, { keepAliveInterval: -1 }, { authMethod: 'custom command' }, { remoteCommand: 'x\u0000y' }]) assert.throws(() => validateSession({ host: 'example.test', ssh }));
});

test('version one configurations migrate on read without modifying existing bytes', t => {
  const { directory, store } = storeFor(t);
  const filename = path.join(directory, 'config.json');
  const old = JSON.stringify({ version: 1, sessions: [{ id: 'legacy', name: 'Legacy', host: 'example.test' }], settings: { theme: 'dark', fontSize: 16, scrollback: 1000 }, snippets: [{ id: 'cmd', name: 'Version', command: 'show version' }] });
  fs.writeFileSync(filename, old);
  const state = store.load();
  assert.equal(state.version, 2); assert.equal(state.sessions[0].ssh.connectTimeout, 15); assert.equal(state.snippets[0].buttonBar, 'Default'); assert.equal(state.settings.fontSize, 16); assert.deepEqual(state.snapshots, []);
  assert.equal(fs.readFileSync(filename, 'utf8'), old);
  store.saveSettings({ cursorStyle: 'underline' });
  assert.equal(JSON.parse(fs.readFileSync(filename)).version, 2);
  assert.equal(store.load().sessions[0].host, 'example.test');
});

test('bulk edits validate everything before writing and preserve untouched sessions', t => {
  const { directory, store } = storeFor(t);
  store.saveSessions([{ id: 'one', name: 'One', host: 'one.test' }, { id: 'two', name: 'Two', host: 'two.test' }]);
  const before = fs.readFileSync(path.join(directory, 'config.json'), 'utf8');
  assert.throws(() => store.saveSessions([{ id: 'one', name: 'Changed', host: 'one.test' }, { id: 'two', host: '-oBad' }]));
  assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'), before);
  store.saveSessions([{ ...store.load().sessions.find(s => s.id === 'one'), folder: 'Production', terminal: { fontSize: 18 } }]);
  assert.equal(store.load().sessions.find(s => s.id === 'one').terminal.fontSize, 18);
  assert.equal(store.load().sessions.find(s => s.id === 'two').folder, '');
});

test('snapshots preserve source references on import collisions and clean deleted profiles', t => {
  const { store } = storeFor(t);
  store.saveSession({ id: 'one', name: 'One', host: 'one.test' });
  store.saveSnapshots([{ id: 'workspace', name: 'Work', sessionIds: ['one'], layout: { tile: true, orientation: 'vertical', activeSessionId: 'one' } }]);
  const config = store.exportConfig();
  const imported = store.importConfig(config);
  const importedProfile = imported.sessions.find(s => s.name === 'One' && s.id !== 'one');
  const importedSnapshot = imported.snapshots.find(s => s.id !== 'workspace');
  assert.deepEqual(importedSnapshot.sessionIds, [importedProfile.id]);
  assert.equal(importedSnapshot.layout.activeSessionId, importedProfile.id);
  assert.throws(() => store.saveSnapshots([{ name: 'Invalid', sessionIds: ['absent'], layout: {} }]), /unknown session/);
  store.deleteSession('one');
  assert.deepEqual(store.load().snapshots.find(s => s.id === 'workspace').sessionIds, []);
  assert.equal(store.load().snapshots.find(s => s.id === 'workspace').layout.activeSessionId, '');
});

test('command history is bounded, configurable, and exported independently of authentication input', t => {
  const { store } = storeFor(t);
  store.saveSettings({ commandHistoryLimit: 2 });
  assert.deepEqual(store.saveCommandHistory(['first', 'second', 'third']).commandHistory, ['second', 'third']);
  store.saveSettings({ commandHistoryLimit: 0 });
  assert.deepEqual(store.load().commandHistory, []);
  store.saveCommandHistory(['new command']);
  assert.deepEqual(store.load().commandHistory, []);
  assert.throws(() => store.saveCommandHistory(['invalid\u0000']), /History command/);
});

test('terminal preferences and literal keyword rules reject unsupported or malformed values', () => {
  const settings = validateSettings({ keywords: [{ text: '<img onerror=evil>', caseSensitive: true, foreground: '#112233', background: '#aabbcc' }], scrollback: 128000, copyOnSelect: true, fontSize: 32 });
  assert.equal(settings.keywords[0].text, '<img onerror=evil>'); assert.equal(settings.copyOnSelect, true);
  for (const value of [{ cursorStyle: 'custom' }, { keywordHighlightEnabled: 'yes' }, { keywords: [{ text: 'x', background: 'url(https://example.test)' }] }, { keywords: [{ text: 'x', regex: true }] }]) assert.throws(() => validateSettings(value));
  assert.throws(() => validateSession({ host: 'example.test', terminal: { encoding: 'arbitrary' } }), /unsupported/);
});
