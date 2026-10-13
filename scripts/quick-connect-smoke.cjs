'use strict';

// This runs only inside the explicit Electron desktop smoke command. CI owns
// the isolated profile and the one local shell created below; no remote host,
// real credential or personal keychain is used by this check.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ window, terminals, store, directory }) => {
  const { BrowserWindow, Menu, app, dialog, ipcMain } = require('electron');
  const profileDirectory = path.resolve(process.env.TERMFORGE_DATA_DIR || '');
  assert.equal(path.dirname(profileDirectory), path.resolve(directory), 'Quick Connect smoke needs an isolated application profile');
  assert.equal(path.basename(profileDirectory), 'profile');
  const fixture = await fs.mkdtemp(path.join(directory, 'quick-connect-fixture-'));
  const fixtureKey = path.join(fixture, 'identity-fixture');
  await fs.writeFile(fixtureKey, 'Synthetic identity-picker fixture; this is not a private key.\n');
  const childURL = 'termforge://app/quick-connect.html';
  const originalOpen = terminals.open, originalWrite = terminals.write;
  const originalDialog = dialog.showOpenDialog;
  const initialSettings = structuredClone(store.load().settings);
  const originalIds = new Set(terminals.list().map(entry => entry.id));
  const opened = [], writes = [], childErrors = [], report = {};
  const fixtureName = 'Native Quick Connect fixture';
  let savedId;
  const wait = async (predicate, description) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Quick Connect smoke timed out: ' + description);
  };
  const evaluate = (target, source) => target.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, description) => {
      const end = Date.now() + 15000;
      while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      throw new Error('Quick Connect renderer timed out: ' + description);
    };
    ${source}
  })()`);
  const childWindows = () => BrowserWindow.getAllWindows().filter(candidate => candidate !== window && !candidate.isDestroyed() && candidate.webContents.getURL() === childURL);
  const childReady = async () => {
    await wait(() => childWindows().length > 0, 'separate Quick Connect BrowserWindow');
    assert.equal(childWindows().length, 1, 'Quick Connect must create only one auxiliary window');
    const child = childWindows()[0];
    await evaluate(child, `await wait(() => window.termforgeQuickConnect && document.getElementById('quick-fields') && !document.getElementById('quick-fields').disabled && !document.getElementById('quick-submit').disabled, 'Quick Connect form');`);
    await wait(() => child.isVisible(), 'visible native Quick Connect window');
    return child;
  };
  const onWindowCreated = (_event, candidate) => {
    if (candidate === window) return;
    candidate.webContents.on('console-message', details => { if (details.level === 'error') childErrors.push(details.message); });
    candidate.webContents.on('render-process-gone', (_event, details) => childErrors.push('Quick Connect renderer stopped: ' + details.reason));
  };
  const menuOpen = () => {
    const file = Menu.getApplicationMenu().items.find(item => item.label === 'File');
    const quick = file?.submenu?.items.find(item => /^Quick Connect/.test(item.label));
    assert.equal(typeof quick?.click, 'function', 'Native File menu must contain Quick Connect');
    quick.click(quick, window, {});
  };
  try {
    app.on('browser-window-created', onWindowCreated);
    terminals.open = function(profile) {
      assert.equal(profile.protocol, 'local', 'Quick Connect smoke may only create an isolated local shell');
      assert.equal(path.resolve(profile.cwd), fixture, 'Quick Connect shell must use its isolated fixture directory');
      const result = originalOpen.call(terminals, profile);
      opened.push({ ...result, profile: structuredClone(profile) });
      return result;
    };
    terminals.write = function(input) { writes.push(structuredClone(input)); return originalWrite.call(terminals, input); };
    await evaluate(window, `
      if (location.href !== 'termforge://app/index.html') throw new Error('Main window must use the application protocol');
      document.getElementById('broadcast-mode').checked = false;
      document.getElementById('quick-connect').click();
    `);
    let child = await childReady();
    assert.notEqual(child.id, window.id);
    assert.equal(child.getParentWindow(), window, 'Quick Connect must belong to the terminal workspace');
    assert.equal(child.isModal(), false, 'Quick Connect must be a separate modeless window');
    assert.equal(child.getTitle(), 'Quick Connect');
    assert.ok(child.getNativeWindowHandle().length > 0, 'Quick Connect needs its own operating-system window');
    assert.ok(!window.isDestroyed() && window.isVisible(), 'The terminal workspace must remain open');
    const bridge = await evaluate(child, `
      if (location.href !== ${JSON.stringify(childURL)}) throw new Error('Quick Connect must use its own application-protocol document');
      return { keys:Object.keys(window.termforgeQuickConnect).sort(), mainBridge:typeof window.termforge, require:typeof window.require, process:typeof window.process };
    `);
    assert.deepEqual(bridge.keys, ['chooseIdentityFile', 'close', 'getState', 'manageCredentials', 'onCredentialsChanged', 'onFileSession', 'submit'].sort());
    assert.equal(bridge.mainBridge, 'undefined');
    assert.equal(bridge.require, 'undefined');
    assert.equal(bridge.process, 'undefined');
    report.nativeQuickConnectWindow = true;
    report.nativeQuickConnectRestrictedPreload = true;
    // A main-process negative test invokes the real registered guards with
    // the actual child identity. No forbidden channel is exposed in its UI.
    const handlers = ipcMain._invokeHandlers;
    assert.equal(typeof handlers?.get, 'function', 'Electron IPC test harness must expose registered invoke handlers');
    const mainEvent = { sender:window.webContents, senderFrame:window.webContents.mainFrame };
    const childEvent = { sender:child.webContents, senderFrame:child.webContents.mainFrame };
    const mainState = await handlers.get('termforge:getState')(mainEvent);
    assert.equal(mainState.version, app.getVersion(), 'Trusted parent IPC must still work');
    for (const channel of ['getState', 'terminalWrite', 'credentialSave', 'transferStart', 'quickConnectAccept']) {
      const handler = handlers.get('termforge:' + channel);
      assert.equal(typeof handler, 'function', 'Missing protected channel: ' + channel);
      await assert.rejects(Promise.resolve().then(() => handler(childEvent, {})), /Untrusted request/);
    }
    await assert.rejects(Promise.resolve().then(() => handlers.get('termforge:terminalWrite')({ sender:window.webContents, senderFrame:child.webContents.mainFrame }, {})), /Untrusted request/);
    assert.deepEqual(writes, [], 'Rejected child requests must not reach a terminal');
    report.nativeQuickConnectParentIpcGuard = true;
    const firstId = child.id;
    await evaluate(window, 'await window.termforge.quickConnectOpen();');
    assert.equal((await childReady()).id, firstId, 'Repeated Quick Connect opens must reuse the existing window');
    report.nativeQuickConnectSingleton = true;
    report.nativeQuickConnectFocusObserved = child.isFocused();
    let pickerCalls = 0;
    dialog.showOpenDialog = async (owner, options) => {
      assert.equal(owner, child, 'Identity picker must belong to Quick Connect');
      assert.ok(options.properties.includes('openFile'));
      pickerCalls++;
      return { canceled:false, filePaths:[fixtureKey] };
    };
    try { assert.equal(await evaluate(child, 'return await window.termforgeQuickConnect.chooseIdentityFile();'), fixtureKey); }
    finally { dialog.showOpenDialog = originalDialog; }
    assert.equal(pickerCalls, 1);
    report.nativeQuickConnectIdentityPicker = true;
    await evaluate(child, `
      document.getElementById('quick-host').value = 'draft.example.test';
      document.getElementById('quick-manage-credentials').click();
    `);
    await evaluate(window, `await wait(() => document.getElementById('credential-dialog').open, 'parent credential manager');`);
    await wait(() => !child.isVisible(), 'Quick Connect hidden while credential manager is open');
    await evaluate(window, `document.querySelector('#credential-dialog [data-secure-close="credential-dialog"]').click();`);
    await wait(() => child.isVisible(), 'Quick Connect returns after closing credential manager');
    assert.equal(await evaluate(child, `return document.getElementById('quick-host').value;`), 'draft.example.test', 'Opening credentials must preserve the connection draft');
    assert.equal(child.id, firstId, 'Credential manager return must reuse the existing window');
    report.nativeQuickConnectCredentialManagerReturn = true;
    child.close();
    await wait(() => child.isDestroyed(), 'native close button path');
    assert.equal(opened.length, 0, 'Closing Quick Connect must not open a connection');
    assert.ok(!window.isDestroyed());
    menuOpen();
    child = await childReady();
    assert.notEqual(child.id, firstId, 'A dismissed Quick Connect window must reopen');
    child.webContents.sendInputEvent({ type:'keyDown', keyCode:'Escape' });
    child.webContents.sendInputEvent({ type:'keyUp', keyCode:'Escape' });
    await wait(() => child.isDestroyed(), 'Escape cancellation');
    assert.equal(opened.length, 0);
    assert.ok(!window.isDestroyed());
    report.nativeQuickConnectMenuAndCancellation = true;
    await evaluate(window, 'await window.termforge.quickConnectOpen();');
    child = await childReady();
    await evaluate(child, `
      const protocol = document.getElementById('quick-protocol'); protocol.value = 'local'; protocol.dispatchEvent(new Event('change', {bubbles:true}));
      document.getElementById('quick-cwd').value = ${JSON.stringify(fixture)};
      const save = document.getElementById('quick-save'); save.checked = true; save.dispatchEvent(new Event('change', {bubbles:true}));
      document.getElementById('quick-name').value = ${JSON.stringify(fixtureName)};
      document.getElementById('quick-startup').checked = true;
      document.getElementById('quick-connect-form').requestSubmit();
    `);
    await wait(() => opened.length === 1 && child.isDestroyed(), 'one parent-window connection after submission');
    savedId = store.load().sessions.find(profile => profile.name === fixtureName)?.id;
    assert.ok(savedId, 'Save session must persist the Quick Connect profile');
    assert.equal(opened[0].profile.id, savedId, 'The parent must open the saved profile');
    assert.equal(store.load().settings.showQuickConnectOnStartup, true, 'Quick Connect startup preference must persist');
    assert.equal(opened[0].profile.protocol, 'local');
    assert.ok(terminals.has(opened[0].id), 'Submission must create a real terminal in the parent process');
    await evaluate(window, `
      await wait(() => document.querySelector('.terminal-pane[data-connection-id="${opened[0].id}"] .xterm-screen'), 'new terminal rendered in parent workspace');
      const state = window.__termforgeQuickSmoke = {output:''};
      state.off = window.termforge.onTerminalData(event => { if (event.id === ${JSON.stringify(opened[0].id)}) state.output += event.data; });
      await window.termforge.terminalWrite({id:${JSON.stringify(opened[0].id)},data:${JSON.stringify(process.platform === 'win32' ? 'echo TERMFORGE_QUICK_^NATIVE\r' : "printf 'TERMFORGE_QUICK_%s\\n' 'NATIVE'\r")}});
      await wait(() => state.output.includes('TERMFORGE_QUICK_NATIVE'), 'real Quick Connect local shell output');
      state.off(); delete window.__termforgeQuickSmoke;
    `);
    assert.equal(opened.length, 1, 'Quick Connect submission must not duplicate the session');
    assert.equal(writes.length, 1, 'Only the explicit local-shell probe may write terminal input');
    assert.deepEqual(childErrors, [], 'Quick Connect child must not emit renderer errors');
    report.nativeQuickConnectSavedProfile = true;
    report.nativeQuickConnectStartupPreference = true;
    report.nativeQuickConnectParentPty = true;
    report.nativeQuickConnectNoDuplicateConnection = true;
    report.nativeQuickConnectVerificationLimits = 'Linux CI verifies a separate native BrowserWindow and real parent PTY. Constructor tests cover the standard frame; macOS traffic-light pixels and a full application restart are not exercised here.';
    await fs.writeFile(path.join(directory, 'quick-connect-native.json'), JSON.stringify(report, null, 2));
    console.log('PASS native Quick Connect window, restricted preload/IPC, singleton, cancellation, identity picker, saved profile, and parent PTY');
    return report;
  } catch (error) {
    await fs.writeFile(path.join(directory, 'quick-connect-native-failure.json'), JSON.stringify({ message:error.message, stack:error.stack, childErrors, completed:report }, null, 2)).catch(() => {});
    throw error;
  } finally {
    app.removeListener('browser-window-created', onWindowCreated);
    dialog.showOpenDialog = originalDialog;
    terminals.open = originalOpen;
    terminals.write = originalWrite;
    for (const child of childWindows()) child.close();
    for (const entry of terminals.list()) if (!originalIds.has(entry.id)) terminals.close(entry.id);
    if (savedId) store.deleteSession(savedId);
    store.saveSettings(initialSettings);
    await evaluate(window, `const state = window.__termforgeQuickSmoke; state?.off?.(); delete window.__termforgeQuickSmoke;`).catch(() => {});
  }
};
