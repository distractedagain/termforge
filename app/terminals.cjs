'use strict';

const { randomUUID } = require('node:crypto');
const { buildLaunch, validateSession } = require('./core.cjs');
const { createTransport } = require('./transports.cjs');
const { createOutputFile } = require('./terminal-output.cjs');

const MAX_TERMINALS = 32;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_EARLY_OUTPUT = 1024 * 1024;
const MAX_RAW_HISTORY = 64 * 1024;

function createTerminalManager({ spawn, transport = createTransport, managedTransport, emitData = () => {}, emitExit = () => {}, emitOutputState = () => {}, platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  const terminals = new Map();
  const spawnPty = spawn || ((file, args, options) => require('node-pty').spawn(file, args, options));

  function get(id) {
    if (typeof id !== 'string' || !terminals.has(id)) throw new Error('Terminal is no longer open.');
    return terminals.get(id);
  }
  function outputState(entry) {
    return { id: entry.id,
      log: entry.log ? { enabled: true, mode: entry.log.mode, paused: entry.log.paused, path: entry.log.filename } : { enabled: false, mode: null, paused: false, path: null },
      capture: entry.capture ? { enabled: true, path: entry.capture.filename } : { enabled: false, path: null },
      capabilities: { rawLog: typeof entry.process.onRawData === 'function', hex: typeof entry.process.onRawData === 'function', binary: typeof entry.process.writeBytes === 'function' },
    };
  }
  function notifyOutput(entry) { emitOutputState(outputState(entry)); }
  function stopOutput(entry, field) {
    const file = entry[field];
    if (!file) return;
    entry[field] = null;
    try { file.close(); } finally { notifyOutput(entry); }
  }
  function writeOutput(entry, field, data) {
    if (!entry[field]) return;
    try { entry[field].write(data); }
    catch (error) {
      try { stopOutput(entry, field); } catch { /* Preserve the terminal after a file I/O error. */ }
      const label = field === 'capture' ? 'ASCII receive' : 'output logging';
      emitData({ id: entry.id, data: `\r\n[ForgeCRT: ${label} stopped ${error.code === 'OUTPUT_LIMIT' ? 'at the 128 MiB limit' : 'because the file could not be written'}.]\r\n` });
    }
  }
  function send(entry, data) {
    // Received output can contain echoed secrets. Neither capture mode redacts
    // content; the caller must explain this before opening the file.
    if (entry.log?.mode === 'text') writeOutput(entry, 'log', data);
    writeOutput(entry, 'capture', data);
    emitData({ id: entry.id, data });
  }
  function receiveRaw(entry, data) {
    if (!terminals.has(entry.id) || !(data instanceof Uint8Array)) return;
    const bytes = Buffer.from(data);
    entry.rawReceived += bytes.length;
    entry.rawHistory = bytes.length >= MAX_RAW_HISTORY ? Buffer.from(bytes.subarray(-MAX_RAW_HISTORY)) : Buffer.concat([entry.rawHistory.subarray(Math.max(0, entry.rawHistory.length + bytes.length - MAX_RAW_HISTORY)), bytes]);
    if (entry.log?.mode === 'raw') writeOutput(entry, 'log', bytes);
  }
  function flush(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    entry.ready = true;
    const buffered = entry.pending;
    entry.pending = []; entry.pendingBytes = 0;
    for (const data of buffered) send(entry, data);
  }
  function dispose(entry) {
    for (const subscription of entry.subscriptions) {
      try { subscription?.dispose?.(); } catch { /* Best-effort native listener cleanup. */ }
    }
    entry.subscriptions = [];
    for (const field of ['log', 'capture']) { try { stopOutput(entry, field); } catch { /* The process must still be removed. */ } }
    entry.rawHistory = Buffer.alloc(0);
  }
  function finish(entry, event = {}) {
    if (!terminals.has(entry.id)) return;
    flush(entry);
    terminals.delete(entry.id);
    dispose(entry);
    emitExit({ id: entry.id, exitCode: Number.isInteger(event.exitCode) ? event.exitCode : 0, signal: event.signal ?? null });
  }

  return {
    open(input) {
      if (terminals.size >= MAX_TERMINALS) throw new Error(`At most ${MAX_TERMINALS} terminals can be open at once.`);
      const session = validateSession(input);
      if (session.protocol === 'sftp' && (session.ssh.backend === 'managed' || session.credentialId)) throw new Error('Managed SFTP sessions open in the graphical file transfer workspace.');
      const managed = session.protocol === 'ssh' && session.ssh.backend === 'managed';
      if (managed && typeof managedTransport !== 'function') throw new Error('Managed SSH is unavailable.');
      const launch = !managed && ['ssh', 'local', 'sftp'].includes(session.protocol) ? buildLaunch(session, { platform, env, cwd }) : null;
      const processHandle = managed ? managedTransport(session) : launch ? spawnPty(launch.file, launch.args, { ...launch.options, encoding: 'utf8' }) : transport(session);
      if (!processHandle || !['write', 'resize', 'kill', 'onData', 'onExit'].every(method => typeof processHandle[method] === 'function')) {
        try { processHandle?.kill?.(); } catch { /* Invalid process handles still need cleanup. */ }
        throw new Error('The native terminal could not be started.');
      }
      const entry = { id: randomUUID(), session, process: processHandle, subscriptions: [], log: null, capture: null, rawHistory: Buffer.alloc(0), rawReceived: 0, ready: false, pending: [], pendingBytes: 0, timer: null };
      terminals.set(entry.id, entry);
      try {
        if (typeof processHandle.onRawData === 'function') entry.subscriptions.push(processHandle.onRawData(data => receiveRaw(entry, data)));
        entry.subscriptions.push(processHandle.onData(data => {
          if (!terminals.has(entry.id) || typeof data !== 'string') return;
          if (entry.ready) send(entry, data);
          else {
            // Briefly hold initial shell prompts until the invoke response can
            // create the renderer's tab. Renderer buffering completes the IPC
            // ordering guarantee; no sleeps block process creation.
            entry.pending.push(data); entry.pendingBytes += Buffer.byteLength(data, 'utf8');
            if (entry.pendingBytes >= MAX_EARLY_OUTPUT) flush(entry);
          }
        }));
        const exitSubscription = processHandle.onExit(event => finish(entry, event));
        if (terminals.has(entry.id)) entry.subscriptions.push(exitSubscription);
        else exitSubscription?.dispose?.();
        if (terminals.has(entry.id)) entry.timer = setTimeout(() => flush(entry), 25);
      } catch (error) {
        terminals.delete(entry.id); dispose(entry);
        try { processHandle.kill(); } catch { /* Preserve the original startup error. */ }
        throw error;
      }
      return { id: entry.id, title: session.name, protocol: session.protocol };
    },
    write({ id, data } = {}) {
      const entry = get(id);
      if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw new Error('Terminal input must be a string of at most 256 KiB.');
      entry.process.write(data);
      return { id };
    },
    resize({ id, cols, rows } = {}) {
      const entry = get(id);
      if (!Number.isInteger(cols) || cols < 1 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) throw new Error('Terminal dimensions must be 1–500 columns and 1–300 rows.');
      entry.process.resize(cols, rows);
      return { id, cols, rows };
    },
    sendBreak(id) {
      const entry = get(id);
      if (typeof entry.process.sendBreak !== 'function') throw new Error('Break is available for serial and Telnet sessions.');
      entry.process.sendBreak();
      return { id };
    },
    close(id) {
      if (typeof id !== 'string') throw new Error('Terminal ID is required.');
      const entry = terminals.get(id);
      if (!entry) return { id, closed: true };
      if (entry.closing) return entry.closing;
      // Native node-pty owns the shell process and platform-specific PTY cleanup.
      // Its exit callback may run synchronously, so finish is idempotent.
      // If native termination fails, retain the handle so a later close can
      // retry. Removing a still-running process would lose the cleanup path.
      const stopped = entry.process.kill();
      if (stopped && typeof stopped.then === 'function') {
        entry.closing = Promise.resolve(stopped).then(() => {
          finish(entry, { exitCode: 0, signal: 'closed' });
          return { id, closed: true };
        }).catch(error => { entry.closing = null; throw error; });
        return entry.closing;
      }
      finish(entry, { exitCode: 0, signal: 'closed' });
      return { id, closed: true };
    },
    closeAll() {
      let firstError;
      const pending = [];
      for (const id of [...terminals.keys()]) {
        try { const stopped = this.close(id); if (stopped && typeof stopped.then === 'function') pending.push(stopped); } catch (error) { firstError ||= error; }
      }
      if (pending.length) return Promise.allSettled(pending).then(results => { for (const result of results) if (result.status === 'rejected') firstError ||= result.reason; if (firstError) throw firstError; return { closed: true }; });
      if (firstError) throw firstError;
      return { closed: true };
    },
    enableLog(id, filename, { mode = 'text' } = {}) {
      const entry = get(id);
      if (mode === 'raw' && typeof entry.process.onRawData !== 'function') throw new Error('Raw logging requires managed SSH, TCP, Telnet, or serial. Native shell output is decoded text.');
      // Flush startup data before capture begins: the chosen file contains only
      // output received after the user's start action.
      flush(entry);
      const file = createOutputFile(filename, { mode });
      try { stopOutput(entry, 'log'); } catch (error) { file.close(); throw error; }
      entry.log = file; notifyOutput(entry);
      return { id, path: filename, logging: true };
    },
    disableLog(id) { const entry = get(id); stopOutput(entry, 'log'); return { id, logging: false }; },
    pauseLog(id, paused = true) {
      const entry = get(id);
      if (typeof paused !== 'boolean') throw new Error('Log pause state must be true or false.');
      if (!entry.log) throw new Error('Start a session log before pausing it.');
      entry.log.paused = paused; notifyOutput(entry);
      return { id, path: entry.log.filename, logging: true, paused };
    },
    enableCapture(id, filename) {
      const entry = get(id); flush(entry);
      const file = createOutputFile(filename);
      try { stopOutput(entry, 'capture'); } catch (error) { file.close(); throw error; }
      entry.capture = file; notifyOutput(entry);
      return { id, path: filename, receiving: true };
    },
    disableCapture(id) { const entry = get(id); stopOutput(entry, 'capture'); return { id, receiving: false }; },
    writeBinary({ id, data } = {}) {
      const entry = get(id);
      if (typeof entry.process.writeBytes !== 'function') throw new Error('Binary sending requires managed SSH, raw TCP, or serial.');
      if (!(data instanceof Uint8Array) || data.byteLength > MAX_INPUT_BYTES) throw new Error('Binary input must contain at most 256 KiB.');
      const bytes = Buffer.from(data); entry.process.writeBytes(bytes);
      return { id, bytes: bytes.length };
    },
    outputState(id) { return outputState(get(id)); },
    readRaw(id) {
      const entry = get(id);
      if (typeof entry.process.onRawData !== 'function') throw new Error('Hex View requires managed SSH, TCP, Telnet, or serial. Native shell output is decoded text.');
      return { id, base64: entry.rawHistory.toString('base64'), offset: entry.rawReceived - entry.rawHistory.length, totalBytes: entry.rawReceived, limit: MAX_RAW_HISTORY };
    },
    get count() { return terminals.size; },
    has(id) { return terminals.has(id); },
    describe(id) { const entry = terminals.get(id); return entry ? { id: entry.id, title: entry.session.name, profileId: entry.session.id, session: JSON.parse(JSON.stringify(entry.session)) } : null; },
    list() { return [...terminals.keys()].map(id => this.describe(id)); },
    reorder(ids) {
      if (!Array.isArray(ids) || ids.length > MAX_TERMINALS || ids.some(id => typeof id !== 'string' || id.length > 128) || new Set(ids).size !== ids.length) throw new Error('Invalid terminal order.');
      const entries = new Map(terminals);
      terminals.clear();
      for (const id of ids) if (entries.has(id)) { terminals.set(id, entries.get(id)); entries.delete(id); }
      for (const [id, entry] of entries) terminals.set(id, entry);
      return [...terminals.keys()];
    },
  };
}

module.exports = { createTerminalManager };
