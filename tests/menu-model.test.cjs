'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMenus, sanitizeMenuState, findMenuAction } = require('../app/menu-model.cjs');
const { createNativeMenu } = require('../app/native-menu.cjs');

const get = (state, action, platform = 'darwin') => findMenuAction(buildMenus({ ready: true, ...state }, platform), action);
const live = { id: 'terminal-1', title: 'Synthetic SSH', protocol: 'ssh', exited: false, selection: false };
function leaves(entries) { return entries.flatMap(entry => !entry ? [] : entry.submenu ? leaves(entry.submenu) : [entry]); }

test('reference menu order is shared across platforms and commercial licensing is absent', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const menus = buildMenus({ ready: true }, platform);
    assert.deepEqual(menus.map(menu => menu.label), ['File', 'Edit', 'View', 'Options', 'Transfer', 'Script', 'Tools', 'Window', 'Help']);
    assert.equal(leaves(menus).some(entry => /SecureCRT Web|Order SecureCRT|Deregister|License Data/.test(entry.label)), false);
    assert.equal(get({}, 'quick-connect', platform).enabled, true);
  }
});

test('closed and disconnected terminals cannot send input, while useful output actions remain available', () => {
  const capabilities = Object.fromEntries(['copy-paste', 'paste-quotation', 'send-binary', 'receive-ascii', 'clear-scrollback', 'clear-screen-scrollback', 'print-screen'].map(action => [action, true]));
  for (const state of [{ capabilities }, { current: { ...live, exited: true }, capabilities }]) {
    for (const action of ['paste', 'copy-paste', 'paste-quotation', 'send-ascii', 'send-binary', 'receive-ascii', 'disconnect', 'log', 'pause-log']) assert.equal(get(state, action).enabled, false, action);
  }
  const exited = { current: { ...live, exited: true, selection: true }, capabilities };
  for (const action of ['copy', 'select-all', 'find', 'clear-scrollback', 'clear-screen', 'clear-screen-scrollback', 'print-screen', 'reconnect']) assert.equal(get(exited, action).enabled, true, action);
  for (const protocol of ['ssh', 'local', 'raw']) assert.equal(get({ current: { ...live, protocol } }, 'send-break').enabled, false);
  for (const protocol of ['serial', 'telnet']) assert.equal(get({ current: { ...live, protocol } }, 'send-break').enabled, true);
});

test('copy requires a selection and editing a read-only field never falls through to a live terminal', () => {
  assert.equal(get({ current: live }, 'copy').enabled, false);
  assert.equal(get({ current: { ...live, selection: true } }, 'copy').enabled, true);
  const readonly = { current: live, editTarget: true, editWritable: false, capabilities: { 'copy-paste': true, 'paste-quotation': true } };
  assert.equal(get(readonly, 'copy').enabled, true);
  for (const action of ['paste', 'cut', 'undo', 'redo', 'copy-paste', 'paste-quotation']) assert.equal(get(readonly, action).enabled, false, action);
  assert.equal(get({ ...readonly, editWritable: true }, 'paste').enabled, true);
});

test('menus reflect logging, recording, running scripts and dock layout state', () => {
  const state = { current: { ...live, logging: true, logPaused: true }, scriptRunning: true, recording: true, capabilities: { 'script-record-start': true, 'script-record-stop': true, 'script-record-cancel': true, 'show-toolbar': true }, panes: { toolbar: true, commandWindow: false, sessionManager: false, commandManager: true, activeSessions: false } };
  assert.equal(get(state, 'log').checked, true); assert.equal(get(state, 'pause-log').checked, true); assert.equal(get(state, 'pause-log').enabled, true);
  assert.equal(get({ ...state, rawLogging:true }, 'log').checked, false); assert.equal(get({ ...state, rawLogging:true }, 'raw-log').checked, true);
  assert.equal(get(state, 'script-cancel').enabled, true); assert.equal(get(state, 'script-record-start').enabled, false); assert.equal(get(state, 'script-record-stop').enabled, true); assert.equal(get(state, 'script-record-cancel').enabled, true);
  assert.equal(get({ ...state, current: null }, 'script-record-stop').enabled, true, 'A recording can stop even if its terminal has closed');
  assert.equal(get(state, 'show-toolbar').checked, true); assert.equal(get(state, 'show-command-window').checked, false);
  assert.equal(get(state, 'show-command-manager').checked, true); assert.equal(get(state, 'show-session-manager').checked, false);
});

test('unimplemented features cannot be enabled by supplying capabilities', () => {
  for (const action of ['send-kermit', 'receive-xmodem', 'zmodem-upload', 'cascade', 'detach-tab', 'lock-session', 'configuration-passphrase', 'import-xml', 'import-text']) {
    const entry = get({ current: live, capabilities: { [action]: true } }, action);
    assert.equal(entry.enabled, false, action); assert.ok(entry.unavailableReason.length > 15, action);
  }
  assert.equal(get({}, 'create-public-key').enabled, false);
  assert.equal(get({ capabilities: { 'create-public-key': true } }, 'create-public-key').enabled, true);
});

test('dynamic menus encode identifiers, reflect tab targets, and empty lists cannot execute', () => {
  const state = { current: live, connections: [live, { id: 'next:tab', title: 'Second tab', exited: true }], recentSessions: [{ id: 'session/2', name: 'Router & switch' }], recentScripts: [{ id: 'script:3', name: 'diagnostics.py' }], snapshots: [{ id: 'workspace 4', name: 'Lab' }], capabilities: { 'recent-session': true, 'recent-script': true, 'snapshot-open': true, 'reconnect-all': true } };
  assert.equal(get(state, 'recent-session:session%2F2').label, 'Router & switch');
  assert.equal(get(state, 'recent-script:script%3A3').enabled, true); assert.equal(get(state, 'snapshot-open:workspace%204').enabled, true);
  assert.equal(get(state, 'activate:terminal-1').checked, true); assert.equal(get(state, 'activate:next%3Atab').checked, false);
  assert.equal(get(state, 'reconnect-all').enabled, true);
  assert.equal(get({ ...state, connections: [live] }, 'reconnect-all').enabled, true);
  assert.equal(get({ ...state, connections: [{ ...live, reconnecting: true }] }, 'reconnect-all').enabled, false);
  const empty = buildMenus({ ready: true });
  assert.equal(findMenuAction(empty, 'recent-session'), null);
  assert.ok(leaves(empty).some(entry => entry.label === 'No recent saved sessions' && !entry.enabled && !entry.action));
});

test('startup, modal and Quick Connect focus guard terminal commands but preserve field editing', () => {
  assert.ok(leaves(buildMenus({})).every(entry => !entry.enabled));
  const base = { current: { ...live, selection: true }, editTarget: true, editWritable: true, capabilities: { 'copy-paste': true, 'snapshot-open': true, 'zoom-in': true }, snapshots: [{ id: 's1', name: 'Lab' }] };
  for (const guard of [{ dialogOpen: true }, { quickConnectFocused: true }]) {
    const state = { ...base, ...guard };
    for (const action of ['local-shell', 'connect', 'script-run', 'send-ascii', 'copy-paste', 'snapshot-open:s1', 'zoom-in']) assert.equal(get(state, action).enabled, false, action);
    for (const action of ['copy', 'paste', 'cut', 'undo', 'redo', 'select-all', 'minimize-window']) assert.equal(get(state, action).enabled, true, action);
  }
  assert.equal(get({ quickConnectFocused: true }, 'paste').enabled, true);
});

test('sanitizer bounds untrusted metadata and discards profile, password, path and terminal text', () => {
  const source = { ready: 'yes', current: { ...live, password: 'secret', output: 'private terminal text', profile: { host: 'private-host' } }, recentScripts: Array.from({ length: 30 }, (_, i) => ({ id: `id-${i}`, name: 'x'.repeat(500), filename: '/private/script.py' })), connections: [{ id: 'a', title: 'One\nLine' }, { id: 'a', title: 'Duplicate' }, { id: '\0', title: 'Bad' }], capabilities: { '__proto__': true, 'UPPER': true, 'send-binary': true }, password: 'outside' };
  const result = sanitizeMenuState(source);
  assert.equal(result.ready, false); assert.equal(result.recentScripts.length, 10); assert.equal(result.recentScripts[0].name.length, 160);
  assert.equal(result.connections.length, 1); assert.equal(result.connections[0].title, 'One Line');
  assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('/private'), false); assert.equal(JSON.stringify(result).includes('private terminal'), false);
  assert.deepEqual(result.capabilities, { 'send-binary': true });
  assert.doesNotThrow(() => buildMenus(null));
});

function nativeHarness(platform = 'darwin') {
  const installed = [], actions = [], native = [], errors = [];
  let context = {};
  const Menu = { buildFromTemplate: template => template, setApplicationMenu: menu => installed.push(menu) };
  const controller = createNativeMenu({ Menu, platform, dispatch: action => actions.push(action), runNative: action => native.push(action), getContext: () => context, onError: error => errors.push(error) });
  return { controller, installed, actions, native, errors, context: value => { context = value; } };
}

test('native menus are enabled at the top level, use platform roles, and rebuild only when relevant state changes', () => {
  const h = nativeHarness();
  h.controller.update({ ready: true });
  assert.equal(h.installed.length, 1); assert.equal(h.installed[0][0].label, 'TermForge');
  assert.ok(h.installed[0][0].submenu.some(entry => entry.role === 'services'));
  assert.ok(h.installed[0].filter(entry => entry.label !== 'TermForge').every(entry => entry.enabled));
  assert.equal(h.controller.update({ ready: true, privateUnrelatedState: 'ignore' }), false); assert.equal(h.installed.length, 1);
  h.controller.update({ ready: true, current: live }); assert.equal(h.installed.length, 2);
  const windows = nativeHarness('win32'); windows.controller.update({ ready: true });
  assert.equal(windows.installed[0][0].label, 'File');
});

test('stale native menu callbacks recheck focus and connection state before dispatch', () => {
  const h = nativeHarness(); h.controller.update({ ready: true, current: live });
  const file = h.installed.at(-1).find(entry => entry.label === 'File');
  const disconnect = file.submenu.find(entry => entry.label === 'Disconnect');
  disconnect.click(); assert.deepEqual(h.actions, ['disconnect']);
  h.context({ quickConnectFocused: true }); disconnect.click(); assert.deepEqual(h.actions, ['disconnect']);
  h.context({}); h.controller.update({ ready: true, current: { ...live, exited: true } });
  disconnect.click(); assert.deepEqual(h.actions, ['disconnect']);
  assert.equal(h.controller.execute('send-kermit'), false); assert.equal(h.controller.execute('made-up-action'), false);
  assert.equal(h.controller.execute('minimize-window'), true); assert.deepEqual(h.native, ['minimize-window']);
  h.controller.dispose(); assert.equal(h.controller.execute('copy'), false); assert.equal(h.controller.update({ ready: true }), false);
});

test('native metadata remains literal and no recent-item callback survives its removal', () => {
  const h = nativeHarness('win32'); const state = { ready: true, capabilities: { 'recent-session': true }, recentSessions: [{ id: 'opaque:id', name: 'Router & Switch' }] };
  h.controller.update(state);
  const recent = h.installed[0][0].submenu.find(entry => entry.label === 'Recent Session').submenu[0];
  assert.equal(recent.label, 'Router && Switch'); recent.click(); assert.deepEqual(h.actions, ['recent-session:opaque%3Aid']);
  h.controller.update({ ...state, recentSessions: [] }); recent.click(); assert.equal(h.actions.length, 1);
  const transfer = h.installed.at(-1).find(entry => entry.label === 'Transfer');
  const unsupported = transfer.submenu.find(entry => entry.label?.startsWith('Send Kermit'));
  assert.equal(unsupported.enabled, false); assert.match(unsupported.label, /unavailable/); assert.match(unsupported.toolTip, /not implemented/);
});
