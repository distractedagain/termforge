'use strict';
const { app, BrowserWindow, ipcMain, protocol, dialog, clipboard, Menu } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createStore, validateSession, parseSecureCRTIni } = require('./core.cjs');
const { createTerminalManager } = require('./terminals.cjs');
const { listSerialPorts } = require('./transports.cjs');
const { createAutomationManager, recordedInputToPython } = require('./automation.cjs');
const { matchingMapping } = require('./keymap.cjs');
const { createTftpServer } = require('./tftp.cjs');
const { stopOwnedResources } = require('./lifecycle.cjs');
const { writePrivateFile, resolveDataDirectory } = require('./files.cjs');
const { createAiAssistant } = require('./ai-assistant.cjs');
const { createProjectManager } = require('./projects.cjs');
const { createAnsibleManager } = require('./ansible.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'termforge', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('TermForge');
let window;
let store;
let terminals;
let automation;
let localAi;
let projects;
let ansible;
const dirtyProjects = new Set();
const savingProjects = new Map();
let activeTerminalId = null;
let focusedTerminalId = null;
let tftp = null;
const tftpRoots = new Map();
const screenRequests = new Map();
let quitting = false;
let shuttingDown = false;
const rendererRoot = path.join(__dirname, '../renderer');
const trustedURL = 'termforge://app/index.html';
const csp = "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(`termforge:${channel}`, value);
}
async function cleanupTerminals() {
  localAi?.close();
  for (const pending of screenRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Terminal display is closing.')); }
  screenRequests.clear();
  const server = tftp;
  await stopOwnedResources({ ansible: () => ansible?.closeAll(), scripts: () => automation?.closeAll(), terminals: () => terminals?.closeAll(), tftp: async () => { await server?.stop(); if (tftp === server) tftp = null; } });
}
function readScreen(request) {
  if (!request || !terminals.has(requiredId(request.id))) return Promise.reject(new Error('The script terminal is no longer open.'));
  const requestId = require('node:crypto').randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { screenRequests.delete(requestId); reject(new Error('Terminal display did not respond within 5 seconds.')); }, 5000);
    screenRequests.set(requestId, { resolve, reject, timer });
    send('screenRequest', { ...request, requestId });
  });
}
function handle(name, callback) {
  ipcMain.handle(`termforge:${name}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== trustedURL) {
      throw new Error('Untrusted request');
    }
    if (shuttingDown && ['terminalOpen', 'scriptRun', 'tftpStart', 'aiStart', 'aiModels', 'projectOpen', 'projectSave', 'ansibleProbe', 'ansiblePrepare', 'ansibleStart'].includes(name)) throw new Error('TermForge is stopping its active work.');
    return callback(...args);
  });
}
function getState() {
  return { ...store.load(), platform: process.platform, version: app.getVersion() };
}
function requiredId(id) {
  if (typeof id !== 'string' || id.length > 128) throw new Error('Invalid identifier');
  return id;
}

function applicationMenu() {
  const action = (label, key, accelerator) => ({ label, ...(accelerator ? { accelerator } : {}), click: () => send('menuAction', key) });
  const separator = { type: 'separator' };
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, separator, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      action('Open Project…', 'open-project', 'CommandOrControl+Shift+O'),
      action('Save Project File', 'save-project-file', 'CommandOrControl+S'), separator,
      action('New Session…', 'new-session', 'CommandOrControl+N'),
      action('Connect', 'connect', 'CommandOrControl+O'),
      action('Quick Connect…', 'quick-connect'),
      action('Local Shell', 'local-shell', 'CommandOrControl+T'), separator,
      action('Disconnect', 'disconnect'), action('Reconnect', 'reconnect'), separator,
      action('Import / Export…', 'import-export'), separator,
      action('Close Tab', 'close-tab', 'CommandOrControl+W'),
      ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }])
    ] },
    { label: 'Edit', submenu: [action('Undo', 'undo', 'CommandOrControl+Z'), action('Redo', 'redo', 'CommandOrControl+Shift+Z'), separator, action('Cut', 'cut', 'CommandOrControl+X'),
      action('Copy', 'copy', process.platform === 'darwin' ? 'Command+C' : 'Control+Shift+C'),
      action('Paste', 'paste', process.platform === 'darwin' ? 'Command+V' : 'Control+Shift+V'),
      action('Select All', 'select-all'), separator,
      action('Find…', 'find', 'CommandOrControl+F')
    ] },
    { label: 'View', submenu: [
      action('Project Workspace', 'project-workspace'),
      action('Session Manager', 'show-session-manager'), action('Command Window', 'show-command-window'),
      action('Button Bar', 'show-button-bar'), separator,
      action('AI Assistant', 'local-ai'), separator,
      action('Connect Bar', 'connect-bar'), action('Command Manager', 'show-command-manager'), action('Active Sessions Manager', 'show-active-sessions'), separator,
      action('Clear Screen', 'clear-screen'), action('Reset Terminal', 'reset-terminal'), separator,
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, separator, { role: 'togglefullscreen' }
    ] },
    { label: 'Options', submenu: [action('Session Options…', 'session-options'), action('Global Options…', 'settings'), action('Color Schemes…', 'color-schemes'), action('Keyword Highlighting…', 'keyword-options')] },
    { label: 'Transfer', submenu: [action('Open SFTP Session', 'sftp'), action('Send ASCII File…', 'send-ascii'), action('Send Break', 'send-break'), action('TFTP Server…', 'tftp-server'), separator, action('Log Session…', 'log'), action('Pause / Resume Log', 'pause-log')] },
    { label: 'Script', submenu: [action('Run Python Script…', 'script-run'), action('Cancel Running Script', 'script-cancel'), separator, action('Record Input…', 'script-record'), action('Script Output', 'script-output')] },
    { label: 'Tools', submenu: [action('Edit Button Bar…', 'snippets'), action('Import / Export…', 'import-export')] },
    { label: 'Window', submenu: [action('Clone Session', 'clone-session'), action('Snapshots…', 'snapshots'), separator, action('New Vertical Tab Group', 'group-vertical'), action('New Horizontal Tab Group', 'group-horizontal'), action('Move Tab to Next Group', 'group-move-next'), action('Collapse Tab Groups', 'group-collapse'), separator, action('Tile Sessions', 'tile'), action('Tile Horizontally', 'tile-horizontal'), action('Tile Vertically', 'tile-vertical'), action('Tile as Grid', 'tile-grid'), separator, { role: 'minimize' }, { label: 'Close Window', role: 'close', accelerator: 'CommandOrControl+Shift+W' }] },
    { label: 'Help', submenu: [action('TermForge Help', 'help')] }
  ]);
}

async function importSecureCRT() {
  const result = await dialog.showOpenDialog(window, { title: 'Import SecureCRT Sessions folder', properties: ['openDirectory'] });
  if (result.canceled) return null;
  const root = result.filePaths[0];
  const profiles = [];
  let scanned = 0;
  let skipped = 0;
  async function walk(directory, folder, depth = 0) {
    if (depth > 12) throw new Error('Session folder has too many levels');
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++scanned > 10000) throw new Error('Session folder is too large (maximum 10,000 entries)');
      if (entry.isSymbolicLink()) { skipped++; continue; }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, [folder, entry.name].filter(Boolean).join('/'), depth + 1);
      else if (entry.isFile() && /\.ini$/i.test(entry.name)) {
        if (profiles.length >= 1000) throw new Error('Maximum 1,000 saved sessions');
        const stat = await fsp.stat(fullPath);
        if (stat.size > 2 * 1024 * 1024) { skipped++; continue; }
        let text = await fsp.readFile(fullPath);
        text = text[0] === 0xff && text[1] === 0xfe ? text.subarray(2).toString('utf16le') : text.toString('utf8').replace(/^\uFEFF/, '');
        try {
          const profile = parseSecureCRTIni(text, { name: entry.name.replace(/\.ini$/i, ''), folder });
          if (profile) profiles.push(profile); else skipped++;
        } catch { skipped++; }
      }
    }
  }
  await walk(root, '');
  if (!profiles.length) return { count: 0, skipped };
  // Merge in one validated atomic write, rather than partially importing a directory.
  store.importConfig({ version: 1, sessions: profiles });
  return { count: profiles.length, skipped };
}

function registerHandlers() {
  handle('getState', getState);
  handle('projectOpen', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Open automation project', properties: ['openDirectory'] });
    return result.canceled ? null : projects.open(result.filePaths[0]);
  });
  handle('projectClose', async ({ projectId } = {}) => {
    if (ansible.hasProject(projectId)) throw new Error('Wait for this project’s Ansible job to stop before closing its folder.');
    if (savingProjects.has(projectId)) throw new Error('Wait for file saves to finish before closing this project.');
    await projects.close(projectId); dirtyProjects.delete(projectId); return true;
  });
  handle('projectSetDirty', ({ projectId, dirty } = {}) => {
    projects.getRoot(projectId);
    if (typeof dirty !== 'boolean') throw new Error('Invalid project edit state.');
    if (dirty) dirtyProjects.add(projectId); else dirtyProjects.delete(projectId);
    return true;
  });
  for (const [channel, method] of Object.entries({ projectList: 'list', projectRead: 'read', projectListBackups: 'listBackups', projectReadBackup: 'readBackup', projectGitStatus: 'gitStatus', projectGitDiff: 'gitDiff' })) handle(channel, input => projects[method](input));
  handle('projectSave', async input => {
    const projectId = input?.projectId;
    projects.getRoot(projectId);
    if (ansible.hasProject(projectId)) throw new Error('Wait for the Ansible job to stop before saving project files. Your editor buffer is unchanged.');
    savingProjects.set(projectId, (savingProjects.get(projectId) || 0) + 1);
    try { return await projects.save(input); }
    finally { const count = savingProjects.get(projectId) - 1; if (count) savingProjects.set(projectId, count); else savingProjects.delete(projectId); }
  });
  handle('ansibleProbe', input => ansible.probe(input));
  handle('ansiblePrepare', input => ansible.prepare(input));
  handle('ansibleStart', input => {
    if (savingProjects.size) throw new Error('Wait for project file saves to finish, then review the run again.');
    return ansible.start(input);
  });
  handle('ansibleCancel', id => ansible.cancel(id));
  handle('aiModels', (options) => localAi.listModels(options));
  handle('aiStart', (request) => localAi.start(request));
  handle('aiCancel', (requestId) => localAi.cancel(requestId));
  handle('saveSession', (input) => {
    const profile = validateSession(input);
    store.saveSession(profile);
    return store.load().sessions.find((item) => item.id === profile.id);
  });
  handle('saveSessions', (input) => { store.saveSessions(input); return store.load().sessions; });
  handle('deleteSession', (id) => { store.deleteSession(requiredId(id)); return getState(); });
  handle('saveSnippets', (input) => { store.saveSnippets(input); return store.load().snippets; });
  handle('saveSettings', (input) => { store.saveSettings(input); return store.load().settings; });
  handle('saveSnapshots', (input) => { store.saveSnapshots(input); return store.load().snapshots; });
  handle('saveCommandHistory', (input) => { store.saveCommandHistory(input); return store.load().commandHistory; });
  handle('serialPorts', () => listSerialPorts());
  handle('chooseIdentityFile', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose SSH private key', properties: ['openFile'], defaultPath: path.join(app.getPath('home'), '.ssh') });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('exportConfig', async () => {
    const result = await dialog.showSaveDialog(window, { title: 'Export connection profiles and snippets', defaultPath: 'termforge-config.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    await writePrivateFile(result.filePath, JSON.stringify(store.exportConfig(), null, 2) + '\n');
    return { path: result.filePath };
  });
  handle('importConfig', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Import TermForge configuration', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled) return null;
    const stat = await fsp.stat(result.filePaths[0]);
    if (stat.size > 4 * 1024 * 1024) throw new Error('Configuration exceeds 4 MiB');
    const config = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
    const imported = store.importConfig(config);
    return { count: Array.isArray(config.sessions) ? config.sessions.length : 0, skipped: imported.skipped || 0 };
  });
  handle('importSecureCRT', importSecureCRT);
  handle('terminalOpen', (request) => {
    if (!request || typeof request !== 'object' || (!!request.sessionId === !!request.profile)) throw new Error('Choose one connection profile');
    const profile = request.sessionId ? store.load().sessions.find((item) => item.id === requiredId(request.sessionId)) : validateSession(request.profile);
    if (!profile) throw new Error('Session not found');
    return terminals.open(profile);
  });
  handle('terminalWrite', (request) => terminals.write(request));
  handle('terminalActivate', (id) => {
    if (id === null) { activeTerminalId = null; return true; }
    if (!terminals.has(requiredId(id))) throw new Error('Terminal is no longer open.');
    activeTerminalId = id; return true;
  });
  handle('terminalFocus', (request) => {
    if (!request || typeof request.focused !== 'boolean') throw new Error('Invalid terminal focus request.');
    const id = requiredId(request.id);
    if (request.focused) { if (!terminals.has(id)) throw new Error('Terminal is no longer open.'); focusedTerminalId = id; }
    else if (focusedTerminalId === id) focusedTerminalId = null;
    return true;
  });
  handle('terminalResize', (request) => terminals.resize(request));
  handle('terminalReorder', (ids) => terminals.reorder(ids));
  handle('terminalBreak', (id) => terminals.sendBreak(requiredId(id)));
  handle('terminalPauseLog', (request) => {
    if (!request || typeof request.paused !== 'boolean') throw new Error('Invalid log pause request.');
    return terminals.pauseLog(requiredId(request.id), request.paused);
  });
  handle('prepareAsciiFile', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose text to send to the terminal', properties: ['openFile'] });
    if (result.canceled) return null;
    const filename = result.filePaths[0];
    const stat = await fsp.stat(filename);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Choose a UTF-8 text file of at most 256 KiB.');
    const bytes = await fsp.readFile(filename);
    if (bytes.length > 256 * 1024) throw new Error('Text file exceeds 256 KiB.');
    const text = bytes.toString('utf8');
    if (text.includes('\u0000') || !Buffer.from(text, 'utf8').equals(bytes)) throw new Error('This file is not UTF-8 text. Binary transfers require a binary file-transfer protocol.');
    return { name: path.basename(filename), size: bytes.length, text };
  });
  handle('scriptRun', async (request = {}) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['terminalId', 'arguments'].includes(key))) throw new Error('Invalid script request.');
    const terminalId = request.terminalId || activeTerminalId;
    if (terminalId && !terminals.has(requiredId(terminalId))) throw new Error('Choose an open terminal for the script.');
    const selected = await dialog.showOpenDialog(window, { title: 'Run Python script', properties: ['openFile'], filters: [{ name: 'Python script', extensions: ['py'] }] });
    if (selected.canceled) return null;
    return automation.run({ filename: selected.filePaths[0], terminalId, arguments: request.arguments || [] });
  });
  handle('scriptCancel', (id) => automation.cancel(requiredId(id)));
  handle('chooseTftpRoot', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose the folder to share through TFTP', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const token = require('node:crypto').randomUUID();
    while (tftpRoots.size >= 16) tftpRoots.delete(tftpRoots.keys().next().value);
    tftpRoots.set(token, { root: result.filePaths[0], created: Date.now() });
    return { token, root: result.filePaths[0] };
  });
  handle('tftpStatus', () => tftp?.status() || { state: 'stopped', running: false, activeTransfers: 0 });
  handle('tftpStart', async (request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['rootToken', 'clientAddress', 'bindAddress', 'port', 'allowWrite'].includes(key))) throw new Error('Invalid TFTP server request.');
    if (tftp) throw new Error('Stop the existing TFTP server before starting another.');
    const chosen = tftpRoots.get(request.rootToken);
    if (!chosen || Date.now() - chosen.created > 30 * 60 * 1000) throw new Error('Choose the shared folder again before starting the server.');
    const server = createTftpServer({ root: chosen.root, clientAddress: request.clientAddress, bindAddress: request.bindAddress, port: request.port, allowWrite: request.allowWrite, onStatus: state => send('tftpStatus', state), onTransfer: transfer => send('tftpTransfer', transfer) });
    tftp = server;
    try { await server.start(); return server.status(); }
    catch (error) { await server.stop(); if (tftp === server) tftp = null; throw error; }
  });
  handle('tftpStop', async () => { await tftp?.stop(); tftp = null; return { state: 'stopped', running: false, activeTransfers: 0 }; });
  handle('saveRecordedScript', async (events) => {
    const source = recordedInputToPython(events);
    const result = await dialog.showSaveDialog(window, { title: 'Save reviewed Python recording', defaultPath: 'termforge-recording.py', filters: [{ name: 'Python script', extensions: ['py'] }] });
    if (result.canceled || !result.filePath) return null;
    if (path.extname(result.filePath).toLowerCase() !== '.py') throw new Error('Choose a .py filename.');
    await fsp.writeFile(result.filePath, source, { flag: 'wx', mode: 0o600 });
    return { path: result.filePath };
  });
  handle('screenResponse', (response) => {
    if (!response || typeof response.requestId !== 'string') throw new Error('Invalid display response.');
    const pending = screenRequests.get(response.requestId);
    if (!pending) return false;
    screenRequests.delete(response.requestId); clearTimeout(pending.timer);
    if (typeof response.error === 'string') { pending.reject(new Error(response.error.slice(0, 500))); return true; }
    if (typeof response.text !== 'string' || Buffer.byteLength(response.text, 'utf8') > 1024 * 1024 || !['rows', 'columns', 'currentRow', 'currentColumn'].every(key => Number.isInteger(response[key]) && response[key] >= 1 && response[key] <= (key.toLowerCase().includes('row') ? 300 : 500))) {
      pending.reject(new Error('Invalid terminal display data.')); return false;
    }
    pending.resolve({ text: response.text, rows: response.rows, columns: response.columns, currentRow: response.currentRow, currentColumn: response.currentColumn }); return true;
  });
  handle('terminalClose', (id) => terminals.close(requiredId(id)));
  handle('terminalSetLog', async (request) => {
    if (!request || typeof request.enabled !== 'boolean') throw new Error('Invalid logging request');
    const id = requiredId(request.id);
    if (!request.enabled) { terminals.disableLog(id); return { enabled: false }; }
    const result = await dialog.showSaveDialog(window, { title: 'Save terminal output log — output may contain secrets', defaultPath: `termforge-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, filters: [{ name: 'Terminal log', extensions: ['log'] }] });
    if (result.canceled || !result.filePath) return { enabled: false };
    terminals.enableLog(id, result.filePath);
    return { enabled: true, path: result.filePath };
  });
  handle('clipboardRead', () => clipboard.readText());
  handle('clipboardWrite', (text) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Clipboard text exceeds 1 MiB');
    clipboard.writeText(text);
    return true;
  });
}

async function boot() {
  const dataDirectory = resolveDataDirectory(app.getPath('appData'), app.getPath('userData'));
  store = createStore(dataDirectory);
  store.load();
  projects = createProjectManager({ dataDirectory });
  ansible = createAnsibleManager({ projects, dataDirectory, send });
  protocol.handle('termforge', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      const target = path.resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
      if (!target.startsWith(rendererRoot + path.sep)) return new Response('Forbidden', { status: 403 });
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }[path.extname(target)];
      if (!mime) return new Response('Forbidden', { status: 403 });
      return new Response(await fsp.readFile(target), { headers: { 'Content-Type': mime, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  window = new BrowserWindow({
    width: 1280, height: 800, minWidth: 850, minHeight: 600,
    title: 'TermForge', backgroundColor: '#f5f7fa',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 24 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
  });
  terminals = createTerminalManager({ cwd: app.getPath('home'), emitData: (data) => { automation?.feedData(data); send('terminalData', data); }, emitExit: (data) => { automation?.feedExit(data); if (activeTerminalId === data.id) activeTerminalId = null; send('terminalExit', data); } });
  automation = createAutomationManager({
    getSessionProfiles: () => store.load().sessions,
    getActiveTerminalId: () => activeTerminalId,
    openSession: (profile) => { if (shuttingDown) throw new Error('TermForge is stopping its active work.'); const opened = terminals.open(profile); send('terminalOpened', { ...opened, profile }); return opened; },
    closeSession: (id) => terminals.close(id), writeTerminal: (data) => terminals.write(data),
    getTerminalIds: () => terminals.list(), getTerminalDetails: (id) => terminals.describe(id),
    getScreen: readScreen, activateTerminal: (id) => { if (!terminals.has(requiredId(id))) throw new Error('Terminal is no longer open.'); activeTerminalId = id; send('terminalActivated', { id }); },
    emitOutput: (data) => send('scriptOutput', data), emitStatus: (data) => send('scriptStatus', data),
  });
  localAi = createAiAssistant({ emit: (event) => send('aiEvent', event) });
  registerHandlers();
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !focusedTerminalId) return;
    const terminal = terminals.describe(focusedTerminalId);
    const mapping = matchingMapping({ type: 'keydown', key: input.key, code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta, isComposing: input.isComposing }, terminal?.session.terminal.mappedKeys);
    if (mapping) { event.preventDefault(); send('mappedKey', { id: terminal.id, mapping }); }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', () => { cleanupTerminals().catch(error => console.error('Cleanup failed:', error.message)); });
  window.on('close', (event) => {
    if (quitting) return;
    if (savingProjects.size) {
      event.preventDefault();
      dialog.showMessageBoxSync(window, { type: 'info', buttons: ['Keep open'], defaultId: 0, cancelId: 0, message: 'A project file is still saving.', detail: 'Let the save finish, then close TermForge again. Closing now could interrupt the file write.' });
      return;
    }
    const serverState = tftp?.status();
    const serverOwned = serverState && (serverState.state !== 'stopped' || serverState.activeTransfers > 0);
    if (terminals.count === 0 && automation.count === 0 && !serverOwned && !ansible.count && !dirtyProjects.size) return;
    event.preventDefault();
    if (shuttingDown) return;
    const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep open', dirtyProjects.size ? 'Discard edits and quit' : 'Stop work and quit'], defaultId: 0, cancelId: 0, message: dirtyProjects.size ? 'Quit with unsaved project edits?' : 'Stop active work and quit?', detail: `${dirtyProjects.size ? 'Unsaved project edits will be lost. ' : ''}${terminals.count} terminal(s), ${automation.count} Python script(s), ${ansible.count || 0} Ansible job(s)${serverOwned ? ', and the TFTP server' : ''}. Running operations may be interrupted. Stopping Ansible does not undo completed changes.` });
    if (choice === 1) {
      shuttingDown = true;
      cleanupTerminals().then(() => { quitting = true; app.quit(); }).catch(error => { shuttingDown = false; dialog.showErrorBox('Active work could not stop', error.message); });
    }
  });
  Menu.setApplicationMenu(applicationMenu());
  if (process.platform !== 'darwin') window.setMenuBarVisibility(false);
  await window.loadURL(trustedURL);
  if (process.argv.includes('--termforge-smoke') || process.argv.includes('--termforge-package-smoke')) {
    try {
      const runTest = process.argv.includes('--termforge-package-smoke') ? require('./package-smoke.cjs') : require('../scripts/smoke-runner.cjs');
      await runTest({ window, terminals, store });
      quitting = true;
      await cleanupTerminals();
      app.exit(0);
    } catch (error) {
      console.error(error.stack || error);
      quitting = true;
      await cleanupTerminals();
      app.exit(1);
    }
  }
}

app.whenReady().then(boot).catch((error) => {
  dialog.showErrorBox('TermForge could not start', error.message);
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { cleanupTerminals().catch(error => console.error('Cleanup failed:', error.message)); });
