'use strict';

const { StringDecoder } = require('node:string_decoder');

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_SUBNEGOTIATION_BYTES = 4096;
const IAC = 255, SE = 240, SB = 250, WILL = 251, WONT = 252, DO = 253, DONT = 254;
const BINARY = 0, ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31;

function display(value) { return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 512); }
function escapeIac(buffer) {
  const escaped = [];
  for (const byte of buffer) { escaped.push(byte); if (byte === IAC) escaped.push(IAC); }
  return Buffer.from(escaped);
}

// RFCs 854/855/856/857/858, 1091 and 1073 define the wire behavior. Each
// direction retains its own negotiation state (RFC 1143); a refused request is
// never automatically retried, and an acknowledgment never starts a new offer.
function createTelnet({ send, receive, terminalType = 'xterm-256color' }) {
  let state = 'data', command = 0, sub = [], previousCR = false;
  let cols = 100, rows = 30;
  const local = new Map(), remote = new Map();
  const localSupported = new Set([BINARY, SGA, TTYPE, NAWS]);
  const remoteSupported = new Set([BINARY, ECHO, SGA]);
  const enabled = (side, option) => side.get(option) === 'yes';
  const offer = (side, positive, option) => {
    if ((side.get(option) || 'no') !== 'no') return;
    side.set(option, 'want-yes'); send(Buffer.from([IAC, positive, option]));
  };
  const subnegotiation = (option, bytes) => send(Buffer.concat([Buffer.from([IAC, SB, option]), escapeIac(bytes), Buffer.from([IAC, SE])]));
  function windowSize() {
    if (!enabled(local, NAWS)) return;
    const bytes = Buffer.alloc(4); bytes.writeUInt16BE(cols, 0); bytes.writeUInt16BE(rows, 2);
    subnegotiation(NAWS, bytes);
  }
  function negotiate(verb, option) {
    const ours = verb === DO || verb === DONT;
    const side = ours ? local : remote;
    const supported = (ours ? localSupported : remoteSupported).has(option);
    const positive = ours ? WILL : DO, negative = ours ? WONT : DONT;
    const requested = verb === DO || verb === WILL;
    const before = side.get(option) || 'no';
    if (requested) {
      if (before === 'no') {
        if (!supported) send(Buffer.from([IAC, negative, option]));
        else { side.set(option, 'yes'); send(Buffer.from([IAC, positive, option])); }
      } else if (before === 'want-yes') side.set(option, 'yes');
      else if (before === 'want-no') side.set(option, 'no');
      // Repeated DO/WILL for an enabled option is not acknowledged again.
    } else {
      side.set(option, 'no');
      if (before === 'yes') send(Buffer.from([IAC, negative, option]));
    }
    if (ours && option === NAWS && before !== 'yes' && enabled(local, NAWS)) windowSize();
  }
  function completeSubnegotiation() {
    // Respond only after TTYPE has actually been enabled, and only to SEND.
    if (sub.length === 2 && sub[0] === TTYPE && sub[1] === 1 && enabled(local, TTYPE)) {
      subnegotiation(TTYPE, Buffer.concat([Buffer.from([0]), Buffer.from(terminalType.toUpperCase(), 'ascii')]));
    }
    sub = [];
  }
  return {
    start() {
      for (const option of [BINARY, SGA, TTYPE, NAWS]) offer(local, WILL, option);
      for (const option of [BINARY, ECHO, SGA]) offer(remote, DO, option);
    },
    feed(buffer) {
      const data = [];
      const flush = () => { if (data.length) { receive(Buffer.from(data)); data.length = 0; } };
      const byteData = byte => {
        if (!enabled(remote, BINARY) && previousCR && byte === 0) { previousCR = false; return; }
        data.push(byte); previousCR = !enabled(remote, BINARY) && byte === 13;
      };
      for (const byte of buffer) {
        if (state === 'data') {
          if (byte === IAC) { flush(); state = 'iac'; } else byteData(byte);
        } else if (state === 'iac') {
          if (byte === IAC) { byteData(IAC); state = 'data'; }
          else if ([WILL, WONT, DO, DONT].includes(byte)) { command = byte; state = 'option'; }
          else if (byte === SB) { sub = []; state = 'sub'; }
          else state = 'data'; // Two-byte Telnet control commands are not text.
        } else if (state === 'option') {
          negotiate(command, byte); state = 'data';
        } else if (state === 'sub') {
          if (byte === IAC) state = 'sub-iac'; else sub.push(byte);
        } else if (state === 'sub-iac') {
          if (byte === SE) { completeSubnegotiation(); state = 'data'; }
          else if (byte === IAC) { sub.push(IAC); state = 'sub'; }
          else throw new Error('Malformed Telnet subnegotiation.');
        }
        if (sub.length > MAX_SUBNEGOTIATION_BYTES) throw new Error('Telnet subnegotiation exceeds 4 KiB.');
      }
      flush();
    },
    encode(text) {
      const bytes = Buffer.from(text, 'utf8');
      if (enabled(local, BINARY)) return escapeIac(bytes);
      // NVT requires CR LF for newline and CR NUL for a lone carriage return.
      const nvt = [];
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]; nvt.push(byte);
        if (byte === 13 && bytes[i + 1] !== 10) nvt.push(0);
        else if (byte === 10 && (i === 0 || bytes[i - 1] !== 13)) nvt.splice(nvt.length - 1, 0, 13);
      }
      return escapeIac(Buffer.from(nvt));
    },
    localEcho() { return !enabled(remote, ECHO); },
    resize(width, height) { cols = width; rows = height; windowSize(); },
    sendBreak() { send(Buffer.from([IAC, 243])); },
  };
}

function serialClass(injected) {
  const SerialPort = injected || require('serialport').SerialPort;
  if (typeof SerialPort !== 'function') throw new Error('Serial port support is unavailable.');
  return SerialPort;
}

function serialOptions(input = {}) {
  const portPath = input.path;
  if (typeof portPath !== 'string' || !portPath || portPath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(portPath)) throw new Error('A serial device path is required.');
  const baudRate = input.baudRate ?? 9600, dataBits = input.dataBits ?? 8, stopBits = input.stopBits ?? 1, parity = input.parity ?? 'none', flowControl = input.flowControl ?? 'none';
  if (!Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4000000) throw new Error('Serial baud rate must be from 50 to 4000000.');
  if (![5, 6, 7, 8].includes(dataBits) || ![1, 1.5, 2].includes(stopBits) || !['none', 'even', 'odd', 'mark', 'space'].includes(parity)) throw new Error('Serial data bits, stop bits, or parity are invalid.');
  if (!['none', 'rtscts', 'xonxoff'].includes(flowControl)) throw new Error('Serial flow control must be none, rtscts, or xonxoff.');
  return { path: portPath, baudRate, dataBits, stopBits, parity, rtscts: flowControl === 'rtscts', xon: flowControl === 'xonxoff', xoff: flowControl === 'xonxoff', xany: false, autoOpen: false, highWaterMark: 64 * 1024 };
}

/** A synchronous node-pty compatible handle; connection and open are asynchronous. */
function createTransport(session, { net, SerialPort, timeoutMs = 15000 } = {}) {
  if (!session || !['telnet', 'raw', 'serial'].includes(session.protocol)) throw new Error('Transport protocol must be telnet, raw, or serial.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Connection timeout must be 1–120000 milliseconds.');
  const serial = session.protocol === 'serial';
  const settings = serial ? serialOptions(session.serial) : null;
  if (!serial && (typeof session.host !== 'string' || !session.host || /[\u0000-\u0020\u007f]/u.test(session.host) || session.host.length > 253 || !Number.isInteger(session.port) || session.port < 1 || session.port > 65535)) throw new Error('A host and valid TCP port are required.');
  const type = session.terminal?.terminalType || session.terminalType || 'xterm-256color';
  if (typeof type !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/u.test(type)) throw new Error('Terminal type is invalid.');
  const Port = serial ? serialClass(SerialPort) : null;
  const network = serial ? null : (net || require('node:net'));
  if (!serial && typeof network.createConnection !== 'function') throw new Error('TCP support is unavailable.');
  const decoder = new StringDecoder('utf8');
  const dataListeners = new Set(), rawListeners = new Set(), exitListeners = new Set();
  let stream = null, open = false, blocked = false, finished = false, timer = null, breakTimer = null, closeRequested = false;
  let inFlightWrites = 0, guardTimer = null, detached = false;
  let serialOpening = false, closing = false, closeFailure = false;
  let closePromise = null, closeResolve = null, closeReject = null, requestedExit = null;
  const swallowLateError = () => {};
  let pending = [], pendingBytes = 0, earlyOutput = [], earlyBytes = 0, exitEvent = null;
  const listeners = [];
  const title = serial ? 'Serial' : session.protocol === 'telnet' ? 'Telnet' : 'Raw TCP';
  const target = serial ? settings.path : `${session.host.includes(':') ? `[${session.host}]` : session.host}:${session.port}`;

  function output(text) {
    if (!text) return;
    if (dataListeners.size) { for (const callback of [...dataListeners]) callback(text); }
    else {
      const size = Buffer.byteLength(text, 'utf8');
      // A late subscriber can recover startup messages without unbounded data.
      if (earlyBytes + size > MAX_QUEUED_BYTES) { earlyOutput = ['\r\n[ForgeCRT: output before subscription exceeded 1 MiB.]\r\n']; earlyBytes = 64; }
      else { earlyOutput.push(text); earlyBytes += size; }
    }
  }
  function receiveBytes(bytes) {
    for (const callback of [...rawListeners]) callback(Buffer.from(bytes));
    output(decoder.write(bytes));
  }
  const status = message => output(`\r\n[ForgeCRT: ${message}]\r\n`);
  function detach() {
    if (!stream) return;
    for (const [event, callback] of listeners.splice(0)) stream.removeListener(event, callback);
    detached = true;
    // SerialPortStream can report a canceled write on its error event *after*
    // the binding's close event. Keep a closure-free guard through that turn,
    // and through every outstanding write callback, then remove it as well.
    if (!stream.listeners('error').includes(swallowLateError)) stream.on('error', swallowLateError);
    cleanErrorGuard();
  }
  function cleanErrorGuard() {
    if (!detached || !stream) return;
    clearImmediate(guardTimer);
    guardTimer = setImmediate(() => {
      guardTimer = null;
      if (!inFlightWrites) stream.removeListener('error', swallowLateError);
    });
  }
  function listen(event, callback) { listeners.push([event, callback]); stream.on(event, callback); }
  function end(exitCode, signal) {
    if (finished) return;
    finished = true; open = false;
    clearTimeout(timer); clearTimeout(breakTimer); timer = breakTimer = null;
    pending = []; pendingBytes = 0;
    output(decoder.end());
    exitEvent = { exitCode, signal };
    for (const callback of [...exitListeners]) callback(exitEvent);
    dataListeners.clear(); rawListeners.clear(); exitListeners.clear();
  }
  function closeTcp() {
    if (!stream || closeRequested) return;
    closeRequested = true; stream.destroy();
  }
  function serialDeviceOpen() {
    // SerialPortStream.isOpen becomes false while a close is only *pending*.
    // The binding state, when available, proves whether the OS port is closed.
    return typeof stream?.port?.isOpen === 'boolean' ? stream.port.isOpen : Boolean(stream?.isOpen);
  }
  function serialClosed(event) {
    const result = requestedExit || event || { exitCode: 0, signal: null };
    const resolve = closeResolve;
    closePromise = closeResolve = closeReject = null;
    closing = closeRequested = false;
    end(result.exitCode, result.signal);
    detach(); resolve?.();
  }
  function rejectSerialClose(error) {
    const reject = closeReject;
    closePromise = closeResolve = closeReject = null;
    closing = closeRequested = false; closeFailure = true;
    open = serialDeviceOpen();
    // Keep the binding, callbacks and subscriptions owned by this handle so
    // its manager can retain the entry and retry kill() after a failed close.
    status(`Serial device could not be closed: ${display(error.message || error)}. Retry closing this terminal.`);
    reject?.(error instanceof Error ? error : new Error(String(error)));
  }
  function attemptSerialClose() {
    if (!closing || closeRequested || finished) return;
    if (!stream) { serialClosed(); return; }
    // Opening a native binding cannot be canceled. Keep this close Promise
    // pending, and close the device from its eventual open event/callback.
    if (serialOpening || stream.opening) return;
    if (!serialDeviceOpen()) { serialClosed(); return; }
    closeRequested = true;
    const closed = error => {
      if (finished) return;
      closeRequested = false;
      if (!error) {
        if (serialDeviceOpen()) rejectSerialClose(new Error('The serial adapter reported closure while its device remained open.'));
        else serialClosed();
        return;
      }
      status(`Serial close failed: ${display(error.message || error)}`);
      if (!serialDeviceOpen()) { serialClosed(); return; }
      // SerialPortStream.destroy() does not close its native binding. Retry
      // the binding directly once, and reject if it still cannot be closed.
      const binding = stream.port;
      if (!binding || typeof binding.close !== 'function') { rejectSerialClose(error); return; }
      closeRequested = true;
      Promise.resolve().then(() => binding.close()).then(() => {
        closeRequested = false;
        if (serialDeviceOpen()) { rejectSerialClose(new Error('The serial binding remained open after close().')); return; }
        serialClosed();
        try { stream.destroy?.(); } catch { /* The OS binding is already closed. */ }
      }, rejectSerialClose);
    };
    try { stream.close(closed); } catch (error) { closed(error); }
  }
  function beginSerialClose(event = { exitCode: 0, signal: 'closed' }) {
    if (finished) return Promise.resolve();
    if (closePromise) return closePromise;
    requestedExit ||= event;
    closing = true; closeFailure = false; open = false;
    clearTimeout(timer); clearTimeout(breakTimer); timer = breakTimer = null;
    pending = []; pendingBytes = 0;
    closePromise = new Promise((resolve, reject) => { closeResolve = resolve; closeReject = reject; });
    const result = closePromise;
    attemptSerialClose();
    return result;
  }
  function fail(error) {
    if (finished) return;
    if (serial && closing && error?.canceled) return;
    status(`${title} error: ${display(error?.message || error)}`);
    if (serial) {
      if (!closing && !closeFailure) beginSerialClose({ exitCode: 1, signal: null }).catch(() => {});
      return;
    }
    end(1, null);
    try { closeTcp(); } catch { detach(); }
  }
  function flush() {
    if (!open || finished || blocked || !stream) return;
    while (pending.length && !blocked && !finished) {
      const bytes = pending.shift(); pendingBytes -= bytes.length;
      let completed = false;
      const written = error => {
        if (completed) return;
        completed = true; inFlightWrites--;
        if (error) fail(error);
        cleanErrorGuard();
      };
      try {
        inFlightWrites++;
        blocked = stream.write(bytes, written) === false;
      } catch (error) { written(error); }
    }
  }
  function send(bytes, strict = false) {
    if (finished) return;
    const buffered = Number.isFinite(stream?.writableLength) ? stream.writableLength : 0;
    if (pendingBytes + buffered + bytes.length > MAX_QUEUED_BYTES) { const error = new Error('Transport output queue exceeds 1 MiB.'); if (strict) throw error; fail(error); return; }
    pending.push(bytes); pendingBytes += bytes.length; flush();
  }
  const telnet = session.protocol === 'telnet' ? createTelnet({ send, receive: receiveBytes, terminalType: type }) : null;

  queueMicrotask(() => {
    if (finished) return;
    try {
      status(`${title} opening ${display(target)}...`);
      stream = serial ? new Port(settings) : network.createConnection({ host: session.host, port: session.port });
      listen('error', fail);
      listen('data', bytes => {
        if (finished) return;
        try { if (telnet) telnet.feed(Buffer.from(bytes)); else receiveBytes(Buffer.from(bytes)); } catch (error) { fail(error); }
      });
      listen('drain', () => { blocked = false; flush(); });
      listen('close', error => {
        if (serial) {
          if (serialDeviceOpen()) return;
          if (!closing && !finished) status(error instanceof Error ? `${title} disconnected: ${display(error.message)}` : `${title} connection closed.`);
          serialClosed({ exitCode: error instanceof Error ? 1 : 0, signal: null });
          return;
        }
        if (!finished) {
          if (error instanceof Error) status(`${title} disconnected: ${display(error.message)}`);
          else status(`${title} connection closed.`);
          end(error instanceof Error ? 1 : 0, null);
        }
        detach();
      });
      listen(serial ? 'open' : 'connect', () => {
        serialOpening = false;
        if (serial && closing) { attemptSerialClose(); return; }
        if (finished) { try { closeTcp(); } catch { detach(); } return; }
        clearTimeout(timer); timer = null;
        status(`${title} connection established to ${display(target)}${serial ? ` at ${settings.baudRate} baud` : ''}.`);
        // Negotiation state changes precede writing the corresponding commands.
        telnet?.start(); open = true; flush();
      });
      timer = setTimeout(() => fail(new Error(`Connection timed out after ${timeoutMs} ms.`)), timeoutMs);
      if (serial) {
        serialOpening = true;
        try {
          stream.open(error => {
            serialOpening = false;
            if (error) {
              if (!closing) fail(error);
              else status(`Serial open failed while closing: ${display(error.message || error)}`);
              attemptSerialClose();
            }
          });
        } catch (error) { serialOpening = false; throw error; }
      }
      else stream.setNoDelay?.(true);
    } catch (error) { fail(error); }
  });

  return {
    write(text) {
      if (finished) throw new Error('Transport is no longer open.');
      if (closing) throw new Error('Transport is closing.');
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('Terminal input must be a string of at most 256 KiB.');
      if (!text) return;
      send(telnet ? telnet.encode(text) : Buffer.from(text, 'utf8'));
      if (telnet?.localEcho() && !finished) output(text.replace(/\r\n|\r|\n/gu, '\r\n'));
    },
    ...(!telnet && (!serial || (settings.dataBits === 8 && !settings.xon && !settings.xoff)) ? { writeBytes(bytes) {
      if (finished) throw new Error('Transport is no longer open.');
      if (closing) throw new Error('Transport is closing.');
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INPUT_BYTES) throw new Error('Binary input must contain at most 256 KiB.');
      // Refuse nontransparent serial settings instead of silently truncating
      // high bytes or treating XON/XOFF bytes as flow-control instructions.
      if (serial && (settings.dataBits !== 8 || settings.xon || settings.xoff)) throw new Error('Binary sending requires 8 data bits and no software flow control.');
      send(Buffer.from(bytes), true);
    } } : {}),
    resize(cols, rows) {
      if (!Number.isInteger(cols) || cols < 1 || cols > 65535 || !Number.isInteger(rows) || rows < 1 || rows > 65535) throw new Error('Transport dimensions must be from 1 to 65535.');
      if (!finished) telnet?.resize(cols, rows);
    },
    kill() {
      if (serial) return beginSerialClose();
      if (finished) { closeTcp(); return; }
      closeTcp(); end(0, 'closed');
    },
    sendBreak() {
      if (!open || finished) throw new Error('Transport is not connected.');
      if (telnet) { telnet.sendBreak(); return; }
      if (!serial || typeof stream.set !== 'function') throw new Error('Break is supported for Telnet and serial connections only.');
      stream.set({ brk: true }, error => {
        if (error) { fail(error); return; }
        if (finished) return;
        clearTimeout(breakTimer);
        breakTimer = setTimeout(() => {
          breakTimer = null;
          if (!finished) stream.set({ brk: false }, resetError => { if (resetError) fail(resetError); });
        }, 250);
      });
    },
    onRawData(callback) {
      if (typeof callback !== 'function') throw new Error('Raw data callback is required.');
      rawListeners.add(callback);
      return { dispose() { rawListeners.delete(callback); } };
    },
    onData(callback) {
      if (typeof callback !== 'function') throw new Error('Data callback is required.');
      dataListeners.add(callback);
      const initial = earlyOutput; earlyOutput = []; earlyBytes = 0;
      for (const text of initial) callback(text);
      return { dispose() { dataListeners.delete(callback); } };
    },
    onExit(callback) {
      if (typeof callback !== 'function') throw new Error('Exit callback is required.');
      let disposed = false;
      if (exitEvent) queueMicrotask(() => { if (!disposed) callback(exitEvent); });
      else exitListeners.add(callback);
      return { dispose() { disposed = true; exitListeners.delete(callback); } };
    },
  };
}

async function listSerialPorts({ SerialPort } = {}) {
  const Port = serialClass(SerialPort);
  if (typeof Port.list !== 'function') throw new Error('Serial port enumeration is unavailable.');
  const ports = await Port.list();
  if (!Array.isArray(ports) || ports.length > 256) throw new Error('Serial port enumeration returned an invalid result.');
  return ports.filter(port => typeof port?.path === 'string' && port.path.length > 0 && port.path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(port.path)).map(port => {
    const result = { path: port.path };
    for (const key of ['manufacturer', 'serialNumber', 'pnpId', 'locationId', 'vendorId', 'productId']) if (typeof port[key] === 'string') result[key] = display(port[key]);
    return result;
  });
}

module.exports = { createTransport, listSerialPorts };
