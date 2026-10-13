'use strict';

// One declarative menu is shared by the native menubar and the renderer.
// Menu state contains presentation metadata only: never terminal text, passwords,
// script paths or connection profiles. Backend IPC remains the authority for work.
const BASE_ACTIONS = new Set([
  'connect', 'quick-connect', 'local-shell', 'new-session', 'open-project', 'save-project-file',
  'snapshots', 'reconnect', 'disconnect', 'clone-session', 'sftp', 'close-tab', 'log', 'pause-log',
  'undo', 'redo', 'cut', 'copy', 'paste', 'select-all', 'find', 'clear-screen', 'reset-terminal', 'send-break',
  'show-command-window', 'show-button-bar', 'show-session-manager', 'show-command-manager', 'show-active-sessions',
  'connect-bar', 'project-workspace', 'local-ai', 'settings', 'session-options', 'snippets', 'color-schemes',
  'keyword-options', 'send-ascii', 'tftp-server', 'script-run', 'script-cancel', 'script-record', 'script-output',
  'credentials', 'ssh-hosts', 'import-export', 'clear-history', 'tile-vertical', 'tile-horizontal', 'tile-grid',
  'group-vertical', 'group-horizontal', 'group-move-next', 'group-collapse', 'next-tab', 'previous-tab', 'help'
]);
const NATIVE_ACTIONS = new Set(['toggle-fullscreen', 'minimize-window', 'zoom-window', 'close-window', 'bring-all-front', 'quit']);
const FIELD_ACTIONS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'select-all']);
const WINDOW_ACTIONS = new Set([...NATIVE_ACTIONS, 'quick-connect']);
const bool = value => value === true;
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
const count = value => Number.isInteger(value) && value >= 0 ? Math.min(value, 1000) : 0;
function records(value, limit) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, limit).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id || entry.id.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.id) || seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [{ id: entry.id, name: text(entry.name || entry.title) || 'Untitled', title: text(entry.title || entry.name) || 'Untitled', exited: bool(entry.exited), reconnecting: bool(entry.reconnecting) }];
  });
}
function sanitizeMenuState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const current = source.current && typeof source.current === 'object' ? source.current : null;
  const state = {
    current: current ? { id: text(current.id, 128), title: text(current.title), protocol: text(current.protocol, 16), exited: bool(current.exited), reconnecting: bool(current.reconnecting), logging: bool(current.logging), logPaused: bool(current.logPaused), selection: bool(current.selection) } : null,
    panes: {}, capabilities: {}, groupCount: count(source.groupCount), activeGroupSize: count(source.activeGroupSize),
    layout: ['tabs', 'vertical', 'horizontal', 'grid'].includes(source.layout) ? source.layout : 'tabs',
    connections: records(source.connections, 128), recentSessions: records(source.recentSessions, 20), recentScripts: records(source.recentScripts, 10), snapshots: records(source.snapshots, 100)
  };
  for (const key of ['ready', 'dialogOpen', 'quickConnectFocused', 'hasProfile', 'hasEditor', 'editTarget', 'editWritable', 'projectVisible', 'aiVisible', 'scriptRunning', 'recording', 'hasRecording', 'hexView', 'keywordHighlighting', 'tftpRunning', 'receivingAscii', 'rawLogging', 'useFirewall', 'autoSave']) state[key] = bool(source[key]);
  state.verticalScrollbar = source.verticalScrollbar !== false;
  for (const key of ['toolbar', 'statusBar', 'commandWindow', 'buttonBar', 'sessionManager', 'commandManager', 'activeSessions']) state.panes[key] = bool(source.panes?.[key]);
  if (source.capabilities && typeof source.capabilities === 'object') for (const [key, value] of Object.entries(source.capabilities).slice(0, 200)) if (/^[a-z][a-z0-9-]{0,63}$/.test(key)) state.capabilities[key] = bool(value);
  return state;
}

function buildMenus(input = {}, platform = 'linux') {
  const s = sanitizeMenuState(input), mac = platform === 'darwin';
  const current = s.current, alive = Boolean(current && !current.exited), terminal = Boolean(current);
  const selected = Boolean(current?.selection), group = s.activeGroupSize > 1, multi = s.connections.length > 1;
  const available = action => BASE_ACTIONS.has(action) || NATIVE_ACTIONS.has(action) || s.capabilities[action] === true;
  const blocked = action => !s.ready || (s.quickConnectFocused ? !FIELD_ACTIONS.has(action) && !WINDOW_ACTIONS.has(action) : s.dialogOpen && !FIELD_ACTIONS.has(action) && !NATIVE_ACTIONS.has(action));
  const shortcut = accelerator => !accelerator ? '' : mac ? accelerator.replace('CommandOrControl+', '⌘').replace('Command+', '⌘').replace('Control+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧').replace('Return', '↩') : accelerator.replace('CommandOrControl+', 'Ctrl+').replace('Control+', 'Ctrl+');
  function item(label, action, enabled = true, accelerator, checked) {
    const entry = { label, action, enabled: Boolean(enabled && available(action) && !blocked(action)) };
    if (accelerator) { entry.accelerator = accelerator; entry.shortcut = shortcut(accelerator); }
    if (typeof checked === 'boolean') entry.checked = checked;
    if (!available(action)) entry.unavailableReason = 'This feature is not available in this version.';
    return entry;
  }
  function unavailable(label, action, reason) { return { label, action, enabled: false, unavailableReason: reason }; }
  function submenu(label, entries) { return { label, enabled: entries.some(entry => entry?.enabled), submenu: entries }; }
  function dynamic(label, rows, prefix, empty, enabled = true) {
    return submenu(label, rows.length ? rows.map(row => {
      const entry = item(row.name, prefix, enabled); entry.action = `${prefix}:${encodeURIComponent(row.id)}`; return entry;
    }) : [{ label: empty, enabled: false }]);
  }
  const editable = s.quickConnectFocused || s.editTarget;
  const writable = s.quickConnectFocused || s.editWritable;
  const menus = [
    { id: 'file', label: 'File', submenu: [
      item('Connect…', 'connect', true, 'CommandOrControl+E'), item('Quick Connect…', 'quick-connect', true, 'CommandOrControl+K'),
      item('Connect In Tab/Tile…', 'connect-tab', true, 'CommandOrControl+T'), item('Connect Local Shell', 'local-shell', true, 'CommandOrControl+L'), null,
      dynamic('Open Snapshot', s.snapshots, 'snapshot-open', 'No saved snapshots'),
      submenu('Save Snapshot', [item('Save Current Workspace…', 'snapshot-save', s.connections.length > 0)]), item('Manage Snapshots…', 'snapshots'), null,
      item('Reconnect', 'reconnect', terminal && !current.reconnecting), item('Reconnect All', 'reconnect-all', s.connections.some(row => !row.reconnecting)),
      item('Disconnect', 'disconnect', alive), item('Disconnect All', 'disconnect-all', s.connections.some(row => !row.exited)), null,
      item('Clone Session', 'clone-session', terminal), item('Connect SFTP Session…', 'sftp', true, 'CommandOrControl+Shift+P'), null,
      unavailable('Lock Session…', 'lock-session', 'Session locking is not implemented; use your operating system screen lock.'), null,
      submenu('Print', [item('Print Screen…', 'print-screen', terminal), item('Print Scrollback…', 'print-scrollback', terminal)]),
      item('Page Setup…', 'page-setup'), null,
      item('Log Session…', 'log', alive, undefined, Boolean(current?.logging && !s.rawLogging)), item('Pause Logging', 'pause-log', alive && current.logging, undefined, Boolean(current?.logPaused)),
      item('Raw Log Session…', 'raw-log', alive, undefined, s.rawLogging), unavailable('Trace Options…', 'trace-options', 'Protocol diagnostic tracing is not implemented.'), null,
      dynamic('Recent Session', s.recentSessions, 'recent-session', 'No recent saved sessions'), null,
      item('New Session…', 'new-session', true, 'CommandOrControl+N'), item('Close Tab', 'close-tab', terminal || s.hasEditor, 'CommandOrControl+W'), null,
      item('Open Project…', 'open-project', true, 'CommandOrControl+Shift+O'), item('Save Project File', 'save-project-file', s.hasEditor, 'CommandOrControl+S'),
      ...(mac ? [] : [null, item('Exit', 'quit')])
    ] },
    { id: 'edit', label: 'Edit', submenu: [
      item('Copy', 'copy', editable || selected, mac ? 'Command+C' : 'Control+Shift+C'), item('Paste', 'paste', editable ? writable : alive, mac ? 'Command+V' : 'Control+Shift+V'),
      item('Copy and Paste', 'copy-paste', alive && selected && !editable), item('Paste as Quotation', 'paste-quotation', alive && !editable),
      item('Select All', 'select-all', editable || terminal, 'CommandOrControl+A'), item('Find…', 'find', terminal || s.hasEditor, 'CommandOrControl+F'), null,
      item('Print Selection…', 'print-selection', selected), null,
      item('Go to Command Window', 'focus-command-window', true, 'CommandOrControl+Alt+G'), item('Go to Session Window', 'focus-session-window', terminal, 'CommandOrControl+Alt+M'),
      item('Go to Command Manager', 'focus-command-manager', true, 'CommandOrControl+Alt+J'), item('Go to Active Sessions', 'focus-active-sessions', true, 'CommandOrControl+Alt+Z'), null,
      item('Clear Scrollback', 'clear-scrollback', terminal), item('Clear Screen', 'clear-screen', terminal), item('Clear Screen and Scrollback', 'clear-screen-scrollback', terminal), null,
      item('Send Break', 'send-break', alive && ['serial', 'telnet'].includes(current.protocol)), item('Reset', 'reset-terminal', terminal), null,
      item('Undo', 'undo', editable && writable, 'CommandOrControl+Z'), item('Redo', 'redo', editable && writable, 'CommandOrControl+Shift+Z'), item('Cut', 'cut', editable && writable, 'CommandOrControl+X')
    ] },
    { id: 'view', label: 'View', submenu: [
      item('Toolbar', 'show-toolbar', true, undefined, s.panes.toolbar), item('Command Window', 'show-command-window', true, undefined, s.panes.commandWindow),
      item('Status Bar', 'show-status-bar', true, undefined, s.panes.statusBar), item('Button Bar', 'show-button-bar', true, undefined, s.panes.buttonBar),
      item('Session Manager', 'show-session-manager', true, undefined, s.panes.sessionManager), item('Command Manager', 'show-command-manager', true, undefined, s.panes.commandManager), item('Active Sessions', 'show-active-sessions', true, undefined, s.panes.activeSessions), null,
      item('Hex View', 'hex-view', terminal, undefined, s.hexView), null,
      submenu('Zoom', [item('Zoom In', 'zoom-in', terminal, 'CommandOrControl+Plus'), item('Zoom Out', 'zoom-out', terminal, 'CommandOrControl+-'), item('Actual Size', 'zoom-reset', terminal, 'CommandOrControl+0')]), null,
      item('Window Transparency…', 'window-transparency', platform !== 'linux'), null,
      unavailable('Horizontal Scroll Bar', 'horizontal-scrollbar', 'The terminal reflows to its width; horizontal scrolling is not implemented.'),
      item('Vertical Scroll Bar', 'vertical-scrollbar', terminal, undefined, s.verticalScrollbar), null,
      item('Full Screen', 'toggle-fullscreen', true, 'CommandOrControl+Return'), null,
      item('Connect Bar', 'connect-bar'), item('Project Workspace', 'project-workspace', true, undefined, s.projectVisible), item('AI Assistant', 'local-ai', true, undefined, s.aiVisible)
    ] },
    { id: 'options', label: 'Options', submenu: [
      item('Session Options…', 'session-options', s.hasProfile), submenu('Configure', [item('Button Bar…', 'snippets'), item('Keymap Editor…', 'keymap-editor', s.hasProfile), item('Color Schemes…', 'color-schemes')]),
      item('Global Options…', 'settings'), null, item('Keyword Highlighting', 'keyword-highlight', true, undefined, s.keywordHighlighting), item('Keyword Highlighting Properties…', 'keyword-options'),
      unavailable('Use Firewall', 'use-firewall', 'Configure each session’s SSH jump host in Session Options; a global firewall switch is not implemented.'), null,
      { ...item('Auto Save Options', 'auto-save-options'), checked: true, enabled: false, unavailableReason: 'Options are saved when you apply their dialog. Deferred global saving is not implemented.' }, item('Save Settings Now', 'save-settings')
    ] },
    { id: 'transfer', label: 'Transfer', submenu: [
      item('Send ASCII…', 'send-ascii', alive), item(s.receivingAscii ? 'Stop Receiving ASCII…' : 'Receive ASCII…', 'receive-ascii', alive), null,
      item('Send Binary…', 'send-binary', alive), null,
      ...['Kermit', 'Xmodem', 'Ymodem'].flatMap(protocol => [unavailable(`Send ${protocol}…`, `send-${protocol.toLowerCase()}`, `${protocol} transfers are not implemented.`), unavailable(`Receive ${protocol}…`, `receive-${protocol.toLowerCase()}`, `${protocol} transfers are not implemented.`), null]),
      unavailable('Zmodem Upload List…', 'zmodem-list', 'Zmodem transfers are not implemented.'), unavailable('Start Zmodem Upload', 'zmodem-upload', 'Zmodem transfers are not implemented.'), null,
      item(s.tftpRunning ? 'TFTP Server…' : 'Start TFTP Server…', 'tftp-server'), null, item('SFTP / SCP File Transfer…', 'sftp')
    ] },
    { id: 'script', label: 'Script', submenu: [
      item('Run…', 'script-run'), item('Cancel', 'script-cancel', s.scriptRunning), null,
      item('Start Recording Script', 'script-record-start', alive && !s.recording), item('Stop Recording Script…', 'script-record-stop', s.recording), item('Cancel Recording Script', 'script-record-cancel', s.recording || s.hasRecording), null,
      dynamic('Recent Script', s.recentScripts, 'recent-script', 'No recent scripts'), null, item('Script Output…', 'script-output')
    ] },
    { id: 'tools', label: 'Tools', submenu: [
      item('Keymap Editor…', 'keymap-editor', s.hasProfile), null,
      item('Create Public Key…', 'create-public-key'), item('Convert Private Key to OpenSSH Format…', 'convert-private-key'),
      unavailable('Public-Key Assistant…', 'public-key-assistant', 'Remote authorized_keys installation is not implemented.'), null,
      item('Manage Agent Keys…', 'agent-keys'), item('Manage Saved Credentials…', 'credentials'),
      unavailable('Change Credentials Password', 'credentials-password', 'Credentials use the operating system protected store; there is no TermForge master password.'), null,
      unavailable('Change Configuration Passphrase…', 'configuration-passphrase', 'Configuration encryption with a master passphrase is not implemented.'), null,
      item('Export Settings…', 'export-settings'), unavailable('Import Settings from XML File…', 'import-xml', 'SecureCRT XML configuration is not supported. Import session INI files instead.'),
      unavailable('Import Settings from Text File…', 'import-text', 'Text session-list import is not implemented.'), null,
      item('Import TermForge Settings…', 'import-json'), item('Import SecureCRT Sessions…', 'import-securecrt'), item('Trusted SSH Hosts…', 'ssh-hosts'), item('Clear Command History…', 'clear-history')
    ] },
    { id: 'window', label: 'Window', submenu: [
      item('Tabs', 'tabbed', true, undefined, s.layout === 'tabs'), item('Tile Vertically', 'tile-vertical', multi, undefined, s.layout === 'vertical'), item('Tile Horizontally', 'tile-horizontal', multi, undefined, s.layout === 'horizontal'),
      unavailable('Cascade', 'cascade', 'Cascading child terminal windows is not implemented.'), null,
      item('Single Tab Group', 'group-collapse', s.groupCount > 1), null,
      item('Minimize', 'minimize-window', true, 'CommandOrControl+M'), item('Zoom', 'zoom-window'), null,
      item('Select Next Tab/Tile', 'next-tab', multi, 'CommandOrControl+Shift+]'), item('Select Previous Tab/Tile', 'previous-tab', multi, 'CommandOrControl+Shift+['),
      unavailable('Move Tab/Tile to New Window', 'detach-tab', 'Detaching a live session into another window is not implemented.'), null,
      item('Bring All to Front', 'bring-all-front'), null,
      ...s.connections.map(connection => ({ label: connection.title, action: `activate:${encodeURIComponent(connection.id)}`, enabled: !blocked('activate'), checked: connection.id === current?.id })),
      ...(!s.connections.length ? [{ label: 'Not connected — TermForge', enabled: false, checked: true }] : []), null,
      item('New Vertical Tab Group', 'group-vertical', group), item('New Horizontal Tab Group', 'group-horizontal', group), item('Move Tab to Next Group', 'group-move-next', s.groupCount > 1), item('Tile as Grid', 'tile-grid', multi), item('Close Window', 'close-window', true, 'CommandOrControl+Shift+W')
    ] },
    { id: 'help', label: 'Help', submenu: [
      item('Help Topics…', 'help'), null, item('TermForge Web Page', 'help-web'), submenu('Update', [item('View Releases…', 'help-updates')]), item('Report an Issue…', 'help-support'), null,
      item('Feature Availability…', 'feature-availability'), item('About TermForge…', 'about')
    ] }
  ];
  return menus;
}

function findMenuAction(menus, action) {
  for (const entry of menus) {
    if (!entry) continue;
    if (entry.action === action) return entry;
    if (entry.submenu) { const found = findMenuAction(entry.submenu, action); if (found) return found; }
  }
  return null;
}

module.exports = { buildMenus, sanitizeMenuState, findMenuAction, NATIVE_ACTIONS };
