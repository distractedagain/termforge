'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(`termforge:${name}`, ...args);
const subscribe = (name) => (callback) => {
  if (typeof callback !== 'function') throw new TypeError('Callback required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(`termforge:${name}`, listener);
  return () => ipcRenderer.removeListener(`termforge:${name}`, listener);
};
contextBridge.exposeInMainWorld('termforge', {
  getState: invoke('getState'),
  aiModels: invoke('aiModels'),
  aiStart: invoke('aiStart'),
  aiCancel: invoke('aiCancel'),
  onAiEvent: subscribe('aiEvent'),
  saveSession: invoke('saveSession'),
  saveSessions: invoke('saveSessions'),
  deleteSession: invoke('deleteSession'),
  saveSnippets: invoke('saveSnippets'),
  saveSettings: invoke('saveSettings'),
  saveSnapshots: invoke('saveSnapshots'),
  saveCommandHistory: invoke('saveCommandHistory'),
  serialPorts: invoke('serialPorts'),
  exportConfig: invoke('exportConfig'),
  importConfig: invoke('importConfig'),
  importSecureCRT: invoke('importSecureCRT'),
  chooseIdentityFile: invoke('chooseIdentityFile'),
  terminalOpen: invoke('terminalOpen'),
  terminalWrite: invoke('terminalWrite'),
  terminalActivate: invoke('terminalActivate'),
  terminalFocus: invoke('terminalFocus'),
  terminalResize: invoke('terminalResize'),
  terminalReorder: invoke('terminalReorder'),
  terminalBreak: invoke('terminalBreak'),
  terminalPauseLog: invoke('terminalPauseLog'),
  prepareAsciiFile: invoke('prepareAsciiFile'),
  chooseTftpRoot: invoke('chooseTftpRoot'),
  tftpStatus: invoke('tftpStatus'),
  tftpStart: invoke('tftpStart'),
  tftpStop: invoke('tftpStop'),
  scriptRun: invoke('scriptRun'),
  scriptCancel: invoke('scriptCancel'),
  saveRecordedScript: invoke('saveRecordedScript'),
  screenResponse: invoke('screenResponse'),
  terminalClose: invoke('terminalClose'),
  terminalSetLog: invoke('terminalSetLog'),
  clipboardRead: invoke('clipboardRead'),
  clipboardWrite: invoke('clipboardWrite'),
  onTerminalData: subscribe('terminalData'),
  onTerminalExit: subscribe('terminalExit'),
  onTerminalOpened: subscribe('terminalOpened'),
  onTerminalActivated: subscribe('terminalActivated'),
  onMappedKey: subscribe('mappedKey'),
  onScreenRequest: subscribe('screenRequest'),
  onScriptOutput: subscribe('scriptOutput'),
  onScriptStatus: subscribe('scriptStatus'),
  onTftpStatus: subscribe('tftpStatus'),
  onTftpTransfer: subscribe('tftpTransfer'),
  onMenuAction: subscribe('menuAction')
});
