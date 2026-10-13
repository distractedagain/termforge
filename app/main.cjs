'use strict';
const { app, BrowserWindow, ipcMain, protocol, dialog, clipboard, Menu, safeStorage, screen, shell } = require('electron');
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
const { createCredentialVault } = require('./credentials.cjs');
const { createAuthPrompts } = require('./auth-prompts.cjs');
const { createSecureSsh } = require('./secure-ssh.cjs');
const { createSecureTransfers } = require('./secure-transfers.cjs');
const { createQuickConnectWindow } = require('./quick-connect-window.cjs');
const { createNativeMenu } = require('./native-menu.cjs');
const { createDesktopActions } = require('./desktop-actions.cjs');
const { createKeyTools } = require('./key-tools.cjs');
const { createSessionImport } = require('./session-import.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'termforge', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('TermForge');
let window;
let store;
let terminals;
let automation;
let localAi;
let projects;
let ansible;
let credentials;
let authPrompts;
let secureSsh;
let secureTransfers;
let quickConnect;
let nativeMenu;
let desktopActions;
let keyTools;
let sessionImport;
let menuReady = false;
const recentScripts = new Map();
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
  quickConnect?.close();
  sessionImport?.close();
  await keyTools?.close();
  localAi?.close();
  authPrompts?.closeAll();
  for (const pending of screenRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Terminal display is closing.')); }
  screenRequests.clear();
  const server = tftp;
  await stopOwnedResources({ ansible: () => ansible?.closeAll(), scripts: () => automation?.closeAll(), terminals: () => terminals?.closeAll(), secureConnections: async () => { try { await secureTransfers?.closeAll(); } finally { await secureSsh?.closeAll(); } }, tftp: async () => { await server?.stop(); if (tftp === server) tftp = null; } });
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
    if (shuttingDown && ['terminalOpen', 'scriptRun', 'tftpStart', 'aiStart', 'aiModels', 'projectOpen', 'projectSave', 'ansibleProbe', 'ansiblePrepare', 'ansibleStart', 'transferOpen', 'transferStart', 'transferPrepareRemoteOperation', 'transferApplyRemoteOperation', 'sessionImportChoose', 'sessionImportPreview', 'sessionImportApply', 'credentialSave', 'keyToolsGenerate', 'keyToolsConvert', 'terminalSendBinary', 'terminalSetCapture', 'terminalSetLog', 'printTerminal'].includes(name)) throw new Error('TermForge is stopping its active work.');
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
function connectionProfile(request) {
  if (!request || typeof request !== 'object' || (!!request.sessionId === !!request.profile)) throw new Error('Choose one connection profile.');
  const profile = request.sessionId ? store.load().sessions.find(item => item.id === requiredId(request.sessionId)) : validateSession(request.profile);
  if (!profile) throw new Error('Session not found.');
  return profile;
}
async function approveNative({ title, message, detail, accept, signal }) {
  if (shuttingDown || signal?.aborted || !window || window.isDestroyed()) return false;
  const result = await dialog.showMessageBox(window, { type: 'warning', title, message, detail, buttons: ['Cancel', accept], defaultId: 0, cancelId: 0, noLink: true, ...(signal ? { signal } : {}) });
  return result.response === 1 && !signal?.aborted && !shuttingDown;
}

function initializeMenu() {
  desktopActions = createDesktopActions({ BrowserWindow, shell, getWindow: () => window, getActionWindow: () => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused && (focused === window || focused.webContents.getURL() === 'termforge://app/quick-connect.html') ? focused : window;
  } });
  nativeMenu = createNativeMenu({ Menu, platform: process.platform, appName: app.name,
    getContext: () => ({ ready: menuReady, quickConnectFocused: BrowserWindow.getFocusedWindow()?.webContents?.getURL() === 'termforge://app/quick-connect.html' }),
    dispatch: action => { if (!quickConnect?.routeMenuAction(action)) send('menuAction', action); },
    runNative: action => action === 'quit' ? window.close() : desktopActions.perform(action),
    onError: error => dialog.showErrorBox('Menu command failed', error.message)
  });
  nativeMenu.refresh();
  app.on('browser-window-focus', () => nativeMenu.refresh());
  app.on('browser-window-blur', () => nativeMenu.refresh());
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
  handle('quickConnectOpen', options => quickConnect.open(options));
  handle('quickConnectAccept', id => quickConnect.accept(id));
  handle('quickConnectResume', () => quickConnect.resumeCredentials());
  handle('credentialStatus', () => credentials.status());
  handle('credentialList', () => credentials.list());
  handle('credentialSave', input => credentials.save(input));
  handle('credentialDelete', async id => {
    const entry = (await credentials.list()).find(item => item.id === requiredId(id));
    if (!entry) return { deleted: false };
    if (!await approveNative({ title: 'Delete saved credential', message: `Delete “${entry.name}”?`, detail: 'Saved sessions that use this credential will need another credential or a password prompt. Active connections remain open.', accept: 'Delete credential' })) return { deleted: false };
    return credentials.delete(id);
  });
  handle('authRespond', input => authPrompts.respond(input));
  handle('sshHosts', () => secureSsh.listHosts());
  handle('sshForgetHost', async input => {
    if (!input || typeof input.host !== 'string' || !Number.isInteger(input.port)) throw new Error('Choose a trusted host.');
    const entry = (await secureSsh.listHosts()).find(item => item.host === input.host && item.port === input.port);
    if (!entry) return { forgotten: false };
    if (!await approveNative({ title: 'Forget SSH host key', message: `Forget the verified key for ${entry.host}:${entry.port}?`, detail: `Current key: ${entry.fingerprint}\n\nThe next connection will ask you to verify the server identity again.`, accept: 'Forget key' })) return { forgotten: false };
    return secureSsh.forgetHost(input);
  });
  handle('transferOpen', request => {
    const profile = connectionProfile(request);
    if (!['ssh', 'sftp'].includes(profile.protocol)) throw new Error('File transfers require an SSH session.');
    return secureTransfers.open(validateSession({ ...profile, ssh: { ...profile.ssh, backend: 'managed' } }));
  });
  handle('transferClose', id => secureTransfers.close(requiredId(id)));
  handle('transferListRemote', input => secureTransfers.listRemote(input));
  handle('transferListLocal', input => secureTransfers.listLocal(input));
  handle('transferChooseLocal', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose local transfer folder', properties: ['openDirectory'], defaultPath: app.getPath('home') });
    return result.canceled ? null : { path: result.filePaths[0] };
  });
  handle('transferStart', input => secureTransfers.start(input));
  handle('transferCancel', id => secureTransfers.cancel(requiredId(id)));
  handle('transferPrepareRemoteOperation', input => secureTransfers.prepareRemoteOperation(input));
  handle('transferApplyRemoteOperation', input => secureTransfers.applyRemoteOperation(input));
  handle('transferDiscardRemoteOperation', input => secureTransfers.discardRemoteOperation(input));
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
  handle('sessionImportChoose', () => sessionImport.choose());
  handle('sessionImportPreview', input => sessionImport.preview(input));
  handle('sessionImportApply', input => sessionImport.apply(input));
  handle('sessionImportDiscard', input => sessionImport.discard(input));
  handle('terminalOpen', (request) => {
    const profile = connectionProfile(request);
    if (profile.protocol === 'sftp' && profile.ssh.backend === 'managed') throw new Error('Open this managed session in File Transfer.');
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
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['terminalId', 'arguments', 'recentId'].includes(key))) throw new Error('Invalid script request.');
    const terminalId = request.terminalId || activeTerminalId;
    if (terminalId && !terminals.has(requiredId(terminalId))) throw new Error('Choose an open terminal for the script.');
    let filename;
    if (request.recentId !== undefined) {
      filename = recentScripts.get(requiredId(request.recentId));
      if (!filename) throw new Error('This recent script is no longer available.');
      if (!await approveNative({ title:'Run recent Python script', message:`Run ${path.basename(filename)}?`, detail:`${filename}\nPython scripts run with your user privileges and can modify files or connected systems. The file may have changed since its last run.`, accept:'Run script' })) return null;
    } else {
      const selected = await dialog.showOpenDialog(window, { title:'Run Python script', properties:['openFile'], filters:[{name:'Python script',extensions:['py']}] });
      if (selected.canceled) return null;
      filename = selected.filePaths[0];
    }
    const result = await automation.run({ filename, terminalId, arguments:request.arguments || [] });
    for (const [id, previous] of recentScripts) if (previous === filename) recentScripts.delete(id);
    recentScripts.set(require('node:crypto').randomUUID(), filename);
    while (recentScripts.size > 10) recentScripts.delete(recentScripts.keys().next().value);
    return result;
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
    if (request.mode !== undefined && !['raw','text'].includes(request.mode)) throw new Error('Invalid log mode.');
    if (request.enabled && request.mode === 'raw' && !terminals.outputState(id).capabilities.rawLog) throw new Error('Raw byte logging is unavailable for this connection.');
    if (!request.enabled) { terminals.disableLog(id); return { enabled: false }; }
    const result = await dialog.showSaveDialog(window, { title: 'Save terminal output log — output may contain secrets', defaultPath: `termforge-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, filters: [{ name: 'Terminal log', extensions: ['log'] }] });
    if (result.canceled || !result.filePath) { const log = terminals.outputState(id).log; return { canceled:true, enabled:log.enabled, path:log.path }; }
    terminals.enableLog(id, result.filePath, { mode: request.mode === 'raw' ? 'raw' : 'text' });
    return { enabled: true, path: result.filePath };
  });
  handle('menuState', input => { menuReady = input?.ready === true; nativeMenu?.update(input); return true; });
  handle('desktopAction', (action, value) => desktopActions.perform(action, value));
  handle('printTerminal', input => desktopActions.print(input));
  handle('terminalOutputState', id => terminals.outputState(requiredId(id)));
  handle('terminalReadRaw', id => terminals.readRaw(requiredId(id)));
  handle('terminalSetCapture', async request => {
    if (!request || typeof request.enabled !== 'boolean') throw new Error('Invalid ASCII capture request.');
    const id = requiredId(request.id);
    if (!request.enabled) return terminals.disableCapture(id);
    terminals.outputState(id);
    const result = await dialog.showSaveDialog(window, { title:'Receive ASCII into a new text file', defaultPath:'termforge-received.txt', filters:[{name:'Text',extensions:['txt']}] });
    if (result.canceled || !result.filePath) return null;
    return terminals.enableCapture(id, result.filePath);
  });
  handle('terminalSendBinary', async id => {
    id = requiredId(id);
    if (!terminals.outputState(id).capabilities.binary) throw new Error('This connection cannot send transparent binary bytes.');
    const result = await dialog.showOpenDialog(window, { title:'Choose binary data to send', properties:['openFile'] });
    if (result.canceled) return null;
    const filename = result.filePaths[0], file = await fsp.open(filename, 'r');
    let bytes;
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Choose a regular file no larger than 256 KiB.'); bytes = Buffer.alloc(256 * 1024 + 1); let total = 0; while (total < bytes.length) { const read = await file.read(bytes, total, bytes.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; } if (total > 256 * 1024) throw new Error('Binary input exceeds 256 KiB.'); bytes = bytes.subarray(0, total); } finally { await file.close(); }
    const target = terminals.describe(id);
    const accepted = await approveNative({ title:'Send binary data', message:`Send ${bytes.length} bytes to ${target.title}?`, detail:`File: ${path.basename(filename)}\nThis sends raw bytes to the session. The receiving application must be ready; control bytes may trigger commands. This does not upload a named remote file.`, accept:'Send binary data' });
    if (!accepted) return null;
    return terminals.writeBinary({ id, data:bytes });
  });
  handle('scriptRecent', () => [...recentScripts].reverse().map(([id, filename]) => ({ id, name:path.basename(filename) })));
  handle('clipboardRead', () => clipboard.readText());
  handle('clipboardWrite', async (text) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Clipboard text exceeds 1 MiB');
    await clipboard.writeText(text);
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
  authPrompts = createAuthPrompts({ send });
  credentials = createCredentialVault({ directory: dataDirectory, safeStorage, confirmUse: ({ name, host, port, fingerprint, signal }) => approveNative({ title: 'Allow saved credential', message: `Use “${name}” with ${host}:${port}?`, detail: `Verified server key: ${fingerprint}\n\nThis allows this credential to authenticate to this host and key on future connections. Only approve servers you trust with these credentials.`, accept: 'Allow credential', signal }) });
  secureSsh = createSecureSsh({ directory: dataDirectory, getCredential: (profile, options) => profile.credentialId ? credentials.use(profile.credentialId, profile, options) : null, requestAuthentication: input => authPrompts.request(input), confirmHost: ({ host, port, fingerprint, algorithm, signal }) => approveNative({ title: 'Verify SSH server identity', message: `Trust ${host}:${port}?`, detail: `Key type: ${algorithm}\nFingerprint: ${fingerprint}\n\nCompare this fingerprint with one provided by the server administrator. Accepting saves this key for future managed SSH and file transfer connections.`, accept: 'Trust and connect', signal }) });
  secureTransfers = createSecureTransfers({
    connect: (profile, options) => secureSsh.connect(profile, options), emit: event => send('transferEvent', event),
    confirmOverwrite: ({ direction, source, destination, signal }) => approveNative({ title: 'Replace existing file', message: `Replace the ${direction === 'download' ? 'local' : 'remote'} destination?`, detail: `From: ${source}\nTo: ${destination}\n\nThe existing destination will be replaced after a successful transfer.`, accept: 'Replace file', signal }),
    confirmRemoteOperation: (review, { signal } = {}) => {
      const labels = { mkdir: 'Create remote folder', rename: 'Rename remote item', delete: 'Delete remote item', chmod: 'Change remote permissions' };
      return approveNative({ title: labels[review.operation], message: `${labels[review.operation]}?`,
        detail: `Server: ${review.host}:${review.port}\nPath: ${review.path}${review.destination ? `\nNew path: ${review.destination}` : ''}${review.permissions ? `\nPermissions: ${review.permissions}` : ''}\n\n${review.operation === 'delete' ? 'Deletion is permanent. Only a regular file or empty directory can be removed.' : 'This changes the selected item on the remote server.'}`,
        accept: labels[review.operation], signal });
    }
  });
  sessionImport = createSessionImport({
    chooseFile: async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Import sessions from CSV or text', properties: ['openFile'], filters: [{ name: 'Session lists', extensions: ['csv', 'tsv', 'txt'] }, { name: 'All files', extensions: ['*'] }] });
      return result.canceled ? null : { path: result.filePaths[0] };
    },
    loadConfig: () => store.load(),
    commitSessions: (sessions, options) => {
      if (shuttingDown) throw new Error('TermForge is stopping its active work.');
      return store.commitImportedSessions(sessions, options);
    },
    approveApply: review => approveNative({ title: 'Import reviewed sessions', message: `Save ${review.added + review.replaced} imported sessions?`, detail: `Add: ${review.added}\nReplace: ${review.replaced}\nSkip: ${review.skipped}\n\nExisting sessions selected for replacement keep their identifiers. No connections will be opened.`, accept: 'Import sessions' })
  });
  quickConnect = createQuickConnectWindow({
    BrowserWindow, ipcMain, parent: window, preload: path.join(__dirname, 'quick-connect-preload.cjs'),
    workArea: screen.getDisplayMatching(window.getBounds()).workArea,
    isStopping: () => shuttingDown || quitting,
    getState: async () => {
      let entries = [], credentialError = '';
      try { entries = await credentials.list(); }
      catch { credentialError = 'Saved credentials could not be loaded. Use a username or open the credential manager to check storage.'; }
      return { platform: process.platform, settings: store.load().settings,
        credentials: entries, credentialError, serialPorts: await listSerialPorts().catch(() => []) };
    },
    prepare: input => store.prepareQuickConnect(input),
    requestMain: request => send('quickConnectRequest', request),
    manageCredentials: () => send('quickConnectCredentials'),
    chooseIdentityFile: async parent => {
      const result = await dialog.showOpenDialog(parent, { title: 'Choose SSH private key', properties: ['openFile'], defaultPath: path.join(app.getPath('home'), '.ssh') });
      return result.canceled ? null : result.filePaths[0];
    }
  });
  window.on('closed', () => quickConnect.dispose());
  terminals = createTerminalManager({ managedTransport: profile => secureSsh.createTerminal(profile), cwd: app.getPath('home'), emitData: (data) => { automation?.feedData(data); send('terminalData', data); }, emitOutputState: data => send('terminalOutputState', data), emitExit: (data) => { automation?.feedExit(data); if (activeTerminalId === data.id) activeTerminalId = null; send('terminalExit', data); } });
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
  keyTools = createKeyTools({ dialog, getWindow: () => window, register: handle, approve: approveNative });
  initializeMenu();
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
    const transferConnections = secureTransfers?.count || 0;
    const keyOperations = keyTools?.count || 0;
    if (terminals.count === 0 && automation.count === 0 && !serverOwned && !ansible.count && !dirtyProjects.size && !transferConnections && !keyOperations) return;
    event.preventDefault();
    if (shuttingDown) return;
    const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep open', dirtyProjects.size ? 'Discard edits and quit' : 'Stop work and quit'], defaultId: 0, cancelId: 0, message: dirtyProjects.size ? 'Quit with unsaved project edits?' : 'Stop active work and quit?', detail: `${dirtyProjects.size ? 'Unsaved project edits will be lost. ' : ''}${terminals.count} terminal(s), ${transferConnections} file-transfer connection(s), ${keyOperations} SSH key operation(s), ${automation.count} Python script(s), ${ansible.count || 0} Ansible job(s)${serverOwned ? ', and the TFTP server' : ''}. Running operations may be interrupted. Stopping Ansible does not undo completed changes.` });
    if (choice === 1) {
      shuttingDown = true;
      cleanupTerminals().then(() => { quitting = true; app.quit(); }).catch(error => { shuttingDown = false; dialog.showErrorBox('Active work could not stop', error.message); });
    }
  });

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
