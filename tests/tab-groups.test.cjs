'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The pure renderer model has no relative imports. Load its source explicitly
// as ESM without changing the CommonJS application package's module type.
const modelModule = import(`data:text/javascript;base64,${fs.readFileSync(path.join(__dirname, '../renderer/tab-groups.js')).toString('base64')}`);

async function workspace() {
  const { createTabGroups } = await modelModule;
  const model = createTabGroups();
  for (const id of ['a', 'b', 'c', 'd']) model.add(id);
  model.activate('b');
  model.split('d', model.groupFor('b').id, 'vertical');
  model.add('e');
  model.split('e', model.groupFor('d').id, 'horizontal');
  model.tree.ratio = 0.3; model.tree.second.ratio = 0.65;
  return model;
}
function assertWorkspace(model, ids) {
  const layout = model.getLayout();
  const tabs = layout.groups.flatMap(group => group.tabs);
  assert.equal(new Set(tabs).size, tabs.length, 'each tab occurs once');
  assert.deepEqual([...tabs].sort(), [...ids].sort());
  for (const group of layout.groups) assert.ok(group.tabs.includes(group.activeId), 'each group selects one of its tabs');
  const leaves = [];
  function visit(node) {
    if (!node) return;
    if (node.groupId) { leaves.push(node.groupId); return; }
    assert.ok(['vertical', 'horizontal'].includes(node.direction));
    assert.ok(node.ratio >= 0.1 && node.ratio <= 0.9);
    assert.ok(node.first && node.second, 'split nodes have two children');
    visit(node.first); visit(node.second);
  }
  visit(layout.tree);
  assert.equal(new Set(leaves).size, leaves.length, 'each group occurs once in the tree');
  assert.deepEqual(leaves, layout.groups.map(group => group.id));
  assert.equal(model.activeId, layout.groups.find(group => group.id === layout.activeGroupId)?.activeId || null);
  if (!ids.length) assert.deepEqual({ groups: layout.groups, tree: layout.tree, activeGroupId: layout.activeGroupId }, { groups: [], tree: null, activeGroupId: '' });
}
function savedLayout() {
  return {
    orientation: 'grid', activeGroupId: 'bottom',
    groups: [{ id: 'left', tabs: ['first', 'second'], activeId: 'second' }, { id: 'right', tabs: ['third'], activeId: 'third' }, { id: 'bottom', tabs: ['fourth'], activeId: 'fourth' }],
    tree: { direction: 'vertical', ratio: 0.4, first: { groupId: 'left' }, second: { direction: 'horizontal', ratio: 0.7, first: { groupId: 'right' }, second: { groupId: 'bottom' } } },
  };
}

test('group selection is independent, and nested splits preserve every connection', async () => {
  const model = await workspace();
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(model.groupFor('a').activeId, 'b');
  assert.equal(model.groupFor('d').activeId, 'd');
  assert.equal(model.activeId, 'e');
  model.activate('c');
  assert.equal(model.groupFor('a').activeId, 'c');
  assert.equal(model.groupFor('d').activeId, 'd');
  assert.equal(model.groupFor('e').activeId, 'e');
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e']);
  const snapshot = model.getLayout(); snapshot.groups[0].tabs.push('mutated'); snapshot.tree.ratio = 0.8;
  assert.equal(model.tree.ratio, 0.3);
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e']);
});

test('moving tabs preserves order and collapses an emptied group without changing retained ratios', async () => {
  const model = await workspace();
  const left = model.groupFor('a').id;
  assert.equal(model.move('e', left, 'b'), true);
  assert.deepEqual(model.groupFor('a').tabs, ['a', 'e', 'b', 'c']);
  assert.equal(model.tree.ratio, 0.3);
  assert.equal(model.tree.second.groupId, model.groupFor('d').id);
  assert.equal(model.activeId, 'e');
  assert.equal(model.move('c', left, 'a'), true);
  assert.deepEqual(model.groupFor('a').tabs, ['c', 'a', 'e', 'b']);
  assert.equal(model.move('c', left, 'c'), false);
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e']);
});

test('moving a sole tab beside another group moves its pane without leaving a ghost group', async () => {
  const model = await workspace();
  const oldGroup = model.groupFor('e').id;
  assert.equal(model.split('e', model.groupFor('a').id, 'horizontal'), true);
  assert.equal(model.groupById(oldGroup), undefined);
  assert.equal(model.tree.first.direction, 'horizontal');
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e']);
  const before = model.getLayout();
  assert.equal(model.split('e', model.groupFor('e').id, 'vertical'), false);
  assert.equal(model.split('a', model.groupFor('a').id, 'diagonal'), false);
  assert.equal(model.move('missing', model.groupFor('a').id), false);
  assert.deepEqual(model.getLayout(), before);
});

test('replacing a reconnected tab retains its group, position, selection and geometry', async () => {
  const model = await workspace();
  model.activate('b');
  const before = model.getLayout(); const oldGroup = model.groupFor('b').id;
  assert.equal(model.replace('b', 'reconnected'), true);
  model.remove('b');
  assert.equal(model.groupFor('reconnected').id, oldGroup);
  assert.deepEqual(model.groupFor('reconnected').tabs, ['a', 'reconnected', 'c']);
  assert.equal(model.activeId, 'reconnected');
  assert.deepEqual(model.tree, before.tree);
  assert.equal(model.replace('reconnected', 'd'), false);
  assert.equal(model.replace('missing', 'extra'), false);
  assertWorkspace(model, ['a', 'reconnected', 'c', 'd', 'e']);
});

test('closing tabs repairs only the affected selections and eventually clears the entire workspace', async () => {
  const model = await workspace();
  model.activate('d');
  model.remove('b');
  assert.equal(model.activeId, 'd'); assert.equal(model.groupFor('a').activeId, 'c');
  model.remove('d');
  assert.ok(['a', 'c', 'e'].includes(model.activeId));
  assertWorkspace(model, ['a', 'c', 'e']);
  for (const id of ['a', 'c', 'e']) model.remove(id);
  assertWorkspace(model, []);
  model.add('fresh'); assertWorkspace(model, ['fresh']);
});

test('collapse and tile retain tab order and global selection', async () => {
  const model = await workspace();
  model.activate('b'); model.collapse();
  assert.deepEqual(model.ordered()[0].tabs, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(model.activeId, 'b');
  for (const direction of ['horizontal', 'vertical', 'grid']) {
    model.tile(direction);
    assert.equal(model.getLayout().orientation, direction);
    assert.equal(model.activeId, 'b');
    assert.equal(model.ordered().length, 5);
    assertWorkspace(model, ['a', 'b', 'c', 'd', 'e']);
  }
  model.collapse(); assert.equal(model.activeId, 'b');
  assert.deepEqual(model.ordered()[0].tabs, ['a', 'b', 'c', 'd', 'e']);
});

test('restoring a snapshot preserves preexisting group geometry and selections while adding separate groups', async () => {
  const model = await workspace();
  model.move('c', model.groupFor('d').id); model.activate('c');
  const previous = model.getLayout();
  const saved = savedLayout(); const savedBefore = structuredClone(saved);
  for (const id of ['new-1', 'new-2', 'new-3', 'new-4']) model.add(id);
  assert.equal(model.restore(saved, new Map([['first', 'new-1'], ['second', 'new-2'], ['third', 'new-3'], ['fourth', 'new-4']]), previous), true);
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e', 'new-1', 'new-2', 'new-3', 'new-4']);
  assert.deepEqual(model.tree.first, previous.tree);
  for (const group of previous.groups) assert.deepEqual(model.groupById(group.id), group);
  assert.equal(model.groupFor('new-1').activeId, 'new-2');
  assert.equal(model.activeId, 'new-4');
  assert.equal(model.tree.second.ratio, 0.4); assert.equal(model.tree.second.second.ratio, 0.7);
  assert.deepEqual(saved, savedBefore);
});

test('partial restore prunes failed and already closed tabs while retaining the surviving split ratio', async () => {
  const model = await workspace(); const previous = model.getLayout();
  for (const id of ['new-1', 'closed', 'new-3', 'new-4']) model.add(id);
  model.remove('closed');
  const saved = savedLayout(); saved.groups[0].tabs = ['second'];
  const restored = model.restore(saved, new Map([['first', 'failed'], ['second', 'closed'], ['third', 'new-3'], ['fourth', 'new-4']]), previous);
  assert.equal(restored, true);
  assert.equal(model.tree.second.direction, 'horizontal'); assert.equal(model.tree.second.ratio, 0.7);
  assert.equal(model.groupFor('closed'), undefined); assert.equal(model.groupFor('failed'), undefined);
  assert.equal(model.activeId, 'new-4');
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e', 'new-1', 'new-3', 'new-4']);
});

test('a wholly failed restore leaves the existing workspace unchanged', async () => {
  const model = await workspace(); const before = model.getLayout();
  assert.equal(model.restore(savedLayout(), new Map([['first', 'absent']])), false);
  assert.deepEqual(model.getLayout(), before);
  assertWorkspace(model, ['a', 'b', 'c', 'd', 'e']);
});

test('restoring into an empty workspace recreates incoming groups after provisional tabs are removed', async () => {
  const { createTabGroups } = await modelModule; const model = createTabGroups();
  const before = model.getLayout();
  model.add('one'); model.add('two');
  assert.equal(model.restore(savedLayout(), new Map([['third', 'one'], ['fourth', 'two']]), before), true);
  assert.equal(model.tree.direction, 'horizontal'); assert.equal(model.tree.ratio, 0.7);
  assert.equal(model.activeId, 'two'); assertWorkspace(model, ['one', 'two']);
});

test('a deterministic sequence of workspace edits never loses, duplicates or strands a tab', async () => {
  const { createTabGroups } = await modelModule; const model = createTabGroups();
  const ids = new Set(); let nextId = 0; let seed = 71231;
  const random = length => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % length; };
  for (let step = 0; step < 600; step++) {
    const action = ids.size ? random(8) : 0;
    const tabs = [...ids]; const groups = model.ordered(); const chosen = tabs[random(tabs.length || 1)];
    if (action === 0 && ids.size < 24) { const id = `instance-${++nextId}`; ids.add(id); model.add(id); }
    else if (action === 1) { ids.delete(chosen); model.remove(chosen); }
    else if (action === 2) model.activate(chosen);
    else if (action === 3) { const target = groups[random(groups.length)]; model.move(chosen, target.id, target.tabs[random(target.tabs.length)]); }
    else if (action === 4) model.split(chosen, groups[random(groups.length)].id, random(2) ? 'vertical' : 'horizontal');
    else if (action === 5) model.tile(['vertical', 'horizontal', 'grid'][random(3)]);
    else if (action === 6) model.collapse();
    else if (action === 7) {
      const replacement = `instance-${++nextId}`; assert.equal(model.replace(chosen, replacement), true);
      ids.delete(chosen); ids.add(replacement); model.remove(chosen);
    }
    assertWorkspace(model, [...ids]);
  }
});
