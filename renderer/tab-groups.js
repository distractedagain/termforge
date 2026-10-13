// Workspace geometry is separate from terminal processes. Moving a tab only
// changes its group; the renderer keeps its existing terminal and DOM nodes.
export function createTabGroups() {
  let sequence = 0;
  let groups = [];
  let tree = null;
  let activeGroupId = '';
  let orientation = 'grid';
  const freshId = () => `group-${++sequence}`;
  const groupFor = id => groups.find(group => group.tabs.includes(id));
  const groupById = id => groups.find(group => group.id === id);
  const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));
  const prune = node => {
    if (!node) return null;
    if (node.groupId) return groupById(node.groupId)?.tabs.length ? node : null;
    const first = prune(node.first); const second = prune(node.second);
    return first && second ? { ...node, first, second } : first || second;
  };
  const leaves = (node, ids = []) => {
    if (node?.groupId) ids.push(node.groupId);
    else if (node) { leaves(node.first, ids); leaves(node.second, ids); }
    return ids;
  };
  function tidy() {
    groups = groups.filter(group => group.tabs.length);
    for (const group of groups) if (!group.tabs.includes(group.activeId)) group.activeId = group.tabs[0];
    tree = prune(tree);
    if (!groupById(activeGroupId)) activeGroupId = leaves(tree)[0] || '';
  }
  function activate(id) {
    const group = groupFor(id);
    if (!group) return false;
    group.activeId = id; activeGroupId = group.id;
    return true;
  }
  function add(id) {
    if (groupFor(id)) return;
    let group = groupById(activeGroupId) || groups[0];
    if (!group) { group = { id: freshId(), tabs: [], activeId: id }; groups.push(group); tree = { groupId: group.id }; }
    group.tabs.push(id); activate(id);
  }
  function remove(id) {
    const group = groupFor(id);
    if (!group) return;
    const index = group.tabs.indexOf(id);
    group.tabs.splice(index, 1);
    if (group.activeId === id) group.activeId = group.tabs[Math.min(index, group.tabs.length - 1)] || '';
    tidy();
  }
  function replace(oldId, id) {
    const group = groupFor(oldId);
    if (!group || groupFor(id)) return false;
    group.tabs.splice(group.tabs.indexOf(oldId), 1, id);
    if (group.activeId === oldId) group.activeId = id;
    return true;
  }
  function move(id, targetId, beforeId = null) {
    const source = groupFor(id); const target = groupById(targetId);
    if (!source || !target || beforeId === id) return false;
    const index = source.tabs.indexOf(id);
    source.tabs.splice(index, 1);
    if (source.activeId === id) source.activeId = source.tabs[Math.min(index, source.tabs.length - 1)] || '';
    const targetIndex = target.tabs.indexOf(beforeId);
    target.tabs.splice(targetIndex < 0 ? target.tabs.length : targetIndex, 0, id);
    activate(id); tidy();
    return true;
  }
  function split(id, targetId, direction) {
    const source = groupFor(id); const target = groupById(targetId);
    if (!source || !target || source === target && source.tabs.length < 2) return false;
    if (!['horizontal', 'vertical'].includes(direction)) return false;
    remove(id);
    const group = { id: freshId(), tabs: [id], activeId: id };
    groups.push(group);
    const insert = node => node.groupId === target.id
      ? { direction, ratio: 0.5, first: node, second: { groupId: group.id } }
      : node.groupId ? node : { ...node, first: insert(node.first), second: insert(node.second) };
    tree = insert(tree); orientation = direction; activate(id);
    return true;
  }
  function ordered() { return leaves(tree).map(groupById).filter(Boolean); }
  function collapse() {
    const tabs = ordered().flatMap(group => group.tabs);
    const current = groupById(activeGroupId)?.activeId;
    if (!tabs.length) return;
    const group = { id: activeGroupId || freshId(), tabs, activeId: tabs.includes(current) ? current : tabs[0] };
    groups = [group]; tree = { groupId: group.id }; activeGroupId = group.id;
  }
  function tile(direction = 'grid') {
    const tabs = ordered().flatMap(group => group.tabs);
    const current = groupById(activeGroupId)?.activeId;
    orientation = ['horizontal', 'vertical', 'grid'].includes(direction) ? direction : 'grid';
    groups = tabs.map(id => ({ id: freshId(), tabs: [id], activeId: id }));
    function divide(items, axis) {
      if (!items.length) return null;
      if (items.length === 1) return { groupId: items[0].id };
      const cut = Math.ceil(items.length / 2);
      return { direction: axis, ratio: cut / items.length, first: divide(items.slice(0, cut), axis), second: divide(items.slice(cut), axis) };
    }
    if (orientation === 'grid' && groups.length) {
      const columns = Math.ceil(Math.sqrt(groups.length)); const rows = [];
      for (let start = 0; start < groups.length; start += columns) rows.push(divide(groups.slice(start, start + columns), 'vertical'));
      const joinRows = items => {
        if (items.length === 1) return items[0];
        const cut = Math.ceil(items.length / 2);
        return { direction: 'horizontal', ratio: cut / items.length, first: joinRows(items.slice(0, cut)), second: joinRows(items.slice(cut)) };
      };
      tree = joinRows(rows);
    } else tree = divide(groups, orientation === 'horizontal' ? 'horizontal' : 'vertical');
    activeGroupId = groupFor(current)?.id || groups[0]?.id || '';
  }
  function restore(layout, idMap, previousLayout = null) {
    const used = new Set(); const groupIds = new Map(); const incoming = [];
    for (const saved of layout.groups || []) {
      const tabs = (saved.tabs || []).map(id => idMap.get(id)).filter(id => id && groupFor(id) && !used.has(id) && used.add(id));
      if (!tabs.length) continue;
      const id = freshId(); groupIds.set(saved.id, id);
      incoming.push({ id, tabs, activeId: tabs.includes(idMap.get(saved.activeId)) ? idMap.get(saved.activeId) : tabs[0] });
    }
    if (!incoming.length) return false;
    const seenLeaves = new Set(); const seenNodes = new Set();
    const readTree = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 64 || seenNodes.has(node)) return null;
      seenNodes.add(node);
      if (node.groupId) {
        if (!groupIds.has(node.groupId) || seenLeaves.has(node.groupId)) return null;
        seenLeaves.add(node.groupId); return { groupId: groupIds.get(node.groupId) };
      }
      const first = readTree(node.first, depth + 1); const second = readTree(node.second, depth + 1);
      return first && second ? { direction: node.direction === 'horizontal' ? 'horizontal' : 'vertical', ratio: Math.max(0.1, Math.min(0.9, Number(node.ratio) || 0.5)), first, second } : first || second;
    };
    let restoredTree = readTree(layout.tree);
    const listed = new Set(leaves(restoredTree));
    for (const group of incoming) if (!listed.has(group.id)) restoredTree = restoredTree ? { direction: 'vertical', ratio: 0.5, first: restoredTree, second: { groupId: group.id } } : { groupId: group.id };
    for (const id of used) remove(id);
    for (const saved of previousLayout?.groups || []) {
      const existing = groupById(saved.id);
      if (existing?.tabs.includes(saved.activeId)) existing.activeId = saved.activeId;
    }
    groups.push(...incoming);
    tree = tree ? { direction: 'vertical', ratio: 0.5, first: tree, second: restoredTree } : restoredTree;
    activeGroupId = groupIds.get(layout.activeGroupId) || incoming[0].id;
    orientation = ['vertical', 'horizontal', 'grid'].includes(layout.orientation) ? layout.orientation : 'grid';
    tidy(); return true;
  }
  return {
    add, remove, replace, activate, move, split, collapse, tile, restore, ordered, groupFor, groupById,
    get activeId() { return groupById(activeGroupId)?.activeId || null; },
    get tree() { return tree; },
    getLayout() { return { tile: groups.length > 1, orientation, groups: clone(ordered()), tree: clone(tree), activeGroupId }; },
  };
}
