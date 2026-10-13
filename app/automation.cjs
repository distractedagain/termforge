'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_SEND_BYTES = 256 * 1024;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function recordedInputToPython(events) {
  if (!Array.isArray(events) || events.length > 10000) throw new Error('A recording must contain at most 10000 input events.');
  let bytes = 0, milliseconds = 0;
  const normalized = events.map(event => {
    const data = typeof event === 'string' ? event : event?.data;
    const delayMs = typeof event === 'string' ? 0 : event?.delayMs ?? 0;
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_SEND_BYTES) throw new Error('Recorded input must be text of at most 256 KiB per event.');
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw new Error('Recorded event delay must be 0–60000 milliseconds.');
    bytes += Buffer.byteLength(data); milliseconds += delayMs;
    if (bytes > MAX_BUFFER_BYTES || milliseconds > MAX_TIMEOUT_SECONDS * 1000) throw new Error('Recording is limited to 1 MiB of input and 24 hours of pauses.');
    return { data, delayMs };
  });
  // JSON data is loaded from a quoted string, never interpolated as Python code.
  const literal = JSON.stringify(JSON.stringify(normalized));
  return `# $language = "Python3"\n# $interface = "1.0"\n# Recorded explicitly in ForgeCRT. Review commands before running.\n# This replays input and pauses; it does not infer authenticated prompts.\nimport json\n\n_events = json.loads(${literal})\nfor _event in _events:\n    if _event["delayMs"]:\n        crt.Sleep(_event["delayMs"])\n    crt.Screen.Send(_event["data"])\n`;
}

function createAutomationManager({ getSessionProfiles = () => [], openSession, closeSession, writeTerminal, getActiveTerminalId = () => null, getTerminalIds, getTerminalDetails, getScreen, activateTerminal, emitOutput = () => {}, emitStatus = () => {}, spawn = spawnChild } = {}) {
  const scripts = new Map();

  function createContext(terminalId) {
    return { id: randomUUID(), terminalId, connected: Boolean(terminalId), synchronous: false, buffer: '', wait: null };
  }
  function contextFor(entry, contextId) {
    if (contextId === undefined || contextId === null) return entry.defaultContext;
    const context = entry.contexts.get(contextId);
    if (!context) throw new Error('The script has no reference to that terminal tab.');
    return context;
  }
  async function tabs() {
    if (typeof getTerminalIds !== 'function') throw new Error('Terminal tab collection is unavailable.');
    const entries = await getTerminalIds();
    if (!Array.isArray(entries) || entries.length > 128) throw new Error('Terminal tab collection must contain at most 128 tabs.');
    const result = entries.map(value => typeof value === 'string' ? { id: value } : value);
    if (result.some(value => !value || typeof value.id !== 'string' || !value.id) || new Set(result.map(value => value.id)).size !== result.length) throw new Error('Terminal tab collection is invalid.');
    return result;
  }
  function rememberTab(entry, tab) {
    let context = [...entry.contexts.values()].find(value => value.terminalId === tab.id);
    if (!context) {
      if (entry.contexts.size >= 128) throw new Error('At most 128 referenced tab contexts are supported per script.');
      context = createContext(tab.id); entry.contexts.set(context.id, context);
    }
    return { id: tab.id, contextId: context.id };
  }
  async function tabDetails(context) {
    if (!context.terminalId) throw new Error('The script terminal is not open.');
    const tab = (await tabs()).find(value => value.id === context.terminalId);
    if (!tab) throw new Error('The terminal tab is no longer open.');
    return typeof getTerminalDetails === 'function' ? { ...tab, ...await getTerminalDetails(context.terminalId) } : tab;
  }
  async function savedProfile(value) {
    const name = savedSessionName(value);
    const profiles = await getSessionProfiles();
    if (!Array.isArray(profiles)) throw new Error('Saved sessions are unavailable.');
    const candidates = profiles.filter(profile => profile && [profile.id, profile.name, [profile.folder, profile.name].filter(Boolean).join('/')].includes(name));
    if (candidates.length !== 1) throw new Error(candidates.length ? 'Saved session name is ambiguous; use folder/session or its ID.' : 'Saved session was not found.');
    return candidates[0];
  }
  async function openProfile(entry, profile) {
    if (typeof openSession !== 'function') throw new Error('Session connection is unavailable.');
    const opened = await openSession(profile);
    if (!opened || typeof opened.id !== 'string' || !opened.id) throw new Error('The session did not open a terminal.');
    if (entry.cancelled || entry.finished) {
      if (typeof closeSession === 'function') await closeSession(opened.id);
      throw new Error('The script has stopped.');
    }
    return opened;
  }
  async function screenRead(context, params) {
    if (!context.terminalId) throw new Error('The script terminal is not open.');
    if (typeof getScreen !== 'function') throw new Error('Rendered terminal screen access is unavailable.');
    const coordinates = ['startRow', 'startColumn', 'endRow', 'endColumn'];
    const hasRange = coordinates.some(key => params[key] !== undefined);
    if (hasRange && (coordinates.some(key => !Number.isInteger(params[key]) || params[key] < 1 || params[key] > 10000) || params.startRow > params.endRow || params.startColumn > params.endColumn)) throw new Error('Screen coordinates must be a one-based inclusive rectangle.');
    const response = await getScreen({ id: context.terminalId, ...(hasRange ? Object.fromEntries(coordinates.map(key => [key, params[key]])) : {}) });
    if (!response || ['rows', 'columns', 'currentRow', 'currentColumn'].some(key => !Number.isInteger(response[key]) || response[key] < 1 || response[key] > 10000) || response.currentRow > response.rows || response.currentColumn > response.columns) throw new Error('Rendered terminal screen metadata is invalid.');
    if (hasRange && (params.endRow > response.rows || params.endColumn > response.columns || typeof response.text !== 'string' || Buffer.byteLength(response.text) > MAX_BUFFER_BYTES)) throw new Error('Screen rectangle is outside the terminal or its text is invalid.');
    return response;
  }

  function notify(callback, value) {
    try { callback(value); } catch { /* A closed renderer must not orphan Python. */ }
  }
  function output(entry, stream, data) {
    if (data) notify(emitOutput, { id: entry.id, terminalId: entry.terminalId, stream, data });
  }
  function status(entry, state, details = {}) {
    notify(emitStatus, { id: entry.id, terminalId: entry.terminalId, filename: entry.filename, state, ...details });
  }
  function reply(entry, requestId, result, error) {
    if (entry.finished || entry.child.stdin.destroyed || entry.child.stdin.writableEnded) return;
    const value = error ? { kind: 'response', requestId, ok: false, error: error.message || String(error) } : { kind: 'response', requestId, ok: true, result: result ?? null };
    entry.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  function finishWait(entry, result, error) {
    const wait = entry.wait;
    if (!wait) return;
    entry.wait = null;
    if (!entry.synchronous) entry.buffer = '';
    if (wait.timer) clearTimeout(wait.timer);
    if (error) wait.reject(error); else wait.resolve(result);
  }
  function evaluateWait(entry) {
    if (!entry.wait) return;
    const wait = entry.wait;
    let match = null;
    for (let i = 0; i < wait.strings.length; i++) {
      const text = wait.strings[i];
      const insensitive = wait.ignoreCase ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu').exec(entry.buffer) : null;
      const index = wait.ignoreCase ? insensitive?.index ?? -1 : entry.buffer.indexOf(text);
      if (index !== -1 && (!match || index < match.position)) match = { position: index, index: i + 1, length: insensitive ? insensitive[0].length : text.length };
    }
    if (!match) return;
    const data = entry.buffer.slice(0, match.position);
    entry.buffer = entry.buffer.slice(match.position + match.length);
    finishWait(entry, { index: match.index, data });
  }
  function waitFor(entry, params) {
    if (!entry.connected) throw new Error('The script terminal is not open.');
    if (entry.wait) throw new Error('Only one terminal wait can be active per script.');
    const strings = params.strings;
    if (!Array.isArray(strings) || strings.length < 1 || strings.length > 64 || strings.some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > 16 * 1024)) throw new Error('Wait strings must be 1–64 nonempty strings of at most 16 KiB each.');
    if (strings.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > 128 * 1024) throw new Error('Wait strings must be at most 128 KiB total.');
    const timeout = params.timeout ?? 0;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_SECONDS) throw new Error('Wait timeout must be 0–86400 seconds; zero waits until a match, cancellation, or terminal closure.');
    if (typeof params.ignoreCase !== 'boolean') throw new Error('Ignore-case must be a boolean.');
    const pending = deferred();
    entry.wait = { ...pending, strings, ignoreCase: params.ignoreCase, timer: null };
    if (timeout > 0) entry.wait.timer = setTimeout(() => {
      const data = entry.buffer;
      entry.buffer = '';
      finishWait(entry, { index: 0, data });
    }, Math.ceil(timeout * 1000));
    evaluateWait(entry);
    return pending.promise;
  }
  function savedSessionName(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000\r\n]/u.test(value)) throw new Error('Connect requires a saved session name or /S "folder/session".');
    let name = value.trim();
    if (/^\/S\s/iu.test(name)) {
      name = name.replace(/^\/S\s+/iu, '').trim();
      if (name.startsWith('"')) {
        if (!/^"[^"\r\n]+"$/u.test(name)) throw new Error('Only a saved /S session is supported; ad hoc connection switches are not supported.');
        name = name.slice(1, -1);
      } else if (/\s/u.test(name)) throw new Error('Quote saved session names containing spaces.');
    } else if (name.startsWith('/')) throw new Error('Only saved sessions are supported by Session.Connect.');
    if (!name) throw new Error('A saved session name is required.');
    return name.replaceAll('\\', '/');
  }
  async function dispatch(entry, method, params = {}) {
    if (entry.cancelled || entry.finished) throw new Error('The script has stopped.');
    const context = contextFor(entry, params.contextId);
    switch (method) {
      case 'screen.send':
        if (!context.connected) throw new Error('The script terminal is not open.');
        if (typeof params.data !== 'string' || Buffer.byteLength(params.data) > MAX_SEND_BYTES) throw new Error('Send requires text of at most 256 KiB.');
        if (typeof writeTerminal !== 'function') throw new Error('Terminal writing is unavailable.');
        await writeTerminal({ id: context.terminalId, data: params.data });
        return null;
      case 'screen.wait': return waitFor(context, params);
      case 'screen.get': return (await screenRead(context, params)).text;
      case 'screen.metadata': {
        if (!['rows', 'columns', 'currentRow', 'currentColumn'].includes(params.property)) throw new Error('Unsupported screen metadata property.');
        return (await screenRead(context, {}))[params.property];
      }
      case 'screen.synchronous':
        if (typeof params.value !== 'boolean') throw new Error('Synchronous must be a boolean.');
        context.synchronous = params.value;
        if (!context.synchronous && !context.wait) context.buffer = '';
        return null;
      case 'session.connected': return context.connected;
      case 'session.disconnect':
        if (context.connected) {
          if (typeof closeSession !== 'function') throw new Error('Session disconnect is unavailable.');
          const id = context.terminalId;
          await closeSession(id);
          if (context.terminalId === id) { context.connected = false; context.buffer = ''; finishWait(context, null, new Error('The script terminal closed.')); }
        }
        return null;
      case 'session.connect': {
        if (context.connected) throw new Error('Disconnect the script terminal before connecting a saved session.');
        const opened = await openProfile(entry, await savedProfile(params.name));
        context.terminalId = opened.id; context.connected = true; context.buffer = '';
        if (context === entry.defaultContext) entry.terminalId = opened.id;
        status(entry, 'running');
        return { id: opened.id };
      }
      case 'session.connectInTab': {
        if (entry.contexts.size >= 128) throw new Error('At most 128 referenced tab contexts are supported per script.');
        const opened = await openProfile(entry, await savedProfile(params.name));
        return rememberTab(entry, opened);
      }
      case 'tabs.count': return (await tabs()).length;
      case 'tabs.get': {
        const available = await tabs();
        if (!Number.isInteger(params.index) || params.index < 1 || params.index > available.length) throw new Error('Tab index is outside the one-based tab collection.');
        return rememberTab(entry, available[params.index - 1]);
      }
      case 'tabs.active': {
        const id = await getActiveTerminalId();
        const tab = (await tabs()).find(value => value.id === id);
        if (!tab) throw new Error('There is no active terminal tab.');
        return rememberTab(entry, tab);
      }
      case 'tab.index': {
        const index = (await tabs()).findIndex(value => value.id === context.terminalId);
        if (index < 0) throw new Error('The terminal tab is no longer open.');
        return index + 1;
      }
      case 'tab.caption': {
        const details = await tabDetails(context);
        if (typeof details.title !== 'string') throw new Error('Terminal tab caption is unavailable.');
        return details.title;
      }
      case 'tab.activate':
        await tabDetails(context);
        if (typeof activateTerminal !== 'function') throw new Error('Terminal tab activation is unavailable.');
        await activateTerminal(context.terminalId);
        return null;
      case 'tab.close':
        if (typeof closeSession !== 'function') throw new Error('Terminal tab closure is unavailable.');
        await closeSession(context.terminalId);
        context.connected = false; context.buffer = ''; finishWait(context, null, new Error('The terminal tab closed.'));
        return null;
      case 'tab.clone': {
        if (entry.contexts.size >= 128) throw new Error('At most 128 referenced tab contexts are supported per script.');
        const details = await tabDetails(context);
        const profiles = details.session ? [] : await getSessionProfiles();
        if (!Array.isArray(profiles)) throw new Error('Saved sessions are unavailable.');
        const profile = details.session || profiles.find(value => value.id === details.profileId);
        if (!profile || typeof profile !== 'object') throw new Error('The terminal profile is unavailable; this tab cannot be cloned.');
        return rememberTab(entry, await openProfile(entry, profile));
      }
      case 'sleep': {
        if (typeof params.milliseconds !== 'number' || !Number.isFinite(params.milliseconds) || params.milliseconds < 0 || params.milliseconds > MAX_TIMEOUT_SECONDS * 1000) throw new Error('Sleep requires 0–86400000 milliseconds.');
        if (entry.sleep) throw new Error('Only one script sleep can be active.');
        const pending = deferred();
        entry.sleep = { ...pending, timer: setTimeout(() => { entry.sleep = null; pending.resolve(null); }, Math.ceil(params.milliseconds)) };
        return pending.promise;
      }
      default: throw new Error(`Unsupported ForgeCRT scripting method: ${method}`);
    }
  }
  function handleFrame(entry, frame) {
    let message;
    try { message = JSON.parse(frame); } catch { stop(entry, new Error('Invalid Python bridge message.')); return; }
    if (message.kind === 'ready' && !entry.ready) {
      entry.ready = true; clearTimeout(entry.startTimer);
      status(entry, 'running'); entry.started.resolve({ id: entry.id, terminalId: entry.terminalId });
      return;
    }
    if (message.kind !== 'request' || !entry.ready || !Number.isSafeInteger(message.requestId) || message.requestId < 1 || typeof message.method !== 'string' || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) {
      stop(entry, new Error('Invalid Python bridge request.')); return;
    }
    if (entry.request) { reply(entry, message.requestId, null, new Error('Concurrent Python bridge requests are not supported.')); return; }
    entry.request = message.requestId;
    Promise.resolve().then(() => dispatch(entry, message.method, message.params)).then(
      result => { entry.request = null; reply(entry, message.requestId, result); },
      error => { entry.request = null; reply(entry, message.requestId, null, error); },
    );
  }
  function parseOutput(entry, data, final = false) {
    if (entry.stopping) { output(entry, 'stdout', entry.stdoutBuffer + data); entry.stdoutBuffer = ''; return; }
    entry.stdoutBuffer += data;
    while (entry.stdoutBuffer) {
      const position = entry.stdoutBuffer.indexOf(entry.prefix);
      if (position === -1) {
        let keep = 0;
        if (!final) for (let n = Math.min(entry.prefix.length - 1, entry.stdoutBuffer.length); n > 0; n--) {
          if (entry.stdoutBuffer.endsWith(entry.prefix.slice(0, n))) { keep = n; break; }
        }
        output(entry, 'stdout', entry.stdoutBuffer.slice(0, entry.stdoutBuffer.length - keep));
        entry.stdoutBuffer = keep ? entry.stdoutBuffer.slice(-keep) : '';
        break;
      }
      if (position > 0) { output(entry, 'stdout', entry.stdoutBuffer.slice(0, position)); entry.stdoutBuffer = entry.stdoutBuffer.slice(position); }
      const newline = entry.stdoutBuffer.indexOf('\n', entry.prefix.length);
      if (newline === -1) {
        if (Buffer.byteLength(entry.stdoutBuffer) > MAX_FRAME_BYTES) stop(entry, new Error('Python bridge message exceeded 2 MiB.'));
        else if (final) { output(entry, 'stdout', entry.stdoutBuffer); entry.stdoutBuffer = ''; }
        break;
      }
      const frame = entry.stdoutBuffer.slice(entry.prefix.length, newline);
      entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { stop(entry, new Error('Python bridge message exceeded 2 MiB.')); break; }
      handleFrame(entry, frame);
    }
  }
  function signal(entry, value) {
    if (entry.finished) return;
    try {
      if (process.platform !== 'win32' && entry.child.pid) process.kill(-entry.child.pid, value);
      else entry.child.kill(value);
    } catch (error) { if (error.code !== 'ESRCH') entry.error ||= error; }
  }
  function stop(entry, error) {
    if (entry.finished || entry.stopping) return;
    entry.stopping = true; entry.error ||= error;
    for (const context of entry.contexts.values()) finishWait(context, null, error || new Error('Script cancelled.'));
    if (entry.sleep) { clearTimeout(entry.sleep.timer); entry.sleep.reject(error || new Error('Script cancelled.')); entry.sleep = null; }
    signal(entry, 'SIGTERM');
    entry.killTimer = setTimeout(() => signal(entry, 'SIGKILL'), 1000);
  }
  function finish(entry, code, signalValue) {
    if (entry.finished) return;
    entry.finished = true;
    clearTimeout(entry.startTimer); clearTimeout(entry.killTimer);
    for (const context of entry.contexts.values()) finishWait(context, null, new Error('The Python process exited.'));
    if (entry.sleep) { clearTimeout(entry.sleep.timer); entry.sleep.reject(new Error('The Python process exited.')); entry.sleep = null; }
    parseOutput(entry, entry.stdoutDecoder.end(), true);
    output(entry, 'stderr', entry.stderrDecoder.end());
    scripts.delete(entry.id);
    try { fs.rmSync(entry.directory, { recursive: true, force: true }); } catch { /* A temp cleanup failure does not change script completion. */ }
    const state = entry.cancelled ? 'cancelled' : entry.error || code !== 0 ? 'failed' : 'completed';
    const error = entry.error?.message || (code !== 0 && !entry.cancelled ? `Python exited with ${signalValue || `code ${code}`}.` : undefined);
    status(entry, state, { exitCode: code, signal: signalValue, ...(error ? { error } : {}) });
    if (!entry.ready) entry.started.reject(entry.error || new Error(error || 'Python exited before starting the script.'));
    entry.exited.resolve({ id: entry.id, state, exitCode: code, signal: signalValue });
  }

  return {
    async run({ filename, terminalId, pythonPath, arguments: args = [] } = {}) {
      if (scripts.size) throw new Error('A Python script is already running. Cancel it before running another.');
      if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\u0000\r\n]/u.test(filename) || path.extname(filename).toLowerCase() !== '.py') throw new Error('Choose an absolute local Python (.py) script path.');
      if (!fs.statSync(filename).isFile()) throw new Error('The Python script must be a regular file.');
      if (!Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096) || Buffer.byteLength(JSON.stringify(args)) > 128 * 1024) throw new Error('Script arguments must be up to 128 strings, each at most 4 KiB, with at most 128 KiB total.');
      const interpreter = pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
      if (typeof interpreter !== 'string' || !interpreter || /[\u0000\r\n]/u.test(interpreter) || (!path.isAbsolute(interpreter) && !['python', 'python3'].includes(interpreter))) throw new Error('Python interpreter must be an absolute executable path, python, or python3.');
      const selectedId = terminalId ?? await getActiveTerminalId();
      if (scripts.size) throw new Error('A Python script is already running. Cancel it before running another.');
      if (selectedId !== null && selectedId !== undefined && (typeof selectedId !== 'string' || !selectedId)) throw new Error('A valid terminal ID is required.');
      // Python cannot read a script inside Electron's ASAR. Materialize the
      // original stdlib shim in a private temporary directory for each run.
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termforge-python-'));
      const shim = path.join(directory, 'termforge_script.py');
      let child;
      try {
        fs.chmodSync(directory, 0o700);
        fs.writeFileSync(shim, fs.readFileSync(path.join(__dirname, 'termforge_script.py')), { mode: 0o600 });
        child = spawn(interpreter, ['-u', shim, filename], { cwd: path.dirname(filename), env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false });
      } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
      const defaultContext = createContext(selectedId ?? null);
      const entry = { id: randomUUID(), filename, directory, child, terminalId: selectedId ?? null, defaultContext, contexts: new Map([[defaultContext.id, defaultContext]]), sleep: null, prefix: `\x1eTERMFORGE_RPC:${randomBytes(24).toString('hex')}:`, stdoutBuffer: '', stdoutDecoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8'), started: deferred(), exited: deferred(), ready: false, cancelled: false, stopping: false, finished: false, error: null, request: null };
      scripts.set(entry.id, entry);
      status(entry, 'starting');
      entry.startTimer = setTimeout(() => stop(entry, new Error('Python did not initialize within 10 seconds.')), 10000);
      child.stdout.on('data', chunk => parseOutput(entry, entry.stdoutDecoder.write(chunk)));
      child.stderr.on('data', chunk => output(entry, 'stderr', entry.stderrDecoder.write(chunk)));
      child.stdin.on('error', error => { if (!entry.stopping && !entry.finished) stop(entry, error); });
      child.once('error', error => { entry.error = new Error(`Python could not start: ${error.message}`); });
      child.once('close', (code, signalValue) => finish(entry, code, signalValue));
      child.stdin.write(`${JSON.stringify({ prefix: entry.prefix, arguments: args, defaultContextId: defaultContext.id })}\n`);
      return entry.started.promise;
    },
    async cancel(id) {
      if (typeof id !== 'string') throw new Error('Script ID is required.');
      const entry = scripts.get(id);
      if (!entry) return { id, state: 'stopped' };
      entry.cancelled = true; stop(entry);
      return entry.exited.promise;
    },
    feedData({ id, data } = {}) {
      if (typeof data !== 'string') return;
      for (const entry of scripts.values()) {
        const context = [...entry.contexts.values()].find(value => value.terminalId === id);
        if (!context || !context.connected || (!context.synchronous && !context.wait)) continue;
        context.buffer += data;
        if (Buffer.byteLength(context.buffer) > MAX_BUFFER_BYTES) {
          context.buffer = '';
          stop(entry, new Error('Unconsumed terminal output exceeded the 1 MiB scripting buffer.'));
        } else evaluateWait(context);
      }
    },
    feedExit({ id } = {}) {
      for (const entry of scripts.values()) for (const context of entry.contexts.values()) if (context.terminalId === id) {
        context.connected = false; context.buffer = '';
        finishWait(context, null, new Error('The script terminal closed.'));
      }
    },
    async closeAll() {
      return Promise.all([...scripts.keys()].map(id => this.cancel(id)));
    },
    get count() { return scripts.size; },
  };
}

module.exports = { createAutomationManager, recordedInputToPython };
