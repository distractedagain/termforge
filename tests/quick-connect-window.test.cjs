'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQuickConnectWindow, QUICK_CONNECT_URL } = require('../app/quick-connect-window.cjs');
const { createStore, validateQuickConnect, validateSession } = require('../app/core.cjs');

const request = overrides => ({ profile:{ name:'Synthetic quick connection', protocol:'ssh', host:'lab.example.test', ssh:{ backend:'managed' } }, saveSession:false, showOnStartup:false, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function harness(t, options = {}) {
  const windows = [], handlers = new Map(), requests = [], prepared = [], metadata = [{ id:'fixture-id', name:'Fixture credential', updatedAt:'2026-10-13T00:00:00.000Z' }];
  const controls = { stopping:false, load:null, prepareError:null, requestError:null, stateGate:null, metadata };
  let focused, managerCalls = 0;
  const parent = { destroyed:false, visible:true, focusCount:0, isDestroyed() { return this.destroyed; }, show() { this.visible = true; }, focus() { this.focusCount++; focused = this; }, webContents:{ edits:[] } };
  focused = parent;
  class FakeWindow extends EventEmitter {
    constructor(config) {
      super(); this.config = config; this.destroyed = false; this.visible = false; this.minimized = false; this.restoreCount = 0; this.focusCount = 0; this.closeCount = 0;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame:{ url:'' }, sent:[], edits:[],
        setWindowOpenHandler: handler => { this.popupHandler = handler; },
        send:(...args) => this.webContents.sent.push(args)
      });
      for (const method of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) this.webContents[method] = () => this.webContents.edits.push(method);
      windows.push(this);
    }
    static getFocusedWindow() { return focused; }
    setMenuBarVisibility(value) { this.menuVisible = value; }
    loadURL(url) { this.loadedURL = url; this.webContents.mainFrame.url = url; const load = controls.load; controls.load = null; return load ? load.promise : Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.restoreCount++; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { focused = this; this.focusCount++; }
    close() { this.closeCount++; this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; if (focused === this) focused = parent; this.emit('closed'); }
  }
  const ipcMain = { handle:(name, callback) => { assert.ok(!handlers.has(name)); handlers.set(name, callback); }, removeHandler:name => handlers.delete(name) };
  const manager = createQuickConnectWindow({
    BrowserWindow:FakeWindow, ipcMain, parent, preload:'/synthetic/quick-connect-preload.cjs',
    getState:async () => { if (controls.stateGate) await controls.stateGate.promise; return { platform:'darwin', settings:{ showQuickConnectOnStartup:false }, credentials:controls.metadata, serialPorts:[] }; },
    prepare:input => { prepared.push(input); if (controls.prepareError) throw controls.prepareError; return { profile:input.profile, state:{ fixture:true } }; },
    requestMain:value => { if (controls.requestError) throw controls.requestError; requests.push(value); },
    manageCredentials:() => { managerCalls++; }, chooseIdentityFile:async child => ({ owner:child, path:'/synthetic/key' }),
    isStopping:() => controls.stopping, timeoutMs:5000, ...options
  });
  t.after(() => manager.dispose());
  const child = () => windows.at(-1);
  const event = () => ({ sender:child().webContents, senderFrame:child().webContents.mainFrame });
  function invoke(name, input, sender = event()) {
    const handler = handlers.get(`termforge:quickConnect:${name}`);
    assert.equal(typeof handler, 'function');
    const result = Promise.resolve().then(() => handler(sender, input));
    // Cleanup can reject a pending request after a prior assertion fails.
    result.catch(() => {});
    return result;
  }
  return { manager, windows, child, event, invoke, handlers, parent, requests, prepared, controls, metadata, get managerCalls() { return managerCalls; } };
}

async function submit(h, value = request()) {
  const promise = h.invoke('submit', value);
  // Let the real asynchronous IPC wrapper register the request before accept.
  await Promise.resolve(); await Promise.resolve();
  return { promise, id:h.requests.at(-1)?.id };
}

test('Quick Connect constructs a separate standard-frame, modeless, sandboxed native window', async t => {
  const h = harness(t); await h.manager.open(); const child = h.child();
  assert.equal(child.config.parent, h.parent); assert.equal(child.config.modal, false);
  assert.equal(child.config.frame, true); assert.equal(child.config.titleBarStyle, 'default');
  assert.equal(child.config.title, 'Quick Connect'); assert.equal(child.config.minimizable, true); assert.equal(child.config.maximizable, true);
  assert.equal(child.config.resizable, true); assert.equal(child.config.fullscreenable, false);
  assert.deepEqual(child.config.webPreferences, { preload:'/synthetic/quick-connect-preload.cjs', contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true, spellcheck:false, zoomMode:'isolated' });
  assert.equal(child.loadedURL, QUICK_CONNECT_URL); assert.equal(child.visible, true); assert.equal(child.menuVisible, false);
  assert.equal(child.focusCount, 1); assert.equal(h.parent.destroyed, false);
  assert.ok(child.config.minWidth <= child.config.width); assert.ok(child.config.minHeight <= child.config.height);
});

test('Quick Connect bounds fit a small work area and deny navigation, redirects and popups', async t => {
  const h = harness(t, { workArea:{ width:620, height:570 } }); await h.manager.open(); const child = h.child();
  assert.ok(child.config.width < 620 && child.config.height < 570);
  assert.deepEqual(child.popupHandler({ url:'https://example.test/' }), { action:'deny' });
  for (const name of ['will-navigate', 'will-redirect', 'page-title-updated']) {
    let prevented = false; child.webContents.emit(name, { preventDefault:() => { prevented = true; } }); assert.equal(prevented, true, name);
  }
});

test('concurrent opens reuse one loading window and a minimized singleton restores', async t => {
  const h = harness(t); const load = deferred(); h.controls.load = load;
  const first = h.manager.open(); const second = h.manager.open();
  assert.equal(h.windows.length, 1); assert.equal(h.child().visible, false);
  load.resolve(); assert.deepEqual(await Promise.all([first, second]), [true, true]);
  const child = h.child(); child.minimized = true; child.hide(); const focusCount = child.focusCount;
  await h.manager.open(); assert.equal(h.windows.length, 1); assert.equal(child.restoreCount, 1); assert.equal(child.visible, true); assert.equal(child.focusCount, focusCount + 1);
});

test('failed document loads destroy the failed window and permit a fresh retry', async t => {
  const h = harness(t); const load = deferred(); h.controls.load = load;
  const opening = h.manager.open(); load.reject(new Error('Fixture load failed'));
  await assert.rejects(opening, /Fixture load failed/); assert.equal(h.child().destroyed, true);
  await h.manager.open(); assert.equal(h.windows.length, 2); assert.equal(h.child().visible, true);
});

test('child IPC requires the exact child sender, main frame and document URL', async t => {
  const h = harness(t); await h.manager.open(); const child = h.child();
  assert.deepEqual([...h.handlers.keys()].map(name => name.replace('termforge:quickConnect:', '')).sort(), ['getState', 'close', 'chooseIdentityFile', 'manageCredentials', 'submit'].sort());
  for (const event of [{ sender:h.parent.webContents, senderFrame:child.webContents.mainFrame }, { sender:child.webContents, senderFrame:{ url:QUICK_CONNECT_URL } }, { sender:child.webContents, senderFrame:null }]) {
    await assert.rejects(h.invoke('getState', undefined, event), /Untrusted Quick Connect/);
  }
  child.webContents.mainFrame.url = 'termforge://app/index.html';
  await assert.rejects(h.invoke('getState'), /Untrusted Quick Connect/);
  child.webContents.mainFrame.url = QUICK_CONNECT_URL;
  const state = await h.invoke('getState'); assert.deepEqual(state.credentials, h.metadata); assert.equal(state.fileSession, false);
  assert.equal((await h.invoke('chooseIdentityFile')).owner, child);
  const stale = h.event(); child.close(); await h.manager.open();
  await assert.rejects(h.invoke('getState', undefined, stale), /Untrusted Quick Connect/);
});

test('file-session defaults are passed to a new window and existing drafts receive a limited update', async t => {
  const h = harness(t); await h.manager.open({ fileSession:true });
  assert.equal((await h.invoke('getState')).fileSession, true);
  const child = h.child(); child.draft = { host:'preserve.example.test' };
  await h.manager.open({ fileSession:true });
  assert.equal(h.windows.length, 1); assert.deepEqual(child.webContents.sent, [['termforge:quickConnect:fileSession', true]]);
  assert.deepEqual(child.draft, { host:'preserve.example.test' });
  h.manager.close(); await h.manager.open(); assert.equal((await h.invoke('getState')).fileSession, false);
  for (const invalid of [null, [], { fileSession:'yes' }, { url:'https://example.test' }]) await assert.rejects(h.manager.open(invalid), /Invalid Quick Connect options/);
});

test('submit awaits parent acceptance without persistence, deduplicates and rejects replay', async t => {
  const h = harness(t); await h.manager.open(); const child = h.child();
  const { promise, id } = await submit(h); assert.ok(id); assert.equal(h.prepared.length, 0); assert.equal(child.visible, true);
  assert.deepEqual(Object.keys(h.requests[0]), ['id']);
  await assert.rejects(h.invoke('submit', request()), /already being submitted/);
  assert.throws(() => h.manager.accept('wrong-request'), /expired/); assert.equal(h.prepared.length, 0);
  const accepted = h.manager.accept(id); assert.equal(h.prepared.length, 1); assert.equal(accepted.profile.host, 'lab.example.test');
  assert.deepEqual(await promise, { accepted:true }); assert.equal(child.visible, false); assert.equal(h.parent.visible, true);
  assert.throws(() => h.manager.accept(id), /expired/);
  await assert.rejects(h.invoke('submit', request()), /already being submitted/);
  await assert.rejects(h.invoke('manageCredentials'), /Wait for the connection request/);
  await assert.rejects(h.manager.open(), /being opened/);
  await nextTurn(); assert.equal(child.destroyed, true); assert.equal(h.prepared.length, 1);
});

test('parent acceptance timeout cancels the request before any store write', async t => {
  const h = harness(t, { timeoutMs:15 }); await h.manager.open(); const { promise, id } = await submit(h);
  await assert.rejects(promise, /workspace did not accept/); assert.equal(h.prepared.length, 0);
  assert.throws(() => h.manager.accept(id), /expired/); assert.equal(h.child().destroyed, false);
});

test('invalid submission never reaches the parent or persistence', async t => {
  const h = harness(t); await h.manager.open();
  for (const invalid of [null, { ...request(), saveSession:'yes' }, { ...request(), secret:'disallowed' }, request({ profile:{ protocol:'ssh', host:'-oProxyCommand=bad' } }), request({ profile:{ protocol:'ssh', host:'lab.example.test', password:'plain-secret' } })]) {
    await assert.rejects(h.invoke('submit', invalid));
  }
  assert.equal(h.requests.length, 0); assert.equal(h.prepared.length, 0);
});

test('failed parent delivery cancels the request and allows a retry', async t => {
  const h = harness(t); await h.manager.open(); h.controls.requestError = new Error('Fixture delivery failed');
  await assert.rejects(h.invoke('submit', request()), /workspace could not receive/);
  assert.equal(h.prepared.length, 0); h.controls.requestError = null;
  const pending = await submit(h); h.manager.accept(pending.id); assert.deepEqual(await pending.promise, { accepted:true });
});

test('failed store preparation returns the error to the still-open form and retry works', async t => {
  const h = harness(t); await h.manager.open(); const child = h.child(); h.controls.prepareError = new Error('Fixture write failed');
  const first = await submit(h); assert.equal(h.manager.accept(first.id), null);
  await assert.rejects(first.promise, /Fixture write failed/); assert.equal(child.visible, true); assert.equal(child.destroyed, false);
  h.controls.prepareError = null; const second = await submit(h); h.manager.accept(second.id);
  assert.deepEqual(await second.promise, { accepted:true }); assert.equal(h.prepared.length, 2);
});

test('native close and renderer crash reject pending requests without storing connections', async t => {
  for (const mode of ['close', 'crash']) {
    const h = harness(t); await h.manager.open(); const pending = await submit(h);
    if (mode === 'close') h.child().close(); else h.child().webContents.emit('render-process-gone');
    await assert.rejects(pending.promise, /closed|stopped unexpectedly/); assert.equal(h.prepared.length, 0);
    assert.throws(() => h.manager.accept(pending.id), /expired/); assert.equal(h.child().destroyed, true);
  }
});

test('explicit cancellation, disposal and shutdown stop requests and remove child handlers', async t => {
  const h = harness(t); await h.manager.open(); const pending = await submit(h);
  assert.equal(await h.invoke('close'), true); await assert.rejects(pending.promise, /cancelled/); assert.equal(h.prepared.length, 0);
  await h.manager.open(); const next = await submit(h); h.manager.dispose();
  await assert.rejects(next.promise, /cancelled/); assert.equal(h.handlers.size, 0); assert.equal(h.child().destroyed, true);
  await assert.rejects(h.manager.open(), /closing/);
  const other = harness(t); other.controls.stopping = true; await assert.rejects(other.manager.open(), /closing/); assert.equal(other.windows.length, 0);
  other.controls.stopping = false; other.parent.destroyed = true; await assert.rejects(other.manager.open(), /closing/); assert.equal(other.windows.length, 0);
});

test('closing the workspace while a child is loading destroys it before display', async t => {
  const h = harness(t); const load = deferred(); h.controls.load = load;
  const opening = h.manager.open(); h.parent.destroyed = true; load.resolve();
  await assert.rejects(opening, /closing/); assert.equal(h.child().destroyed, true); assert.equal(h.child().visible, false);
});

test('child menu editing stays in its webContents and terminal actions are consumed', async t => {
  const h = harness(t); await h.manager.open(); const child = h.child();
  for (const action of ['undo', 'redo', 'cut', 'copy', 'paste', 'select-all']) assert.equal(h.manager.routeMenuAction(action), true);
  assert.deepEqual(child.webContents.edits, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.deepEqual(h.parent.webContents.edits, []);
  for (const action of ['local-shell', 'send-break', 'disconnect', 'quick-connect']) assert.equal(h.manager.routeMenuAction(action), true);
  assert.equal(h.prepared.length, 0); assert.equal(h.requests.length, 0);
  h.parent.focus(); assert.equal(h.manager.routeMenuAction('copy'), false); assert.equal(h.manager.routeMenuAction('local-shell'), false);
  child.focus(); assert.equal(h.manager.routeMenuAction('close-tab'), true); assert.equal(child.destroyed, true);
});

test('credential manager hides and restores the same drafted window with fresh metadata only', async t => {
  const h = harness(t); await h.manager.open(); const child = h.child(); child.draft = { host:'preserve.example.test', username:'synthetic' };
  await h.invoke('manageCredentials'); assert.equal(h.managerCalls, 1); assert.equal(child.visible, false); assert.equal(h.parent.focusCount, 1);
  h.controls.metadata = [{ id:'replacement-id', name:'Replacement', updatedAt:'2026-10-13T01:00:00.000Z' }];
  assert.equal(await h.manager.resumeCredentials(), true); assert.equal(child.visible, true); assert.equal(h.windows.length, 1);
  assert.deepEqual(child.draft, { host:'preserve.example.test', username:'synthetic' });
  assert.deepEqual(child.webContents.sent, [['termforge:quickConnect:credentialsChanged', h.controls.metadata]]);
  assert.equal(await h.manager.resumeCredentials(), false);
});

test('closing the child during credential refresh never revives a destroyed or replacement window', async t => {
  const h = harness(t); await h.manager.open(); const child = h.child(); await h.invoke('manageCredentials');
  const gate = deferred(); h.controls.stateGate = gate; const refresh = h.manager.resumeCredentials();
  child.close(); await h.manager.open(); const replacement = h.child(); gate.resolve();
  assert.equal(await refresh, false); assert.equal(child.destroyed, true); assert.deepEqual(child.webContents.sent, []); assert.deepEqual(replacement.webContents.sent, []);
});

function storeFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-quick-store-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const store = createStore(directory); store.saveSettings(store.load().settings);
  return { directory, filename:path.join(directory, 'config.json'), store };
}

test('Quick Connect saves a new profile and startup preference in one persisted configuration', t => {
  const { store, filename, directory } = storeFixture(t); const before = store.load();
  const result = store.prepareQuickConnect(request({ saveSession:true, showOnStartup:true }));
  const disk = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(disk.settings.showQuickConnectOnStartup, true); assert.equal(disk.sessions.length, before.sessions.length + 1);
  assert.deepEqual(disk.sessions.find(profile => profile.id === result.profile.id), result.profile);
  assert.deepEqual(store.load(), result.state); assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  assert.deepEqual(result.state.snippets, before.snippets); assert.deepEqual(result.state.snapshots, before.snapshots);
});

test('unsaved Quick Connect profiles have no saved ID and do not append or rewrite unchanged configuration', t => {
  const { store, filename } = storeFixture(t); const initial = fs.readFileSync(filename, 'utf8'); const before = store.load();
  const unsaved = store.prepareQuickConnect(request()); assert.equal(Object.hasOwn(unsaved.profile, 'id'), false);
  assert.equal(unsaved.state.sessions.length, before.sessions.length); assert.equal(fs.readFileSync(filename, 'utf8'), initial);
  const changed = store.prepareQuickConnect(request({ showOnStartup:true }));
  assert.equal(Object.hasOwn(changed.profile, 'id'), false); assert.equal(changed.state.settings.showQuickConnectOnStartup, true);
  assert.deepEqual(changed.state.sessions, before.sessions); assert.deepEqual(store.load(), changed.state);
});

test('a supplied session ID cannot overwrite an existing profile', t => {
  const { store } = storeFixture(t); const existing = validateSession({ id:'existing-fixture', name:'Keep original', protocol:'ssh', host:'original.example.test' });
  store.saveSession(existing); const before = store.load();
  const result = store.prepareQuickConnect(request({ saveSession:true, profile:{ ...existing, name:'New connection', host:'new.example.test' } }));
  assert.notEqual(result.profile.id, existing.id); assert.equal(result.state.sessions.length, before.sessions.length + 1);
  assert.deepEqual(result.state.sessions.find(profile => profile.id === existing.id), existing);
  assert.equal(result.profile.host, 'new.example.test');
  const validated = validateQuickConnect(request({ profile:existing })); assert.notEqual(validated.profile.id, existing.id);
});

test('invalid Quick Connect input changes neither profiles nor startup preferences on disk', t => {
  const { store, filename } = storeFixture(t); const before = fs.readFileSync(filename, 'utf8');
  for (const invalid of [request({ showOnStartup:'true' }), request({ saveSession:null }), request({ extra:true }), request({ showOnStartup:true, saveSession:true, profile:{ protocol:'ssh', host:'bad..host' } }), request({ profile:{ protocol:'ssh', host:'lab.example.test', password:'Never persist' } })]) {
    assert.throws(() => store.prepareQuickConnect(invalid)); assert.equal(fs.readFileSync(filename, 'utf8'), before);
  }
});

test('session-limit failure also preserves the old startup preference atomically', t => {
  const { store, filename } = storeFixture(t); const state = store.load();
  state.sessions = Array.from({ length:1000 }, (_, index) => validateSession({ id:`fixture-${index}`, name:`Fixture ${index}`, protocol:'local' }));
  fs.writeFileSync(filename, JSON.stringify(state)); const before = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.prepareQuickConnect(request({ saveSession:true, showOnStartup:true })), /1000 sessions/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before); assert.equal(store.load().settings.showQuickConnectOnStartup, false);
});
