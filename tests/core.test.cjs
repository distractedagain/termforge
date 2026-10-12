'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateSession, validateSettings, validateSnippets, buildLaunch, parseSecureCRTIni, createStore } = require('../app/core.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-core-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function ssh(overrides = {}) { return { name: 'Router', protocol: 'ssh', host: 'router.example.com', ...overrides }; }

test('SSH validation rejects option injection and malformed structured fields', () => {
  for (const host of ['-oProxyCommand=touch /tmp/file', 'host; touch /tmp/file', 'user@host', 'host\nother', 'https://example.com', '-example.com', 'bad..host']) assert.throws(() => validateSession(ssh({ host })), /Host/);
  for (const value of ['-oProxyCommand=id', 'user@host -oStrictHostKeyChecking=no', 'one,two', 'host:0', 'host:65536']) assert.throws(() => validateSession(ssh({ jumpHost: value })), /Jump/);
  for (const value of ['-lroot', 'user@host', 'root;whoami', 'root\nother']) assert.throws(() => validateSession(ssh({ username: value })), /Username/);
  assert.throws(() => validateSession(ssh({ password: 'secret' })), /unsupported field: password/);
  assert.throws(() => validateSession(ssh({ folder: '../elsewhere' })), /Folder/);
  assert.throws(() => validateSession(ssh({ port: Infinity })), /Port/);
  assert.throws(() => validateSession(ssh({ protocol: 'telnet' })), /protocol/);
  assert.throws(() => validateSession(ssh({ forwardings: [{ type: 'local', listenPort: 8080, targetHost: 'x', targetPort: 80 }, { type: 'dynamic', listenPort: 8080 }] })), /Duplicate/);
});

test('launches use independent arguments, strict host-key prompts, isolated configuration and loopback forwards', () => {
  const launch = buildLaunch(ssh({ username: 'operator', host: '2001:db8::1', port: '2222', identityFile: '/keys/key with spaces', jumpHost: 'admin@[2001:db8::2]:2200', forwardings: [
    { type: 'local', listenPort: 8080, targetHost: '2001:db8::3', targetPort: 80 },
    { type: 'remote', listenPort: 9000, targetHost: 'localhost', targetPort: 9001 },
    { type: 'dynamic', listenPort: 1080 },
  ] }), { platform: 'linux', env: { HOME: '/home/test', PATH: '/usr/bin' }, cwd: '/home/test' });
  assert.equal(launch.file, 'ssh');
  assert.ok(launch.args.includes('StrictHostKeyChecking=ask'));
  assert.deepEqual(launch.args.slice(0, 2), ['-F', 'none']);
  assert.ok(launch.args.includes('/keys/key with spaces'));
  assert.ok(launch.args.includes('admin@[2001:db8::2]:2200'));
  assert.ok(launch.args.includes('127.0.0.1:8080:[2001:db8::3]:80'));
  assert.ok(launch.args.includes('127.0.0.1:9000:localhost:9001'));
  assert.ok(launch.args.includes('127.0.0.1:1080'));
  assert.deepEqual(launch.args.slice(-2), ['--', '2001:db8::1']);
  assert.equal(launch.options.env.TERM, 'xterm-256color');
  assert.equal(launch.options.env.PATH, '/usr/bin');
});

test('SFTP and local launch contracts work on supported operating systems', () => {
  const sftp = buildLaunch(ssh({ protocol: 'sftp', host: '[::1]', username: 'alice', port: 2200 }), { platform: 'win32', env: {}, cwd: 'C:\\Users\\Alice' });
  assert.equal(sftp.file, 'sftp.exe');
  assert.ok(sftp.args.includes('-P'));
  assert.deepEqual(sftp.args.slice(-2), ['--', 'alice@[::1]']);
  const windows = buildLaunch({ protocol: 'local' }, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, cwd: 'C:\\Users\\Alice' });
  assert.equal(windows.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(windows.args, ['/Q']);
  const mac = buildLaunch({ protocol: 'local', cwd: '~' }, { platform: 'darwin', env: { HOME: '/Users/alice', SHELL: '/bin/zsh' } });
  assert.equal(mac.file, '/bin/zsh');
  assert.equal(mac.options.cwd, path.normalize('/Users/alice'));
  const linux = buildLaunch({ protocol: 'local' }, { platform: 'linux', env: { SHELL: 'malformed shell' }, cwd: '/home/alice' });
  assert.equal(linux.file, '/bin/bash');
  assert.throws(() => validateSession(ssh({ protocol: 'sftp', forwardings: [{ type: 'dynamic', listenPort: 1080 }] })), /SSH sessions only/);
});

test('SecureCRT INI reader imports plain SSH2 metadata and excludes credentials and scripts', () => {
  const profile = parseSecureCRTIni('\uFEFFS:"Protocol Name"=SSH2\r\nS:"Hostname"=192.0.2.10\r\nS:"Username"=operator\r\nD:"[SSH2] Port"=000008ae\r\nS:"Identity Filename"=/home/operator/.ssh/id_ed25519\r\nS:"Password V2"=encrypted-secret\r\nS:"Login Script"=bad.vbs\r\nS:"Description"=potential secret\r\n', { name: 'Switch', folder: 'Network/Switches' });
  assert.equal(profile.host, '192.0.2.10');
  assert.equal(profile.port, 2222);
  assert.equal(profile.username, 'operator');
  assert.equal(profile.folder, 'Network/Switches');
  assert.equal(profile.description, '');
  assert.equal(profile.identityFile, '/home/operator/.ssh/id_ed25519');
  assert.ok(!JSON.stringify(profile).includes('secret'));
  assert.ok(!JSON.stringify(profile).includes('bad.vbs'));
  assert.equal(parseSecureCRTIni('S:"Protocol Name"=Telnet\nS:"Hostname"=device'), null);
  assert.throws(() => parseSecureCRTIni('S:"Protocol Name"=SSH2\nS:"Hostname"=-oProxyCommand=id'), /Host/);
  assert.throws(() => parseSecureCRTIni('S:"Protocol Name"=SSH2\nS:"Hostname"=one\nS:"Hostname"=two'), /Duplicate/);
  assert.throws(() => parseSecureCRTIni('S:"Protocol Name"=SSH2\nS:"Hostname"=one\nD:"Port"=invalid'), /port/);
  assert.throws(() => parseSecureCRTIni('S:"Protocol Name"=SSH2'), /hostname/);
});

test('settings and snippets are allowlisted and bounded', () => {
  assert.deepEqual(validateSettings({}), { theme: 'light', fontSize: 14, scrollback: 5000 });
  assert.throws(() => validateSettings({ theme: 'neon' }), /Theme/);
  assert.throws(() => validateSettings({ fontSize: 1000 }), /Font size/);
  assert.throws(() => validateSettings({ remoteScript: 'x' }), /unsupported/);
  assert.deepEqual(validateSnippets([{ id: 'example', name: 'Directory', command: 'pwd' }]), [{ id: 'example', name: 'Directory', command: 'pwd' }]);
  assert.throws(() => validateSnippets([{ name: 'Run', command: 'x', password: 'secret' }]), /unsupported/);
  assert.throws(() => validateSnippets([{ name: 'Empty', command: '' }]), /required/);
  assert.throws(() => validateSnippets([{ id: 'same', name: 'One', command: 'one' }, { id: 'same', name: 'Two', command: 'two' }]), /unique/);
});

test('store saves atomic private state without mutating input or exposing private keys', t => {
  const directory = temporary(t);
  const store = createStore(directory);
  const initial = store.load();
  assert.equal(initial.sessions[0].protocol, 'local');
  assert.equal(fs.existsSync(path.join(directory, 'config.json')), false);
  const profile = ssh({ id: 'router-one', identityFile: '/keys/private-key' });
  const saved = store.saveSession(profile);
  assert.equal(saved.sessions.length, 2);
  assert.equal(profile.color, undefined);
  store.saveSession(ssh({ id: 'router-one', name: 'Updated' }));
  store.saveSettings({ fontSize: 18 });
  store.saveSnippets([{ name: 'Version', command: 'uname -a' }]);
  const exported = store.exportConfig();
  assert.equal(exported.sessions.length, 2);
  assert.equal(exported.sessions[1].name, 'Updated');
  assert.equal(exported.settings.fontSize, 18);
  assert.equal(exported.settings.theme, 'light');
  exported.sessions[0].name = 'Mutated';
  assert.equal(store.load().sessions[0].name, 'Local shell');
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, 'config.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  const deleted = store.deleteSession('router-one');
  assert.equal(deleted.sessions.length, 1);
});

test('imports validate the complete payload before mutation and retain colliding profiles', t => {
  const directory = temporary(t);
  const store = createStore(directory);
  store.saveSession(ssh({ id: 'router-one' }));
  const before = fs.readFileSync(path.join(directory, 'config.json'), 'utf8');
  assert.throws(() => store.importConfig({ version: 1, sessions: [ssh({ id: 'valid' }), ssh({ host: '-oBad' })] }), /Host/);
  assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'), before);
  assert.throws(() => store.importConfig({ version: 2, sessions: [] }), /version/);
  assert.throws(() => store.importConfig({ sessions: [], credentials: {} }), /unsupported/);
  const imported = store.importConfig({ version: 1, sessions: [ssh({ id: 'router-one', name: 'Imported router' })] });
  assert.equal(imported.sessions.length, 3);
  assert.equal(new Set(imported.sessions.map(item => item.id)).size, 3);
  assert.equal(imported.sessions[1].name, 'Router');
  assert.equal(imported.sessions[2].name, 'Imported router');
});

test('corrupt or unknown existing configuration blocks every save and remains intact', t => {
  const directory = temporary(t);
  const filename = path.join(directory, 'config.json');
  for (const content of ['not json', '{"version":100,"sessions":[]}', '{"version":1,"sessions":[],"settings":{},"snippets":[],"password":"secret"}']) {
    fs.writeFileSync(filename, content);
    const store = createStore(directory);
    assert.throws(() => store.load(), /left untouched/);
    assert.throws(() => store.saveSession(ssh()), /left untouched/);
    assert.throws(() => store.saveSettings({ fontSize: 16 }), /left untouched/);
    assert.equal(fs.readFileSync(filename, 'utf8'), content);
  }
});

test('store refuses to replace a symlink configuration', { skip: process.platform === 'win32' }, t => {
  const directory = temporary(t);
  const target = path.join(directory, 'original.json');
  fs.writeFileSync(target, JSON.stringify(createStore(path.join(directory, 'fresh')).load()));
  fs.symlinkSync(target, path.join(directory, 'config.json'));
  assert.throws(() => createStore(directory).saveSession(ssh()));
  assert.equal(JSON.parse(fs.readFileSync(target)).sessions.length, 1);
});
