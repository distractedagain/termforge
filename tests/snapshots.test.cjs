'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSnapshots, createStore } = require('../app/core.cjs');
const { pruneLayout } = require('../app/snapshot-layout.cjs');

const profiles = [{ id: 'one', name: 'One', host: 'one.test' }, { id: 'two', name: 'Two', host: 'two.test' }, { id: 'three', name: 'Three', host: 'three.test' }];
function workspace() {
  return {
    id: 'workspace', name: 'Operations', sessionIds: ['one', 'two', 'three'],
    instances: [{ id: 'first', sessionId: 'one' }, { id: 'clone', sessionId: 'one' }, { id: 'other', sessionId: 'two' }, { id: 'last', sessionId: 'three' }],
    layout: {
      tile: false, orientation: 'grid', activeSessionId: 'one', activeGroupId: 'right',
      groups: [{ id: 'left', tabs: ['first', 'other'], activeId: 'other' }, { id: 'right', tabs: ['clone'], activeId: 'clone' }, { id: 'bottom', tabs: ['last'], activeId: 'last' }],
      tree: { direction: 'vertical', ratio: 0.35, first: { groupId: 'left' }, second: { direction: 'horizontal', ratio: 0.7, first: { groupId: 'right' }, second: { groupId: 'bottom' } } },
    },
  };
}
function storeFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-snapshots-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createStore(directory);
  store.saveSessions(profiles);
  return { directory, store };
}

test('snapshots retain duplicate profile instances, per-group active tabs and split geometry through persistence and export', t => {
  const { store } = storeFor(t);
  const snapshot = workspace();
  const before = structuredClone(snapshot);
  const saved = store.saveSnapshots([snapshot]);
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.snapshots, [snapshot]);
  assert.deepEqual(store.load().snapshots, [snapshot]);
  assert.deepEqual(store.exportConfig().snapshots, [snapshot]);
  assert.deepEqual(snapshot, before);
  assert.equal(saved.snapshots[0].instances.filter(instance => instance.sessionId === 'one').length, 2);
});

test('legacy snapshots stay legacy when read and saved beside instance snapshots', t => {
  const { store } = storeFor(t);
  const legacy = { id: 'legacy', name: 'Old layout', sessionIds: ['one', 'two'], layout: { tile: true, orientation: 'horizontal', activeSessionId: 'two' } };
  assert.deepEqual(store.saveSnapshots([legacy, workspace()]).snapshots[0], legacy);
  assert.deepEqual(store.exportConfig().snapshots[0], legacy);
  assert.equal(Object.hasOwn(store.load().snapshots[0], 'instances'), false);
});

test('instance snapshots derive a missing active profile but reject a conflicting one', () => {
  const snapshot = workspace();
  delete snapshot.layout.activeSessionId;
  assert.equal(validateSnapshots([snapshot], profiles)[0].layout.activeSessionId, 'one');
  snapshot.layout.activeSessionId = 'two';
  assert.throws(() => validateSnapshots([snapshot], profiles), /active session must match/);
});

test('an empty instance workspace is explicit and cannot carry dangling groups or selection', () => {
  const empty = { id: 'empty', name: 'Empty', sessionIds: [], instances: [], layout: { tile: false, orientation: 'grid', groups: [], tree: null, activeGroupId: '', activeSessionId: '' } };
  assert.deepEqual(validateSnapshots([empty], profiles), [empty]);
  for (const patch of [{ tree: {} }, { activeGroupId: 'left' }, { groups: [{ id: 'left', tabs: [], activeId: '' }] }]) {
    assert.throws(() => validateSnapshots([{ ...empty, layout: { ...empty.layout, ...patch } }], profiles));
  }
});

test('snapshots reject missing, duplicated or misassigned instances and profile references', () => {
  const invalid = [
    ['duplicate instance ID', s => { s.instances[1].id = 'first'; }],
    ['missing instance ID', s => { delete s.instances[0].id; }],
    ['invalid instance ID', s => { s.instances[0].id = 'has spaces'; }],
    ['unknown saved profile', s => { s.sessionIds[0] = 'absent'; s.instances[0].sessionId = 'absent'; s.instances[1].sessionId = 'absent'; }],
    ['unlisted saved profile', s => { s.instances[0].sessionId = 'missing'; }],
    ['unused listed profile', s => { s.instances.pop(); s.layout.groups.pop(); s.layout.tree.second = { groupId: 'right' }; }],
    ['unassigned instance', s => { s.layout.groups[0].tabs = ['other']; }],
    ['instance in two groups', s => { s.layout.groups[1].tabs.push('first'); }],
    ['instance twice in one group', s => { s.layout.groups[0].tabs.push('first'); }],
    ['unknown instance in group', s => { s.layout.groups[0].tabs.push('absent'); }],
    ['active tab in another group', s => { s.layout.groups[0].activeId = 'clone'; }],
    ['missing active group', s => { s.layout.activeGroupId = 'absent'; }],
    ['duplicate group ID', s => { s.layout.groups[1].id = 'left'; }],
    ['empty group', s => { s.layout.groups.push({ id: 'empty', tabs: [], activeId: '' }); }],
  ];
  for (const [label, mutate] of invalid) {
    const snapshot = workspace(); mutate(snapshot);
    assert.throws(() => validateSnapshots([snapshot], profiles), undefined, label);
  }
});

test('snapshot trees reject missing groups, repeated groups, malformed splits and cycles', () => {
  const invalid = [
    ['missing tree', s => { delete s.layout.tree; }],
    ['null tree', s => { s.layout.tree = null; }],
    ['omitted group', s => { s.layout.tree = { groupId: 'left' }; }],
    ['unknown group', s => { s.layout.tree.first.groupId = 'absent'; }],
    ['duplicate group', s => { s.layout.tree.second.first.groupId = 'left'; }],
    ['hybrid leaf and split', s => { s.layout.tree.groupId = 'left'; }],
    ['invalid direction', s => { s.layout.tree.direction = 'diagonal'; }],
    ['ratio under range', s => { s.layout.tree.ratio = 0.09; }],
    ['ratio above range', s => { s.layout.tree.ratio = 0.91; }],
    ['non-finite ratio', s => { s.layout.tree.ratio = NaN; }],
    ['string ratio', s => { s.layout.tree.ratio = '0.5'; }],
    ['missing split child', s => { delete s.layout.tree.second; }],
    ['cyclic split', s => { s.layout.tree.first = s.layout.tree; }],
    ['aliased child', s => { s.layout.tree.second = s.layout.tree.first; }],
  ];
  for (const [label, mutate] of invalid) {
    const snapshot = workspace(); mutate(snapshot);
    assert.throws(() => validateSnapshots([snapshot], profiles), undefined, label);
  }
});

test('snapshot structures reject unsupported fields and invalid container types', () => {
  const invalid = [
    s => { s.password = 'ignored?'; }, s => { s.instances[0].password = 'ignored?'; },
    s => { s.layout.groups[0].position = 0; }, s => { s.layout.tree.first.label = 'extra'; },
    s => { s.layout.tree.extra = true; }, s => { s.layout.extra = true; },
    s => { s.instances = undefined; }, s => { s.instances = {}; },
    s => { s.layout.groups = {}; }, s => { s.layout.groups[0].tabs = 'first'; },
    s => { s.layout = null; }, s => { s.instances[0] = new Date(); },
    s => { delete s.instances; },
  ];
  for (const mutate of invalid) {
    const snapshot = workspace(); mutate(snapshot);
    assert.throws(() => validateSnapshots([snapshot], profiles));
  }
});

test('the largest supported workspace allows 32 duplicate instances and 63 tree nodes but no more', () => {
  const instances = Array.from({ length: 32 }, (_, index) => ({ id: `tab-${index}`, sessionId: 'one' }));
  const groups = instances.map((instance, index) => ({ id: `group-${index}`, tabs: [instance.id], activeId: instance.id }));
  let tree = { groupId: 'group-31' };
  for (let index = 30; index >= 0; index--) tree = { direction: index % 2 ? 'vertical' : 'horizontal', ratio: index % 2 ? 0.1 : 0.9, first: { groupId: `group-${index}` }, second: tree };
  const snapshot = { id: 'maximum', name: 'Maximum', sessionIds: ['one'], instances, layout: { groups, tree, activeGroupId: 'group-31' } };
  assert.equal(validateSnapshots([snapshot], profiles)[0].instances.length, 32);
  snapshot.instances.push({ id: 'excess', sessionId: 'one' });
  assert.throws(() => validateSnapshots([snapshot], profiles), /at most 32/);
  const tooDeep = workspace();
  let branch = tooDeep.layout.tree;
  for (let depth = 0; depth < 33; depth++) branch = { direction: 'vertical', ratio: 0.5, first: branch, second: { groupId: 'left' } };
  tooDeep.layout.tree = branch;
  assert.throws(() => validateSnapshots([tooDeep], profiles), /size limit/);
});

test('import collisions remap every profile reference while preserving tab IDs and geometry', t => {
  const { store } = storeFor(t);
  store.saveSnapshots([workspace()]);
  const exported = store.exportConfig();
  const before = structuredClone(exported);
  const imported = store.importConfig(exported);
  assert.deepEqual(exported, before);
  assert.deepEqual(imported.snapshots.find(s => s.id === 'workspace'), workspace());
  const copy = imported.snapshots.find(s => s.id !== 'workspace');
  const remapped = new Map(profiles.map(profile => [profile.id, imported.sessions.find(s => s.name === profile.name && s.id !== profile.id).id]));
  assert.deepEqual(copy.sessionIds, profiles.map(profile => remapped.get(profile.id)));
  assert.deepEqual(copy.instances, workspace().instances.map(instance => ({ ...instance, sessionId: remapped.get(instance.sessionId) })));
  assert.equal(copy.layout.activeSessionId, remapped.get('one'));
  assert.deepEqual(copy.layout.groups, workspace().layout.groups);
  assert.deepEqual(copy.layout.tree, workspace().layout.tree);
});

test('profile deletion removes every matching tab, collapses empty groups and repairs workspace selection', t => {
  const { store } = storeFor(t);
  store.saveSnapshots([workspace()]);
  const snapshot = store.deleteSession('one').snapshots[0];
  assert.deepEqual(snapshot.instances, [{ id: 'other', sessionId: 'two' }, { id: 'last', sessionId: 'three' }]);
  assert.deepEqual(snapshot.sessionIds, ['two', 'three']);
  assert.deepEqual(snapshot.layout.groups, [{ id: 'left', tabs: ['other'], activeId: 'other' }, { id: 'bottom', tabs: ['last'], activeId: 'last' }]);
  assert.deepEqual(snapshot.layout.tree, { direction: 'vertical', ratio: 0.35, first: { groupId: 'left' }, second: { groupId: 'bottom' } });
  assert.equal(snapshot.layout.activeGroupId, 'left');
  assert.equal(snapshot.layout.activeSessionId, 'two');
  store.deleteSession('two');
  assert.deepEqual(store.load().snapshots[0].layout.tree, { groupId: 'bottom' });
  const empty = store.deleteSession('three').snapshots[0];
  assert.deepEqual(empty.instances, []); assert.deepEqual(empty.sessionIds, []);
  assert.deepEqual(empty.layout.groups, []); assert.equal(empty.layout.tree, null);
  assert.equal(empty.layout.activeGroupId, ''); assert.equal(empty.layout.activeSessionId, '');
});

test('pruning keeps tab order and surviving nested geometry without mutating its inputs', () => {
  const snapshot = workspace();
  const before = structuredClone(snapshot);
  const layout = pruneLayout(snapshot.layout, new Set(['first', 'clone', 'last']));
  assert.deepEqual(layout.groups[0], { id: 'left', tabs: ['first'], activeId: 'first' });
  assert.equal(layout.activeGroupId, 'right');
  assert.deepEqual(layout.tree, snapshot.layout.tree);
  const collapsed = pruneLayout(snapshot.layout, ['clone', 'last']);
  assert.deepEqual(collapsed.tree, snapshot.layout.tree.second);
  assert.equal(collapsed.tree.ratio, 0.7);
  assert.deepEqual(pruneLayout(snapshot.layout, []), { groups: [], tree: null, activeGroupId: '' });
  assert.deepEqual(snapshot, before);
});

test('invalid snapshot updates and imports leave persisted configuration untouched', t => {
  const { store, directory } = storeFor(t);
  store.saveSnapshots([workspace()]);
  const before = fs.readFileSync(path.join(directory, 'config.json'), 'utf8');
  const invalid = workspace(); invalid.layout.tree.ratio = 2;
  assert.throws(() => store.saveSnapshots([invalid]), /ratio/);
  const imported = store.exportConfig(); imported.snapshots[0].instances[0].sessionId = 'absent';
  assert.throws(() => store.importConfig(imported), /not included/);
  assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'), before);
});
