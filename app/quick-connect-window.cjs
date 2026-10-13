'use strict';
const { randomUUID } = require('node:crypto');
const { validateQuickConnect } = require('./core.cjs');

const QUICK_CONNECT_URL = 'termforge://app/quick-connect.html';

// The auxiliary window has its own minimal bridge. It cannot invoke terminal,
// transfer, automation, clipboard, vault-write or general configuration APIs.
function createQuickConnectWindow({ BrowserWindow, ipcMain, parent, preload, getState, prepare,
  requestMain, manageCredentials, chooseIdentityFile, isStopping = () => false,
  timeoutMs = 5000, workArea = { width: 1280, height: 800 } }) {
  let child = null, loading = null, pending = null, managing = false, disposed = false, fileSession = false, accepted = false;
  const handlers = [];
  function exists() { return child && !child.isDestroyed(); }
  function cancelPending(message) {
    if (!pending) return;
    const current = pending; pending = null; clearTimeout(current.timer);
    current.reject(new Error(message));
  }
  function available() {
    if (disposed || isStopping() || parent.isDestroyed()) throw new Error('The workspace is closing.');
  }
  function focused() { return exists() && BrowserWindow.getFocusedWindow() === child; }
  function show() {
    if (!exists()) return;
    if (child.isMinimized()) child.restore();
    child.show(); child.focus();
  }
  function close() {
    managing = false;
    cancelPending('Quick Connect was cancelled.');
    if (exists()) child.close();
  }
  async function open(options = {}) {
    available();
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'fileSession') || options.fileSession !== undefined && typeof options.fileSession !== 'boolean') throw new Error('Invalid Quick Connect options.');
    if (exists()) {
      if (accepted) throw new Error('The connection is being opened.');
      await loading;
      if (options.fileSession && exists()) { fileSession = true; child.webContents.send('termforge:quickConnect:fileSession', true); }
      show(); return true;
    }
    fileSession = Boolean(options.fileSession);
    accepted = false;
    const width = Math.max(440, Math.min(660, workArea.width - 40));
    const height = Math.max(420, Math.min(660, workArea.height - 60));
    const current = new BrowserWindow({
      width, height, minWidth: Math.min(540, width), minHeight: Math.min(500, height),
      parent, modal: false, show: false, title: 'Quick Connect',
      frame: true, titleBarStyle: 'default', minimizable: true, maximizable: true,
      resizable: true, fullscreenable: false, backgroundColor: '#ececec',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false,
        sandbox: true, webSecurity: true, spellcheck: false, zoomMode: 'isolated' }
    });
    child = current;
    current.setMenuBarVisibility(false);
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.on('will-redirect', event => event.preventDefault());
    current.webContents.on('page-title-updated', event => event.preventDefault());
    current.webContents.on('render-process-gone', () => { cancelPending('Quick Connect stopped unexpectedly.'); if (!current.isDestroyed()) current.destroy(); });
    current.on('closed', () => {
      if (child !== current) return;
      cancelPending('Quick Connect was closed.');
      child = null; loading = null; managing = false;
    });
    loading = current.loadURL(QUICK_CONNECT_URL);
    try { await loading; available(); if (child === current && !current.isDestroyed()) show(); return true; }
    catch (error) { if (!current.isDestroyed()) current.destroy(); throw error; }
  }
  function handle(name, callback) {
    const channel = `termforge:quickConnect:${name}`; handlers.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      available();
      if (!exists() || event.sender !== child.webContents || event.senderFrame !== child.webContents.mainFrame || event.senderFrame.url !== QUICK_CONNECT_URL) throw new Error('Untrusted Quick Connect request.');
      return callback(...args);
    });
  }
  handle('getState', async () => ({ ...await getState(), fileSession }));
  handle('close', () => { close(); return true; });
  handle('chooseIdentityFile', () => chooseIdentityFile(child));
  handle('manageCredentials', () => {
    if (pending || accepted) throw new Error('Wait for the connection request to finish.');
    managing = true; child.hide(); parent.show(); parent.focus(); manageCredentials(); return true;
  });
  handle('submit', input => {
    if (pending || accepted) throw new Error('A connection request is already being submitted.');
    const request = validateQuickConnect(input);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => cancelPending('The workspace did not accept the connection. Try again.'), timeoutMs);
      pending = { id, input: request, resolve, reject, timer };
      try { requestMain({ id }); }
      catch { cancelPending('The workspace could not receive the connection.'); }
    });
  });
  return {
    open, close,
    accept(id) {
      available();
      if (typeof id !== 'string' || !pending || pending.id !== id || !exists()) throw new Error('This Quick Connect request has expired.');
      const current = pending;
      let result;
      try { result = prepare(current.input); }
      catch (error) { cancelPending(error.message); return null; }
      accepted = true; pending = null; clearTimeout(current.timer); current.resolve({ accepted: true });
      child.hide(); parent.show(); parent.focus();
      const acceptedWindow = child;
      setImmediate(() => { if (child === acceptedWindow && !acceptedWindow.isDestroyed()) acceptedWindow.close(); });
      return result;
    },
    async resumeCredentials() {
      if (!managing || !exists() || disposed || isStopping()) return false;
      managing = false;
      const current = child;
      try {
        const state = await getState();
        if (child !== current || current.isDestroyed()) return false;
        current.webContents.send('termforge:quickConnect:credentialsChanged', state.credentials);
      } finally { if (child === current && !current.isDestroyed()) show(); }
      return true;
    },
    routeMenuAction(action) {
      if (!focused()) return false;
      const editing = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', 'select-all': 'selectAll' };
      if (editing[action]) child.webContents[editing[action]]();
      else if (action === 'close-tab') close();
      else if (action === 'quick-connect') show();
      // Other workspace actions do not run against the terminal behind it.
      return true;
    },
    dispose() { disposed = true; close(); for (const channel of handlers) ipcMain.removeHandler(channel); }
  };
}
module.exports = { createQuickConnectWindow, QUICK_CONNECT_URL };
