'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { buildLaunch, validateSession } = require('./core.cjs');

const MAX_TERMINALS = 32;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_EARLY_OUTPUT = 1024 * 1024;
const MAX_LOG_BYTES = 128 * 1024 * 1024;

function createTerminalManager({ spawn, emitData = () => {}, emitExit = () => {}, platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
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
    if (entry.log) {
      try {
        const bytes = Buffer.byteLength(data, 'utf8');
        if (entry.log.bytes + bytes > MAX_LOG_BYTES) {
          stopLog(entry);
          emitData({ id: entry.id, data: '\r\n[Harbor: output logging stopped at the 128 MiB limit.]\r\n' });
        } else {
          fs.writeSync(entry.log.descriptor, data, undefined, 'utf8');
          entry.log.bytes += bytes;
        }
      } catch {
        try { stopLog(entry); } catch { /* Preserve the terminal after a log I/O error. */ }
        emitData({ id: entry.id, data: '\r\n[Harbor: output logging stopped because the log could not be written.]\r\n' });
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
      const launch = buildLaunch(session, { platform, env, cwd });
      const processHandle = spawnPty(launch.file, launch.args, { ...launch.options, encoding: 'utf8' });
      if (!processHandle || !['write', 'resize', 'kill', 'onData', 'onExit'].every(method => typeof processHandle[method] === 'function')) {
        try { processHandle?.kill?.(); } catch { /* Invalid process handles still need cleanup. */ }
        throw new Error('The native terminal could not be started.');
      }
      const entry = { id: randomUUID(), process: processHandle, subscriptions: [], log: null, ready: false, pending: [], pendingBytes: 0, timer: null };
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
    close(id) {
      if (typeof id !== 'string') throw new Error('Terminal ID is required.');
      const entry = terminals.get(id);
      if (!entry) return { id, closed: true };
      // Native node-pty owns the shell process and platform-specific PTY cleanup.
      // Its exit callback may run synchronously, so finish is idempotent.
      // If native termination fails, retain the handle so a later close can
      // retry. Removing a still-running process would lose the cleanup path.
      entry.process.kill();
      finish(entry, { exitCode: 0, signal: 'closed' });
      return { id, closed: true };
    },
    closeAll() {
      let firstError;
      for (const id of [...terminals.keys()]) {
        try { this.close(id); } catch (error) { firstError ||= error; }
      }
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
      entry.log = { descriptor, filename, bytes: 0 };
      return { id, path: filename, logging: true };
    },
    disableLog(id) { const entry = get(id); stopLog(entry); return { id, logging: false }; },
    get count() { return terminals.size; },
  };
}

module.exports = { createTerminalManager };
