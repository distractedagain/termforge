'use strict';
// An isolated in-memory bridge. Nothing here connects to a device or launches a shell.
module.exports = function installFixture({ platform = 'darwin', settings = {}, sessions = [], snippets = [] } = {}) {
  const clone = value => JSON.parse(JSON.stringify(value));
  let state = { version: '0.7.0', platform, settings, sessions, snippets, snapshots: [], commandHistory: [] };
  let counter = 0;
  const listeners = new Map();
  const calls = { opens: [], writes: [], closes: [], resizes: [], saves: [], bulk: [], history: [], snapshots: [], breaks: [], logs: [], scriptRuns: [], scriptCancels: [], recordedScripts: [], screens: [], clipboard: [], active: [], focus: [], orders: [], tftpRoots: [], tftpStarts: [], tftpStops: [], aiModels: [], aiStarts: [], aiCancels: [] };
  let clipboard = 'synthetic clipboard';
  let asciiFile = { name: 'synthetic-commands.txt', size: 11, text: 'show clock\n' };
  let tftp = { state: 'stopped', running: false, activeTransfers: 0, completedTransfers: 0 };
  let aiModels = [{ name: 'synthetic-local:4b', size: 2500000000, parameterSize: '4B' }];
  let aiModelError = ''; let aiStartError = '';
  const emit = (event, payload) => { for (const callback of listeners.get(event) || []) callback(clone(payload)); };
  const subscribe = event => callback => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); return () => listeners.get(event).delete(callback); };
  const saveSession = async profile => { const saved = await window.__validateProfile({ ...profile, id: profile.id || `fixture-saved-${++counter}` }); const index = state.sessions.findIndex(item => item.id === saved.id); if (index < 0) state.sessions.push(saved); else state.sessions[index] = saved; calls.saves.push(clone(saved)); return clone(saved); };
  window.__qa = { calls, getState: () => clone(state), setClipboard: value => { clipboard = value; }, setAscii: value => { asciiFile = value; }, emitMenu: action => emit('menu', action), emitData: (id, data) => emit('data', { id, data }), emitScript: value => emit('script-status', value), emitOutput: value => emit('script-output', value), emitScreen: value => emit('screen-request', value), emitOpened: value => emit('opened', value), emitActivated: id => emit('activated', { id }), emitMapped: value => emit('mapped', value), emitTftpTransfer: value => emit('tftp-transfer', value), emitTftpStatus: value => { tftp = { ...tftp, ...value }; emit('tftp-status', tftp); }, emitExit: id => emit('exit', { id, exitCode: 0 }) };
  Object.assign(window.__qa, { setAiModels: value => { aiModels = clone(value); }, setAiModelError: value => { aiModelError = value; }, setAiStartError: value => { aiStartError = value; }, emitAi: value => emit('ai-event', value) });
  window.termforge = {
    getState: async () => clone(state), saveSession,
    saveSessions: async profiles => {
      // Validate the complete batch before changing the fixture, just as the
      // production store does. Invalid bulk changes cannot partially commit.
      calls.bulk.push(clone(profiles));
      const saved = [];
      for (const profile of profiles) saved.push(await window.__validateProfile(profile));
      if (new Set(saved.map(profile => profile.id)).size !== saved.length || saved.some(profile => !state.sessions.some(item => item.id === profile.id))) throw new Error('Invalid bulk profile IDs.');
      state.sessions = state.sessions.map(profile => saved.find(item => item.id === profile.id) || profile);
      return clone(state.sessions);
    },
    deleteSession: async id => { state.sessions = state.sessions.filter(profile => profile.id !== id); return clone(state); },
    saveSnippets: async snippets => { state.snippets = await window.__validateSnippets(snippets); return clone(state.snippets); },
    saveSettings: async settings => { state.settings = await window.__validateSettings({ ...state.settings, ...clone(settings) }); return clone(state.settings); },
    saveSnapshots: async snapshots => { state.snapshots = await window.__validateSnapshots(clone(snapshots).map(snapshot => ({ ...snapshot, id: snapshot.id || `fixture-snapshot-${++counter}` })), state.sessions); calls.snapshots.push(clone(state.snapshots)); return clone(state.snapshots); },
    saveCommandHistory: async history => { state.commandHistory = await window.__validateHistory(history, state.settings.commandHistoryLimit); calls.history.push(clone(state.commandHistory)); return clone(state.commandHistory); },
    serialPorts: async () => [{ path: '/dev/cu.fixture', manufacturer: 'Simulated device' }],
    chooseIdentityFile: async () => null, exportConfig: async () => null, importConfig: async () => null, importSecureCRT: async () => null,
    terminalOpen: async request => {
      const profile = request.sessionId ? state.sessions.find(profile => profile.id === request.sessionId) : request.profile;
      if (!profile) throw new Error('Unknown synthetic session.');
      const normalized = await window.__validateProfile(profile);
      const id = `fixture-terminal-${++counter}`; calls.opens.push({ id, request: clone(request), profile: clone(normalized) });
      setTimeout(() => emit('data', { id, data: '\x1b[32mDEMO SESSION\x1b[0m — Synthetic test; no device connected\r\n' + profile.name + '> ' }), 30);
      return { id, title: profile.name, protocol: profile.protocol };
    },
    terminalWrite: async value => { calls.writes.push(clone(value)); }, terminalResize: async value => { calls.resizes.push(clone(value)); }, terminalActivate: async id => { calls.active.push(id); return true; },
    terminalFocus: async value => { calls.focus.push(clone(value)); return true; },
    terminalReorder: async ids => { calls.orders.push(clone(ids)); return clone(ids); },
    terminalClose: async id => { calls.closes.push(id); emit('exit', { id, exitCode: 0 }); }, terminalBreak: async id => { calls.breaks.push(id); },
    terminalSetLog: async value => { calls.logs.push(clone(value)); return { enabled: value.enabled, path: '/synthetic/output.log' }; }, terminalPauseLog: async value => { calls.logs.push(clone(value)); return { logging: true, paused: value.paused }; },
    prepareAsciiFile: async () => clone(asciiFile),
    scriptRun: async value => { calls.scriptRuns.push(clone(value)); const id = `fixture-script-${++counter}`; emit('script-status', { id, terminalId: value.terminalId, filename: 'synthetic.py', state: 'running' }); return { id, terminalId: value.terminalId }; },
    scriptCancel: async id => { calls.scriptCancels.push(id); emit('script-status', { id, state: 'cancelled' }); },
    saveRecordedScript: async events => { const source = await window.__validateRecorded(events); calls.recordedScripts.push({ events: clone(events), source }); return { path: '/synthetic/recorded.py' }; },
    chooseTftpRoot: async () => { const result = { token: 'fixture-folder-token', root: '/synthetic/tftp-folder' }; calls.tftpRoots.push(clone(result)); return result; },
    tftpStatus: async () => clone(tftp),
    tftpStart: async request => { if (request.rootToken !== 'fixture-folder-token') throw new Error('Choose the synthetic folder first.'); calls.tftpStarts.push(clone(request)); const normalized = await window.__validateTftp(request); tftp = { ...normalized, state: 'running', running: true }; emit('tftp-status', tftp); return clone(tftp); },
    tftpStop: async () => { calls.tftpStops.push(true); tftp = { ...tftp, state: 'stopped', running: false, activeTransfers: 0 }; emit('tftp-status', tftp); return clone(tftp); },
    screenResponse: async response => { calls.screens.push(clone(response)); },
    aiModels: async request => { calls.aiModels.push(clone(request)); if (aiModelError) throw new Error(aiModelError); return { models: request.provider === 'openrouter-free' ? [{ name: 'openrouter/free', parameterSize: 'Free online router' }] : clone(aiModels), excluded: 0 }; },
    aiStart: async request => { calls.aiStarts.push(clone(request)); if (aiStartError) throw new Error(aiStartError); return { requestId: request.requestId }; },
    aiCancel: async requestId => { calls.aiCancels.push(requestId); return { cancelled: true }; },
    onAiEvent: subscribe('ai-event'),
    clipboardRead: async () => clipboard, clipboardWrite: async value => { calls.clipboard.push(value); return true; },
    onTerminalData: subscribe('data'), onTerminalExit: subscribe('exit'), onTerminalOpened: subscribe('opened'), onTerminalActivated: subscribe('activated'), onMappedKey: subscribe('mapped'), onTftpStatus: subscribe('tftp-status'), onTftpTransfer: subscribe('tftp-transfer'), onMenuAction: subscribe('menu'), onScriptStatus: subscribe('script-status'), onScriptOutput: subscribe('script-output'), onScreenRequest: subscribe('screen-request'),
  };
};
