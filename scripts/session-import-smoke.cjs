'use strict';
// Linux CI only: actual preload, native menu and atomic store, with picker and
// approval responses replaced by fixtures inside the isolated smoke directory.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async ({ window, terminals, store, directory }) => {
  const { dialog, Menu } = require('electron');
  const filename = path.join(directory, 'native-session-import.csv');
  const bytes = 'name,host,protocol,port,username,folder\nNative import fixture,import.example.test,SSH2,2222,fixture,Imported\n';
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  const originalPicker = dialog.showOpenDialog, originalApproval = dialog.showMessageBox;
  const baseline = store.load(); const count = terminals.count;
  let pickers = 0, approvals = 0;
  const evaluate = code => window.webContents.executeJavaScript(`(async () => { ${code} })()`);
  try {
    dialog.showOpenDialog = async (_parent, options) => {
      assert.equal(options.title, 'Import sessions from CSV or text');
      assert.deepEqual(options.properties, ['openFile']); pickers++;
      return { canceled: false, filePaths: [filename] };
    };
    dialog.showMessageBox = async (_parent, options) => {
      assert.equal(options.title, 'Import reviewed sessions');
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
      assert.equal(options.buttons[0], 'Cancel');
      assert.ok(options.detail.includes('Add: 1\nReplace: 0\nSkip: 0')); approvals++;
      return { response: 1 };
    };
    const output = await evaluate(`
      const chosen = await window.termforge.sessionImportChoose();
      if (!chosen.fileId || chosen.rowCount !== 1) throw new Error('Native picker import failed');
      const preview = await window.termforge.sessionImportPreview({fileId:chosen.fileId,delimiter:'comma',header:true,mapping:{name:0,host:1,protocol:2,port:3,username:4,folder:5},collision:'skip'});
      if (!preview.canApply || preview.counts.added !== 1 || preview.counts.errors !== 0) throw new Error('Native import preview is invalid');
      const result = await window.termforge.sessionImportApply({planId:preview.planId});
      if (result.canceled) throw new Error('Native fixture unexpectedly cancelled');
      let reused = false; try { await window.termforge.sessionImportApply({planId:preview.planId}); reused = true; } catch {}
      if (reused) throw new Error('Native import allowed token reuse');
      await window.termforge.sessionImportDiscard({fileId:chosen.fileId});
      return {rows:preview.rows.length};
    `);
    assert.equal(output.rows, 1); assert.equal(pickers, 1); assert.equal(approvals, 1);
    const after = store.load(); const imported = after.sessions.find(profile => profile.name === 'Native import fixture');
    assert.ok(imported); assert.equal(imported.host, 'import.example.test'); assert.equal(imported.port, 2222);
    assert.equal(imported.username, 'fixture'); assert.equal(imported.folder, 'Imported'); assert.equal(imported.credentialId, '');
    assert.equal(after.sessions.length, baseline.sessions.length + 1);
    assert.deepEqual(after.settings, baseline.settings); assert.equal(terminals.count, count, 'Session import must not open a connection');
    assert.equal(await fs.readFile(filename, 'utf8'), bytes, 'Import must leave the source file unchanged');
    // The real native menu must advertise the implemented action after dialogs
    // close. UI checks separately exercise its mapping workflow and controls.
    await new Promise(resolve => setTimeout(resolve, 80));
    const leaves = menu => menu.items.flatMap(item => item.submenu ? leaves(item.submenu) : [item]);
    const entry = leaves(Menu.getApplicationMenu()).find(item => item.label === 'Import Settings from Text File…');
    assert.ok(entry?.enabled, 'Native text-import menu must be enabled in the ready workspace');
    const result = { nativeSessionImport: true, nativeSessionImportApproval: true, nativeSessionImportSingleUse: true, nativeSessionImportNoConnection: true };
    await fs.writeFile(path.join(directory, 'session-import-native.json'), JSON.stringify(result, null, 2));
    console.log('PASS native session import picker, preview, confirmation, atomic store and no automatic connection');
    return result;
  } finally {
    dialog.showOpenDialog = originalPicker; dialog.showMessageBox = originalApproval;
    for (const profile of store.load().sessions) if (!baseline.sessions.some(item => item.id === profile.id)) store.deleteSession(profile.id);
  }
};
