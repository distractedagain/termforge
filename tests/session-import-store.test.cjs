'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, validateSession } = require('../app/core.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-import-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createStore(directory);
  store.saveSession({ id: 'existing', name: 'Router', host: 'old.example', protocol: 'ssh', ssh: { backend: 'managed' }, credentialId: 'synthetic-credential' });
  return { store, directory };
}
test('reviewed import replaces profile in place and preserves snapshots and latest unrelated settings', t => {
  const { store } = fixture(t);
  store.saveSnapshots([{ id: 'saved-workspace', name: 'Workspace', sessionIds: ['existing'], layout: { activeSessionId: 'existing' } }]);
  const before = store.load();
  store.saveSettings({ fontSize: 18 });
  const next = before.sessions.map(profile => profile.id === 'existing' ? validateSession({ ...profile, host: 'new.example', credentialId: '' }) : profile);
  next.push(validateSession({ id: 'new', name: 'New', protocol: 'ssh', host: 'new2.example' }));
  const result = store.commitImportedSessions(next, { expectedSessions: before.sessions });
  assert.equal(result.sessions.find(p => p.id === 'existing').host, 'new.example');
  assert.equal(result.sessions.find(p => p.id === 'existing').credentialId, '');
  assert.deepEqual(result.snapshots, before.snapshots);
  assert.equal(result.settings.fontSize, 18);
  assert.equal(result.sessions.length, before.sessions.length + 1);
});
test('stale import refuses to overwrite a concurrent session edit', t => {
  const { store, directory } = fixture(t);
  const before = store.load();
  store.saveSession({ ...before.sessions[1], host: 'edited.example' });
  const bytes = fs.readFileSync(path.join(directory, 'config.json'));
  assert.throws(() => store.commitImportedSessions(before.sessions, { expectedSessions: before.sessions }), /changed after preview/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'config.json')), bytes);
});
test('invalid, duplicate and removal import plans leave the complete configuration untouched', t => {
  const { store, directory } = fixture(t);
  const before = store.load();
  const bytes = fs.readFileSync(path.join(directory, 'config.json'));
  assert.throws(() => store.commitImportedSessions(before.sessions.slice(0,1), { expectedSessions: before.sessions }), /cannot remove/);
  assert.throws(() => store.commitImportedSessions([...before.sessions, before.sessions[1]], { expectedSessions: before.sessions }), /unique/);
  assert.throws(() => store.commitImportedSessions([...before.sessions, {name:'Broken',protocol:'ssh',host:'-bad'}], { expectedSessions: before.sessions }));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'config.json')), bytes);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});
