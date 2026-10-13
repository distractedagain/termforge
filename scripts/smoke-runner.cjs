'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ciGraphics = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && process.env.TERMFORGE_CI_NO_SANDBOX === '1';

async function screenshot(window, directory, name) {
  try {
    const image = await window.webContents.capturePage();
    if (image.isEmpty()) throw new Error('Desktop screenshot is empty');
    await fs.writeFile(path.join(directory, name), image.toPNG());
    console.log(`PASS smoke screenshot: ${name}`);
    return { screenshotCaptured: true, file: name };
  } catch (error) {
    if (!ciGraphics) throw error;
    const captureError = error.message || String(error);
    console.warn(`WARN CI screenshot unavailable (${name}): ${captureError}. Behavioral checks remain strict.`);
    return { screenshotCaptured: false, captureError };
  }
}

async function singleInstanceSmoke(app, window, terminals) {
  assert.equal(app.hasSingleInstanceLock(), true, 'Primary desktop process must own the application lock');
  const originalUserData = app.getPath('userData'), originalSessionData = app.getPath('sessionData');
  const originalTerminals = terminals.count; let observed = false;
  const onSecondInstance = () => { observed = true; };
  app.on('second-instance', onSecondInstance);
  const childEnvironment = { ...process.env }; delete childEnvironment.ELECTRON_RUN_AS_NODE;
  // Same binary, app path and environment resolve the same native userData
  // identity. The second process has no smoke flag and must quit before boot.
  const child = spawn(process.execPath, [...(ciGraphics ? ['--no-sandbox', '--disable-gpu'] : []), app.getAppPath(), '--forgecrt-single-instance-probe'],
    { cwd: app.getAppPath(), env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', settled = false;
  const collect = chunk => { output = (output + String(chunk)).slice(-16000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Second desktop instance failed to exit within 15 seconds: ' + output)); }, 15000);
      child.once('error', error => { clearTimeout(timer); settled = true; reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); settled = true; resolve({ code, signal }); });
    });
    assert.deepEqual(result, { code: 0, signal: null }, 'Secondary desktop process must quit cleanly: ' + output);
    const deadline = Date.now() + 3000;
    while (!observed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(observed, true, 'Primary process must receive the rejected secondary launch');
    assert.equal(app.hasSingleInstanceLock(), true); assert.equal(window.isDestroyed(), false);
    assert.equal(app.getPath('userData'), originalUserData); assert.equal(app.getPath('sessionData'), originalSessionData);
    assert.equal(terminals.count, originalTerminals, 'Secondary launch must not open a terminal');
    const alive = await window.webContents.executeJavaScript(`(async () => ({url:location.href,version:(await window.termforge.getState()).version}))()`);
    assert.equal(alive.url, 'termforge://app/index.html'); assert.equal(typeof alive.version, 'string');
    console.log('PASS native single-instance lock, second-process rejection and continued primary IPC');
    return { nativeSingleInstanceLock: true, nativeSecondInstanceRejected: true, nativePrimaryContinuesAfterSecondLaunch: true };
  } finally {
    app.removeListener('second-instance', onSecondInstance);
    if (!settled) child.kill('SIGKILL');
  }
}

// Runs only when the explicit desktop smoke command is launched. CI exercises
// the real custom protocol, preload bridge and operating-system clipboard.
async function projectSmoke(window, terminals, directory) {
  const { clipboard, dialog } = require('electron');
  const project = await fs.mkdtemp(path.join(directory, 'project-fixture-'));
  const playbook = '---\n- name: ForgeCRT desktop fixture\n  hosts: localhost\n  gather_facts: false\n  tasks:\n    - name: Show fixture text\n      ansible.builtin.debug:\n        msg: Original fixture\n';
  const editedPlaybook = playbook.replace('Original fixture', 'Edited through native clipboard');
  const validJson = '{"smoke":true,"savedFrom":"native editor"}\n';
  await fs.writeFile(path.join(project, 'playbook.yml'), playbook);
  await fs.writeFile(path.join(project, 'fixture.json'), '{"smoke": }\n');
  const profile = path.resolve(process.env.TERMFORGE_DATA_DIR || path.join(directory, 'profile'));
  assert.equal(path.dirname(project), path.dirname(profile), 'Project fixture must be a sibling of the isolated application profile');
  assert.notEqual(path.resolve(project), profile);
  const originalDialog = dialog.showOpenDialog;
  const originalWrite = terminals.write;
  const oldClipboard = await clipboard.readText();
  const editorWrites = [];
  let dialogCalls = 0;
  const evaluate = code => window.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, description) => {
      const end = Date.now() + 15000;
      while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
      throw new Error('Timed out: ' + description);
    };
    ${code}
  })()`);
  const menu = action => window.webContents.send('termforge:menuAction', action);
  const waitClipboard = async expected => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      if (await clipboard.readText() === expected) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Native Copy did not return the complete project document');
  };
  try {
    console.log('START native project IPC and editor worker checks');
    terminals.write = (...args) => { editorWrites.push(args[0]); return originalWrite.apply(terminals, args); };
    await evaluate(`
      if (location.href !== 'termforge://app/index.html') throw new Error('Editor smoke must use the real termforge protocol');
      if (!globalThis.MonacoEnvironment?.getWorker) throw new Error('Missing local Monaco worker factory');
      const state = window.__termforgeEditorSmoke = { workers: [], violations: [], originalWorker: globalThis.MonacoEnvironment.getWorker };
      state.onViolation = event => state.violations.push({directive:event.effectiveDirective, blocked:event.blockedURI});
      document.addEventListener('securitypolicyviolation', state.onViolation);
      globalThis.MonacoEnvironment.getWorker = function(id, label) {
        const record = {label, messages:0, errors:[]}; state.workers.push(record);
        const worker = state.originalWorker.call(this, id, label);
        worker.addEventListener('message', () => { record.messages += 1; });
        worker.addEventListener('error', event => record.errors.push(event.message || 'Worker error'));
        return worker;
      };
      document.getElementById('broadcast-mode').checked = false;
      document.getElementById('project-toggle').click();
      await wait(() => !document.getElementById('project-workspace').hidden, 'project workspace');
    `);
    dialog.showOpenDialog = async (_window, options) => {
      assert.ok(options.properties.includes('openDirectory'), 'Project should use a native folder picker');
      dialogCalls += 1;
      return { canceled: false, filePaths: [project] };
    };
    try {
      await evaluate(`
        document.getElementById('project-open-folder').click();
        await wait(() => document.querySelector('#project-files [data-path="playbook.yml"]'), 'real project filesystem tree');
      `);
    } finally { dialog.showOpenDialog = originalDialog; }
    assert.equal(dialogCalls, 1, 'The real projectOpen IPC must invoke the native dialog once');
    console.log('PASS native projectOpen IPC and real filesystem tree (folder-picker return stubbed)');
    await evaluate(`
      document.querySelector('#project-files [data-path="playbook.yml"]').click();
      await wait(() => document.querySelector('#project-editor .monaco-editor') && document.activeElement?.closest('#project-editor'), 'focused Monaco editor');
      await wait(() => document.getElementById('project-diagnostics').textContent.includes('YAML syntax checked'), 'YAML diagnostics');
    `);
    await evaluate("await window.termforge.clipboardWrite('TERMFORGE_SMOKE_CLIPBOARD_SENTINEL');");
    assert.equal(await clipboard.readText(), 'TERMFORGE_SMOKE_CLIPBOARD_SENTINEL', 'Clipboard write IPC must finish before acknowledging completion');
    menu('select-all'); menu('copy');
    await waitClipboard(playbook);
    await clipboard.writeText(editedPlaybook); menu('paste');
    await evaluate(`
      await wait(() => !document.getElementById('project-save').disabled, 'editor paste through native IPC');
      document.getElementById('project-save').click();
      await wait(() => document.getElementById('project-language').textContent === 'YAML · Saved', 'real project save completed');
    `);
    assert.equal(await fs.readFile(path.join(project, 'playbook.yml'), 'utf8'), editedPlaybook, 'Editor save must reach the actual fixture file');
    console.log('PASS native Select All/Copy/Paste IPC and YAML save to disk');
    await evaluate(`
      document.querySelector('#project-files [data-path="fixture.json"]').click();
      await wait(() => document.getElementById('project-document-path').textContent === 'fixture.json' && document.activeElement?.closest('#project-editor'), 'focused JSON model');
      await wait(() => /[1-9][0-9]* JSON syntax issue/.test(document.getElementById('project-diagnostics').textContent), 'JSON worker diagnostics over the custom protocol');
      await wait(() => window.__termforgeEditorSmoke.workers.some(worker => worker.label === 'json' && worker.messages > 0), 'actual JSON worker response');
    `);
    await clipboard.writeText(validJson); menu('select-all'); menu('paste');
    await evaluate(`
      await wait(() => !document.getElementById('project-save').disabled, 'corrected JSON editor buffer');
      await wait(() => document.getElementById('project-diagnostics').textContent === 'JSON syntax checked locally', 'JSON worker clears corrected diagnostics');
      document.getElementById('project-save').click();
      await wait(() => document.getElementById('project-language').textContent === 'JSON · Saved', 'JSON fixture save completed');
    `);
    assert.equal(await fs.readFile(path.join(project, 'fixture.json'), 'utf8'), validJson);
    assert.deepEqual(editorWrites, [], 'Editor clipboard actions must not write to any live terminal');
    const state = await evaluate('return { workers:window.__termforgeEditorSmoke.workers, violations:window.__termforgeEditorSmoke.violations };');
    assert.deepEqual(state.violations, [], 'Editor must not violate the packaged CSP');
    assert.ok(state.workers.some(worker => worker.label === 'json' && worker.messages > 0), 'A real JSON worker must respond');
    assert.ok(state.workers.every(worker => worker.errors.length === 0), JSON.stringify(state.workers));
    await fs.writeFile(path.join(directory, 'project-workers.json'), JSON.stringify(state, null, 2));
    console.log('PASS custom-protocol JSON worker, corrected diagnostics, JSON save, CSP, and zero editor-to-terminal writes');
    return { projectNativeDialog:true, projectNativeClipboard:true, clipboardIpcCompletion:true, projectSaveToDisk:true, projectNoTerminalWrites:true, jsonCustomProtocolWorker:true, jsonDiagnostics:true, editorCsp:true };
  } catch (error) {
    const state = await evaluate(`return {workers:window.__termforgeEditorSmoke?.workers, violations:window.__termforgeEditorSmoke?.violations, diagnostics:document.getElementById('project-diagnostics')?.textContent, error:document.getElementById('project-error-text')?.textContent};`).catch(() => null);
    const failure = {error:error.stack || String(error), state};
    await fs.writeFile(path.join(directory, 'project-failure.json'), JSON.stringify(failure, null, 2)).catch(() => {});
    failure.screenshot = await screenshot(window, directory, 'project-failure.png').catch(capture => ({screenshotCaptured:false, captureError:capture.message || String(capture)}));
    await fs.writeFile(path.join(directory, 'project-failure.json'), JSON.stringify(failure, null, 2)).catch(() => {});
    throw error;
  } finally {
    dialog.showOpenDialog = originalDialog; terminals.write = originalWrite; await clipboard.writeText(oldClipboard);
    await evaluate(`
      const state = window.__termforgeEditorSmoke;
      if (state) {
        globalThis.MonacoEnvironment.getWorker = state.originalWorker;
        document.removeEventListener('securitypolicyviolation', state.onViolation);
        delete window.__termforgeEditorSmoke;
      }
    `).catch(() => {});
  }
}

module.exports = async ({ window, terminals, store }) => {
  const { app } = require('electron');
  const packageInfo = require('../package.json');
  const { resolveDataDirectory } = require('../app/files.cjs');
  assert.equal(app.getName(), 'TermForge', 'Branding must retain the runtime name used for native credential-store lookup');
  assert.equal(path.resolve(app.getPath('userData')), path.resolve(app.getPath('appData'), 'TermForge'), 'Branding must retain the established Electron userData directory');
  assert.equal(path.resolve(app.getPath('sessionData')), path.resolve(app.getPath('userData')), 'Chromium Local State must keep the established encryption-state location');
  assert.equal(packageInfo.productName, 'ForgeCRT', 'The desktop display product is ForgeCRT');
  assert.equal(packageInfo.build.appId, 'org.termforge.desktop', 'The installed application identity must remain stable');
  assert.ok(process.env.TERMFORGE_DATA_DIR && path.isAbsolute(process.env.TERMFORGE_DATA_DIR), 'Native smoke requires an isolated configuration override');
  const isolatedProfile = path.resolve(process.env.TERMFORGE_DATA_DIR);
  assert.equal(path.resolve(resolveDataDirectory(app.getPath('appData'), app.getPath('userData'))), isolatedProfile, 'The legacy configuration override must still control application files');
  const singleInstance = await singleInstanceSmoke(app, window, terminals);
  const errors = [];
  window.webContents.on('console-message', (details) => { if (details.level === 'error' || /Could not create web worker|Falling back to loading web worker/i.test(details.message)) errors.push(details.message); });
  console.log('START native isolation, PTY, terminal UI, broadcast, and preferences checks');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, description) => {
      const end = Date.now() + 12000;
      while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('Timed out: ' + description);
    };
    await wait(() => document.querySelector('button'), 'renderer UI');
    if (typeof window.require !== 'undefined' || typeof window.process !== 'undefined') throw new Error('Node exposed to renderer');
    const state = await window.termforge.getState();
    if (!state.sessions.some(session => session.protocol === 'local')) throw new Error('Missing local shell profile');
    const session = await window.termforge.saveSession({name:'Smoke SSH',protocol:'ssh',host:'127.0.0.1',port:2222,username:'tester',folder:'Tests'});
    if (!(await window.termforge.getState()).sessions.some(item => item.id === session.id)) throw new Error('Save failed');
    await window.termforge.deleteSession(session.id);
    let output = '';
    let exited = false;
    let id;
    const offData = window.termforge.onTerminalData(event => { if (event.id === id) output += event.data; });
    const offExit = window.termforge.onTerminalExit(event => { if (event.id === id) exited = true; });
    const connection = await window.termforge.terminalOpen({sessionId:state.sessions.find(item => item.protocol === 'local').id});
    id = connection.id;
    await window.termforge.terminalResize({id,cols:110,rows:35});
    await window.termforge.terminalWrite({id,data:${JSON.stringify(process.platform === 'win32' ? "echo TERMFORGE_REAL_^PTY\r" : "printf 'TERMFORGE_REAL_%s\\n' 'PTY'\r")}});
    await wait(() => output.includes('TERMFORGE_REAL_PTY'), 'real shell output');
    await window.termforge.terminalClose(id);
    await wait(() => exited, 'PTY exit event');
    offData(); offExit();
    const event = new KeyboardEvent('keydown', {key:'l',code:'KeyL',ctrlKey:${process.platform !== 'darwin'},metaKey:${process.platform === 'darwin'},bubbles:true});
    document.dispatchEvent(event);
    await wait(() => document.querySelector('.xterm-screen'), 'terminal UI shortcut');
    const visibleOutput = new Map();
    const offVisible = window.termforge.onTerminalData(event => visibleOutput.set(event.id, (visibleOutput.get(event.id) || '') + event.data));
    document.getElementById('quick-local').click();
    await wait(() => document.querySelectorAll('.terminal-pane').length === 2, 'second terminal tab');
    document.getElementById('toggle-tile').click();
    await wait(() => [...document.querySelectorAll('.terminal-pane')].every(pane => !pane.hidden && pane.getBoundingClientRect().width > 200), 'tiled terminals');
    const broadcast = document.getElementById('broadcast-mode');
    broadcast.checked = true;
    document.getElementById('command-input').value = ${JSON.stringify(process.platform === 'win32' ? "echo TERMFORGE_BROADCAST_^OK" : "printf 'TERMFORGE_BROADCAST_%s\\n' 'OK'")};
    document.getElementById('send-command').click();
    await wait(() => document.getElementById('confirm-dialog').open, 'broadcast confirmation');
    if (document.querySelectorAll('.confirm-target-item').length !== 2) throw new Error('Broadcast did not show both target terminals');
    if ([...visibleOutput.values()].some(text => text.includes('TERMFORGE_BROADCAST_OK'))) throw new Error('Broadcast sent before confirmation');
    document.getElementById('confirm-accept').click();
    await wait(() => [...visibleOutput.values()].filter(text => text.includes('TERMFORGE_BROADCAST_OK')).length === 2, 'broadcast delivered to both real shells');
    offVisible();
    document.getElementById('settings-button').click();
    await wait(() => document.getElementById('settings-dialog').open, 'preferences dialog');
    document.getElementById('settings-font').value = '16';
    document.getElementById('settings-form').requestSubmit();
    await wait(() => !document.getElementById('settings-dialog').open, 'preferences saved');
    if ((await window.termforge.getState()).settings.fontSize !== 16) throw new Error('Preferences did not persist');
    document.getElementById('footer-search').click();
    if (document.getElementById('terminal-search-bar').hidden) throw new Error('Terminal search did not open');
    document.getElementById('terminal-search-input').value = 'TERMFORGE_BROADCAST_OK';
    document.getElementById('terminal-search-input').dispatchEvent(new Event('input', {bubbles:true}));
    document.getElementById('close-search').click();
    return {platform:state.platform,version:state.version,nodeIsolated:true,profileRoundTrip:true,realPTY:true,terminalUI:true,tileView:true,broadcastConfirmation:true,broadcastDelivery:true,preferencesPersist:true};
  })()`);
  assert.equal(result.realPTY, true);
  const isolatedConfig = JSON.parse(await fs.readFile(path.join(isolatedProfile, 'config.json'), 'utf8'));
  assert.equal(isolatedConfig.settings.fontSize, 16, 'Native preference writes must reach the existing configuration override');
  const displayedTitle = await window.webContents.executeJavaScript('document.title');
  assert.match(displayedTitle, /ForgeCRT/, 'Visible document title must use the new product name');
  Object.assign(result, singleInstance, { runtimeIdentityPreserved: true, nativeUserDataIdentityPreserved: true, chromiumSessionIdentityPreserved: true,
    isolatedConfigOverrideVerified: true, brandDisplayVerified: true, installedCredentialMigrationVerified: false });
  console.log('PASS native display branding, retained runtime/storage identities and isolated configuration persistence');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS native isolation, PTY, terminal UI, broadcast, and preferences checks');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const directory = process.env.TERMFORGE_SMOKE_DIR;
  console.log('START isolated loopback SSH checks');
  const ssh = await require('./ssh-smoke.cjs')(directory);
  console.log('PASS isolated loopback SSH authentication, commands, and changed-host-key refusal');
  const report = { ...result, ...ssh, behavioralChecksPassed:false, screenshots:{}, activeTerminals:terminals.count, savedProfiles:store.load().sessions.length };
  const persist = () => fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  await persist();
  console.log('START terminal screenshot capture');
  report.screenshots.desktop = await screenshot(window, directory, 'desktop.png');
  await persist();
  const project = await projectSmoke(window, terminals, directory);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('START native credential, managed SSH and SFTP integration checks');
  const secure = await require('./secure-smoke.cjs')({ window, terminals, directory });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('START native standalone Quick Connect window and parent IPC checks');
  const quickConnect = await require('./quick-connect-smoke.cjs')({ window, terminals, store, directory });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('START native application menu, focus, byte-transfer and capture checks');
  const menus = await require('./menu-smoke.cjs')({ window, terminals, directory });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('START native reviewed session import checks');
  const sessionImport = await require('./session-import-smoke.cjs')({ window, terminals, store, directory });
  assert.equal(errors.length, 0, errors.join('\n'));
  Object.assign(report, project, secure, quickConnect, menus, sessionImport, {behavioralChecksPassed:true});
  await persist();
  console.log('START project editor screenshot capture');
  report.screenshots.projectEditor = await screenshot(window, directory, 'project-editor.png');
  report.screenshotCaptured = Object.values(report.screenshots).every(capture => capture.screenshotCaptured);
  await persist();
  console.log('ForgeCRT desktop smoke behavioral checks passed: ' + JSON.stringify(report));
};
