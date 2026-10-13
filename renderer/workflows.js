import { createIcon } from './icons.js';
import { pruneLayout } from '../app/snapshot-layout.cjs';

const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

export function createWorkflows(context) {
  const { api, getState, setState, getConnections, getActiveId, activate, openConnection, closeConnection, reconnect, sendCommand, showSnippets, setPane, confirmAction, toast, getSelection, setSelection, getLayout, setLayout, restoreLayout, renderSessions } = context;
  let manager = 'sessions';
  let selectedCommandId = null;
  let snapshotBusy = false;
  const collapsed = new Set();
  const state = () => getState();
  const current = () => getConnections().get(getActiveId());
  const report = (error) => toast(error.message || String(error), true);
  const attempt = (fn) => Promise.resolve().then(fn).catch(report);
  const dialog = (id) => { if (!$(id).open) $(id).showModal(); };
  function showManager(name) {
    manager = name;
    setPane('sessionManager', true);
    $('manager-title').textContent = { sessions: 'Session Manager', commands: 'Command Manager', active: 'Active Sessions' }[name];
    for (const key of ['sessions', 'commands', 'active']) {
      $(`${key}-manager-content`).hidden = key !== name;
      $(`dock-${key}`).classList.toggle('selected', key === name);
      $(`dock-${key}`).setAttribute('aria-pressed', String(key === name));
    }
    if (name === 'commands') renderCommands();
    if (name === 'active') renderActive();
  }
  function previewCommand(command) {
    context.clearCommandDraft?.();
    setPane('commandWindow', true); $('command-input').value = command.command; $('command-input').focus();
  }
  async function launchCommand(command) {
    previewCommand(command);
    await sendCommand();
  }
  function renderCommands() {
    const needle = $('command-filter').value.trim().toLowerCase();
    const commands = state().snippets.filter((command) => `${command.folder || ''} ${command.name}`.toLowerCase().includes(needle));
    const root = { name: 'Commands', path: '', folders: new Map(), commands: [] };
    for (const command of commands) {
      let branch = root;
      const parts = String(command.folder || '').split(/[\\/]/).filter(Boolean);
      for (let index = 0; index < parts.length; index += 1) {
        const path = parts.slice(0, index + 1).join('/');
        if (!branch.folders.has(parts[index])) branch.folders.set(parts[index], { name: parts[index], path, folders: new Map(), commands: [] });
        branch = branch.folders.get(parts[index]);
      }
      branch.commands.push(command);
    }
    const branchNode = (branch, depth) => {
      const group = make('div', 'session-group');
      const expanded = needle || !collapsed.has(branch.path);
      const heading = make('button', 'folder-heading'); heading.setAttribute('role', 'treeitem'); heading.setAttribute('aria-expanded', String(Boolean(expanded))); heading.setAttribute('aria-level', String(depth));
      heading.append(make('span', 'tree-chevron', expanded ? '▾' : '▸'), createIcon('folder', 'folder-icon'), make('span', 'folder-name', branch.name));
      heading.addEventListener('click', () => { if (collapsed.has(branch.path)) collapsed.delete(branch.path); else collapsed.add(branch.path); renderCommands(); }); group.append(heading);
      if (expanded) {
        const list = make('div', 'tree-children'); list.setAttribute('role', 'group');
        for (const child of [...branch.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) list.append(branchNode(child, depth + 1));
        for (const command of branch.commands) {
          const button = make('button', `command-manager-row${selectedCommandId === command.id ? ' selected' : ''}`); button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(depth + 1)); button.setAttribute('aria-selected', String(selectedCommandId === command.id)); button.dataset.commandId = command.id;
          const dot = make('span', 'command-color'); if (/^#[a-f0-9]{6}$/i.test(command.color || '')) dot.style.backgroundColor = command.color;
          button.append(dot, make('span', '', command.name)); button.title = command.command;
          button.addEventListener('click', () => { selectedCommandId = command.id; renderCommands(); previewCommand(command); $('command-manager-list').querySelector(`[data-command-id="${CSS.escape(command.id)}"]`)?.focus(); });
          button.addEventListener('dblclick', () => attempt(() => launchCommand(command)));
          button.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); attempt(() => launchCommand(command)); } });
          list.append(button);
        }
        group.append(list);
      }
      return group;
    };
    $('command-manager-list').replaceChildren(branchNode(root, 1));
    if (!commands.length) $('command-manager-list').append(make('p', 'sidebar-empty', needle ? 'No matching commands.' : 'Use + to add a command.'));
    $('command-run').disabled = !commands.some((command) => command.id === selectedCommandId) || ![...getConnections().values()].some((connection) => !connection.exited);
  }
  function renderActive() {
    const needle = $('active-filter').value.trim().toLowerCase();
    const rows = [];
    for (const connection of getConnections().values()) {
      if (!`${connection.title} ${connection.profile.host || ''}`.toLowerCase().includes(needle)) continue;
      const button = make('button', `active-session-row${connection.id === getActiveId() ? ' selected' : ''}`); button.setAttribute('role', 'treeitem'); button.dataset.connectionId = connection.id;
      button.setAttribute('aria-selected', String(connection.id === getActiveId()));
      button.append(make('span', `tab-dot ${connection.exited ? 'exited' : 'active'}`), make('span', 'active-session-name', connection.title));
      button.title = `${connection.protocol.toUpperCase()} · ${connection.exited ? 'Terminal ended' : 'Terminal open'}`;
      button.addEventListener('click', () => activate(connection.id)); button.addEventListener('dblclick', () => activate(connection.id)); rows.push(button);
    }
    const heading = make('div', 'folder-heading'); heading.append(make('span', 'tree-chevron', '▾'), createIcon('folder', 'folder-icon'), make('span', 'folder-name', `Sessions (${getConnections().size})`));
    $('active-manager-list').replaceChildren(heading, ...rows);
    for (const id of ['active-clone', 'active-close', 'active-reconnect']) $(id).disabled = !current();
  }
  function refresh() {
    renderCommands(); renderActive(); renderHistory();
    $('connect-suggestions').replaceChildren(...state().sessions.map((profile) => { const option = make('option'); option.value = profile.folder ? `${profile.folder}/${profile.name}` : profile.name; option.label = profile.host || profile.protocol; return option; }));
  }
  function renderHistory() {
    $('command-history').replaceChildren(make('option', '', 'Command history'));
    $('command-history').firstElementChild.value = '';
    for (const [index, command] of (state().commandHistory || []).entries()) {
      const option = make('option', '', command.replace(/[\r\n]+/g, ' ↵ ').slice(0, 120)); option.value = String(index); $('command-history').append(option);
    }
  }
  async function recordHistory(command) {
    const limit = Number(state().settings.commandHistoryLimit ?? 100);
    if (!limit) return;
    const history = [command, ...(state().commandHistory || []).filter((entry) => entry !== command)].slice(0, Math.min(limit, 200));
    const saved = await api.saveCommandHistory(history); setState({ commandHistory: saved }); renderHistory();
  }
  function openQuickConnect(options = {}) {
    return attempt(() => api.quickConnectOpen(options));
  }
  async function connectAddress() {
    const input = $('connect-address').value.trim(); if (!input) return;
    const sessionName = input.startsWith('/S ') ? input.slice(3).replace(/^"(.*)"$/, '$1') : input;
    const saved = state().sessions.find((profile) => profile.name === sessionName || `${profile.folder}/${profile.name}` === sessionName);
    if (saved) { await openConnection(saved); return; }
    let address;
    try { address = new URL(input.includes('://') ? input : `ssh://${input}`); } catch { toast('Enter a saved session name or host, such as ssh://user@example.com:22.', true); return; }
    const protocol = address.protocol.replace(':', '');
    if (!['ssh', 'sftp', 'telnet', 'raw'].includes(protocol)) { toast('Connect Bar supports SSH, SFTP, Telnet, and Raw TCP hosts.', true); return; }
    if (address.password || address.search || address.hash || !address.hostname || address.pathname && address.pathname !== '/') { toast('Use a host, username, and optional port. Passwords must be entered in the terminal.', true); return; }
    await openConnection({ name: address.hostname, protocol, host: address.hostname.replace(/^\[|\]$/g, ''), username: decodeURIComponent(address.username), port: address.port ? Number(address.port) : ['telnet', 'raw'].includes(protocol) ? 23 : 22, forwardings: [] });
  }
  function bulkOptions() {
    const profiles = state().sessions.filter((profile) => getSelection().has(profile.id)); if (profiles.length < 2) return false;
    $('bulk-form').reset(); $('bulk-description').textContent = `Edit ${profiles.length} selected sessions: ${profiles.map((profile) => profile.name).join(', ')}`; $('bulk-error').hidden = true; dialog('bulk-dialog'); return true;
  }
  async function saveBulk(event) {
    event.preventDefault();
    const targets = state().sessions.filter((profile) => getSelection().has(profile.id)).map((profile) => {
      const next = { ...profile, terminal: { ...profile.terminal } };
      if ($('bulk-folder-enable').checked) next.folder = $('bulk-folder').value.trim();
      if ($('bulk-user-enable').checked && ['ssh', 'sftp'].includes(profile.protocol)) next.username = $('bulk-user').value.trim();
      if ($('bulk-font-enable').checked) next.terminal.fontSize = Number($('bulk-font').value);
      if ($('bulk-color-enable').checked) next.terminal.colorScheme = $('bulk-color').value;
      return next;
    });
    if (!['folder', 'user', 'font', 'color'].some((key) => $(`bulk-${key}-enable`).checked)) { $('bulk-error').textContent = 'Check at least one setting to apply.'; $('bulk-error').hidden = false; return; }
    $('bulk-save').disabled = true;
    try { const sessions = await api.saveSessions(targets); setState({ sessions }); renderSessions(); refresh(); $('bulk-dialog').close(); toast(`${targets.length} sessions updated.`); }
    catch (error) { $('bulk-error').textContent = error.message || String(error); $('bulk-error').hidden = false; }
    finally { $('bulk-save').disabled = false; }
  }
  function renderSnapshots() {
    $('snapshot-list').replaceChildren();
    for (const snapshot of state().snapshots || []) {
      const row = make('div', 'snapshot-row');
      const count = snapshot.instances?.length ?? snapshot.sessionIds.length;
      const arrangement = snapshot.layout.groups ? `${snapshot.layout.groups.length} tab group${snapshot.layout.groups.length === 1 ? '' : 's'}` : snapshot.layout.tile ? snapshot.layout.orientation : 'tabs';
      const description = make('div'); description.append(make('strong', '', snapshot.name), make('span', 'field-note', `${count} connection${count === 1 ? '' : 's'} · ${arrangement}`));
      const load = make('button', 'secondary-button', 'Select'); load.addEventListener('click', () => selectSnapshot(snapshot));
      const connect = make('button', 'secondary-button', 'Connect…'); connect.addEventListener('click', () => attempt(() => connectSnapshot(snapshot)));
      const remove = make('button', 'icon-button', '×'); remove.setAttribute('aria-label', `Delete snapshot ${snapshot.name}`); remove.addEventListener('click', () => attempt(() => deleteSnapshot(snapshot)));
      row.append(description, load, connect, remove); $('snapshot-list').append(row);
    }
    if (!$('snapshot-list').children.length) $('snapshot-list').append(make('p', 'field-note', 'No snapshots saved.'));
  }
  async function deleteSnapshot(snapshot) {
    if (snapshotBusy) return;
    snapshotBusy = true;
    try {
      const accepted = await confirmAction({ title: 'Delete snapshot?', message: `Delete “${snapshot.name}”? Saved session profiles remain available.`, accept: 'Delete' });
      if (!accepted) return;
      const saved = await api.saveSnapshots((state().snapshots || []).filter((entry) => entry.id !== snapshot.id));
      setState({ snapshots: saved }); renderSnapshots();
    } finally { snapshotBusy = false; }
  }
  function selectSnapshot(snapshot) {
    const profiles = state().sessions.filter((profile) => snapshot.sessionIds.includes(profile.id));
    setSelection(profiles.map((profile) => profile.id)); renderSessions();
    const missing = snapshot.sessionIds.length - profiles.length;
    $('snapshot-status').textContent = `Selected ${profiles.length} profiles${missing ? `; ${missing} profiles are no longer available` : ''}. No connections were opened.`;
  }
  async function connectSnapshot(snapshot) {
    if (snapshotBusy) return;
    snapshotBusy = true;
    try {
      // Old snapshots contain one instance per profile. New ones retain repeats.
      const instances = snapshot.instances || snapshot.sessionIds.map((sessionId) => ({ id: sessionId, sessionId }));
      const entries = instances.map((instance) => ({ ...instance, profile: state().sessions.find((profile) => profile.id === instance.sessionId) }));
      const available = entries.filter((entry) => entry.profile);
      if (!available.length) { toast('This snapshot has no available saved sessions.', true); return; }
      const missing = entries.length - available.length;
      const accepted = await confirmAction({ title: `Connect ${available.length} saved session${available.length === 1 ? '' : 's'}?`, message: `Open the connections from “${snapshot.name}”. Current tabs stay open.${missing ? ` ${missing} connections have unavailable profiles and will be skipped.` : ''}`, targets: available.map(({ profile }) => `${profile.name} · ${profile.protocol.toUpperCase()} · ${profile.host || profile.serial?.path || 'Local shell'}`), accept: 'Connect sessions' });
      if (!accepted) return;
      $('snapshots-dialog').close();
      const previousLayout = getLayout();
      const opened = new Map();
      for (const entry of available) {
        const connection = await openConnection(entry.profile);
        if (connection) opened.set(entry.id, connection.id);
      }
      if (opened.size) {
        if (snapshot.instances) restoreLayout(snapshot.layout, opened, previousLayout);
        else {
          setLayout(snapshot.layout);
          const active = opened.get(snapshot.layout.activeSessionId);
          if (active) activate(active);
        }
      }
      const failed = available.length - opened.size;
      const status = `Opened ${opened.size} of ${instances.length} saved connections${failed ? `; ${failed} failed` : ''}${missing ? `; ${missing} unavailable` : ''}.`;
      $('snapshot-status').textContent = status;
      toast(status, Boolean(failed || missing));
    } finally { snapshotBusy = false; }
  }
  async function saveSnapshot() {
    if (snapshotBusy) return;
    const name = $('snapshot-name').value.trim(); if (!name) { toast('Give the snapshot a name.', true); return; }
    const available = new Set(state().sessions.map((profile) => profile.id));
    const instances = [...getConnections().values()].filter((connection) => available.has(connection.profile.id)).map((connection) => ({ id: connection.id, sessionId: connection.profile.id }));
    const sessionIds = [...new Set(instances.map((instance) => instance.sessionId))];
    if (!sessionIds.length) { toast('Open at least one saved session before saving a snapshot. Quick connections must be saved first.', true); return; }
    if (instances.length > 32) { toast('A snapshot can contain at most 32 saved connections.', true); return; }
    const currentLayout = getLayout();
    const layout = { tile: currentLayout.tile, orientation: currentLayout.orientation, ...pruneLayout(currentLayout, new Set(instances.map((instance) => instance.id))) };
    const activeInstance = layout.groups.find((group) => group.id === layout.activeGroupId)?.activeId;
    layout.activeSessionId = instances.find((instance) => instance.id === activeInstance)?.sessionId || '';
    const excluded = getConnections().size - instances.length;
    snapshotBusy = true;
    $('snapshot-save').disabled = true;
    try {
      const existing = (state().snapshots || []).find((entry) => entry.name === name);
      if (existing && !await confirmAction({ title: 'Replace snapshot?', message: `Replace the saved workspace “${name}”?`, accept: 'Replace' })) return;
      const snapshot = { ...(existing ? { id: existing.id } : {}), name, sessionIds, instances, layout };
      const saved = await api.saveSnapshots([...(state().snapshots || []).filter((entry) => entry !== existing), snapshot]);
      setState({ snapshots: saved }); renderSnapshots(); $('snapshot-name').value = '';
      $('snapshot-status').textContent = `Saved “${name}” with ${instances.length} connections.${excluded ? ` ${excluded} unsaved quick connection${excluded === 1 ? ' was' : 's were'} excluded; save a profile to include it.` : ''}`;
    } finally { snapshotBusy = false; $('snapshot-save').disabled = false; }
  }
  async function perform(action) {
    switch (action) {
      case 'quick-connect': openQuickConnect(); return true;
      case 'connect-bar': $('connect-address').focus(); $('connect-address').select(); return true;
      case 'show-command-manager': showManager('commands'); return true;
      case 'show-active-sessions': showManager('active'); return true;
      case 'snapshots': renderSnapshots(); $('snapshot-status').textContent = ''; dialog('snapshots-dialog'); return true;
      case 'clone-session': if (current()) await openConnection({ ...current().profile }); return true;
      case 'clear-history': {
        const accepted = await confirmAction({ title: 'Clear command history?', message: 'Remove saved Command Window history from this computer?', accept: 'Clear history' });
        if (accepted) { setState({ commandHistory: await api.saveCommandHistory([]) }); renderHistory(); } return true;
      }
      default: return false;
    }
  }
  function install() {
    for (const name of ['sessions', 'commands', 'active']) $(`dock-${name}`).addEventListener('click', () => showManager(name));
    $('command-filter').addEventListener('input', renderCommands); $('active-filter').addEventListener('input', renderActive);
    $('command-edit').addEventListener('click', showSnippets); $('command-new').addEventListener('click', showSnippets);
    $('command-run').addEventListener('click', () => { const command = state().snippets.find((entry) => entry.id === selectedCommandId); if (command) attempt(() => launchCommand(command)); });
    $('active-clone').addEventListener('click', () => attempt(() => perform('clone-session'))); $('active-close').addEventListener('click', () => { if (current()) attempt(() => closeConnection(current().id)); }); $('active-reconnect').addEventListener('click', () => { if (current()) attempt(() => reconnect(current().id)); });
    $('quick-connect').addEventListener('click', () => openQuickConnect());
    $('connect-address').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); attempt(connectAddress); } });
    $('bulk-form').addEventListener('submit', saveBulk); $('snapshot-save').addEventListener('click', () => attempt(saveSnapshot));
    $('command-history').addEventListener('change', () => { if ($('command-history').value === '') return; context.clearCommandDraft?.(); $('command-input').value = state().commandHistory[Number($('command-history').value)] || ''; $('command-input').focus(); $('command-history').value = ''; });
  }
  return { install, openQuickConnect, refresh, showManager, recordHistory, bulkOptions, perform, renderHistory, renderCommands, renderActive };
}
