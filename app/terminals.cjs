'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { buildLaunch, validateSession } = require('./core.cjs');
const { createTransport } = require('./transports.cjs');

const MAX_TERMINALS = 32;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_EARLY_OUTPUT = 1024 * 1024;
const MAX_LOG_BYTES = 128 * 1024 * 1024;

function createTerminalManager({ spawn, transport = createTransport, emitData = () => {}, emitExit = () => {}, platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  const terminals = new Map();
  const spawnPty = spawn || ((file, args, options) => require('node-pty').spawn(file, args, options));

  function get(id) {
    if (typeof id !== 'string' || !terminals.has(id)) throw new Error('Terminal is no longer open.');
    return terminals.get(id);
  }
  function stopLog(entry) {
    if (!entry.log) return;
    const descriptor = entry.log.descriptor;
    entry.log = null;
    fs.closeSync(descriptor);
  }
  function send(entry, data) {
    // Log only PTY output. Echoed input and remote output can still contain
    // sensitive information; the UI must explain this before logging starts.
    if (entry.log && !entry.log.paused) {
      try {
        const bytes = Buffer.byteLength(data, 'utf8');
        if (entry.log.bytes + bytes > MAX_LOG_BYTES) {
          stopLog(entry);
          emitData({ id: entry.id, data: '\r\n[TermForge: output logging stopped at the 128 MiB limit.]\r\n' });
        } else {
          fs.writeSync(entry.log.descriptor, data, undefined, 'utf8');
          entry.log.bytes += bytes;
        }
      } catch {
        try { stopLog(entry); } catch { /* Preserve the terminal after a log I/O error. */ }
        emitData({ id: entry.id, data: '\r\n[TermForge: output logging stopped because the log could not be written.]\r\n' });
      }
    }
    emitData({ id: entry.id, data });
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
    try { stopLog(entry); } catch { /* The process must still be removed. */ }
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
      const launch = ['ssh', 'local', 'sftp'].includes(session.protocol) ? buildLaunch(session, { platform, env, cwd }) : null;
      const processHandle = launch ? spawnPty(launch.file, launch.args, { ...launch.options, encoding: 'utf8' }) : transport(session);
      if (!processHandle || !['write', 'resize', 'kill', 'onData', 'onExit'].every(method => typeof processHandle[method] === 'function')) {
        try { processHandle?.kill?.(); } catch { /* Invalid process handles still need cleanup. */ }
        throw new Error('The native terminal could not be started.');
      }
      const entry = { id: randomUUID(), session, process: processHandle, subscriptions: [], log: null, ready: false, pending: [], pendingBytes: 0, timer: null };
      terminals.set(entry.id, entry);
      try {
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
    enableLog(id, filename) {
      const entry = get(id);
      if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[\u0000\r\n]/u.test(filename)) throw new Error('An absolute output log path is required.');
      // A new file only: never overwrite or follow an existing file or symlink.
      // The save dialog can select a different filename when one already exists.
      const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { stopLog(entry); } catch (error) { fs.closeSync(descriptor); throw error; }
      entry.log = { descriptor, filename, bytes: 0, paused: false };
      return { id, path: filename, logging: true };
    },
    disableLog(id) { const entry = get(id); stopLog(entry); return { id, logging: false }; },
    pauseLog(id, paused = true) {
      const entry = get(id);
      if (typeof paused !== 'boolean') throw new Error('Log pause state must be true or false.');
      if (!entry.log) throw new Error('Start a session log before pausing it.');
      entry.log.paused = paused;
      return { id, path: entry.log.filename, logging: true, paused };
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
