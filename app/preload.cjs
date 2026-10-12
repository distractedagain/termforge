'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(`harbor:${name}`, ...args);
const subscribe = (name) => (callback) => {
  if (typeof callback !== 'function') throw new TypeError('Callback required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(`harbor:${name}`, listener);
  return () => ipcRenderer.removeListener(`harbor:${name}`, listener);
};
contextBridge.exposeInMainWorld('harbor', {
  getState: invoke('getState'),
  saveSession: invoke('saveSession'),
  deleteSession: invoke('deleteSession'),
  saveSnippets: invoke('saveSnippets'),
  saveSettings: invoke('saveSettings'),
  exportConfig: invoke('exportConfig'),
  importConfig: invoke('importConfig'),
  importSecureCRT: invoke('importSecureCRT'),
  chooseIdentityFile: invoke('chooseIdentityFile'),
  terminalOpen: invoke('terminalOpen'),
  terminalWrite: invoke('terminalWrite'),
  terminalResize: invoke('terminalResize'),
  terminalClose: invoke('terminalClose'),
  terminalSetLog: invoke('terminalSetLog'),
  clipboardRead: invoke('clipboardRead'),
  clipboardWrite: invoke('clipboardWrite'),
  onTerminalData: subscribe('terminalData'),
  onTerminalExit: subscribe('terminalExit'),
  onMenuAction: subscribe('menuAction')
});
