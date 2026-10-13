'use strict';

const MAX_INSTANCES = 32;
const MAX_TREE_NODES = MAX_INSTANCES * 2 - 1;

function fail(message) { throw new Error(message); }
function object(input, label, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(`${label} must be an object.`);
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`${label} contains an unsupported field: ${key}.`);
}
function reference(value, label) {
  if (typeof value !== 'string' || value.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) fail(`${label} is invalid.`);
  return value;
}

// IDs in a workspace identify tab instances, independently of saved profiles.
// This keeps two connections to the same saved profile distinct on restore.
function validateInstanceLayout(input, sessionIds) {
  if (!Array.isArray(input.instances) || input.instances.length > MAX_INSTANCES) fail('Snapshot instances must contain at most 32 tabs.');
  const instanceIds = new Set();
  const referencedSessions = new Set();
  const instances = input.instances.map(item => {
    object(item, 'Snapshot instance', ['id', 'sessionId']);
    const instanceId = reference(item.id, 'Snapshot instance ID');
    if (instanceIds.has(instanceId)) fail('Snapshot instance IDs must be unique.');
    instanceIds.add(instanceId);
    const sessionId = reference(item.sessionId, 'Snapshot instance session');
    if (!sessionIds.includes(sessionId)) fail('Snapshot instance refers to a session not included in the snapshot.');
    referencedSessions.add(sessionId);
    return { id: instanceId, sessionId };
  });
  if (referencedSessions.size !== sessionIds.length) fail('Snapshot session IDs must exactly match its instance references.');

  const layout = input.layout;
  if (!Array.isArray(layout.groups) || layout.groups.length > MAX_INSTANCES) fail('Snapshot groups must contain at most 32 groups.');
  const groupIds = new Set();
  const assignedInstances = new Set();
  const groups = layout.groups.map(item => {
    object(item, 'Snapshot group', ['id', 'tabs', 'activeId']);
    const groupId = reference(item.id, 'Snapshot group ID');
    if (groupIds.has(groupId)) fail('Snapshot group IDs must be unique.');
    groupIds.add(groupId);
    if (!Array.isArray(item.tabs) || item.tabs.length === 0 || item.tabs.length > MAX_INSTANCES) fail('Snapshot groups must contain 1 to 32 tabs.');
    const tabs = item.tabs.map(value => {
      const instanceId = reference(value, 'Snapshot group tab');
      if (!instanceIds.has(instanceId)) fail('Snapshot group refers to an unknown instance.');
      if (assignedInstances.has(instanceId)) fail('Each snapshot instance must belong to exactly one group.');
      assignedInstances.add(instanceId);
      return instanceId;
    });
    const activeId = reference(item.activeId, 'Snapshot group active tab');
    if (!tabs.includes(activeId)) fail('Snapshot group active tab must belong to that group.');
    return { id: groupId, tabs, activeId };
  });
  if (assignedInstances.size !== instances.length) fail('Each snapshot instance must belong to exactly one group.');

  const treeGroups = new Set();
  const visited = new WeakSet();
  let nodeCount = 0;
  function visit(node, depth) {
    if (++nodeCount > MAX_TREE_NODES || depth > MAX_INSTANCES) fail('Snapshot layout tree exceeds its size limit.');
    object(node, 'Snapshot layout tree node', ['groupId', 'direction', 'ratio', 'first', 'second']);
    if (visited.has(node)) fail('Snapshot layout tree contains a repeated node or cycle.');
    visited.add(node);
    if (Object.hasOwn(node, 'groupId')) {
      object(node, 'Snapshot layout leaf', ['groupId']);
      const groupId = reference(node.groupId, 'Snapshot layout group');
      if (!groupIds.has(groupId)) fail('Snapshot layout tree refers to an unknown group.');
      if (treeGroups.has(groupId)) fail('Each snapshot group must occur exactly once in the layout tree.');
      treeGroups.add(groupId);
      return { groupId };
    }
    if (!['vertical', 'horizontal'].includes(node.direction)) fail('Snapshot split direction is invalid.');
    if (typeof node.ratio !== 'number' || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) fail('Snapshot split ratio must be a number from 0.1 to 0.9.');
    return { direction: node.direction, ratio: node.ratio, first: visit(node.first, depth + 1), second: visit(node.second, depth + 1) };
  }
  let tree = null;
  if (groups.length) tree = visit(layout.tree, 1);
  else if (layout.tree !== null) fail('An empty snapshot must have a null layout tree.');
  if (treeGroups.size !== groups.length) fail('Each snapshot group must occur exactly once in the layout tree.');

  const activeGroupId = groups.length ? reference(layout.activeGroupId, 'Snapshot active group') : layout.activeGroupId;
  if (groups.length ? !groupIds.has(activeGroupId) : activeGroupId !== '') fail('Snapshot active group must belong to the workspace.');
  const activeInstanceId = groups.find(group => group.id === activeGroupId)?.activeId;
  const activeSessionId = instances.find(instance => instance.id === activeInstanceId)?.sessionId || '';
  if (layout.activeSessionId !== undefined && layout.activeSessionId !== activeSessionId) fail('Snapshot active session must match its active tab.');
  return { instances, layout: { groups, tree, activeGroupId, activeSessionId } };
}

function pruneLayout(layout, allowedInstanceIds) {
  const keptInstances = new Set(allowedInstanceIds);
  const groups = layout.groups.flatMap(group => {
    const tabs = group.tabs.filter(tab => keptInstances.has(tab));
    if (!tabs.length) return [];
    return [{ ...group, tabs, activeId: tabs.includes(group.activeId) ? group.activeId : tabs[0] }];
  });
  const keptGroups = new Set(groups.map(group => group.id));
  function prune(node) {
    if (!node) return null;
    if (Object.hasOwn(node, 'groupId')) return keptGroups.has(node.groupId) ? { groupId: node.groupId } : null;
    const first = prune(node.first);
    const second = prune(node.second);
    if (!first || !second) return first || second;
    return { ...node, first, second };
  }
  const activeGroupId = keptGroups.has(layout.activeGroupId) ? layout.activeGroupId : groups[0]?.id || '';
  return { groups, tree: prune(layout.tree), activeGroupId };
}

function pruneSnapshotSession(snapshot, sessionId) {
  const sessionIds = snapshot.sessionIds.filter(value => value !== sessionId);
  if (!snapshot.instances) return { ...snapshot, sessionIds, layout: { ...snapshot.layout, activeSessionId: snapshot.layout.activeSessionId === sessionId ? '' : snapshot.layout.activeSessionId } };

  const instances = snapshot.instances.filter(instance => instance.sessionId !== sessionId);
  const { groups, tree, activeGroupId } = pruneLayout(snapshot.layout, instances.map(instance => instance.id));
  const activeId = groups.find(group => group.id === activeGroupId)?.activeId;
  const activeSessionId = instances.find(instance => instance.id === activeId)?.sessionId || '';
  return { ...snapshot, sessionIds, instances, layout: { ...snapshot.layout, groups, tree, activeGroupId, activeSessionId } };
}

module.exports = { validateInstanceLayout, pruneLayout, pruneSnapshotSession };
