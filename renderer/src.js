import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { installOptionDialogs, selectCategory, loadExtraProfile, readExtraProfile, loadExtraSettings, readExtraSettings, addKeywordRule } from './options.js';
import { installWorkspaceDialogs } from './workspace-dialogs.js';
import { createWorkflows } from './workflows.js';
import { attachKeywordHighlighting } from './highlighting.js';
import { createScriptUi } from './scripting.js';
import { createRecorder } from './recorder.js';
import { matchingMapping, decodeMappedText } from './keymap.js';
import { createTransferUi } from './transfers.js';
import './style.css';
import './extensions.css';
import './tab-groups.css';
import { resolveColorScheme } from '../app/color-schemes.cjs';
import { createColorPicker } from './color-picker.js';
import { applyInterfaceColors, applyTerminalColors } from './appearance.js';
import { createTabGroups } from './tab-groups.js';
import { createLocalAiUi } from './local-ai.js';
import './ai-draft.css';
import { createIcon } from './icons.js';
import './modern.css';
import './modern-ai.css';
import { createProjectUi } from './projects.js';

const api = window.termforge;
const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const bind = (id, event, fn) => $(id).addEventListener(event, fn);
let state = { sessions: [], snippets: [], snapshots: [], commandHistory: [], settings: { theme: 'light', fontSize: 13, scrollback: 10000 }, platform: 'darwin', version: '' };
const connections = new Map();
const pendingData = new Map();
const pendingExits = new Map();
const closedIds = new Set();
const collapsedFolders = new Set();
let activeId = null;
let aiDraft = null;
let tileView = false;
let tileOrientation = 'grid';
const tabGroups = createTabGroups();
const groupNodes = new Map();
let renderedTreeRoot;
let selectedButtonBar = 'Default';
let dragConnectionId = null;
let quickKeyword = '';
let notifiedActiveId = undefined;
let editingSessionId = null;
let editingConnectionId = null;
let selectedProtocol = 'ssh';
let isMac = true;
let confirmResolver = null;
let openingCount = 0;
let ready = false;
let selectedSessionId = null;
const selectedSessionIds = new Set();
let selectedFolderPath = null;
let focusedTreeKey = 'folder:';
let openMenuName = null;
let menuEditTarget = null;
let lastWorkspaceFocus = 'terminal';
const panes = { sessionManager: true, commandWindow: true, buttonBar: true };
const workflows = createWorkflows({ api, getState: () => state, setState: (patch) => { state = { ...state, ...patch }; }, getConnections: () => connections, getActiveId: () => activeId, activate, openConnection, closeConnection, reconnect, sendCommand, showSnippets: openSnippets, setPane, confirmAction, toast,
  getSelection: () => selectedSessionIds,
  setSelection: (ids) => { selectedSessionIds.clear(); for (const id of ids) selectedSessionIds.add(id); selectedSessionId = ids[0] || null; },
  getLayout: () => tabGroups.getLayout(),
  setLayout: (layout) => { if (layout.tile) tabGroups.tile(layout.orientation); else tabGroups.collapse(); refreshGroups(); },
  restoreLayout: (layout, idMap, previousLayout) => { if (tabGroups.restore(layout, idMap, previousLayout)) refreshGroups(); }, renderSessions, clearCommandDraft: clearAiDraft
});
const scripts = createScriptUi({ api, getActiveId: () => activeId, toast });
const recorder = createRecorder({ api, getConnection: () => connections.get(activeId), confirmAction, toast, changed: updateWorkspaceStatus });
const transfers = createTransferUi({ api });
const localAi = createLocalAiUi({ api, getConnection: () => connections.get(activeId) || null, stageCommand: stageAiCommand, reviewFileEdit: proposal => projectUi.reviewAiEdit(proposal), toast, onLayout: () => requestAnimationFrame(fitVisible) });
const projectUi = createProjectUi({ api, toast, confirmAction, getSettings: () => state.settings, onLayout: () => requestAnimationFrame(fitVisible), requestAiEdit: snapshot => localAi.attachFile(snapshot) });
const colorPicker = createColorPicker({
  getSettings: () => state.settings,
  async saveSettings(patch) {
    const saved = await api.saveSettings({ ...state.settings, ...patch });
    state.settings = saved;
    applySettings();
    toast('Color scheme saved. Open terminals updated.');
  },
});
function addToolbarIcons() {
  for (const button of document.querySelectorAll('[data-icon]')) {
    button.replaceChildren(createIcon(button.dataset.icon));
    if (button.dataset.iconLabel) button.append(make('span', 'tool-label', button.dataset.iconLabel));
  }
}

function selectedProfile() {
  return state.sessions.find((profile) => profile.id === selectedSessionId && selectedSessionIds.has(profile.id)) || null;
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
    const style = getComputedStyle(document.documentElement);
    localStorage.setItem('termforge-classic-layout', JSON.stringify({ panes, sidebarWidth: parseInt(style.getPropertyValue('--sidebar-width')) || 280, commandHeight: parseInt(style.getPropertyValue('--command-height')) || 128 }));
  } catch { /* Storage can be unavailable in restricted profiles. */ }
}

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('termforge-classic-layout') || 'null');
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(panes)) if (typeof saved.panes?.[key] === 'boolean') panes[key] = saved.panes[key];
      if (Number.isFinite(saved.sidebarWidth)) document.documentElement.style.setProperty('--sidebar-width', `${Math.max(160, Math.min(460, saved.sidebarWidth))}px`);
      if (Number.isFinite(saved.commandHeight)) document.documentElement.style.setProperty('--command-height', `${Math.max(94, Math.min(300, saved.commandHeight))}px`);
    }
  } catch { /* Ignore invalid layout preferences. */ }
  applyPaneVisibility();
}

function setupSplitters() {
  for (const [id, variable, axis, minimum, maximum] of [['sidebar-resizer', '--sidebar-width', 'x', 160, 460], ['command-resizer', '--command-height', 'y', 94, 300]]) {
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
  const stack = $('toast-stack');
  const key = JSON.stringify([message, error, path]);
  for (const previous of stack.children) if (previous.dataset.toastKey === key) previous.remove();
  const node = make('div', `toast${error ? ' error' : ''}`, message);
  node.dataset.toastKey = key;
  if (path) node.append(make('span', 'toast-path', path));
  stack.append(node);
  while (stack.children.length > 3) stack.firstElementChild.remove();
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
  if (profile.protocol === 'serial') return `${profile.serial?.path || 'Serial port'} · ${profile.serial?.baudRate || 9600} baud`;
  return `${profile.username ? `${profile.username}@` : ''}${profile.host || ''}${profile.port && Number(profile.port) !== 22 ? `:${profile.port}` : ''}`;
}

function sessionIcon(protocol) {
  return protocol === 'local' ? '›_' : protocol === 'sftp' ? '⇄' : '⌁';
}

function normalizeFolder(folder) {
  return String(folder || '').split(/[\\/]/).map((part) => part.trim()).filter(Boolean);
}

function selectSession(profile, focus = false, event = null) {
  if (!profile) return;
  if (event?.shiftKey && selectedSessionId) {
    const visible = [...$('session-list').querySelectorAll('.session-row')].map((row) => row.dataset.sessionId);
    const start = visible.indexOf(selectedSessionId); const end = visible.indexOf(profile.id);
    if (start >= 0 && end >= 0) { selectedSessionIds.clear(); for (const id of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) selectedSessionIds.add(id); }
  } else if (event?.metaKey || event?.ctrlKey) {
    if (selectedSessionIds.has(profile.id)) selectedSessionIds.delete(profile.id); else selectedSessionIds.add(profile.id);
  } else { selectedSessionIds.clear(); selectedSessionIds.add(profile.id); }
  selectedSessionId = profile.id;
  selectedFolderPath = null;
  focusedTreeKey = `session:${profile.id}`;
  for (const row of $('session-list').querySelectorAll('.session-row')) {
    const selected = selectedSessionIds.has(row.dataset.sessionId);
    row.classList.toggle('selected', selected);
    const button = row.querySelector('.session-main'); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  }
  for (const folder of $('session-list').querySelectorAll('.folder-heading')) { folder.classList.remove('selected'); folder.tabIndex = -1; }
  $('session-selection').textContent = selectedSessionIds.size > 1 ? `${selectedSessionIds.size} sessions selected. Connect or edit their options.` : `${profile.protocol.toUpperCase()} · ${profileDetail(profile)}`;
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
  for (const id of selectedSessionIds) if (!state.sessions.some((profile) => profile.id === id)) selectedSessionIds.delete(id);
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
    heading.append(make('span', 'tree-chevron', collapsed ? '▸' : '▾'), createIcon('folder', 'folder-icon'), make('span', 'folder-name', folder.name), make('span', 'folder-count', String(folder.count)));
    heading.addEventListener('click', () => {
      selectedFolderPath = folder.path; selectedSessionId = null; selectedSessionIds.clear(); focusedTreeKey = key;
      if (collapsedFolders.has(folder.path)) collapsedFolders.delete(folder.path); else collapsedFolders.add(folder.path);
      renderSessions(); updateToolbar(); focusTreeItem(key);
    });
    heading.addEventListener('focus', () => { focusedTreeKey = key; });
    heading.addEventListener('contextmenu', (event) => { event.preventDefault(); selectedFolderPath = folder.path; selectedSessionId = null; selectedSessionIds.clear(); focusedTreeKey = key; renderSessions(); updateToolbar(); showSessionContext(event.clientX, event.clientY, null, folder.path); });
    group.append(heading);
    if (!collapsed) {
      const children = make('div', 'tree-children'); children.setAttribute('role', 'group');
      for (const child of [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) children.append(renderFolder(child, level + 1));
      for (const profile of [...folder.profiles].sort((a, b) => a.name.localeCompare(b.name))) {
        const connected = [...connections.values()].some((connection) => connection.profile.id === profile.id && !connection.exited);
        const row = make('div', `session-row${connected ? ' connected' : ''}${selectedSessionIds.has(profile.id) ? ' selected' : ''}`);
        row.dataset.sessionId = profile.id;
        const icon = createIcon(profile.protocol === 'sftp' ? 'transfer' : 'terminal', 'session-icon');
        const main = make('button', 'session-main'); main.dataset.treeKey = `session:${profile.id}`; main.dataset.treeKind = 'session'; main.dataset.sessionId = profile.id;
        main.setAttribute('role', 'treeitem'); main.setAttribute('aria-level', String(level + 1)); main.setAttribute('aria-selected', String(selectedSessionIds.has(profile.id)));
        main.tabIndex = focusedTreeKey === main.dataset.treeKey ? 0 : -1;
        main.title = `${profile.name} · ${profile.protocol.toUpperCase()} · ${profileDetail(profile)}${profile.description ? ` — ${profile.description}` : ''}`;
        main.append(make('strong', '', profile.name));
        main.addEventListener('focus', () => { focusedTreeKey = main.dataset.treeKey; });
        row.addEventListener('click', (event) => selectSession(profile, true, event));
        row.addEventListener('dblclick', () => openConnection(profile));
        row.addEventListener('contextmenu', (event) => { event.preventDefault(); if (!selectedSessionIds.has(profile.id)) selectSession(profile); showSessionContext(event.clientX, event.clientY, profile, null); });
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
  $('session-selection').textContent = selectedSessionIds.size > 1 ? `${selectedSessionIds.size} sessions selected. Connect or edit their options.` : selected ? `${selected.protocol.toUpperCase()} · ${profileDetail(selected)}` : 'Double-click a session to connect.';
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
    else { selectedFolderPath = node.dataset.folderPath; selectedSessionId = null; selectedSessionIds.clear(); updateToolbar(); }
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
  const bars = [...new Set(['Default', ...state.snippets.map((snippet) => snippet.buttonBar || 'Default')])];
  if (!bars.includes(selectedButtonBar)) selectedButtonBar = 'Default';
  $('button-bar-select').replaceChildren(...bars.map((bar) => { const option = make('option', '', bar); option.value = bar; return option; }));
  $('button-bar-select').value = selectedButtonBar;
  const nodes = state.snippets.filter((snippet) => (snippet.buttonBar || 'Default') === selectedButtonBar).map((snippet) => {
    const button = make('button', 'snippet-button');
    const dot = make('span', 'command-color'); if (/^#[a-f0-9]{6}$/i.test(snippet.color || '')) dot.style.backgroundColor = snippet.color;
    button.append(dot, make('span', '', snippet.name));
    button.title = `${snippet.command} — places text in the Command Window for review`;
    button.addEventListener('click', () => {
      setPane('commandWindow', true);
      $('command-input').value = snippet.command;
      clearAiDraft();
      $('command-input').focus();
    });
    return button;
  });
  if (!nodes.length) nodes.push(make('p', 'snippet-empty', 'No buttons configured. Use the options button to add commands.'));
  $('snippet-list').replaceChildren(...nodes);
  workflows.refresh();
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
  $('profile-protocol-select').value = protocol;
  const remote = ['ssh', 'sftp', 'telnet', 'raw'].includes(protocol);
  const ssh = ['ssh', 'sftp'].includes(protocol);
  for (const button of document.querySelectorAll('[data-protocol]')) {
    const selected = button.dataset.protocol === protocol;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  $('remote-fields').hidden = !remote;
  $('local-fields').hidden = protocol !== 'local';
  $('profile-host').required = remote;
  $('profile-port').required = remote;
  for (const input of $('remote-fields').querySelectorAll('input, select')) input.disabled = !remote;
  for (const id of ['profile-username', 'profile-identity', 'profile-jump']) { $(id).closest('label').hidden = !ssh; $(id).disabled = !ssh; }
  for (const input of $('profile-dialog-ssh').querySelectorAll('input, select, textarea')) input.disabled = !ssh;
  for (const input of $('profile-dialog-serial').querySelectorAll('input, select')) input.disabled = protocol !== 'serial';
  $('profile-serial-path').required = protocol === 'serial';
  for (const key of ['ssh', 'serial']) $('profile-dialog').querySelector(`.category-item[data-category="${key}"]`).disabled = key === 'ssh' ? !ssh : protocol !== 'serial';
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
  editingConnectionId = profile && !profile.id ? [...connections.values()].find(connection => connection.profile === profile)?.id || null : null;
  $('profile-form').reset();
  $('profile-dialog-title').textContent = profile ? `Session Options — ${profile.name}` : 'New Session';
  $('save-profile').textContent = profile ? 'Save changes' : 'Save session';
  $('profile-error').hidden = true;
  for (const [field, key] of [['name', 'name'], ['folder', 'folder'], ['host', 'host'], ['port', 'port'], ['username', 'username'], ['identity', 'identityFile'], ['jump', 'jumpHost'], ['cwd', 'cwd'], ['description', 'description'], ['color', 'color']]) {
    $(`profile-${field}`).value = String(profile?.[key] ?? (field === 'port' ? 22 : field === 'color' ? '#83d5bf' : ''));
  }
  $('forwarding-list').replaceChildren();
  for (const forwarding of profile?.forwardings || []) addForwarding(forwarding);
  $('remote-fields').querySelector('details').open = Boolean(profile?.jumpHost || profile?.forwardings?.length);
  loadExtraProfile(profile || {});
  setProtocol(profile?.protocol || 'ssh');
  selectCategory('profile-dialog', 'connection');
  dialogOpen('profile-dialog');
  $('profile-name').focus();
}

function readProfile() {
  const profile = {
    name: $('profile-name').value.trim(), protocol: selectedProtocol, folder: $('profile-folder').value.trim(),
    host: ['local', 'serial'].includes(selectedProtocol) ? '' : $('profile-host').value.trim(),
    port: ['local', 'serial'].includes(selectedProtocol) ? 22 : Number($('profile-port').value),
    username: ['ssh', 'sftp'].includes(selectedProtocol) ? $('profile-username').value.trim() : '',
    identityFile: ['ssh', 'sftp'].includes(selectedProtocol) ? $('profile-identity').value.trim() : '',
    jumpHost: ['ssh', 'sftp'].includes(selectedProtocol) ? $('profile-jump').value.trim() : '',
    cwd: selectedProtocol === 'local' ? $('profile-cwd').value.trim() : '',
    description: $('profile-description').value.trim(), color: $('profile-color').value,
    forwardings: [],
    ...readExtraProfile(),
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
    selectedSessionId = saved.id; selectedSessionIds.clear(); selectedSessionIds.add(saved.id); selectedFolderPath = null; focusedTreeKey = `session:${saved.id}`;
    for (const part of normalizeFolder(saved.folder).map((_, index, parts) => parts.slice(0, index + 1).join('/'))) collapsedFolders.delete(part);
    collapsedFolders.delete(''); renderSessions();
    workflows.refresh();
    let updated = false;
    for (const connection of connections.values()) {
      if (connection.profile.id !== saved.id && connection.id !== editingConnectionId) continue;
      // Transport and keyboard settings belong to the running connection.
      // Appearance can change without reopening it or clearing its output.
      const terminal = { ...connection.profile.terminal };
      for (const key of ['colorScheme', 'fontFamily', 'fontSize', 'cursorStyle', 'cursorBlink']) terminal[key] = saved.terminal?.[key];
      connection.profile = { ...connection.profile, id: saved.id, terminal };
      updated = true;
    }
    if (updated) { applySettings(); renderSessions(); }
    toast(updated ? 'Session saved. Appearance updated; connection changes apply next time.' : 'Session saved. Double-click it in Session Manager to connect.');
  } catch (error) { selectCategory('profile-dialog', 'connection'); $('profile-error').textContent = errorMessage(error); $('profile-error').hidden = false; }
  finally { $('save-profile').disabled = false; }
}

function terminalTheme(profile = {}) {
  return { ...resolveColorScheme(profile.terminal?.colorScheme, state.settings.colorScheme).theme };
}

function terminalOptions(profile = {}) {
  const options = profile.terminal || {};
  return {
    theme: terminalTheme(profile), fontFamily: options.fontFamily || state.settings.fontFamily || '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: Number(options.fontSize || state.settings.fontSize), scrollback: Number(options.scrollback || state.settings.scrollback),
    cursorStyle: options.cursorStyle || state.settings.cursorStyle || 'block', cursorBlink: options.cursorBlink ?? state.settings.cursorBlink ?? true,
    wordSeparator: state.settings.wordDelimiters || ' ()[]{}\'"', macOptionIsMeta: Boolean(options.emacsMode),
  };
}

function keywordSettings() {
  return { ...state.settings, keywords: [...(state.settings.keywords || []), ...(quickKeyword ? [{ text: quickKeyword, foreground: '#000000', background: '#70e330', caseSensitive: false }] : [])], keywordHighlightEnabled: state.settings.keywordHighlightEnabled !== false };
}

function applySettings() {
  applyInterfaceColors(state.settings);
  projectUi.applyTheme?.();
  for (const connection of connections.values()) {
    Object.assign(connection.term.options, terminalOptions(connection.profile));
    applyTerminalColors(connection, state.settings.colorScheme);
    connection.highlight.refresh();
  }
  $('keyword-toggle').setAttribute('aria-pressed', String(state.settings.keywordHighlightEnabled !== false));
  requestAnimationFrame(fitVisible);
}

function createConnection(response, profile, oldId = null) {
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
    ...terminalOptions(profile), allowProposedApi: true,
    convertEol: false, rightClickSelectsWord: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const connection = { id: response.id, title: response.title || profile.name, protocol: response.protocol || profile.protocol, profile: { ...profile }, pane, mount, term, fit, search, exitBar, exitLabel, logButton, exited: false, logging: false, logPaused: false, reconnecting: false, writeErrorShown: false };
  connections.set(response.id, connection);
  if (!oldId || !tabGroups.replace(oldId, response.id)) tabGroups.add(response.id);
  $('terminal-workspace').append(pane);
  term.open(mount);
  applyTerminalColors(connection, state.settings.colorScheme);
  connection.highlight = attachKeywordHighlighting(term, keywordSettings);
  term.onData((data) => { if (connection.profile.terminal?.localEcho && !connection.exited) term.write(data.replace(/\r/g, '\r\n')); writeToConnection(connection, data); });
  term.onSelectionChange(() => { if (state.settings.copyOnSelect && term.hasSelection()) copySelection(connection); });
  term.onBell(() => { if (state.settings.bellStyle === 'visual') { pane.classList.add('visual-bell'); window.setTimeout(() => pane.classList.remove('visual-bell'), 120); } });
  term.onResize(({ cols, rows }) => {
    if (!connection.exited) Promise.resolve(api.terminalResize({ id: connection.id, cols, rows })).catch(() => {});
    if (activeId === connection.id) updateWorkspaceStatus();
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const mapping = matchingMapping(event, connection.profile.terminal?.mappedKeys);
    if (mapping) { event.preventDefault(); applyMappedKey(connection, mapping); return false; }
    const copy = (isMac ? event.metaKey : event.ctrlKey && event.shiftKey) && event.key.toLowerCase() === 'c';
    const paste = (isMac ? event.metaKey : event.ctrlKey && event.shiftKey) && event.key.toLowerCase() === 'v';
    if (copy) { event.preventDefault(); copySelection(connection); return false; }
    if (paste) { event.preventDefault(); pasteClipboard(connection); return false; }
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === 'Backspace' && profile.terminal?.backspaceMode === 'bs') { event.preventDefault(); writeToConnection(connection, '\x08'); return false; }
      if (event.key === 'Delete' && profile.terminal?.deleteMode === 'del') { event.preventDefault(); writeToConnection(connection, '\x7f'); return false; }
    }
    if ((isMac ? event.metaKey : event.ctrlKey) && ['t', 'k', 'f', 'w'].includes(event.key.toLowerCase()) && !event.altKey) return false;
    return true;
  });
  if (term.textarea && typeof api.terminalFocus === 'function') {
    term.textarea.addEventListener('focus', () => Promise.resolve(api.terminalFocus({ id: connection.id, focused: true })).catch(() => {}));
    term.textarea.addEventListener('blur', () => Promise.resolve(api.terminalFocus({ id: connection.id, focused: false })).catch(() => {}));
  }
  mount.addEventListener('paste', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData?.getData('text/plain');
    if (text !== undefined) pasteText(connection, text);
    else pasteClipboard(connection);
  }, true);
  mount.addEventListener('contextmenu', (event) => { if (state.settings.pasteOnRightClick) { event.preventDefault(); pasteClipboard(connection); } });
  pane.addEventListener('mousedown', () => { if (activeId !== connection.id) activate(connection.id, false); });
  mount.addEventListener('focusin', () => { if (activeId !== connection.id) activate(connection.id, false); });
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

function handleScreenRequest(request) {
  const connection = connections.get(request.id);
  const reply = (response) => Promise.resolve(api.screenResponse({ requestId: request.requestId, ...response })).catch(() => {});
  if (!connection) { reply({ error: 'Terminal screen is no longer available.' }); return; }
  // A zero-length write flushes earlier output before reading rendered cells.
  connection.term.write('', () => {
    if (!connections.has(connection.id)) { reply({ error: 'Terminal screen is no longer available.' }); return; }
    const term = connection.term; const buffer = term.buffer.active;
    const startRow = request.startRow ?? 1; const endRow = request.endRow ?? term.rows;
    const startColumn = request.startColumn ?? 1; const endColumn = request.endColumn ?? term.cols;
    if (![startRow, endRow, startColumn, endColumn].every(Number.isInteger) || startRow < 1 || startColumn < 1 || endRow > term.rows || endColumn > term.cols || endRow < startRow || endColumn < startColumn) { reply({ error: 'Screen rectangle is outside the rendered terminal.' }); return; }
    const lines = [];
    for (let row = startRow; row <= endRow; row += 1) lines.push(buffer.getLine(buffer.baseY + row - 1)?.translateToString(false, startColumn - 1, endColumn) || '');
    reply({ text: lines.join('\r\n'), rows: term.rows, columns: term.cols, currentRow: Math.min(term.rows, buffer.cursorY + 1), currentColumn: Math.min(term.cols, buffer.cursorX + 1) });
  });
}

function handleTerminalExit(event) {
  recorder.exited(event.id);
  if (closedIds.has(event.id)) return;
  const connection = connections.get(event.id);
  if (!connection) { pendingExits.set(event.id, event); return; }
  connection.exited = true;
  connection.logging = false;
  connection.logPaused = false;
  connection.logButton.disabled = true;
  connection.logButton.textContent = 'Log';
  connection.logButton.classList.remove('logging');
  connection.exitBar.hidden = false;
  connection.exitLabel.textContent = `Connection ended${event.exitCode !== undefined && event.exitCode !== null ? ` · exit ${event.exitCode}` : ''}${event.signal ? ` · ${event.signal}` : ''}. Terminal output is retained.`;
  renderTabs(); renderSessions(); updateWorkspaceStatus();
  if (state.settings.closeOnExit && !connection.reconnecting) {
    requestAnimationFrame(() => { if (connections.get(connection.id) === connection && !connection.reconnecting) disposeConnection(connection.id); });
    return;
  }
  requestAnimationFrame(() => safeFit(connection));
}

async function openConnection(profile, oldId = null) {
  if (!ready) { toast('The workspace is still loading. Please try again in a moment.'); return null; }
  if (profile.id) profile = state.sessions.find((session) => session.id === profile.id) || profile;
  openingCount += 1;
  updateWorkspaceStatus();
  try {
    const result = await api.terminalOpen(profile.id ? { sessionId: profile.id } : { profile });
    const connection = createConnection(result, profile, oldId);
    if (oldId) disposeConnection(oldId);
    activate(connection.id);
    if (projectUi.isOpen()) projectUi.showTerminal?.();
    renderSessions(); workflows.refresh();
    return connection;
  } catch (error) { toast(`Could not open ${profile.name}: ${errorMessage(error)}`, true); return null; }
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
  tabGroups.activate(id);
  activeId = id;
  renderTabs();
  renderWorkspace();
  updateWorkspaceStatus();
  requestAnimationFrame(() => {
    fitVisible();
    if (focus && !document.querySelector('dialog[open]')) connections.get(id)?.term.focus();
  });
}

function clearTabDrag() {
  dragConnectionId = null;
  for (const node of document.querySelectorAll('.drop-before, .drop-target')) node.classList.remove('drop-before', 'drop-target');
  for (const node of document.querySelectorAll('[data-drop-edge]')) delete node.dataset.dropEdge;
}

function syncConnectionOrder() {
  const ids = tabGroups.ordered().flatMap(group => group.tabs).filter(id => connections.has(id));
  if (ids.length !== connections.size || ids.every((id, index) => id === [...connections.keys()][index])) return;
  const order = ids.map(id => connections.get(id));
  connections.clear(); for (const connection of order) connections.set(connection.id, connection);
  if (api?.terminalReorder) Promise.resolve(api.terminalReorder(order.filter(entry => !entry.exited).map(entry => entry.id))).catch(error => toast(`Could not update script tab order: ${errorMessage(error)}`, true));
}

function refreshGroups(focus = true) {
  activeId = tabGroups.activeId;
  syncConnectionOrder(); renderTabs(); renderWorkspace(); updateWorkspaceStatus();
  requestAnimationFrame(() => { fitVisible(); if (focus && !document.querySelector('dialog[open]')) connections.get(activeId)?.term.focus(); });
}

function bindStripDrop(strip, getGroupId) {
  strip.addEventListener('dragover', event => { if (dragConnectionId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; strip.classList.add('drop-target'); } });
  strip.addEventListener('dragleave', event => { if (!strip.contains(event.relatedTarget)) strip.classList.remove('drop-target'); });
  strip.addEventListener('drop', event => {
    if (!dragConnectionId) return;
    event.preventDefault(); event.stopPropagation();
    const changed = tabGroups.move(dragConnectionId, getGroupId()); clearTabDrag(); if (changed) refreshGroups();
  });
}

function ensureGroupNode(group) {
  if (groupNodes.has(group.id)) return groupNodes.get(group.id);
  const node = make('section', 'tab-group'); node.dataset.groupId = group.id;
  const strip = make('div', 'tab-strip tab-group-strip'); strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Sessions in tab group');
  const body = make('div', 'tab-group-body');
  bindStripDrop(strip, () => group.id);
  const dropEdge = event => {
    const source = tabGroups.groupFor(dragConnectionId);
    if (!source || source.id === group.id && source.tabs.length < 2) return 'center';
    const rect = body.getBoundingClientRect();
    const right = rect.right - event.clientX; const bottom = rect.bottom - event.clientY;
    if (right < Math.min(70, rect.width * 0.25) && right / rect.width < bottom / rect.height) return 'vertical';
    if (bottom < Math.min(60, rect.height * 0.25)) return 'horizontal';
    return 'center';
  };
  body.addEventListener('dragover', event => {
    if (!dragConnectionId) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; body.dataset.dropEdge = dropEdge(event);
  });
  body.addEventListener('dragleave', event => { if (!body.contains(event.relatedTarget)) delete body.dataset.dropEdge; });
  body.addEventListener('drop', event => {
    if (!dragConnectionId) return;
    event.preventDefault(); event.stopPropagation();
    const edge = dropEdge(event);
    const changed = edge === 'center' ? tabGroups.move(dragConnectionId, group.id) : tabGroups.split(dragConnectionId, group.id, edge);
    clearTabDrag(); if (changed) refreshGroups();
  });
  node.append(strip, body);
  const entry = { node, strip, body }; groupNodes.set(group.id, entry); return entry;
}

function renderTab(connection, group) {
  const selected = connection.id === group.activeId;
  const tab = make('div', `terminal-tab${selected ? ' active' : ''}`);
  tab.dataset.connectionId = connection.id; tab.draggable = true; tab.setAttribute('role', 'presentation');
  tab.addEventListener('dragstart', event => { dragConnectionId = connection.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', connection.id); });
  tab.addEventListener('dragover', event => {
    if (dragConnectionId && dragConnectionId !== connection.id) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; tab.classList.add('drop-before'); }
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drop-before'));
  tab.addEventListener('drop', event => {
    if (!dragConnectionId) return;
    event.preventDefault(); event.stopPropagation();
    const changed = tabGroups.move(dragConnectionId, group.id, connection.id); clearTabDrag(); if (changed) refreshGroups();
  });
  tab.addEventListener('dragend', clearTabDrag);
  const dot = make('span', `tab-dot ${connection.exited ? 'exited' : 'active'}`);
  if (!connection.exited && /^#[0-9a-f]{6}$/i.test(connection.profile.color || '')) dot.style.backgroundColor = connection.profile.color;
  const button = make('button', 'tab-label', connection.title);
  button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(selected));
  button.setAttribute('aria-controls', `pane-${connection.id}`); button.tabIndex = selected ? 0 : -1;
  connection.pane.id = `pane-${connection.id}`;
  button.title = `${connection.title} · ${connection.exited ? 'Ended' : 'Open'}`;
  button.addEventListener('click', () => activate(connection.id));
  button.addEventListener('dblclick', () => openConnection({ ...connection.profile }));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = group.tabs.indexOf(connection.id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? group.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + group.tabs.length) % group.tabs.length;
    activate(group.tabs[next], false);
    document.querySelector(`.terminal-tab[data-connection-id="${group.tabs[next]}"] .tab-label`)?.focus();
  });
  tab.append(dot, button);
  if (connection.logging) tab.append(make('span', 'tab-log-dot', '●'));
  const close = make('button', 'icon-button', '×'); close.title = `Close ${connection.title}`; close.setAttribute('aria-label', close.title);
  close.addEventListener('click', () => closeConnection(connection.id)); tab.append(close);
  return tab;
}

function renderTabs() {
  const groups = tabGroups.ordered();
  const grouped = groups.length > 1;
  $('tab-strip').replaceChildren();
  for (const group of groups) {
    const entry = ensureGroupNode(group);
    const nodes = group.tabs.map(id => connections.get(id)).filter(Boolean).map(connection => renderTab(connection, group));
    entry.strip.hidden = !grouped;
    if (grouped) entry.strip.replaceChildren(...nodes);
    else { entry.strip.replaceChildren(); $('tab-strip').replaceChildren(...nodes); }
  }
  $('tab-strip').hidden = grouped;
  $('connection-count').textContent = `${connections.size} session${connections.size === 1 ? '' : 's'}`;
  $('toggle-tile').disabled = connections.size < 1;
  workflows.renderActive();
}

function renderGroupTree(node) {
  if (node.groupId) return ensureGroupNode(tabGroups.groupById(node.groupId)).node;
  const split = make('div', 'tab-group-split'); split.dataset.direction = node.direction;
  const first = renderGroupTree(node.first); const second = renderGroupTree(node.second);
  const divider = make('div', 'group-divider'); divider.tabIndex = 0;
  divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', `Resize ${node.direction} tab groups`);
  divider.setAttribute('aria-orientation', node.direction); divider.setAttribute('aria-valuemin', '10'); divider.setAttribute('aria-valuemax', '90');
  const resize = value => {
    node.ratio = Math.max(0.1, Math.min(0.9, value));
    first.style.flexGrow = String(node.ratio); second.style.flexGrow = String(1 - node.ratio);
    split.dataset.ratio = String(node.ratio); divider.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)));
    divider.setAttribute('aria-valuetext', `${Math.round(node.ratio * 100)} percent`);
    requestAnimationFrame(fitVisible);
  };
  divider.addEventListener('keydown', event => {
    const decrease = node.direction === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const increase = node.direction === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (![decrease, increase, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); resize(event.key === 'Home' ? 0.1 : event.key === 'End' ? 0.9 : node.ratio + (event.key === increase ? 0.05 : -0.05));
  });
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); divider.focus(); divider.setPointerCapture(event.pointerId); divider.classList.add('resizing');
    const rect = split.getBoundingClientRect();
    const move = moveEvent => { if (moveEvent.pointerId === event.pointerId) resize(node.direction === 'vertical' ? (moveEvent.clientX - rect.left) / rect.width : (moveEvent.clientY - rect.top) / rect.height); };
    const stop = () => { divider.classList.remove('resizing'); divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', stop); divider.removeEventListener('pointercancel', stop); divider.removeEventListener('lostpointercapture', stop); };
    divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', stop); divider.addEventListener('pointercancel', stop); divider.addEventListener('lostpointercapture', stop);
  });
  split.append(first, divider, second); resize(node.ratio);
  return split;
}

function renderWorkspace() {
  const groups = tabGroups.ordered(); const layout = tabGroups.getLayout();
  tileView = groups.length > 1; tileOrientation = layout.orientation;
  const hasConnections = connections.size > 0;
  $('welcome').hidden = hasConnections;
  const workspace = $('terminal-workspace'); workspace.hidden = !hasConnections;
  $('tab-strip').hidden = tileView;
  applyPaneVisibility(); $('footer-search').hidden = !hasConnections;
  workspace.classList.add('group-workspace'); workspace.classList.toggle('tiles', tileView); workspace.classList.toggle('single-tile', connections.size === 1);
  workspace.dataset.orientation = tileOrientation; $('toggle-tile').setAttribute('aria-pressed', String(tileView));
  if (tabGroups.tree !== renderedTreeRoot) {
    workspace.replaceChildren(...(tabGroups.tree ? [renderGroupTree(tabGroups.tree)] : [])); renderedTreeRoot = tabGroups.tree;
  }
  for (const group of groups) {
    const entry = ensureGroupNode(group); entry.node.classList.toggle('active-group', group.id === layout.activeGroupId);
    for (const id of group.tabs) {
      const connection = connections.get(id); if (!connection) continue;
      if (connection.pane.parentNode !== entry.body) entry.body.append(connection.pane);
      connection.pane.hidden = id !== group.activeId; connection.pane.classList.toggle('active', id === activeId);
    }
  }
  for (const [id, entry] of groupNodes) if (!tabGroups.groupById(id)) { entry.node.remove(); groupNodes.delete(id); }
  syncConnectionOrder();
  if (!hasConnections) { $('terminal-search-bar').hidden = true; $('broadcast-mode').checked = false; }
}

function updateToolbar() {
  const current = connections.get(activeId);
  const selected = selectedProfile();
  for (const id of ['connect-session', 'sidebar-connect']) $(id).disabled = !selectedSessionIds.size && selectedFolderPath === null;
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
  const liveId = current && !current.exited ? current.id : null;
  if (notifiedActiveId !== liveId && typeof api?.terminalActivate === 'function') { notifiedActiveId = liveId; Promise.resolve(api.terminalActivate(liveId)).catch(() => {}); }
  const liveCount = [...connections.values()].filter((connection) => !connection.exited).length;
  $('workspace-status').textContent = openingCount ? `Opening${openingCount > 1 ? ` (${openingCount})` : ''}…` : current ? `${recorder.isRecording() ? 'Recording input · ' : ''}${current.exited ? 'Terminal ended' : 'Terminal open'} · ${profileDetail(current.profile) || current.title}` : 'Ready';
  $('status-protocol').textContent = current ? current.protocol === 'ssh' ? 'SSH2' : current.protocol.toUpperCase() : '—';
  $('status-size').textContent = current ? `${current.term.cols} × ${current.term.rows}` : '—';
  $('send-command').disabled = !liveCount || (!current || current.exited) && !$('broadcast-mode').checked;
  updateToolbar();
  workflows.renderActive();
}

async function writeToConnection(connection, data) {
  if (!connection || connection.exited) return;
  try { await api.terminalWrite({ id: connection.id, data }); recorder.input(connection, data); }
  catch (error) {
    if (!connection.writeErrorShown) { toast(`Could not send input: ${errorMessage(error)}`, true); connection.writeErrorShown = true; }
  }
}
function applyMappedKey(connection, mapping) {
  try { if (mapping.action === 'menu') runAction(mapping.value); else writeToConnection(connection, decodeMappedText(mapping.value)); }
  catch (error) { toast(errorMessage(error), true); }
}

function disposeConnection(id) {
  const connection = connections.get(id);
  if (!connection) return;
  const wasActive = activeId === id;
  closedIds.add(id);
  connection.observer.disconnect();
  connection.highlight.dispose();
  connection.term.dispose();
  connection.pane.remove();
  connections.delete(id);
  tabGroups.remove(id);
  pendingData.delete(id); pendingExits.delete(id);
  activeId = tabGroups.activeId;
  renderTabs(); renderWorkspace(); renderSessions(); updateWorkspaceStatus();
  requestAnimationFrame(() => {
    fitVisible();
    if (wasActive && !document.querySelector('dialog[open]')) connections.get(activeId)?.term.focus();
  });
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
    connection.logPaused = false;
    connection.logButton.textContent = connection.logging ? '● Logging' : 'Log';
    connection.logButton.classList.toggle('logging', connection.logging);
    renderTabs(); updateToolbar();
    toast(connection.logging ? 'Session logging started.' : 'Session logging stopped.', false, result.path || '');
  } catch (error) { toast(errorMessage(error), true); }
  finally { connection.logButton.disabled = connection.exited; }
}

function clearAiDraft() {
  aiDraft = null;
  if ($('ai-draft-notice')) $('ai-draft-notice').hidden = true;
}

function stageAiCommand(text, targetId) {
  const target = connections.get(targetId);
  if (!target || target.exited || activeId !== targetId) throw new Error('Return to the original active terminal before using this command.');
  if (typeof text !== 'string' || !text.trim() || text.length > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error('This suggestion contains unsupported control characters or is too long.');
  aiDraft = { id: targetId, target, title: target.title };
  setPane('commandWindow', true);
  $('broadcast-mode').checked = false;
  $('command-input').value = text;
  $('command-input').placeholder = 'Review this AI suggestion before sending it to the original terminal.';
  $('ai-draft-label').textContent = `AI draft for ${target.title} — review before sending`;
  $('ai-draft-notice').hidden = false;
  $('command-input').focus();
  updateWorkspaceStatus();
  return true;
}

async function sendCommand() {
  const raw = $('command-input').value;
  if (!raw.trim()) return;
  const draft = aiDraft;
  const validDraft = () => aiDraft === draft && activeId === draft.id && connections.get(draft.id) === draft.target && !draft.target.exited && !$('broadcast-mode').checked && $('command-input').value === raw;
  if (draft && !validDraft()) { toast('AI drafts can only be sent to their original active terminal with broadcast disabled.', true); return; }
  let targets = $('broadcast-mode').checked ? [...connections.values()].filter((c) => !c.exited) : [connections.get(activeId)].filter((c) => c && !c.exited);
  if (!targets.length) { toast('There is no active terminal to receive this command.'); return; }
  if (draft || $('broadcast-mode').checked || /[\r\n]/.test(raw)) {
    const accepted = await confirmAction({ title: draft ? 'Review AI command' : targets.length > 1 ? `Send to ${targets.length} terminals?` : 'Review command', message: 'This sends the command exactly as shown, followed by Enter. Check each target before continuing.', preview: raw, targets: targets.map((c) => `${c.title} · ${c.protocol.toUpperCase()} · ${profileDetail(c.profile)}`), accept: targets.length > 1 ? 'Send to all targets' : 'Send command', eyebrow: draft ? 'AI COMMAND PREVIEW' : 'COMMAND PREVIEW' });
    if (!accepted) return;
    if (draft && !validDraft()) { toast('The AI draft or active target changed during review. Review the command again.', true); return; }
    targets = targets.filter((c) => connections.has(c.id) && !c.exited);
    if (!targets.length) { toast('The target connections ended before sending.'); return; }
  }
  let failed = 0;
  for (const connection of targets) {
    try { const data = `${raw.replace(/\r?\n/g, '\r')}\r`; await api.terminalWrite({ id: connection.id, data }); recorder.input(connection, data); }
    catch (error) { failed += 1; toast(`Could not send to ${connection.title}: ${errorMessage(error)}`, true); }
  }
  if (failed < targets.length) {
    try { await workflows.recordHistory(raw); } catch (error) { toast(`Command sent, but history could not be saved: ${errorMessage(error)}`, true); }
  }
  if (!failed && $('command-input').value === raw && aiDraft === draft) { $('command-input').value = ''; clearAiDraft(); }
  connections.get(activeId)?.term.focus();
}

async function copySelection(connection) {
  const selection = connection.term.getSelection();
  if (!selection) return;
  try { await api.clipboardWrite(selection); } catch (error) { toast(errorMessage(error), true); }
}

function focusedEditTarget() {
  const target = document.activeElement;
  if (projectUi.handlesEditTarget?.(target)) return target;
  return target && target.matches('input, textarea') && !target.classList.contains('xterm-helper-textarea') ? target : null;
}

async function editField(action, target) {
  if (!target.isConnected || target.disabled) return;
  target.focus();
  if (action === 'undo' || action === 'redo') { document.execCommand(action); return; }
  if (action === 'select-all') { target.select(); return; }
  const value = target.value;
  const start = Number.isInteger(target.selectionStart) ? target.selectionStart : 0;
  const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : value.length;
  if (action === 'copy' || action === 'cut') {
    if (end > start) await api.clipboardWrite(value.slice(start, end));
    if (action === 'cut' && !target.readOnly && target.isConnected && document.activeElement === target && target.value === value && target.selectionStart === start && target.selectionEnd === end) { target.setRangeText('', start, end, 'end'); target.dispatchEvent(new Event('input', { bubbles: true })); }
    return;
  }
  if (target.readOnly) return;
  let inserted = await api.clipboardRead();
  // A clipboard operation must never spill into a terminal or overwrite a
  // different edit that became active while the native clipboard was read.
  if (!target.isConnected || target.disabled || target.readOnly || document.activeElement !== target || target.value !== value || (Number.isInteger(target.selectionStart) && (target.selectionStart !== start || target.selectionEnd !== end))) return;
  if (typeof inserted !== 'string') return;
  if (target.maxLength >= 0) inserted = inserted.slice(0, Math.max(0, target.maxLength - value.length + end - start));
  if (Number.isInteger(target.selectionStart)) target.setRangeText(inserted, start, end, 'end');
  else target.value = inserted;
  target.dispatchEvent(new Event('input', { bubbles: true }));
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
  if (/[\r\n]/.test(text) && state.settings.confirmPaste !== false) {
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
  loadExtraSettings(state.settings); selectCategory('settings-dialog', 'general');
  dialogOpen('settings-dialog');
}

async function saveSettings(event) {
  event.preventDefault();
  const button = $('settings-form').querySelector('[type="submit"]');
  button.disabled = true;
  try {
    state.settings = await api.saveSettings({ ...state.settings, ...readExtraSettings(), theme: $('settings-theme').value, fontSize: Number($('settings-font').value), scrollback: Number($('settings-scrollback').value) });
    applySettings();
    workflows.renderHistory();
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
  const properties = make('div', 'snippet-properties');
  const folder = make('input'); folder.value = snippet.folder || ''; folder.placeholder = 'Folder, e.g. Admin/Network'; folder.dataset.field = 'folder'; folder.maxLength = 160; folder.setAttribute('aria-label', 'Command folder');
  const bar = make('input'); bar.value = snippet.buttonBar || 'Default'; bar.placeholder = 'Button Bar name'; bar.dataset.field = 'buttonBar'; bar.maxLength = 120; bar.setAttribute('aria-label', 'Button Bar name');
  const color = make('input'); color.type = 'color'; color.value = snippet.color || '#2cb442'; color.dataset.field = 'color'; color.setAttribute('aria-label', 'Command color');
  properties.append(folder, bar, color);
  header.append(name, remove); row.append(header, properties, command);
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
    const snippet = { name, command, folder: row.querySelector('[data-field="folder"]').value.trim(), buttonBar: row.querySelector('[data-field="buttonBar"]').value.trim() || 'Default', color: row.querySelector('[data-field="color"]').value };
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
  if (workflows.bulkOptions()) return;
  const profile = actionProfile();
  if (profile) openProfileDialog(profile);
}

async function performAction(action, editTarget = null) {
  if (editTarget && ['copy', 'cut', 'paste', 'select-all', 'undo', 'redo'].includes(action)) {
    if (projectUi.handlesEditTarget?.(editTarget)) await projectUi.editAction(action, editTarget);
    else await editField(action, editTarget);
    return;
  }
  if (action.startsWith('activate:')) { activate(action.slice(9)); return; }
  if (await scripts.perform(action)) return;
  if (await recorder.perform(action)) return;
  if (await transfers.perform(action)) return;
  if (await workflows.perform(action)) return;
  const current = connections.get(activeId);
  switch (action) {
    case 'local-ai': localAi.toggle(); break;
    case 'open-project': await projectUi.chooseProject(); break;
    case 'project-workspace': await projectUi.toggle(); break;
    case 'save-project-file': await projectUi.saveActive(); break;
    case 'new-session': openProfileDialog(); if (selectedFolderPath) $('profile-folder').value = selectedFolderPath; break;
    case 'connect': {
      const profiles = selectedSessionIds.size ? state.sessions.filter((profile) => selectedSessionIds.has(profile.id)) : selectedFolderPath !== null ? state.sessions.filter((profile) => !selectedFolderPath || normalizeFolder(profile.folder).join('/') === selectedFolderPath || normalizeFolder(profile.folder).join('/').startsWith(`${selectedFolderPath}/`)) : [];
      if (profiles.length > 1 && !await confirmAction({ title: `Connect ${profiles.length} sessions?`, message: 'Open the selected saved sessions in separate tabs.', targets: profiles.map((profile) => `${profile.name} · ${profile.protocol.toUpperCase()} · ${profileDetail(profile)}`), accept: 'Connect sessions' })) return;
      if (profiles.length) for (const profile of profiles) await openConnection(profile);
      else { workflows.showManager('sessions'); $('session-search').focus(); }
      break;
    }
    case 'disconnect': await disconnectActive(); break;
    case 'reconnect': if (current) await reconnect(current.id); break;
    case 'close-tab': if (projectUi.isOpen() && lastWorkspaceFocus === 'editor') await projectUi.closeActive?.(); else if (current) await closeConnection(current.id); break;
    case 'local-shell': localShell(); break;
    case 'session-options': showSessionOptions(); break;
    case 'find': if (projectUi.isOpen() && lastWorkspaceFocus === 'editor') projectUi.find?.(editTarget); else showSearch(); break;
    case 'log': if (current) await toggleLog(current.id); break;
    case 'pause-log': if (current?.logging && !current.exited) { const result = await api.terminalPauseLog({ id: current.id, paused: !current.logPaused }); current.logPaused = Boolean(result.paused); current.logButton.textContent = current.logPaused ? 'Ⅱ Log paused' : '● Logging'; renderTabs(); updateToolbar(); toast(current.logPaused ? 'Session logging paused.' : 'Session logging resumed.'); } break;
    case 'send-break': if (current && !current.exited && ['serial', 'telnet'].includes(current.protocol)) await api.terminalBreak(current.id); break;
    case 'send-ascii': {
      if (!current || current.exited) return;
      const file = await api.prepareAsciiFile(); if (!file) return;
      const accepted = await confirmAction({ title: `Send “${file.name}”?`, message: `Send ${file.size} bytes of text to “${current.title}”. Newlines are sent as carriage returns and may execute commands.`, preview: file.text, targets: [`${current.title} · ${current.protocol.toUpperCase()} · ${profileDetail(current.profile)}`], accept: 'Send text file', eyebrow: 'TEXT FILE PREVIEW' });
      if (accepted && connections.has(current.id) && !current.exited) await writeToConnection(current, file.text.replace(/\r\n|\n/g, '\r'));
      break;
    }
    case 'tile': if (tabGroups.ordered().length > 1) tabGroups.collapse(); else tabGroups.tile(tileOrientation); refreshGroups(); break;
    case 'tile-horizontal': case 'tile-vertical': case 'tile-grid': tabGroups.tile(action.slice(5)); refreshGroups(); break;
    case 'group-vertical': case 'group-horizontal': {
      const group = tabGroups.groupFor(activeId);
      if (group && tabGroups.split(activeId, group.id, action.slice(6))) refreshGroups();
      else toast('Open at least two tabs in this group before creating another group.');
      break;
    }
    case 'group-move-next': {
      const groups = tabGroups.ordered(); const group = tabGroups.groupFor(activeId); const index = groups.indexOf(group);
      if (groups.length > 1 && index >= 0 && tabGroups.move(activeId, groups[(index + 1) % groups.length].id)) refreshGroups();
      break;
    }
    case 'group-collapse': tabGroups.collapse(); refreshGroups(); break;
    case 'clear-screen': if (current) current.term.clear(); break;
    case 'reset-terminal': if (current) current.term.reset(); break;
    case 'keyword-options': openSettings(); selectCategory('settings-dialog', 'keywords'); break;
    case 'snippets': openSnippets(); break;
    case 'settings': openSettings(); break;
    case 'color-schemes': colorPicker.open(); break;
    case 'import-export': dialogOpen('import-dialog'); break;
    case 'copy': {
      const selection = window.getSelection();
      const selectedElement = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection?.anchorNode?.parentElement;
      if (!document.activeElement?.classList.contains('xterm-helper-textarea') && selection?.toString() && !selectedElement?.closest('.terminal-mount')) await api.clipboardWrite(selection.toString());
      else if (current) await copySelection(current);
      break;
    }
    case 'paste': if (current) await pasteClipboard(current); break;
    case 'select-all': if (current) { current.term.selectAll(); current.term.focus(); } break;
    case 'show-session-manager': if (panes.sessionManager && !$('sessions-manager-content').hidden) setPane('sessionManager', false); else workflows.showManager('sessions'); break;
    case 'show-command-window': setPane('commandWindow', !panes.commandWindow); break;
    case 'show-button-bar': setPane('buttonBar', !panes.buttonBar); break;
    case 'sftp': openSftp(); break;
    case 'next-tab': case 'previous-tab': {
      const ids = tabGroups.groupFor(activeId)?.tabs || []; const index = ids.indexOf(activeId);
      if (ids.length) activate(ids[(index + (action === 'next-tab' ? 1 : -1) + ids.length) % ids.length]);
      break;
    }
    case 'help': dialogOpen('help-dialog'); break;
  }
}

function runAction(action) {
  const editTarget = focusedEditTarget() || (openMenuName ? menuEditTarget : null);
  closeMenus();
  Promise.resolve(performAction(action, editTarget)).catch((error) => toast(errorMessage(error), true));
}

function menuDefinitions(name) {
  const current = connections.get(activeId);
  const editTarget = focusedEditTarget() || menuEditTarget;
  const selected = selectedProfile();
  const mod = isMac ? '⌘' : 'Ctrl+';
  const item = (label, action, enabled = true, shortcut = '', checked = null) => ({ label, action, enabled, shortcut, checked });
  switch (name) {
    case 'file': return [item('Open Project…', 'open-project', true, `${mod}⇧O`), item('Save Project File', 'save-project-file', Boolean(projectUi.getActiveDocument()), `${mod}S`), null, item('Connect…', 'connect', Boolean(selected || selectedFolderPath !== null), 'Enter'), item('Quick Connect…', 'quick-connect'), item('New Session…', 'new-session'), item('Connect Bar', 'connect-bar'), item('Disconnect', 'disconnect', Boolean(current && !current.exited)), item('Reconnect', 'reconnect', Boolean(current && !current.reconnecting)), null, item('Local Shell', 'local-shell', true, `${mod}T`), item('Clone Session', 'clone-session', Boolean(current)), item('Close Tab', 'close-tab', Boolean(current || projectUi.getActiveDocument()), `${mod}W`), null, item('Snapshots…', 'snapshots'), item('Import / Export Sessions…', 'import-export')];
    case 'edit': return [item('Copy', 'copy', Boolean(editTarget || current), isMac ? '⌘C' : 'Ctrl+Shift+C'), item('Paste', 'paste', editTarget ? !editTarget.disabled && !editTarget.readOnly : Boolean(current && !current.exited), isMac ? '⌘V' : 'Ctrl+Shift+V'), item('Select All', 'select-all', Boolean(editTarget || current)), null, item('Find…', 'find', Boolean(current || projectUi.getActiveDocument()), `${mod}F`), item('Configure Button Bar…', 'snippets')];
    case 'view': return [item('Project Workspace', 'project-workspace', true, '', projectUi.isOpen()), item('AI Assistant', 'local-ai', true, '', localAi.isVisible()), null, item('Session Manager', 'show-session-manager', true, '', panes.sessionManager && !$('sessions-manager-content').hidden), item('Command Manager', 'show-command-manager'), item('Active Sessions', 'show-active-sessions'), item('Command Window', 'show-command-window', true, '', panes.commandWindow), item('Button Bar', 'show-button-bar', true, '', panes.buttonBar), null, item('Tile Sessions', 'tile', connections.size > 0, '', tileView), item('Tile Vertically', 'tile-vertical', connections.size > 0), item('Tile Horizontally', 'tile-horizontal', connections.size > 0), item('Tile as Grid', 'tile-grid', connections.size > 0)];
    case 'options': return [item('Session Options…', 'session-options', Boolean(actionProfile())), item('Global Options…', 'settings'), item('Color Schemes…', 'color-schemes')];
    case 'transfer': return [item('Open SFTP Session', 'sftp'), item('Send ASCII…', 'send-ascii', Boolean(current && !current.exited)), item('Send Break', 'send-break', Boolean(current && !current.exited && ['telnet', 'serial'].includes(current.protocol))), item('TFTP Server…', 'tftp-server'), null, item('SFTP Command Help…', 'help')];
    case 'script': return [item('Run Python Script…', 'script-run'), item('Cancel Script', 'script-cancel', scripts.hasRunning()), null, item(recorder.isRecording() ? 'Stop Recording…' : 'Record Input…', 'script-record', Boolean(current && !current.exited)), item('Script Output…', 'script-output')];
    case 'tools': return [item(current?.logging ? 'Stop Session Logging' : 'Log Session…', 'log', Boolean(current && !current.exited)), item(current?.logPaused ? 'Resume Log' : 'Pause Log', 'pause-log', Boolean(current && current.logging && !current.exited)), item('Configure Button Bar…', 'snippets'), item('Keyword Highlighting…', 'keyword-options'), null, item('Clear Screen', 'clear-screen', Boolean(current)), item('Reset Terminal', 'reset-terminal', Boolean(current)), item('Clear Command History…', 'clear-history'), null, item('Import / Export Sessions…', 'import-export')];
    case 'window': return [item('New Vertical Tab Group', 'group-vertical', (tabGroups.groupFor(activeId)?.tabs.length || 0) > 1), item('New Horizontal Tab Group', 'group-horizontal', (tabGroups.groupFor(activeId)?.tabs.length || 0) > 1), item('Move Tab to Next Group', 'group-move-next', tileView), item('Collapse Tab Groups', 'group-collapse', tileView), null, item('Tile Sessions', 'tile', connections.size > 0, '', tileView), item('Tile Vertically', 'tile-vertical', connections.size > 0), item('Tile Horizontally', 'tile-horizontal', connections.size > 0), item('Tile as Grid', 'tile-grid', connections.size > 0), item('Clone Session', 'clone-session', Boolean(current)), item('Next Tab', 'next-tab', (tabGroups.groupFor(activeId)?.tabs.length || 0) > 1), item('Previous Tab', 'previous-tab', (tabGroups.groupFor(activeId)?.tabs.length || 0) > 1), null, ...[...connections.values()].map((connection, index) => item(`${index + 1}  ${connection.title}`, `activate:${connection.id}`, true, '', connection.id === activeId))];
    case 'help': return [item('TermForge Help…', 'help'), item('About TermForge…', 'help')];
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
  menuEditTarget = null;
  for (const button of document.querySelectorAll('[data-menu]')) button.setAttribute('aria-expanded', 'false');
}

function placeMenu(container, x, y) {
  container.hidden = false;
  const rect = container.getBoundingClientRect();
  container.style.left = `${Math.max(1, Math.min(x, window.innerWidth - rect.width - 3))}px`;
  container.style.top = `${Math.max(1, Math.min(y, window.innerHeight - rect.height - 3))}px`;
}

function showMenu(name, focus = false) {
  const editTarget = focusedEditTarget() || menuEditTarget;
  closeMenus(); openMenuName = name; menuEditTarget = editTarget;
  const button = document.querySelector(`[data-menu="${name}"]`); button.setAttribute('aria-expanded', 'true');
  const rect = button.getBoundingClientRect(); fillMenu($('menu-dropdown'), menuDefinitions(name)); placeMenu($('menu-dropdown'), rect.left, rect.bottom);
  if (focus) $('menu-dropdown').querySelector('button:not(:disabled)')?.focus();
}

function showSessionContext(x, y, profile, folder) {
  closeMenus();
  const entries = [{ label: 'New Session…', action: 'new-session', enabled: true }, null, { label: selectedSessionIds.size > 1 ? `Connect ${selectedSessionIds.size} Sessions…` : folder !== null ? 'Connect Folder…' : 'Connect', action: 'connect', enabled: Boolean(profile || folder !== null) }, { label: selectedSessionIds.size > 1 ? 'Multiple Session Options…' : 'Session Options…', action: 'session-options', enabled: Boolean(profile) }];
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
    button.addEventListener('pointerdown', () => { menuEditTarget = focusedEditTarget() || menuEditTarget; });
    button.addEventListener('click', () => {
      const wasOpen = openMenuName === button.dataset.menu;
      const editTarget = focusedEditTarget() || menuEditTarget;
      closeMenus();
      if (!wasOpen) { menuEditTarget = editTarget; showMenu(button.dataset.menu); }
    });
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
  installOptionDialogs({ getSettings: () => state.settings }); installWorkspaceDialogs(); workflows.install(); scripts.install(); transfers.install(); localAi.install(); projectUi.install();
  $('profile-form').noValidate = true; $('settings-form').noValidate = true;
  addToolbarIcons(); setupMenus(); setupSplitters(); loadLayout();
  $('settings-font').min = '8'; $('settings-font').max = '72'; $('settings-scrollback').max = '128000';
  bind('profile-protocol-select', 'change', () => {
    const protocol = $('profile-protocol-select').value;
    if (['telnet', 'raw'].includes(protocol) && $('profile-port').value === '22') $('profile-port').value = '23';
    if (['ssh', 'sftp'].includes(protocol) && $('profile-port').value === '23') $('profile-port').value = '22';
    setProtocol(protocol); if (protocol === 'serial') selectCategory('profile-dialog', 'serial');
  });
  bind('refresh-serial-ports', 'click', async () => {
    $('refresh-serial-ports').disabled = true;
    try { const ports = await api.serialPorts(); $('serial-port-options').replaceChildren(...ports.map((port) => { const option = make('option'); option.value = port.path; option.label = port.friendlyName || port.manufacturer || port.path; return option; })); toast(ports.length ? `${ports.length} serial ports found.` : 'No serial ports found. You can enter a port path manually.'); }
    catch (error) { toast(errorMessage(error), true); }
    finally { $('refresh-serial-ports').disabled = false; }
  });
  bind('add-keyword', 'click', () => { if ($('keyword-editor').children.length >= 32) { toast('Up to 32 keyword rules can be saved.', true); return; } addKeywordRule().focus(); });
  $('keyword-input').maxLength = 128;
  bind('keyword-input', 'input', () => { quickKeyword = $('keyword-input').value; for (const connection of connections.values()) connection.highlight.refresh(); });
  bind('keyword-toggle', 'click', async () => {
    try { state.settings = await api.saveSettings({ ...state.settings, keywordHighlightEnabled: state.settings.keywordHighlightEnabled === false }); applySettings(); }
    catch (error) { toast(errorMessage(error), true); }
  });
  bind('button-bar-select', 'change', () => { selectedButtonBar = $('button-bar-select').value; renderSnippets(); });
  const toolbarActions = { 'color-schemes-button': 'color-schemes', 'connect-session': 'connect', 'sidebar-connect': 'connect', 'disconnect-session': 'disconnect', 'reconnect-session': 'reconnect', 'session-options': 'session-options', 'sidebar-properties': 'session-options', 'copy-terminal': 'copy', 'paste-terminal': 'paste', 'find-terminal': 'find', 'sftp-session': 'sftp', 'session-log': 'log' };
  for (const [id, action] of Object.entries(toolbarActions)) bind(id, 'click', () => runAction(action));
  bind('close-session-manager', 'click', () => setPane('sessionManager', false));
  bind('close-command-window', 'click', () => setPane('commandWindow', false));
  bind('session-list', 'keydown', treeKeydown);
  for (const id of ['add-session-sidebar', 'new-session', 'welcome-new']) bind(id, 'click', () => runAction('new-session'));
  for (const id of ['quick-local', 'welcome-local']) bind(id, 'click', localShell);
  for (const button of document.querySelectorAll('.dialog-close')) button.addEventListener('click', () => button.closest('dialog').close());
  for (const dialog of document.querySelectorAll('dialog:not(#color-scheme-dialog)')) dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  $('confirm-dialog').addEventListener('close', () => { if (confirmResolver && !$('confirm-dialog').open) finishConfirm(false); });
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
  bind('toggle-tile', 'click', () => runAction('tile'));
  bindStripDrop($('tab-strip'), () => tabGroups.ordered()[0]?.id);
  bind('send-command', 'click', sendCommand);
  bind('command-input', 'keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCommand(); } });
  bind('command-input', 'input', () => { if (!$('command-input').value.trim()) clearAiDraft(); });
  bind('ai-draft-discard', 'click', () => { $('command-input').value = ''; clearAiDraft(); });
  bind('project-toggle', 'click', () => projectUi.toggle());
  bind('welcome-project', 'click', () => projectUi.chooseProject());
  bind('local-ai-toggle', 'click', () => localAi.toggle());
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
  document.addEventListener('focusin', event => {
    if (event.target.closest?.('#project-workspace')) lastWorkspaceFocus = 'editor';
    else if (event.target.closest?.('#terminal-workspace')) lastWorkspaceFocus = 'terminal';
  });
  document.addEventListener('keydown', (event) => {
    if (!document.querySelector('dialog[open]') && document.activeElement?.classList.contains('xterm-helper-textarea')) {
      const connection = connections.get(activeId); const mapping = matchingMapping(event, connection?.profile.terminal?.mappedKeys);
      if (mapping) { event.preventDefault(); event.stopPropagation(); applyMappedKey(connection, mapping); return; }
    }
    if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    if (projectUi.isOpen() && lastWorkspaceFocus === 'editor' && ['s', 'f', 'w', 'k'].includes(key)) {
      if (key === 's' || key === 'w') { event.preventDefault(); event.stopPropagation(); Promise.resolve(key === 's' ? projectUi.saveActive() : projectUi.closeActive?.()).catch(error => toast(errorMessage(error), true)); }
      return;
    }
    if (!['t', 'k', 'f', 'w'].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === 't') localShell();
    if (key === 'k') { workflows.showManager('sessions'); $('session-search').focus(); $('session-search').select(); }
    if (key === 'f') showSearch();
    if (key === 'w' && activeId) closeConnection(activeId);
  }, true);
  window.addEventListener('resize', () => requestAnimationFrame(fitVisible));
}

async function init() {
  setupHandlers();
  if (!api) {
    toast('The native TermForge bridge is unavailable. Start TermForge using the desktop application.', true);
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    renderSessions(); renderSnippets(); renderTabs();
    return;
  }
  if (typeof api.onMenuAction === 'function') api.onMenuAction((action) => {
    const name = String(action);
    if (!document.querySelector('dialog[open]') || focusedEditTarget() && ['copy', 'cut', 'paste', 'select-all', 'undo', 'redo'].includes(name)) runAction(name);
  });
  api.onTerminalData(handleTerminalData);
  api.onTerminalExit(handleTerminalExit);
  if (typeof api.onTerminalOpened === 'function') api.onTerminalOpened((event) => { if (!connections.has(event.id) && event.profile) { createConnection(event, event.profile); activate(event.id); renderSessions(); workflows.refresh(); } });
  if (typeof api.onTerminalActivated === 'function') api.onTerminalActivated((event) => { if (connections.has(event.id)) activate(event.id); });
  if (typeof api.onMappedKey === 'function') api.onMappedKey((event) => { const connection = connections.get(event.id); if (connection && !connection.exited) applyMappedKey(connection, event.mapping); });
  if (typeof api.onScreenRequest === 'function') api.onScreenRequest(handleScreenRequest);
  try {
    state = { ...state, ...await api.getState() };
    isMac = state.platform === 'darwin';
    if (isMac && !localStorage.getItem('termforge-classic-layout')) { panes.commandWindow = false; applyPaneVisibility(); }
    document.documentElement.dataset.platform = state.platform;
    $('platform-label').textContent = `${isMac ? 'macOS' : state.platform === 'win32' ? 'Windows' : 'Linux'}`;
    $('version-label').textContent = state.version ? `v${state.version}` : 'OSS';
    $('about-version').textContent = `Version ${state.version || 'development'} · MIT License`;
    $('search-shortcut').textContent = isMac ? '⌘ K' : 'Ctrl K';
    $('shortcut-hint').textContent = `${isMac ? '⌘' : 'Ctrl'} T for a local shell`;
    for (const element of document.querySelectorAll('[data-shortcut]')) element.textContent = `${isMac ? '⌘' : 'Ctrl'}${element.dataset.shift ? isMac ? ' ⇧' : ' Shift' : ''} ${element.dataset.shortcut}`;
    renderSessions(); renderSnippets(); renderTabs(); renderWorkspace(); applySettings(); updateWorkspaceStatus(); workflows.refresh();
    ready = true;
  } catch (error) {
    $('workspace-status').textContent = 'Could not load the workspace';
    toast(`Could not load configuration: ${errorMessage(error)}`, true);
  }
}

init();
