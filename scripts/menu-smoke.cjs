'use strict';

// Runs inside the explicit desktop smoke process in Linux CI. Native menu
// objects, renderer/preload IPC and a raw TCP peer are real. Only native picker
// and confirmation return values are stubbed, using files in the isolated
// fixture directory. No printer, personal key, or external host is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');

module.exports = async ({ window, terminals, directory }) => {
  const { BrowserWindow, Menu, clipboard, dialog, ipcMain } = require('electron');
  const profile = path.resolve(process.env.TERMFORGE_DATA_DIR || '');
  assert.equal(path.dirname(profile), path.resolve(directory), 'Menu smoke needs an isolated application profile');
  assert.equal(path.basename(profile), 'profile');
  const fixture = await fs.mkdtemp(path.join(directory, 'menu-fixture-'));
  const rawFile = path.join(fixture, 'received.bin'), asciiFile = path.join(fixture, 'received.txt'), binaryFile = path.join(fixture, 'send.bin');
  const payload = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  // All 256 outgoing octets must reach the peer unchanged. Its reply is a
  // separate payload: valid terminal text followed by malformed UTF-8 bytes.
  // Echoing every control octet would intentionally feed invalid ESC syntax to
  // xterm and obscure the strict zero-unexpected-console-errors assertion.
  const binaryReply = Buffer.concat([Buffer.from('BINARY_RECEIVED\r\n'), Buffer.from([0xff, 0xc0, 0x80])]);
  await fs.writeFile(binaryFile, payload);
  const originalOpenDialog = dialog.showOpenDialog, originalSaveDialog = dialog.showSaveDialog, originalMessageBox = dialog.showMessageBox;
  const originalWrite = terminals.write, originalBinary = terminals.writeBinary;
  const oldClipboard = await clipboard.readText();
  const originalIds = new Set(terminals.list().map(value => value.id));
  const writes = [], binaryWrites = [], report = {};
  let peer, server, rawId, child, received = Buffer.alloc(0), binaryApprovals = 0, pickerCalls = 0, allowBinary = false;
  let initialUi;
  const wait = async (predicate, description) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Native menu smoke timed out: ' + description);
  };
  const evaluate = (source, target = window) => target.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, description) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      throw new Error('Menu renderer timed out: ' + description);
    };
    ${source}
  })()`);
  const find = (...labels) => {
    let entries = Menu.getApplicationMenu()?.items || [], found;
    for (const label of labels) { found = entries.find(item => typeof label === 'string' ? item.label === label : label.test(item.label)); if (!found) return null; entries = found.submenu?.items || []; }
    return found;
  };
  const click = (...labels) => {
    const item = find(...labels); assert.ok(item?.enabled, 'Native menu command must be enabled: ' + labels.join(' / '));
    assert.equal(typeof item.click, 'function'); item.click(item, window, {}); return item;
  };
  const snapshot = () => {
    const visit = items => items.map(item => ({ label:item.label, type:item.type, enabled:item.enabled, checked:item.checked, ...(item.submenu ? { submenu:visit(item.submenu.items) } : {}) }));
    return visit(Menu.getApplicationMenu()?.items || []);
  };
  const confirmRenderer = async title => evaluate(`
    await wait(() => document.getElementById('confirm-dialog').open, 'review dialog');
    if (!document.getElementById('confirm-title').textContent.includes(${JSON.stringify(title)})) throw new Error('Unexpected menu review dialog');
    document.getElementById('confirm-accept').click();
  `);
  try {
    terminals.write = input => { writes.push(structuredClone(input)); return originalWrite.call(terminals, input); };
    terminals.writeBinary = input => { binaryWrites.push({ id:input.id, bytes:Buffer.from(input.data) }); return originalBinary.call(terminals, input); };
    initialUi = await evaluate(`
      if (location.href !== 'termforge://app/index.html') throw new Error('Native menus must use the real application protocol');
      const state = window.__termforgeMenuSmoke = { actions:[], output:[] };
      state.offMenu = window.termforge.onMenuAction(action => state.actions.push(action));
      state.offOutput = window.termforge.onTerminalOutputState(event => state.output.push(event));
      document.getElementById('broadcast-mode').checked = false;
      return { toolbarHidden:document.getElementById('main-toolbar').hidden, projectVisible:!document.getElementById('project-workspace').hidden };
    `);
    window.focus();
    await wait(() => find('Options', 'Global Options…')?.enabled, 'renderer state synchronized to actual native menu');
    const names = Menu.getApplicationMenu().items.map(item => item.label).filter(label => label !== 'ForgeCRT');
    assert.deepEqual(names, ['File', 'Edit', 'View', 'Options', 'Transfer', 'Script', 'Tools', 'Window', 'Help']);
    assert.deepEqual(find('File').submenu.items.slice(0, 4).map(item => item.label), ['Connect…', 'Quick Connect…', 'Connect In Tab/Tile…', 'Connect Local Shell']);
    for (const [group, label] of [['Transfer', /^Send Kermit/], ['Transfer', /^Receive Xmodem/], ['Window', /^Cascade/], ['File', /^Lock Session/]]) assert.equal(find(group, label)?.enabled, false, label.toString());
    assert.equal(find('File', /^Raw Log Session/)?.enabled, false, 'A native PTY cannot expose raw byte logging');
    report.nativeMenuStructure = true; report.nativeMenuUnavailableGates = true;

    assert.equal(find('View', 'Toolbar').checked, !initialUi.toolbarHidden);
    click('View', 'Toolbar');
    await evaluate(`await wait(() => document.getElementById('main-toolbar').hidden === ${!initialUi.toolbarHidden}, 'toolbar visibility after native command');`);
    await wait(() => find('View', 'Toolbar').checked === initialUi.toolbarHidden, 'updated native checkmark');
    click('View', 'Toolbar');
    await wait(() => find('View', 'Toolbar').checked === !initialUi.toolbarHidden, 'restored native checkmark');
    report.nativeMenuLiveChecks = true;

    const staleLocal = find('File', 'Connect Local Shell'), beforeModalCount = terminals.count;
    click('Options', 'Global Options…');
    await evaluate(`await wait(() => document.getElementById('settings-dialog').open, 'Global Options action');`);
    await wait(() => !find('File', 'Connect Local Shell').enabled, 'disabled commands under modal dialog');
    staleLocal.click(staleLocal, window, {});
    await evaluate(`await new Promise(resolve => setTimeout(resolve, 100)); if (window.__termforgeMenuSmoke.actions.includes('local-shell')) throw new Error('Stale native menu dispatched through a modal'); document.querySelector('#settings-dialog .dialog-close').click();`);
    assert.equal(terminals.count, beforeModalCount);
    await wait(() => find('File', 'Connect Local Shell').enabled, 'commands reenable after modal closes');
    report.nativeMenuModalGuard = true;

    server = net.createServer(socket => {
      peer = socket; socket.on('error', () => {});
      let replied = false;
      socket.on('data', bytes => {
        received = Buffer.concat([received, bytes]);
        if (!replied && received.length >= payload.length) { replied = true; socket.write(binaryReply); }
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await evaluate(`const address = document.getElementById('connect-address'); address.value = ${JSON.stringify('raw://127.0.0.1:') } + ${server.address().port}; address.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));`);
    await wait(() => peer && terminals.list().some(entry => !originalIds.has(entry.id) && entry.session.protocol === 'raw'), 'isolated raw TCP terminal');
    rawId = terminals.list().find(entry => !originalIds.has(entry.id) && entry.session.protocol === 'raw').id;
    await evaluate(`await wait(() => document.querySelector('.terminal-pane[data-connection-id="${rawId}"] .xterm-screen'), 'native raw terminal renderer');`);
    await wait(() => find('File', /^Raw Log Session/)?.enabled && find('Transfer', 'Send Binary…')?.enabled && find('View', 'Hex View')?.enabled, 'transport capabilities in native menu');
    const capabilities = await evaluate(`return await window.termforge.terminalOutputState(${JSON.stringify(rawId)});`);
    assert.deepEqual(capabilities.capabilities, { rawLog:true, hex:true, binary:true });
    const zoomBefore = await evaluate(`return parseFloat(getComputedStyle(document.querySelector('.terminal-pane[data-connection-id="${rawId}"] .xterm-rows')).fontSize);`);
    assert.ok(zoomBefore >= 8 && zoomBefore < 36, 'The fixture font must allow a zoom-in step');
    const webZoomBefore = window.webContents.getZoomLevel(), writesBeforeZoom = writes.length;
    click('View', 'Zoom', 'Zoom In');
    await evaluate(`await wait(() => parseFloat(getComputedStyle(document.querySelector('.terminal-pane[data-connection-id="${rawId}"] .xterm-rows')).fontSize) === ${zoomBefore + 1}, 'native menu changes terminal font size');`);
    click('View', 'Zoom', 'Actual Size');
    await evaluate(`await wait(() => parseFloat(getComputedStyle(document.querySelector('.terminal-pane[data-connection-id="${rawId}"] .xterm-rows')).fontSize) === ${zoomBefore}, 'native menu restores terminal font size');`);
    assert.equal(window.webContents.getZoomLevel(), webZoomBefore, 'Terminal Zoom must leave application chrome zoom unchanged');
    assert.equal(writes.length, writesBeforeZoom, 'Font zoom must not send terminal input');
    report.nativeMenuTerminalZoom = true;
    dialog.showSaveDialog = async (owner, options) => {
      assert.equal(owner, window); pickerCalls++;
      if (options.title.startsWith('Save terminal output log')) return { canceled:false, filePath:rawFile };
      if (options.title === 'Receive ASCII into a new text file') return { canceled:false, filePath:asciiFile };
      throw new Error('Unexpected menu save picker: ' + options.title);
    };
    click('File', /^Raw Log Session/); await confirmRenderer('Start raw logging');
    await wait(() => terminals.outputState(rawId).log.mode === 'raw', 'raw log state through real IPC');
    await wait(() => find('File', /^Raw Log Session/).checked, 'raw log native checkmark');
    assert.equal(find('File', 'Log Session…').checked, false, 'Raw logging must not check the plain-text log item');
    click('Transfer', 'Receive ASCII…'); await confirmRenderer('Receive ASCII');
    await wait(() => terminals.outputState(rawId).capture.enabled, 'ASCII capture through real IPC');
    await wait(() => find('Transfer', 'Stop Receiving ASCII…')?.enabled, 'native receive label after start');
    const textBytes = Buffer.from('Native\x1b[31m red\x1b[0m\r\n');
    peer.write(textBytes);
    await wait(async () => (await fs.readFile(rawFile)).equals(textBytes), 'raw file bytes on disk');
    assert.equal(await fs.readFile(asciiFile, 'utf8'), 'Native red\r\n');
    click('File', 'Pause Logging');
    await wait(() => terminals.outputState(rawId).log.paused && find('File', 'Pause Logging').checked, 'paused log state and native checkmark');
    peer.write('while paused\r\n');
    await wait(async () => (await fs.readFile(asciiFile, 'utf8')).includes('while paused'), 'independent ASCII capture during log pause');
    assert.deepEqual(await fs.readFile(rawFile), textBytes);
    click('File', 'Pause Logging'); await wait(() => !terminals.outputState(rawId).log.paused, 'log resume');
    click('Transfer', 'Stop Receiving ASCII…'); await wait(() => !terminals.outputState(rawId).capture.enabled, 'stop ASCII capture');
    report.nativeMenuCaptureAndRawLog = true; report.nativeMenuLogPauseState = true;

    dialog.showOpenDialog = async (owner, options) => {
      assert.equal(owner, window); assert.equal(options.title, 'Choose binary data to send'); assert.deepEqual(options.properties, ['openFile']); pickerCalls++;
      return { canceled:false, filePaths:[binaryFile] };
    };
    dialog.showMessageBox = async (owner, options) => {
      assert.equal(owner, window); assert.equal(options.title, 'Send binary data'); assert.deepEqual(options.buttons, ['Cancel', 'Send binary data']);
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.match(options.message, /256 bytes to 127\.0\.0\.1/); assert.match(options.detail, /send\.bin/);
      binaryApprovals++; return { response:allowBinary ? 1 : 0 };
    };
    click('Transfer', 'Send Binary…'); await wait(() => binaryApprovals === 1, 'cancel-first binary review');
    assert.equal(binaryWrites.length, 0); assert.equal(received.length, 0);
    allowBinary = true; click('Transfer', 'Send Binary…');
    await wait(() => received.length === payload.length, 'binary bytes at real loopback peer');
    await wait(async () => (await fs.readFile(rawFile)).length === textBytes.length + binaryReply.length, 'peer binary reply in raw output log');
    assert.deepEqual(received, payload); assert.deepEqual(binaryWrites, [{ id:rawId, bytes:payload }]);
    assert.deepEqual(await fs.readFile(rawFile), Buffer.concat([textBytes, binaryReply]));
    assert.equal(await fs.readFile(asciiFile, 'utf8'), 'Native red\r\nwhile paused\r\n');
    const raw = await evaluate(`return await window.termforge.terminalReadRaw(${JSON.stringify(rawId)});`);
    assert.deepEqual(Buffer.from(raw.base64, 'base64'), Buffer.concat([textBytes, Buffer.from('while paused\r\n'), binaryReply]));
    click('View', 'Hex View');
    await evaluate(`await wait(() => document.getElementById('hex-dialog').open, 'Hex View dialog'); if (!document.getElementById('hex-data').textContent.includes('ff c0 80')) throw new Error('Hex View did not preserve malformed UTF-8 byte data'); document.querySelector('#hex-dialog .dialog-close').click();`);
    await wait(() => find('File', /^Raw Log Session/).enabled, 'menus resume after Hex View');
    click('File', /^Raw Log Session/); await wait(() => !terminals.outputState(rawId).log.enabled, 'stop raw log from native menu');
    report.nativeMenuBinaryReviewAndBytes = true; report.nativeMenuHexView = true;
    report.nativeMenuByteFixtureScope = { sentOctets:'Every byte value 0–255, verified at the TCP peer', receivedBytes:'Terminal text/ANSI plus ff c0 80 malformed UTF-8, verified independently in raw log and Hex View' };

    const staleBinary = find('Transfer', 'Send Binary…'), staleDisconnect = find('File', 'Disconnect');
    const beforeChild = { writes:writes.length, binary:binaryWrites.length, pickers:pickerCalls, terminals:terminals.count };
    click('File', 'Quick Connect…');
    await wait(() => (child = BrowserWindow.getAllWindows().find(candidate => candidate !== window && candidate.webContents.getURL() === 'termforge://app/quick-connect.html')), 'Quick Connect created by native menu');
    await evaluate(`await wait(() => document.getElementById('quick-host') && !document.getElementById('quick-fields').disabled, 'Quick Connect ready'); document.getElementById('quick-host').focus();`, child);
    child.focus(); await wait(() => BrowserWindow.getFocusedWindow() === child, 'native Quick Connect focus');
    await wait(() => !find('Transfer', 'Send Binary…').enabled && !find('File', 'Disconnect').enabled, 'workspace commands disabled while child focused');
    staleBinary.click(staleBinary, window, {}); staleDisconnect.click(staleDisconnect, window, {});
    await clipboard.writeText('menu-child-fixture.example'); click('Edit', 'Paste');
    await evaluate(`await wait(() => document.getElementById('quick-host').value === 'menu-child-fixture.example', 'native Paste routes to child field');`, child);
    assert.deepEqual({ writes:writes.length, binary:binaryWrites.length, pickers:pickerCalls, terminals:terminals.count }, beforeChild);
    const event = { sender:child.webContents, senderFrame:child.webContents.mainFrame };
    for (const name of ['menuState', 'terminalSetCapture', 'terminalSendBinary', 'terminalReadRaw']) {
      const handler = ipcMain._invokeHandlers.get('termforge:' + name); assert.equal(typeof handler, 'function');
      await assert.rejects(Promise.resolve().then(() => handler(event, rawId)), /Untrusted request/);
    }
    click('Window', 'Close Window');
    await wait(() => child.isDestroyed(), 'native Close Window closes focused Quick Connect');
    assert.equal(window.isDestroyed(), false, 'Closing the focused child must preserve the parent window');
    assert.equal(terminals.count, beforeChild.terminals, 'Closing the focused child must preserve all parent terminals');
    window.focus();
    await wait(() => find('Transfer', 'Send Binary…').enabled, 'parent menu capability restored');
    report.nativeMenuQuickConnectFocusGuard = true; report.nativeMenuChildClipboardRouting = true; report.nativeMenuNewIpcGuards = true;
    report.nativeMenuChildCloseRouting = true; report.nativeMenuDesktopAction = true;
    const outputEvents = await evaluate(`return window.__termforgeMenuSmoke.output.filter(event => event.id === ${JSON.stringify(rawId)});`);
    assert.ok(outputEvents.some(event => event.log.paused)); assert.ok(outputEvents.some(event => event.capture.enabled));
    assert.equal(outputEvents.at(-1).log.enabled, false);
    report.nativeMenuOutputStateEvents = true;
    report.nativeMenuVerificationLimits = 'Actual Electron menu objects, focus routing and loopback TCP paths were exercised. Native picker/confirmation responses used isolated fixtures. macOS menu pixels and the system print dialog were not exercised.';
    await fs.writeFile(path.join(directory, 'menu-native.json'), JSON.stringify({ ...report, menu:snapshot() }, null, 2));
    console.log('PASS native menu order, live checks, modal/focus guards, byte transfer, raw log, ASCII capture, pause, Hex View, and restricted child IPC');
    return report;
  } catch (error) {
    await fs.writeFile(path.join(directory, 'menu-native-failure.json'), JSON.stringify({ message:error.message, stack:error.stack, completed:report, menu:snapshot() }, null, 2)).catch(() => {});
    throw error;
  } finally {
    dialog.showOpenDialog = originalOpenDialog; dialog.showSaveDialog = originalSaveDialog; dialog.showMessageBox = originalMessageBox;
    terminals.write = originalWrite; terminals.writeBinary = originalBinary;
    if (child && !child.isDestroyed()) child.close();
    for (const entry of terminals.list()) if (!originalIds.has(entry.id)) await terminals.close(entry.id);
    peer?.destroy(); if (server?.listening) await new Promise(resolve => server.close(resolve));
    await clipboard.writeText(oldClipboard);
    await evaluate(`
      const state = window.__termforgeMenuSmoke; state?.offMenu?.(); state?.offOutput?.(); delete window.__termforgeMenuSmoke;
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      ${rawId ? `document.querySelector('.terminal-tab[data-connection-id="${rawId}"] .icon-button')?.click();` : ''}
      ${initialUi?.projectVisible ? `if (document.getElementById('project-workspace').hidden) document.getElementById('project-toggle').click();` : ''}
    `).catch(() => {});
  }
};
