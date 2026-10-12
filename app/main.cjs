'use strict';
const { app, BrowserWindow, ipcMain, protocol, dialog, clipboard, Menu } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createStore, validateSession, parseSecureCRTIni } = require('./core.cjs');
const { createTerminalManager } = require('./terminals.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'harbor', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('Harbor Terminal');
let window;
let store;
let terminals;
let quitting = false;
const rendererRoot = path.join(__dirname, '../renderer');
const trustedURL = 'harbor://app/index.html';
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(`harbor:${channel}`, value);
}
function cleanupTerminals() {
  try { terminals?.closeAll(); } catch (error) { console.error('Terminal cleanup failed:', error.message); }
}
function handle(name, callback) {
  ipcMain.handle(`harbor:${name}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== trustedURL) {
      throw new Error('Untrusted request');
    }
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
      action('New Session…', 'new-session', 'CommandOrControl+N'),
      action('Connect', 'connect', 'CommandOrControl+O'),
      action('Local Shell', 'local-shell', 'CommandOrControl+T'), separator,
      action('Disconnect', 'disconnect'), action('Reconnect', 'reconnect'), separator,
      action('Import / Export…', 'import-export'), separator,
      action('Close Tab', 'close-tab', 'CommandOrControl+W'),
      ...(process.platform === 'darwin' ? [] : [{ role: 'quit' }])
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, separator, { role: 'cut' },
      action('Copy Terminal Selection', 'copy', 'CommandOrControl+Shift+C'),
      action('Paste into Terminal', 'paste', 'CommandOrControl+Shift+V'),
      action('Select Terminal Output', 'select-all'), separator,
      action('Find…', 'find', 'CommandOrControl+F')
    ] },
    { label: 'View', submenu: [
      action('Session Manager', 'show-session-manager'), action('Command Window', 'show-command-window'),
      action('Button Bar', 'show-button-bar'), separator,
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, separator, { role: 'togglefullscreen' }
    ] },
    { label: 'Options', submenu: [action('Session Options…', 'session-options'), action('Global Options…', 'settings')] },
    { label: 'Transfer', submenu: [action('Open SFTP Session', 'sftp'), action('Log Session…', 'log')] },
    { label: 'Tools', submenu: [action('Edit Button Bar…', 'snippets'), action('Import / Export…', 'import-export')] },
    { label: 'Window', submenu: [action('Tile Sessions', 'tile'), separator, { role: 'minimize' }, { label: 'Close Window', role: 'close', accelerator: 'CommandOrControl+Shift+W' }] },
    { label: 'Help', submenu: [action('Harbor Terminal Help', 'help')] }
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
  handle('saveSession', (input) => {
    const profile = validateSession(input);
    store.saveSession(profile);
    return store.load().sessions.find((item) => item.id === profile.id);
  });
  handle('deleteSession', (id) => { store.deleteSession(requiredId(id)); return getState(); });
  handle('saveSnippets', (input) => { store.saveSnippets(input); return store.load().snippets; });
  handle('saveSettings', (input) => { store.saveSettings(input); return store.load().settings; });
  handle('chooseIdentityFile', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose SSH private key', properties: ['openFile'], defaultPath: path.join(app.getPath('home'), '.ssh') });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('exportConfig', async () => {
    const result = await dialog.showSaveDialog(window, { title: 'Export connection profiles and snippets', defaultPath: 'harbor-config.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, JSON.stringify(store.exportConfig(), null, 2) + '\n', { mode: 0o600 });
    return { path: result.filePath };
  });
  handle('importConfig', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Import Harbor configuration', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
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
  handle('terminalResize', (request) => terminals.resize(request));
  handle('terminalClose', (id) => terminals.close(requiredId(id)));
  handle('terminalSetLog', async (request) => {
    if (!request || typeof request.enabled !== 'boolean') throw new Error('Invalid logging request');
    const id = requiredId(request.id);
    if (!request.enabled) { terminals.disableLog(id); return { enabled: false }; }
    const result = await dialog.showSaveDialog(window, { title: 'Save terminal output log — output may contain secrets', defaultPath: `harbor-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, filters: [{ name: 'Terminal log', extensions: ['log'] }] });
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
  const dataDirectory = process.env.HARBOR_DATA_DIR || app.getPath('userData');
  store = createStore(dataDirectory);
  store.load();
  protocol.handle('harbor', async (request) => {
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
    title: 'Harbor Terminal', backgroundColor: '#f0f0f0',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
  });
  terminals = createTerminalManager({ cwd: app.getPath('home'), emitData: (data) => send('terminalData', data), emitExit: (data) => send('terminalExit', data) });
  registerHandlers();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', cleanupTerminals);
  window.on('close', (event) => {
    if (quitting || terminals.count === 0) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep open', 'Disconnect and quit'], defaultId: 0, cancelId: 0, message: `Disconnect ${terminals.count} active terminal${terminals.count === 1 ? '' : 's'}?`, detail: 'Running commands may be interrupted.' });
    if (choice === 1) {
      try { terminals.closeAll(); quitting = true; app.quit(); }
      catch (error) { dialog.showErrorBox('A terminal could not disconnect', error.message); }
    }
  });
  Menu.setApplicationMenu(applicationMenu());
  if (process.platform !== 'darwin') window.setMenuBarVisibility(false);
  await window.loadURL(trustedURL);
  if (process.argv.includes('--harbor-smoke') || process.argv.includes('--harbor-package-smoke')) {
    try {
      const runTest = process.argv.includes('--harbor-package-smoke') ? require('./package-smoke.cjs') : require('../scripts/smoke-runner.cjs');
      await runTest({ window, terminals, store });
      quitting = true;
      cleanupTerminals();
      app.exit(0);
    } catch (error) {
      console.error(error.stack || error);
      quitting = true;
      cleanupTerminals();
      app.exit(1);
    }
  }
}

app.whenReady().then(boot).catch((error) => {
  dialog.showErrorBox('Harbor Terminal could not start', error.message);
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (quitting) cleanupTerminals(); });
app.on('will-quit', cleanupTerminals);
