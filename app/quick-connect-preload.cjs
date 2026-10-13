'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(`termforge:quickConnect:${name}`, ...args);
contextBridge.exposeInMainWorld('termforgeQuickConnect', {
  getState: invoke('getState'),
  submit: invoke('submit'),
  close: invoke('close'),
  chooseIdentityFile: invoke('chooseIdentityFile'),
  manageCredentials: invoke('manageCredentials'),
  onFileSession(callback) {
    if (typeof callback !== 'function') throw new TypeError('Callback required');
    const listener = () => callback();
    ipcRenderer.on('termforge:quickConnect:fileSession', listener);
    return () => ipcRenderer.removeListener('termforge:quickConnect:fileSession', listener);
  },
  onCredentialsChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('Callback required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('termforge:quickConnect:credentialsChanged', listener);
    return () => ipcRenderer.removeListener('termforge:quickConnect:credentialsChanged', listener);
  }
});
