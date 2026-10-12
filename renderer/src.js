import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import './style.css';

const api = window.harbor;
const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const bind = (id, event, fn) => $(id).addEventListener(event, fn);
let state = { sessions: [], snippets: [], settings: { theme: 'light', fontSize: 13, scrollback: 10000 }, platform: 'darwin', version: '' };
const connections = new Map();
const pendingData = new Map();
const pendingExits = new Map();
const closedIds = new Set();
const collapsedFolders = new Set();
let activeId = null;
let tileView = false;
let editingSessionId = null;
let selectedProtocol = 'ssh';
let isMac = true;
let confirmResolver = null;
let openingCount = 0;
let ready = false;
let selectedSessionId = null;
let selectedFolderPath = null;
let focusedTreeKey = 'folder:';
let openMenuName = null;
const panes = { sessionManager: true, commandWindow: true, buttonBar: true };
const SVG_NS = 'http://www.w3.org/2000/svg';
const iconPaths = {
  connect: 'M5 6h14v9H5z M9 19h6 M12 15v4 M2 11h6 M5 8l3 3-3 3',
  disconnect: 'M5 6h14v9H5z M9 19h6 M12 15v4 M2 2l20 20',
  reconnect: 'M19 8a7 7 0 1 0 0 8 M19 3v5h-5',
  new: 'M3 7h7l2 2h9v11H3z M3 7V5h8l2 2 M17 10v7 M13.5 13.5h7',
  terminal: 'M3 4h18v16H3z M6 8l3 3-3 3 M11 15h6',
  options: 'M5 3h10l4 4v14H5z M15 3v5h4 M8 12h8 M8 16h6',
  copy: 'M8 7h12v14H8z M16 7V3H4v14h4',
  paste: 'M7 5H4v16h16V5h-3 M8 3h8v5H8z M7 12h10 M7 16h8',
  find: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M14.5 14.5L21 21',
  transfer: 'M3 5h7l2 2h9v13H3z M5 11h12 M14 8l3 3-3 3 M19 16H7 M10 13l-3 3 3 3',
  log: 'M5 3h11l3 3v15H5z M8 9h8 M8 13h8 M8 17h5 M15 3v4h4',
  tile: 'M3 3h8v8H3z M14 3h7v8h-7z M3 14h8v7H3z M14 14h7v7h-7z',
  settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 16v.1',
  import: 'M3 7h7l2 2h9v11H3z M3 7V5h8l2 2 M12 10v7 M9 14l3 3 3-3',
};

function addToolbarIcons() {
  for (const button of document.querySelectorAll('[data-icon]')) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `tool-icon icon-${button.dataset.icon}`);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', iconPaths[button.dataset.icon] || iconPaths.options);
    svg.append(path); button.replaceChildren(svg);
  }
}

function selectedProfile() {
  return state.sessions.find((profile) => profile.id === selectedSessionId) || null;
}

function actionProfile() {
  return selectedProfile() || connections.get(activeId)?.profile || null;
}

function setPane(name, visible) {
  panes[name] = visible;
  applyPaneVisibility();
  saveLayout();
}

function applyPaneVisibility() {
  $('session-manager').hidden = !panes.sessionManager;
  $('sidebar-resizer').hidden = !panes.sessionManager;
  $('command-bar').hidden = !panes.commandWindow;
  $('command-resizer').hidden = !panes.commandWindow;
  $('button-bar').hidden = !panes.buttonBar;
  requestAnimationFrame(fitVisible);
}

function saveLayout() {
  try {
    localStorage.setItem('harbor-classic-layout', JSON.stringify({ panes, sidebarWidth: parseInt(document.documentElement.style.getPropertyValue('--sidebar-width')) || 230, commandHeight: parseInt(document.documentElement.style.getPropertyValue('--command-height')) || 100 }));
  } catch { /* Storage can be unavailable in restricted profiles. */ }
}

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('harbor-classic-layout') || 'null');
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(panes)) if (typeof saved.panes?.[key] === 'boolean') panes[key] = saved.panes[key];
      if (Number.isFinite(saved.sidebarWidth)) document.documentElement.style.setProperty('--sidebar-width', `${Math.max(160, Math.min(460, saved.sidebarWidth))}px`);
      if (Number.isFinite(saved.commandHeight)) document.documentElement.style.setProperty('--command-height', `${Math.max(65, Math.min(300, saved.commandHeight))}px`);
    }
  } catch { /* Ignore invalid layout preferences. */ }
  applyPaneVisibility();
}

function setupSplitters() {
  for (const [id, variable, axis, minimum, maximum] of [['sidebar-resizer', '--sidebar-width', 'x', 160, 460], ['command-resizer', '--command-height', 'y', 65, 300]]) {
    const handle = $(id);
    const setSize = (value) => {
      const limit = axis === 'x' ? Math.min(maximum, Math.max(minimum, window.innerWidth - 420)) : Math.min(maximum, Math.max(minimum, document.querySelector('.workspace').clientHeight - 140));
      document.documentElement.style.setProperty(variable, `${Math.max(minimum, Math.min(limit, value))}px`);
      requestAnimationFrame(fitVisible);
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = axis === 'x' ? event.clientX : event.clientY;
      const initial = axis === 'x' ? $('session-manager').getBoundingClientRect().width : $('command-bar').getBoundingClientRect().height;
      handle.setPointerCapture(event.pointerId);
      $('app').classList.add('resizing');
      const move = (e) => setSize(initial + (axis === 'x' ? e.clientX - start : start - e.clientY));
      const finish = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); $('app').classList.remove('resizing'); saveLayout(); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
    });
    handle.addEventListener('keydown', (event) => {
      const direction = axis === 'x' ? { ArrowLeft: -10, ArrowRight: 10 } : { ArrowUp: 10, ArrowDown: -10 };
      if (!direction[event.key]) return;
      event.preventDefault();
      setSize((axis === 'x' ? $('session-manager').getBoundingClientRect().width : $('command-bar').getBoundingClientRect().height) + direction[event.key]); saveLayout();
    });
  }
}


function toast(message, error = false, path = '') {
  const node = make('div', `toast${error ? ' error' : ''}`, message);
  if (path) node.append(make('span', 'toast-path', path));
  $('toast-stack').append(node);
  const timer = window.setTimeout(() => node.remove(), error ? 10000 : path ? 9000 : 5000);
  node.addEventListener('click', () => { window.clearTimeout(timer); node.remove(); });
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error || 'Something went wrong.');
}

function dialogOpen(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}

function confirmAction({ title, message, preview, targets = [], accept = 'Confirm', eyebrow = 'PLEASE REVIEW' }) {
  if (confirmResolver) confirmResolver(false);
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-eyebrow').textContent = eyebrow;
  $('confirm-accept').textContent = accept;
  $('confirm-preview').hidden = !preview;
  $('confirm-preview').textContent = preview || '';
  $('confirm-targets').replaceChildren(...targets.map((title) => make('div', 'confirm-target-item', title)));
  $('confirm-targets').hidden = !targets.length;
  dialogOpen('confirm-dialog');
  $('confirm-cancel').focus();
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function finishConfirm(accepted) {
  const resolve = confirmResolver;
  confirmResolver = null;
  if ($('confirm-dialog').open) $('confirm-dialog').close();
  if (resolve) resolve(accepted);
}

function profileDetail(profile) {
  if (profile.protocol === 'local') return profile.cwd || 'Your default shell';
  return `${profile.username ? `${profile.username}@` : ''}${profile.host || ''}${profile.port && Number(profile.port) !== 22 ? `:${profile.port}` : ''}`;
}

function sessionIcon(protocol) {
  return protocol === 'local' ? '›_' : protocol === 'sftp' ? '⇄' : '⌁';
}

function normalizeFolder(folder) {
  return String(folder || '').split(/[\\/]/).map((part) => part.trim()).filter(Boolean);
}

function selectSession(profile, focus = false) {
  if (!profile) return;
  selectedSessionId = profile.id;
  selectedFolderPath = null;
  focusedTreeKey = `session:${profile.id}`;
  for (const row of $('session-list').querySelectorAll('.session-row')) {
    const selected = row.dataset.sessionId === profile.id;
    row.classList.toggle('selected', selected);
    const button = row.querySelector('.session-main'); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  }
  for (const folder of $('session-list').querySelectorAll('.folder-heading')) { folder.classList.remove('selected'); folder.tabIndex = -1; }
  $('session-selection').textContent = `${profile.protocol.toUpperCase()} · ${profileDetail(profile)}`;
  updateToolbar();
  if (focus) focusTreeItem(focusedTreeKey);
}

function focusTreeItem(key) {
  const item = [...$('session-list').querySelectorAll('[data-tree-key]')].find((node) => node.dataset.treeKey === key);
  if (item) { focusedTreeKey = key; item.focus(); item.scrollIntoView({ block: 'nearest' }); }
}

function renderSessions() {
  const previousFocus = $('session-list').contains(document.activeElement) ? document.activeElement.dataset.treeKey : null;
  const needle = $('session-search').value.trim().toLowerCase();
  const profiles = state.sessions.filter((profile) => [profile.name, profile.folder, profile.host, profile.username, profile.description, profile.protocol].join(' ').toLowerCase().includes(needle));
  if (!state.sessions.some((profile) => profile.id === selectedSessionId)) selectedSessionId = null;
  const root = { name: 'Sessions', path: '', folders: new Map(), profiles: [], count: profiles.length };
  for (const profile of profiles) {
    let node = root;
    const parts = normalizeFolder(profile.folder);
    for (let i = 0; i < parts.length; i += 1) {
      const path = parts.slice(0, i + 1).join('/');
      if (!node.folders.has(parts[i])) node.folders.set(parts[i], { name: parts[i], path, folders: new Map(), profiles: [], count: 0 });
      node = node.folders.get(parts[i]); node.count += 1;
    }
    node.profiles.push(profile);
  }
  const renderFolder = (folder, level) => {
    const group = make('div', 'session-group');
    const key = `folder:${folder.path}`;
    const collapsed = collapsedFolders.has(folder.path) && !needle;
    const heading = make('button', `folder-heading${selectedFolderPath === folder.path ? ' selected' : ''}`);
    heading.dataset.treeKey = key; heading.dataset.treeKind = 'folder'; heading.dataset.folderPath = folder.path;
    heading.setAttribute('role', 'treeitem'); heading.setAttribute('aria-expanded', String(!collapsed)); heading.setAttribute('aria-level', String(level));
    heading.tabIndex = focusedTreeKey === key ? 0 : -1;
    heading.append(make('span', 'tree-chevron', collapsed ? '▸' : '▾'), make('span', 'folder-icon'), make('span', 'folder-name', folder.name), make('span', 'folder-count', String(folder.count)));
    heading.addEventListener('click', () => {
      selectedFolderPath = folder.path; selectedSessionId = null; focusedTreeKey = key;
      if (collapsedFolders.has(folder.path)) collapsedFolders.delete(folder.path); else collapsedFolders.add(folder.path);
      renderSessions(); updateToolbar(); focusTreeItem(key);
    });
    heading.addEventListener('focus', () => { focusedTreeKey = key; });
    heading.addEventListener('contextmenu', (event) => { event.preventDefault(); selectedFolderPath = folder.path; selectedSessionId = null; focusedTreeKey = key; renderSessions(); updateToolbar(); showSessionContext(event.clientX, event.clientY, null, folder.path); });
    group.append(heading);
    if (!collapsed) {
      const children = make('div', 'tree-children'); children.setAttribute('role', 'group');
      for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) children.append(renderFolder(child, level + 1));
      for (const profile of [...folder.profiles].sort((a, b) => a.name.localeCompare(b.name))) {
        const connected = [...connections.values()].some((connection) => connection.profile.id === profile.id && !connection.exited);
        const row = make('div', `session-row${connected ? ' connected' : ''}${selectedSessionId === profile.id ? ' selected' : ''}`);
        row.dataset.sessionId = profile.id;
        const icon = make('span', 'session-icon', profile.protocol === 'sftp' ? '↔' : ''); icon.setAttribute('aria-hidden', 'true');
        const main = make('button', 'session-main'); main.dataset.treeKey = `session:${profile.id}`; main.dataset.treeKind = 'session'; main.dataset.sessionId = profile.id;
        main.setAttribute('role', 'treeitem'); main.setAttribute('aria-level', String(level + 1)); main.setAttribute('aria-selected', String(selectedSessionId === profile.id));
        main.tabIndex = focusedTreeKey === main.dataset.treeKey ? 0 : -1;
        main.title = `${profile.name} · ${profile.protocol.toUpperCase()} · ${profileDetail(profile)}${profile.description ? ` — ${profile.description}` : ''}`;
        main.append(make('strong', '', profile.name));
        main.addEventListener('focus', () => { focusedTreeKey = main.dataset.treeKey; });
        row.addEventListener('click', () => selectSession(profile, true));
        row.addEventListener('dblclick', () => openConnection(profile));
        row.addEventListener('contextmenu', (event) => { event.preventDefault(); selectSession(profile); showSessionContext(event.clientX, event.clientY, profile, null); });
        row.append(icon, main); children.append(row);
      }
      group.append(children);
    }
    return group;
  };
  $('session-list').replaceChildren(renderFolder(root, 1));
  if (!profiles.length) {
    const empty = make('div', 'sidebar-empty'); empty.append(make('strong', '', needle ? 'No matching sessions.' : 'No saved sessions.'), make('span', '', needle ? 'Try a hostname or folder name.' : 'Use File → New Session to save a connection.'));
    $('session-list').append(empty);
  }
  const focusable = [...$('session-list').querySelectorAll('[data-tree-key]')];
  if (!focusable.some((node) => node.tabIndex === 0) && focusable.length) focusable[0].tabIndex = 0;
  if (previousFocus) focusTreeItem(previousFocus);
  const selected = selectedProfile();
  $('session-selection').textContent = selected ? `${selected.protocol.toUpperCase()} · ${profileDetail(selected)}` : 'Double-click a session to connect.';
  $('folder-options').replaceChildren(...[...new Set(state.sessions.map((profile) => normalizeFolder(profile.folder).join('/')).filter(Boolean))].sort().map((folder) => { const option = make('option'); option.value = folder; return option; }));
  updateToolbar();
}

function treeKeydown(event) {
  const item = event.target.closest('[data-tree-key]');
  if (!item) return;
  const items = [...$('session-list').querySelectorAll('[data-tree-key]')];
  const index = items.indexOf(item);
  const profile = state.sessions.find((entry) => entry.id === item.dataset.sessionId);
  const focusItem = (node) => {
    if (!node) return;
    if (node.dataset.treeKind === 'session') selectSession(state.sessions.find((entry) => entry.id === node.dataset.sessionId));
    else { selectedFolderPath = node.dataset.folderPath; selectedSessionId = null; updateToolbar(); }
    focusTreeItem(node.dataset.treeKey);
  };
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    focusItem(items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]);
  } else if (event.key === 'Enter') {
    event.preventDefault(); if (profile) openConnection(profile); else item.click();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (item.dataset.treeKind === 'folder' && item.getAttribute('aria-expanded') === 'false') { collapsedFolders.delete(item.dataset.folderPath); renderSessions(); focusTreeItem(item.dataset.treeKey); }
    else if (item.dataset.treeKind === 'folder') focusItem(items[index + 1]);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (item.dataset.treeKind === 'folder' && item.getAttribute('aria-expanded') === 'true') { collapsedFolders.add(item.dataset.folderPath); renderSessions(); focusTreeItem(item.dataset.treeKey); }
    else {
      const parent = item.closest('.tree-children')?.parentElement.querySelector(':scope > .folder-heading');
      focusItem(parent);
    }
  } else if (event.key === 'F2' && profile) { event.preventDefault(); openProfileDialog(profile); }
  else if (event.key === 'Delete' && profile) { event.preventDefault(); deleteSession(profile); }
  else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const rect = item.getBoundingClientRect(); showSessionContext(rect.left + 10, rect.bottom, profile || null, item.dataset.folderPath || ''); }
}

function renderSnippets() {
  const nodes = state.snippets.map((snippet) => {
    const button = make('button', 'snippet-button', snippet.name);
    button.title = `${snippet.command} — places text in the Command Window for review`;
    button.addEventListener('click', () => {
      setPane('commandWindow', true);
      $('command-input').value = snippet.command;
      $('command-input').focus();
    });
    return button;
  });
  if (!nodes.length) nodes.push(make('p', 'snippet-empty', 'No buttons configured. Use the options button to add commands.'));
  $('snippet-list').replaceChildren(...nodes);
}

async function deleteSession(profile) {
  const accepted = await confirmAction({ title: 'Delete saved session?', message: `Remove “${profile.name}” from this workspace? Open connections will stay available.`, accept: 'Delete session' });
  if (!accepted) return;
  try {
    const result = await api.deleteSession(profile.id);
    if (result && Array.isArray(result.sessions)) state = { ...state, ...result };
    else state.sessions = state.sessions.filter((p) => p.id !== profile.id);
    renderSessions();
    toast('Saved session deleted.');
  } catch (error) { toast(errorMessage(error), true); }
}

function setProtocol(protocol) {
  selectedProtocol = protocol;
  for (const button of document.querySelectorAll('[data-protocol]')) {
    const selected = button.dataset.protocol === protocol;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  $('remote-fields').hidden = protocol === 'local';
  $('local-fields').hidden = protocol !== 'local';
  $('profile-host').required = protocol !== 'local';
  $('profile-port').required = protocol !== 'local';
  for (const input of $('remote-fields').querySelectorAll('input, select')) input.disabled = protocol === 'local';
  for (const input of $('local-fields').querySelectorAll('input')) input.disabled = protocol !== 'local';
  $('ssh-forwarding-fields').hidden = protocol !== 'ssh';
  for (const row of $('forwarding-list').children) {
    const dynamic = row.querySelector('[data-field="type"]').value === 'dynamic';
    for (const input of row.querySelectorAll('input, select')) {
      const target = ['targetHost', 'targetPort'].includes(input.dataset.field);
      input.disabled = protocol !== 'ssh' || dynamic && target;
      input.required = input.tagName === 'INPUT' && !input.disabled;
    }
  }
}

function addForwarding(forwarding = { type: 'local', listenPort: '', targetHost: 'localhost', targetPort: '' }) {
  const row = make('div', 'forwarding-row');
  const controls = {};
  const definitions = [
    ['type', 'Type', 'select'], ['listenPort', 'Listen port', 'number'], ['targetHost', 'Target host', 'text'], ['targetPort', 'Target port', 'number'],
  ];
  for (const [key, labelText, type] of definitions) {
    const label = make('label', '', labelText);
    const control = make(type === 'select' ? 'select' : 'input');
    control.dataset.field = key;
    if (type === 'select') {
      for (const [value, title] of [['local', 'Local'], ['remote', 'Remote'], ['dynamic', 'SOCKS']]) {
        const option = make('option', '', title); option.value = value; control.append(option);
      }
    } else {
      control.type = type;
      if (type === 'number') { control.min = '1'; control.max = '65535'; }
    }
    control.value = String(forwarding[key] ?? '');
    label.append(control);
    row.append(label);
    controls[key] = control;
  }
  const changeType = () => {
    const dynamic = controls.type.value === 'dynamic';
    const enabled = selectedProtocol === 'ssh';
    controls.targetHost.disabled = !enabled || dynamic;
    controls.targetPort.disabled = !enabled || dynamic;
    controls.targetHost.required = enabled && !dynamic;
    controls.targetPort.required = enabled && !dynamic;
    controls.listenPort.required = enabled;
    controls.listenPort.disabled = !enabled;
    controls.type.disabled = !enabled;
  };
  controls.type.addEventListener('change', changeType);
  changeType();
  const remove = make('button', 'icon-button', '×');
  remove.type = 'button'; remove.title = 'Remove forwarding'; remove.setAttribute('aria-label', remove.title);
  remove.addEventListener('click', () => row.remove());
  row.append(remove);
  $('forwarding-list').append(row);
}

function openProfileDialog(profile = null) {
  editingSessionId = profile?.id || null;
  $('profile-form').reset();
  $('profile-dialog-title').textContent = profile ? 'Edit session' : 'New session';
  $('save-profile').textContent = profile ? 'Save changes' : 'Save session';
  $('profile-error').hidden = true;
  for (const [field, key] of [['name', 'name'], ['folder', 'folder'], ['host', 'host'], ['port', 'port'], ['username', 'username'], ['identity', 'identityFile'], ['jump', 'jumpHost'], ['cwd', 'cwd'], ['description', 'description'], ['color', 'color']]) {
    $(`profile-${field}`).value = String(profile?.[key] ?? (field === 'port' ? 22 : field === 'color' ? '#83d5bf' : ''));
  }
  $('forwarding-list').replaceChildren();
  for (const forwarding of profile?.forwardings || []) addForwarding(forwarding);
  $('remote-fields').querySelector('details').open = Boolean(profile?.jumpHost || profile?.forwardings?.length);
  setProtocol(profile?.protocol || 'ssh');
  dialogOpen('profile-dialog');
  $('profile-name').focus();
}

function readProfile() {
  const profile = {
    name: $('profile-name').value.trim(), protocol: selectedProtocol, folder: $('profile-folder').value.trim(),
    host: selectedProtocol === 'local' ? '' : $('profile-host').value.trim(),
    port: selectedProtocol === 'local' ? 22 : Number($('profile-port').value),
    username: selectedProtocol === 'local' ? '' : $('profile-username').value.trim(),
    identityFile: selectedProtocol === 'local' ? '' : $('profile-identity').value.trim(),
    jumpHost: selectedProtocol === 'local' ? '' : $('profile-jump').value.trim(),
    cwd: selectedProtocol === 'local' ? $('profile-cwd').value.trim() : '',
    description: $('profile-description').value.trim(), color: $('profile-color').value,
    forwardings: [],
  };
  if (editingSessionId) profile.id = editingSessionId;
  if (selectedProtocol === 'ssh') {
    for (const row of $('forwarding-list').children) {
      const field = (key) => row.querySelector(`[data-field="${key}"]`).value;
      const type = field('type');
      profile.forwardings.push({ type, listenPort: Number(field('listenPort')), targetHost: type === 'dynamic' ? '' : field('targetHost').trim(), targetPort: type === 'dynamic' ? 0 : Number(field('targetPort')) });
    }
  }
  return profile;
}

async function saveProfile(event) {
  event.preventDefault();
  const profile = readProfile();
  if (!profile.name) { $('profile-error').textContent = 'Give this session a name.'; $('profile-error').hidden = false; return; }
  $('save-profile').disabled = true;
  try {
    const saved = await api.saveSession(profile);
    const index = state.sessions.findIndex((p) => p.id === saved.id);
    if (index >= 0) state.sessions[index] = saved;
    else state.sessions.push(saved);
    renderSessions();
    $('profile-dialog').close();
    selectedSessionId = saved.id; selectedFolderPath = null; focusedTreeKey = `session:${saved.id}`;
    for (const part of normalizeFolder(saved.folder).map((_, index, parts) => parts.slice(0, index + 1).join('/'))) collapsedFolders.delete(part);
    collapsedFolders.delete(''); renderSessions();
    toast('Session saved. Double-click it in Session Manager to connect.');
  } catch (error) { $('profile-error').textContent = errorMessage(error); $('profile-error').hidden = false; }
  finally { $('save-profile').disabled = false; }
}

function terminalTheme() {
  return {
    background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', cursorAccent: '#000000', selectionBackground: '#375675',
    black: '#000000', red: '#b94343', green: '#48a848', yellow: '#b8a841', blue: '#4477bb', magenta: '#a653a6', cyan: '#43a6a6', white: '#c0c0c0',
    brightBlack: '#777777', brightRed: '#ef7676', brightGreen: '#75d475', brightYellow: '#e1d571', brightBlue: '#7c9fdf', brightMagenta: '#d78dd7', brightCyan: '#8bdada', brightWhite: '#ffffff',
  };
}

function applySettings() {
  document.documentElement.dataset.theme = state.settings.theme;
  for (const connection of connections.values()) {
    connection.term.options.theme = terminalTheme();
    connection.term.options.fontSize = Number(state.settings.fontSize);
    connection.term.options.scrollback = Number(state.settings.scrollback);
  }
  requestAnimationFrame(fitVisible);
}

function createConnection(response, profile) {
  const pane = make('section', 'terminal-pane');
  pane.dataset.connectionId = response.id;
  const toolbar = make('div', 'pane-toolbar');
  const heading = make('div', 'pane-heading');
  heading.append(make('strong', '', profileDetail(profile) || response.title), make('span', '', String(response.protocol || profile.protocol).toUpperCase()));
  const tools = make('div', 'pane-tools');
  const logButton = make('button', '', 'Log');
  logButton.title = 'Capture received terminal output to a local file';
  logButton.addEventListener('click', () => toggleLog(response.id));
  const findButton = make('button', '', 'Find');
  findButton.addEventListener('click', () => { activate(response.id); showSearch(); });
  const reconnectButton = make('button', '', 'Reconnect');
  reconnectButton.addEventListener('click', () => reconnect(response.id));
  tools.append(logButton, findButton, reconnectButton);
  toolbar.append(heading, tools);
  const mount = make('div', 'terminal-mount');
  const exitBar = make('div', 'terminal-exit-bar');
  exitBar.hidden = true;
  const exitLabel = make('span');
  const exitReconnect = make('button', 'text-button', 'Reconnect');
  exitReconnect.addEventListener('click', () => reconnect(response.id));
  exitBar.append(exitLabel, exitReconnect);
  pane.append(toolbar, mount, exitBar);
  const term = new Terminal({
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: Number(state.settings.fontSize), scrollback: Number(state.settings.scrollback),
    theme: terminalTheme(), cursorBlink: true, cursorStyle: 'block', allowProposedApi: false,
    convertEol: false, macOptionIsMeta: true, rightClickSelectsWord: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const connection = { id: response.id, title: response.title || profile.name, protocol: response.protocol || profile.protocol, profile: { ...profile }, pane, mount, term, fit, search, exitBar, exitLabel, logButton, exited: false, logging: false, reconnecting: false, writeErrorShown: false };
  connections.set(response.id, connection);
  $('terminal-workspace').append(pane);
  term.open(mount);
  term.onData((data) => writeToConnection(connection, data));
  term.onResize(({ cols, rows }) => {
    if (!connection.exited) Promise.resolve(api.terminalResize({ id: connection.id, cols, rows })).catch(() => {});
    if (activeId === connection.id) updateWorkspaceStatus();
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const copy = (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') || (event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection());
    const paste = (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') || (event.metaKey && event.key.toLowerCase() === 'v');
    if (copy) { event.preventDefault(); copySelection(connection); return false; }
    if (paste) { event.preventDefault(); pasteClipboard(connection); return false; }
    if ((event.ctrlKey || event.metaKey) && ['t', 'k', 'f', 'w'].includes(event.key.toLowerCase()) && !event.altKey) return false;
    return true;
  });
  mount.addEventListener('paste', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData('text/plain');
    if (text !== undefined) pasteText(connection, text);
    else pasteClipboard(connection);
  }, true);
  pane.addEventListener('mousedown', () => {
    if (activeId !== connection.id) { activeId = connection.id; renderTabs(); renderWorkspace(); updateWorkspaceStatus(); }
  });
  const observer = new ResizeObserver(() => { if (!pane.hidden) requestAnimationFrame(() => safeFit(connection)); });
  observer.observe(mount);
  connection.observer = observer;
  const buffered = pendingData.get(response.id);
  if (buffered) { term.write(buffered); pendingData.delete(response.id); }
  const exit = pendingExits.get(response.id);
  if (exit) { pendingExits.delete(response.id); handleTerminalExit(exit); }
  return connection;
}

function handleTerminalData({ id, data }) {
  if (closedIds.has(id)) return;
  const connection = connections.get(id);
  if (connection) connection.term.write(String(data));
  else pendingData.set(id, ((pendingData.get(id) || '') + String(data)).slice(-2 * 1024 * 1024));
}

function handleTerminalExit(event) {
  if (closedIds.has(event.id)) return;
  const connection = connections.get(event.id);
  if (!connection) { pendingExits.set(event.id, event); return; }
  connection.exited = true;
  connection.logging = false;
  connection.logButton.disabled = true;
  connection.logButton.textContent = 'Log';
  connection.logButton.classList.remove('logging');
  connection.exitBar.hidden = false;
  connection.exitLabel.textContent = `Connection ended${event.exitCode !== undefined && event.exitCode !== null ? ` · exit ${event.exitCode}` : ''}${event.signal ? ` · ${event.signal}` : ''}. Terminal output is retained.`;
  renderTabs(); renderSessions(); updateWorkspaceStatus();
  requestAnimationFrame(() => safeFit(connection));
}

async function openConnection(profile, oldId = null) {
  if (!ready) { toast('The workspace is still loading. Please try again in a moment.'); return; }
  openingCount += 1;
  updateWorkspaceStatus();
  try {
    const result = await api.terminalOpen(profile.id ? { sessionId: profile.id } : { profile });
    const connection = createConnection(result, profile);
    if (oldId) disposeConnection(oldId);
    activate(connection.id);
    renderSessions();
  } catch (error) { toast(`Could not open ${profile.name}: ${errorMessage(error)}`, true); }
  finally { openingCount -= 1; updateWorkspaceStatus(); }
}

function localShell() {
  openConnection({ name: 'Local shell', protocol: 'local', folder: '', cwd: '', forwardings: [] });
}

function safeFit(connection) {
  if (!connection || connection.pane.hidden || !connection.mount.clientWidth || !connection.mount.clientHeight) return;
  try { connection.fit.fit(); } catch { /* A resize can race terminal disposal. */ }
}

function fitVisible() {
  for (const connection of connections.values()) safeFit(connection);
}

function activate(id, focus = true) {
  if (!connections.has(id)) return;
  activeId = id;
  renderTabs();
  renderWorkspace();
  updateWorkspaceStatus();
  requestAnimationFrame(() => {
    fitVisible();
    if (focus && !document.querySelector('dialog[open]')) connections.get(id)?.term.focus();
  });
}

function renderTabs() {
  const nodes = [];
  for (const connection of connections.values()) {
    const tab = make('div', `terminal-tab${connection.id === activeId ? ' active' : ''}`);
    tab.setAttribute('role', 'presentation');
    const dot = make('span', `tab-dot ${connection.exited ? 'exited' : 'active'}`);
    if (!connection.exited && /^#[0-9a-f]{6}$/i.test(connection.profile.color || '')) dot.style.backgroundColor = connection.profile.color;
    const button = make('button', 'tab-label', connection.title);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(connection.id === activeId));
    button.setAttribute('aria-controls', `pane-${connection.id}`);
    connection.pane.id = `pane-${connection.id}`;
    button.title = `${connection.title} · ${connection.exited ? 'Ended' : 'Open'}`;
    button.addEventListener('click', () => activate(connection.id));
    tab.append(dot, button);
    if (connection.logging) tab.append(make('span', 'tab-log-dot', '●'));
    const close = make('button', 'icon-button', '×');
    close.title = `Close ${connection.title}`;
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', () => closeConnection(connection.id));
    tab.append(close);
    nodes.push(tab);
  }
  $('tab-strip').replaceChildren(...nodes);
  $('connection-count').textContent = `${connections.size} session${connections.size === 1 ? '' : 's'}`;
  $('toggle-tile').disabled = connections.size < 1;
}

function renderWorkspace() {
  const hasConnections = connections.size > 0;
  $('welcome').hidden = hasConnections;
  $('terminal-workspace').hidden = !hasConnections;
  $('tab-strip').hidden = false;
  applyPaneVisibility();
  $('footer-search').hidden = !hasConnections;
  $('terminal-workspace').classList.toggle('tiles', tileView);
  $('terminal-workspace').classList.toggle('single-tile', connections.size === 1);
  $('toggle-tile').setAttribute('aria-pressed', String(tileView));
  for (const connection of connections.values()) {
    connection.pane.hidden = !tileView && connection.id !== activeId;
    connection.pane.classList.toggle('active', connection.id === activeId);
  }
  if (!hasConnections) { $('terminal-search-bar').hidden = true; $('broadcast-mode').checked = false; }
}

function updateToolbar() {
  const current = connections.get(activeId);
  const selected = selectedProfile();
  for (const id of ['connect-session', 'sidebar-connect']) $(id).disabled = !selected;
  for (const id of ['session-options', 'sidebar-properties']) $(id).disabled = !actionProfile();
  $('disconnect-session').disabled = !current || current.exited;
  $('reconnect-session').disabled = !current || current.reconnecting;
  $('copy-terminal').disabled = !current;
  $('paste-terminal').disabled = !current || current.exited;
  $('find-terminal').disabled = !current;
  $('session-log').disabled = !current || current.exited;
  $('session-log').setAttribute('aria-pressed', String(Boolean(current?.logging)));
  $('session-log').title = current?.logging ? 'Stop session logging' : 'Log session output';
  $('toolbar-session-name').textContent = current ? `${current.title} · ${current.exited ? 'Disconnected' : current.protocol.toUpperCase()}` : 'No active session';
}

function updateWorkspaceStatus() {
  const current = connections.get(activeId);
  const liveCount = [...connections.values()].filter((connection) => !connection.exited).length;
  $('workspace-status').textContent = openingCount ? `Opening${openingCount > 1 ? ` (${openingCount})` : ''}…` : current ? `${current.exited ? 'Terminal ended' : 'Terminal open'} · ${profileDetail(current.profile) || current.title}` : 'Ready';
  $('status-protocol').textContent = current ? current.protocol === 'ssh' ? 'SSH2' : current.protocol.toUpperCase() : '—';
  $('status-size').textContent = current ? `${current.term.cols} × ${current.term.rows}` : '—';
  $('send-command').disabled = !liveCount || (!current || current.exited) && !$('broadcast-mode').checked;
  updateToolbar();
}

async function writeToConnection(connection, data) {
  if (!connection || connection.exited) return;
  try { await api.terminalWrite({ id: connection.id, data }); }
  catch (error) {
    if (!connection.writeErrorShown) { toast(`Could not send input: ${errorMessage(error)}`, true); connection.writeErrorShown = true; }
  }
}

function disposeConnection(id) {
  const connection = connections.get(id);
  if (!connection) return;
  closedIds.add(id);
  connection.observer.disconnect();
  connection.term.dispose();
  connection.pane.remove();
  connections.delete(id);
  pendingData.delete(id); pendingExits.delete(id);
  if (activeId === id) activeId = [...connections.keys()].at(-1) || null;
  renderTabs(); renderWorkspace(); renderSessions(); updateWorkspaceStatus();
  requestAnimationFrame(fitVisible);
}

async function closeConnection(id) {
  const connection = connections.get(id);
  if (!connection) return;
  if (!connection.exited) {
    const accepted = await confirmAction({ title: 'Close connection?', message: `Close “${connection.title}” and stop its terminal process? Any programs running in this session may be interrupted.`, accept: 'Close connection' });
    if (!accepted) return;
    try { await api.terminalClose(id); }
    catch (error) { toast(errorMessage(error), true); return; }
  }
  disposeConnection(id);
}

async function reconnect(id) {
  const connection = connections.get(id);
  if (!connection || connection.reconnecting) return;
  if (!connection.exited) {
    const accepted = await confirmAction({ title: 'Reconnect session?', message: `Disconnect “${connection.title}” and open it again? Any programs running in this session may be interrupted.`, accept: 'Reconnect' });
    if (!accepted) return;
  }
  connection.reconnecting = true;
  try {
    if (!connection.exited) await api.terminalClose(id);
    await openConnection(connection.profile, id);
  } catch (error) { toast(errorMessage(error), true); }
  finally { connection.reconnecting = false; }
}

async function toggleLog(id) {
  const connection = connections.get(id);
  if (!connection || connection.exited) return;
  if (!connection.logging) {
    const accepted = await confirmAction({ title: 'Start session logging?', message: 'Logging saves received terminal output to a file on this computer. Terminal output can contain credentials or other sensitive information.', accept: 'Start logging', eyebrow: 'LOCAL SESSION LOG' });
    if (!accepted || connection.exited) return;
  }
  connection.logButton.disabled = true;
  try {
    const result = await api.terminalSetLog({ id, enabled: !connection.logging });
    connection.logging = Boolean(result.enabled);
    connection.logButton.textContent = connection.logging ? '● Logging' : 'Log';
    connection.logButton.classList.toggle('logging', connection.logging);
    renderTabs(); updateToolbar();
    toast(connection.logging ? 'Session logging started.' : 'Session logging stopped.', false, result.path || '');
  } catch (error) { toast(errorMessage(error), true); }
  finally { connection.logButton.disabled = connection.exited; }
}

async function sendCommand() {
  const raw = $('command-input').value;
  if (!raw.trim()) return;
  let targets = $('broadcast-mode').checked ? [...connections.values()].filter((c) => !c.exited) : [connections.get(activeId)].filter((c) => c && !c.exited);
  if (!targets.length) { toast('There is no active terminal to receive this command.'); return; }
  if ($('broadcast-mode').checked || /[\r\n]/.test(raw)) {
    const accepted = await confirmAction({ title: targets.length > 1 ? `Send to ${targets.length} terminals?` : 'Review command', message: 'This sends the command exactly as shown, followed by Enter. Check each target before continuing.', preview: raw, targets: targets.map((c) => `${c.title} · ${c.protocol.toUpperCase()} · ${profileDetail(c.profile)}`), accept: targets.length > 1 ? 'Send to all targets' : 'Send command', eyebrow: 'COMMAND PREVIEW' });
    if (!accepted) return;
    targets = targets.filter((c) => connections.has(c.id) && !c.exited);
    if (!targets.length) { toast('The target connections ended before sending.'); return; }
  }
  let failed = 0;
  for (const connection of targets) {
    try { await api.terminalWrite({ id: connection.id, data: `${raw.replace(/\r?\n/g, '\r')}\r` }); }
    catch (error) { failed += 1; toast(`Could not send to ${connection.title}: ${errorMessage(error)}`, true); }
  }
  if (!failed) $('command-input').value = '';
  connections.get(activeId)?.term.focus();
}

async function copySelection(connection) {
  const selection = connection.term.getSelection();
  if (!selection) return;
  try { await api.clipboardWrite(selection); } catch (error) { toast(errorMessage(error), true); }
}

async function pasteClipboard(connection) {
  if (connection.exited) return;
  try {
    const text = await api.clipboardRead();
    await pasteText(connection, text);
  } catch (error) { toast(errorMessage(error), true); }
}

async function pasteText(connection, text) {
  if (!text || connection.exited || !connections.has(connection.id)) return;
  if (/[\r\n]/.test(text)) {
    const accepted = await confirmAction({ title: 'Paste multiple lines?', message: `Pasting this text into “${connection.title}” may execute commands. Review it before continuing.`, preview: text, accept: 'Paste text', eyebrow: 'PASTE PREVIEW' });
    if (!accepted || connection.exited || !connections.has(connection.id)) return;
  }
  connection.term.paste(text);
  connection.term.focus();
}

function showSearch() {
  if (!connections.size) return;
  $('terminal-search-bar').hidden = false;
  $('terminal-search-input').focus();
  $('terminal-search-input').select();
  requestAnimationFrame(fitVisible);
}

function findTerminal(previous = false) {
  const connection = connections.get(activeId);
  const term = $('terminal-search-input').value;
  if (!connection || !term) return;
  const options = { caseSensitive: $('search-case').checked, incremental: true };
  const found = previous ? connection.search.findPrevious(term, options) : connection.search.findNext(term, options);
  $('terminal-search-input').setAttribute('aria-invalid', String(!found));
}

function openSettings() {
  $('settings-theme').value = state.settings.theme;
  $('settings-font').value = String(state.settings.fontSize);
  $('settings-scrollback').value = String(state.settings.scrollback);
  dialogOpen('settings-dialog');
}

async function saveSettings(event) {
  event.preventDefault();
  const button = $('settings-form').querySelector('[type="submit"]');
  button.disabled = true;
  try {
    state.settings = await api.saveSettings({ ...state.settings, theme: $('settings-theme').value, fontSize: Number($('settings-font').value), scrollback: Number($('settings-scrollback').value) });
    applySettings();
    $('settings-dialog').close();
    toast('Preferences saved.');
  } catch (error) { toast(errorMessage(error), true); }
  finally { button.disabled = false; }
}

function addSnippetEditor(snippet = { name: '', command: '' }) {
  const row = make('div', 'snippet-edit-row');
  const header = make('div', 'snippet-title');
  const name = make('input'); name.type = 'text'; name.value = snippet.name; name.placeholder = 'Command name'; name.maxLength = 120; name.dataset.field = 'name'; name.setAttribute('aria-label', 'Command name');
  const remove = make('button', 'icon-button', '×'); remove.title = 'Remove command'; remove.setAttribute('aria-label', remove.title); remove.addEventListener('click', () => row.remove());
  const command = make('textarea'); command.value = snippet.command; command.placeholder = 'Command to preview in the command bar'; command.rows = 2; command.dataset.field = 'command'; command.setAttribute('aria-label', 'Command text');
  header.append(name, remove); row.append(header, command);
  if (snippet.id) row.dataset.id = snippet.id;
  $('snippet-editor').append(row);
  return name;
}

function openSnippets() {
  $('snippet-editor').replaceChildren();
  for (const snippet of state.snippets) addSnippetEditor(snippet);
  if (!state.snippets.length) addSnippetEditor();
  dialogOpen('snippets-dialog');
}

async function saveSnippets() {
  const snippets = [];
  for (const row of $('snippet-editor').children) {
    const name = row.querySelector('[data-field="name"]').value.trim();
    const command = row.querySelector('[data-field="command"]').value;
    if (!name && !command.trim()) continue;
    if (!name || !command.trim()) { toast('Give each quick command a name and command text.', true); return; }
    const snippet = { name, command };
    if (row.dataset.id) snippet.id = row.dataset.id;
    snippets.push(snippet);
  }
  $('save-snippets').disabled = true;
  try {
    state.snippets = await api.saveSnippets(snippets);
    renderSnippets();
    $('snippets-dialog').close();
    toast('Quick commands saved.');
  } catch (error) { toast(errorMessage(error), true); }
  finally { $('save-snippets').disabled = false; }
}

async function importConfiguration(kind) {
  const buttons = [...$('import-dialog').querySelectorAll('.import-option')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = kind === 'securecrt' ? await api.importSecureCRT() : await api.importConfig();
    if (!result) return;
    state = { ...state, ...await api.getState() };
    renderSessions(); renderSnippets(); applySettings();
    $('import-dialog').close();
    const skipped = Array.isArray(result.skipped) ? result.skipped.length : Number(result.skipped || 0);
    toast(`Imported ${result.count} session${result.count === 1 ? '' : 's'}${skipped ? `. ${skipped} skipped` : ''}. No connections were opened.`);
  } catch (error) { toast(`Import failed: ${errorMessage(error)}`, true); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

async function exportConfiguration() {
  $('export-json').disabled = true;
  try {
    const result = await api.exportConfig();
    if (result) toast('Configuration exported.', false, result.path || '');
  } catch (error) { toast(errorMessage(error), true); }
  finally { $('export-json').disabled = false; }
}

async function disconnectActive() {
  const connection = connections.get(activeId);
  if (!connection || connection.exited) return;
  const accepted = await confirmAction({ title: 'Disconnect session?', message: `Disconnect “${connection.title}” and stop its terminal process? Any programs running in this session may be interrupted. The terminal output will remain in this tab.`, accept: 'Disconnect' });
  if (!accepted || connection.exited || !connections.has(connection.id)) return;
  try { await api.terminalClose(connection.id); if (!connection.exited) handleTerminalExit({ id: connection.id }); }
  catch (error) { toast(errorMessage(error), true); }
}

function openSftp() {
  const profile = actionProfile();
  if (profile && ['ssh', 'sftp'].includes(profile.protocol)) {
    openConnection({ ...profile, id: undefined, protocol: 'sftp', forwardings: [], name: `SFTP — ${profile.name}` });
  } else {
    openProfileDialog(); setProtocol('sftp'); $('profile-dialog-title').textContent = 'New SFTP session';
  }
}

function showSessionOptions() {
  const profile = actionProfile();
  if (profile) openProfileDialog(profile);
}

async function performAction(action) {
  if (action.startsWith('activate:')) { activate(action.slice(9)); return; }
  const current = connections.get(activeId);
  switch (action) {
    case 'new-session': openProfileDialog(); if (selectedFolderPath) $('profile-folder').value = selectedFolderPath; break;
    case 'connect': if (selectedProfile()) openConnection(selectedProfile()); else { setPane('sessionManager', true); $('session-search').focus(); } break;
    case 'disconnect': await disconnectActive(); break;
    case 'reconnect': if (current) await reconnect(current.id); break;
    case 'close-tab': if (current) await closeConnection(current.id); break;
    case 'local-shell': localShell(); break;
    case 'session-options': showSessionOptions(); break;
    case 'find': showSearch(); break;
    case 'log': if (current) await toggleLog(current.id); break;
    case 'tile': tileView = !tileView; renderWorkspace(); requestAnimationFrame(fitVisible); break;
    case 'snippets': openSnippets(); break;
    case 'settings': openSettings(); break;
    case 'import-export': dialogOpen('import-dialog'); break;
    case 'copy': if (current) await copySelection(current); break;
    case 'paste': if (current) await pasteClipboard(current); break;
    case 'select-all': if (current) { current.term.selectAll(); current.term.focus(); } break;
    case 'show-session-manager': setPane('sessionManager', !panes.sessionManager); break;
    case 'show-command-window': setPane('commandWindow', !panes.commandWindow); break;
    case 'show-button-bar': setPane('buttonBar', !panes.buttonBar); break;
    case 'sftp': openSftp(); break;
    case 'next-tab': case 'previous-tab': {
      const ids = [...connections.keys()]; const index = ids.indexOf(activeId);
      if (ids.length) activate(ids[(index + (action === 'next-tab' ? 1 : -1) + ids.length) % ids.length]);
      break;
    }
    case 'help': dialogOpen('help-dialog'); break;
  }
}

function runAction(action) {
  closeMenus();
  Promise.resolve(performAction(action)).catch((error) => toast(errorMessage(error), true));
}

function menuDefinitions(name) {
  const current = connections.get(activeId);
  const selected = selectedProfile();
  const mod = isMac ? '⌘' : 'Ctrl+';
  const item = (label, action, enabled = true, shortcut = '', checked = null) => ({ label, action, enabled, shortcut, checked });
  switch (name) {
    case 'file': return [item('New Session…', 'new-session'), item('Connect', 'connect', Boolean(selected), 'Enter'), item('Disconnect', 'disconnect', Boolean(current && !current.exited)), item('Reconnect', 'reconnect', Boolean(current && !current.reconnecting)), null, item('Local Shell', 'local-shell', true, `${mod}T`), item('Close Tab', 'close-tab', Boolean(current), `${mod}W`), null, item('Import / Export Sessions…', 'import-export')];
    case 'edit': return [item('Copy', 'copy', Boolean(current), isMac ? '⌘C' : 'Ctrl+Shift+C'), item('Paste', 'paste', Boolean(current && !current.exited), isMac ? '⌘V' : 'Ctrl+Shift+V'), item('Select All', 'select-all', Boolean(current)), null, item('Find…', 'find', Boolean(current), `${mod}F`), item('Configure Button Bar…', 'snippets')];
    case 'view': return [item('Session Manager', 'show-session-manager', true, '', panes.sessionManager), item('Command Window', 'show-command-window', true, '', panes.commandWindow), item('Button Bar', 'show-button-bar', true, '', panes.buttonBar), null, item('Tile Sessions', 'tile', connections.size > 0, '', tileView)];
    case 'options': return [item('Session Options…', 'session-options', Boolean(actionProfile())), item('Global Options…', 'settings')];
    case 'transfer': return [item('Open SFTP Session', 'sftp'), null, item('SFTP Command Help…', 'help')];
    case 'tools': return [item(current?.logging ? 'Stop Session Logging' : 'Log Session…', 'log', Boolean(current && !current.exited)), item('Configure Button Bar…', 'snippets'), null, item('Import / Export Sessions…', 'import-export')];
    case 'window': return [item('Tile Sessions', 'tile', connections.size > 0, '', tileView), item('Next Tab', 'next-tab', connections.size > 1), item('Previous Tab', 'previous-tab', connections.size > 1), null, ...[...connections.values()].map((connection, index) => item(`${index + 1}  ${connection.title}`, `activate:${connection.id}`, true, '', connection.id === activeId))];
    case 'help': return [item('Harbor Help…', 'help'), item('About Harbor Terminal…', 'help')];
    default: return [];
  }
}

function fillMenu(container, entries) {
  container.replaceChildren();
  for (const entry of entries) {
    if (!entry) { const separator = make('div', 'menu-separator'); separator.setAttribute('role', 'separator'); container.append(separator); continue; }
    const button = make('button', 'menu-item'); button.dataset.action = entry.action; button.disabled = !entry.enabled;
    button.setAttribute('role', entry.checked === null || entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (entry.checked !== null && entry.checked !== undefined) button.setAttribute('aria-checked', String(entry.checked));
    button.append(make('span', 'menu-check', entry.checked ? '✓' : ''), make('span', 'menu-label', entry.label));
    if (entry.shortcut) button.append(make('span', 'menu-shortcut', entry.shortcut));
    button.addEventListener('click', () => runAction(entry.action)); container.append(button);
  }
}

function closeMenus() {
  $('menu-dropdown').hidden = true; $('session-context-menu').hidden = true; openMenuName = null;
  for (const button of document.querySelectorAll('[data-menu]')) button.setAttribute('aria-expanded', 'false');
}

function placeMenu(container, x, y) {
  container.hidden = false;
  const rect = container.getBoundingClientRect();
  container.style.left = `${Math.max(1, Math.min(x, window.innerWidth - rect.width - 3))}px`;
  container.style.top = `${Math.max(1, Math.min(y, window.innerHeight - rect.height - 3))}px`;
}

function showMenu(name, focus = false) {
  closeMenus(); openMenuName = name;
  const button = document.querySelector(`[data-menu="${name}"]`); button.setAttribute('aria-expanded', 'true');
  const rect = button.getBoundingClientRect(); fillMenu($('menu-dropdown'), menuDefinitions(name)); placeMenu($('menu-dropdown'), rect.left, rect.bottom);
  if (focus) $('menu-dropdown').querySelector('button:not(:disabled)')?.focus();
}

function showSessionContext(x, y, profile, folder) {
  closeMenus();
  const entries = [{ label: 'New Session…', action: 'new-session', enabled: true }, null, { label: 'Connect', action: 'connect', enabled: Boolean(profile) }, { label: 'Session Options…', action: 'session-options', enabled: Boolean(profile) }];
  fillMenu($('session-context-menu'), entries);
  if (profile) {
    const remove = make('button', 'menu-item'); remove.dataset.action = 'delete-session'; remove.setAttribute('role', 'menuitem'); remove.append(make('span', 'menu-check'), make('span', 'menu-label', 'Delete Session…'));
    remove.addEventListener('click', () => { closeMenus(); deleteSession(profile); }); $('session-context-menu').append(remove);
  }
  if (folder !== null && folder !== undefined) selectedFolderPath = folder;
  placeMenu($('session-context-menu'), x, y); $('session-context-menu').querySelector('button:not(:disabled)')?.focus();
}

function setupMenus() {
  for (const button of document.querySelectorAll('[data-menu]')) {
    button.addEventListener('click', () => { const wasOpen = openMenuName === button.dataset.menu; closeMenus(); if (!wasOpen) showMenu(button.dataset.menu); });
    button.addEventListener('mouseenter', () => { if (openMenuName && openMenuName !== button.dataset.menu) showMenu(button.dataset.menu); });
    button.addEventListener('keydown', (event) => {
      const buttons = [...document.querySelectorAll('[data-menu]')]; const index = buttons.indexOf(button);
      if (event.key === 'ArrowDown') { event.preventDefault(); showMenu(button.dataset.menu, true); }
      if (['ArrowRight', 'ArrowLeft'].includes(event.key)) { event.preventDefault(); const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]; next.focus(); if (openMenuName) showMenu(next.dataset.menu); }
      if (event.key === 'Escape') closeMenus();
    });
  }
  for (const container of [$('menu-dropdown'), $('session-context-menu')]) container.addEventListener('keydown', (event) => {
    const buttons = [...container.querySelectorAll('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    if (event.key === 'Escape') { event.preventDefault(); const name = openMenuName; closeMenus(); if (name) document.querySelector(`[data-menu="${name}"]`)?.focus(); else focusTreeItem(focusedTreeKey); }
    if (container.id === 'menu-dropdown' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const buttons = [...document.querySelectorAll('[data-menu]')]; const index = buttons.findIndex((button) => button.dataset.menu === openMenuName); showMenu(buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].dataset.menu, true); }
  });
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.menu-dropdown,.menu-bar')) closeMenus(); });
  window.addEventListener('blur', closeMenus);
}

function setupHandlers() {
  addToolbarIcons(); setupMenus(); setupSplitters(); loadLayout();
  const toolbarActions = { 'connect-session': 'connect', 'sidebar-connect': 'connect', 'disconnect-session': 'disconnect', 'reconnect-session': 'reconnect', 'session-options': 'session-options', 'sidebar-properties': 'session-options', 'copy-terminal': 'copy', 'paste-terminal': 'paste', 'find-terminal': 'find', 'sftp-session': 'sftp', 'session-log': 'log' };
  for (const [id, action] of Object.entries(toolbarActions)) bind(id, 'click', () => runAction(action));
  bind('close-session-manager', 'click', () => setPane('sessionManager', false));
  bind('close-command-window', 'click', () => setPane('commandWindow', false));
  bind('session-list', 'keydown', treeKeydown);
  for (const id of ['add-session-sidebar', 'new-session', 'welcome-new']) bind(id, 'click', () => runAction('new-session'));
  for (const id of ['quick-local', 'welcome-local']) bind(id, 'click', localShell);
  for (const button of document.querySelectorAll('.dialog-close')) button.addEventListener('click', () => button.closest('dialog').close());
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  $('confirm-dialog').addEventListener('close', () => { if (confirmResolver) finishConfirm(false); });
  bind('confirm-accept', 'click', () => finishConfirm(true));
  bind('confirm-cancel', 'click', () => finishConfirm(false));
  bind('session-search', 'input', renderSessions);
  bind('session-search', 'keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); $('session-search').value = ''; renderSessions(); connections.get(activeId)?.term.focus(); }
    if (event.key === 'Enter') { event.preventDefault(); const first = $('session-list').querySelector('.session-main'); if (first) { selectSession(state.sessions.find((profile) => profile.id === first.dataset.sessionId), true); } }
  });
  for (const button of document.querySelectorAll('[data-protocol]')) button.addEventListener('click', () => setProtocol(button.dataset.protocol));
  bind('add-forwarding', 'click', () => addForwarding());
  bind('profile-form', 'submit', saveProfile);
  bind('choose-key', 'click', async () => {
    $('choose-key').disabled = true;
    try { const path = await api.chooseIdentityFile(); if (path) $('profile-identity').value = path; }
    catch (error) { toast(errorMessage(error), true); }
    finally { $('choose-key').disabled = false; }
  });
  bind('toggle-tile', 'click', () => { tileView = !tileView; renderWorkspace(); requestAnimationFrame(fitVisible); });
  bind('send-command', 'click', sendCommand);
  bind('command-input', 'keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCommand(); } });
  bind('broadcast-mode', 'change', () => { $('command-input').placeholder = $('broadcast-mode').checked ? 'Command for all active sessions. Review targets before sending.' : 'Enter a command here. Press Enter to send; Shift+Enter adds a line.'; updateWorkspaceStatus(); });
  bind('settings-button', 'click', openSettings);
  bind('settings-form', 'submit', saveSettings);
  bind('help-button', 'click', () => dialogOpen('help-dialog'));
  bind('edit-snippets', 'click', openSnippets);
  bind('add-snippet', 'click', () => addSnippetEditor().focus());
  bind('save-snippets', 'click', saveSnippets);
  bind('import-export', 'click', () => dialogOpen('import-dialog'));
  bind('welcome-import', 'click', () => dialogOpen('import-dialog'));
  bind('import-json', 'click', () => importConfiguration('json'));
  bind('import-securecrt', 'click', () => importConfiguration('securecrt'));
  bind('export-json', 'click', exportConfiguration);
  bind('footer-search', 'click', showSearch);
  bind('search-prev', 'click', () => findTerminal(true));
  bind('search-next', 'click', () => findTerminal());
  bind('search-case', 'change', () => findTerminal());
  bind('terminal-search-input', 'input', () => findTerminal());
  bind('terminal-search-input', 'keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); findTerminal(event.shiftKey); }
    if (event.key === 'Escape') { event.preventDefault(); $('close-search').click(); }
  });
  bind('close-search', 'click', () => { $('terminal-search-bar').hidden = true; connections.get(activeId)?.search.clearDecorations(); requestAnimationFrame(fitVisible); connections.get(activeId)?.term.focus(); });
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    if (!['t', 'k', 'f', 'w'].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === 't') localShell();
    if (key === 'k') { setPane('sessionManager', true); $('session-search').focus(); $('session-search').select(); }
    if (key === 'f') showSearch();
    if (key === 'w' && activeId) closeConnection(activeId);
  }, true);
  window.addEventListener('resize', () => requestAnimationFrame(fitVisible));
}

async function init() {
  setupHandlers();
  if (!api) {
    toast('The native Harbor bridge is unavailable. Start Harbor using the desktop application.', true);
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    renderSessions(); renderSnippets(); renderTabs();
    return;
  }
  if (typeof api.onMenuAction === 'function') api.onMenuAction((action) => { if (!document.querySelector('dialog[open]')) runAction(String(action)); });
  api.onTerminalData(handleTerminalData);
  api.onTerminalExit(handleTerminalExit);
  try {
    state = { ...state, ...await api.getState() };
    isMac = state.platform === 'darwin';
    $('platform-label').textContent = `${isMac ? 'macOS' : state.platform === 'win32' ? 'Windows' : 'Linux'}`;
    $('version-label').textContent = state.version ? `v${state.version}` : 'OSS';
    $('about-version').textContent = `Version ${state.version || 'development'} · MIT License`;
    $('search-shortcut').textContent = isMac ? '⌘ K' : 'Ctrl K';
    $('shortcut-hint').textContent = `${isMac ? '⌘' : 'Ctrl'} T for a local shell`;
    for (const element of document.querySelectorAll('[data-shortcut]')) element.textContent = `${isMac ? '⌘' : 'Ctrl'}${element.dataset.shift ? isMac ? ' ⇧' : ' Shift' : ''} ${element.dataset.shortcut}`;
    renderSessions(); renderSnippets(); renderTabs(); renderWorkspace(); applySettings(); updateWorkspaceStatus();
    ready = true;
  } catch (error) {
    $('workspace-status').textContent = 'Could not load the workspace';
    toast(`Could not load configuration: ${errorMessage(error)}`, true);
  }
}

init();
