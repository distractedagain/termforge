'use strict';

const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const BLOCK_BYTES = 512;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TRANSFERS = 8;
const RRQ = 1, WRQ = 2, DATA = 3, ACK = 4, ERROR = 5;

class TftpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function ip(value, label) {
  if (typeof value !== 'string' || !net.isIP(value)) throw new Error(`${label} must be an explicit IPv4 or IPv6 address.`);
  return net.isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}
function packet(opcode, block, bytes = Buffer.alloc(0)) {
  const result = Buffer.alloc(4 + bytes.length);
  result.writeUInt16BE(opcode, 0); result.writeUInt16BE(block, 2); bytes.copy(result, 4);
  return result;
}
function errorPacket(code, message) {
  const text = String(message).replace(/[^\x20-\x7e]/gu, ' ').slice(0, 160);
  return packet(ERROR, code, Buffer.from(`${text}\0`, 'ascii'));
}
function filename(value) {
  if (!value || value.length > 240 || /[^\x20-\x7e]|[\\:]/u.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new TftpError(2, 'A safe relative filename is required.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^\.termforge-tftp-/iu.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new TftpError(2, 'Filename is not permitted.');
  return parts;
}
function request(bytes) {
  if (bytes.length < 2 || bytes.length > 512) throw new TftpError(4, 'Invalid TFTP request.');
  const opcode = bytes.readUInt16BE(0);
  if (![RRQ, WRQ].includes(opcode)) throw new TftpError([DATA, ACK, ERROR].includes(opcode) ? 5 : 4, [DATA, ACK, ERROR].includes(opcode) ? 'Unknown transfer ID.' : 'Illegal TFTP operation.');
  if (bytes.length < 6) throw new TftpError(4, 'Invalid TFTP request.');
  const fields = []; let offset = 2;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end === offset || [...bytes.subarray(offset, end)].some(byte => byte < 32 || byte > 126)) throw new TftpError(4, 'Invalid TFTP request fields.');
    fields.push(bytes.subarray(offset, end).toString('ascii')); offset = end + 1;
  }
  if (fields.length < 2 || fields.length % 2 !== 0) throw new TftpError(4, 'Invalid TFTP request fields.');
  const parts = filename(fields[0]);
  if (fields[1].toLowerCase() !== 'octet') throw new TftpError(4, 'Only octet transfer mode is supported.');
  const options = new Set();
  for (let i = 2; i < fields.length; i += 2) {
    const option = fields[i].toLowerCase();
    if (options.has(option)) throw new TftpError(4, 'A TFTP option was requested more than once.');
    options.add(option);
  }
  // RFC 2347 permits a server to ignore unsupported options: DATA 1 / ACK 0
  // therefore selects the classic RFC 1350 512-byte exchange without OACK.
  return { opcode, filename: fields[0], parts };
}
function protocolError(error, direction) {
  if (error instanceof TftpError) return error;
  if (error?.code === 'ENOENT') return new TftpError(direction === 'read' ? 1 : 2, direction === 'read' ? 'File not found.' : 'Destination folder does not exist.');
  if (error?.code === 'EEXIST') return new TftpError(6, 'File already exists.');
  if (['EACCES', 'EPERM', 'ELOOP'].includes(error?.code)) return new TftpError(2, 'Access denied.');
  if (['ENOSPC', 'EDQUOT'].includes(error?.code)) return new TftpError(3, 'Disk space or allocation exceeded.');
  return new TftpError(0, 'File or transfer operation failed.');
}
function closeSocket(socket) {
  if (!socket) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const closed = () => resolve();
    socket.once('close', closed);
    try { socket.close(); } catch (error) {
      socket.removeListener('close', closed);
      if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve(); else reject(error);
    }
  });
}
function bind(socket, port, address) {
  return new Promise((resolve, reject) => {
    const failed = error => { socket.removeListener('listening', listening); reject(error); };
    const listening = () => { socket.removeListener('error', failed); resolve(socket.address()); };
    socket.once('error', failed); socket.once('listening', listening);
    try { socket.bind(port, address); } catch (error) { socket.removeListener('error', failed); socket.removeListener('listening', listening); reject(error); }
  });
}

/** Original RFC 1350 server. It never starts or binds without explicit start(). */
function createTftpServer({ root, clientAddress, bindAddress = '127.0.0.1', port = 6969, allowWrite = false, onStatus = () => {}, onTransfer = () => {}, timeoutMs = 1000, retries = 5 } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(root)) throw new Error('TFTP root must be an absolute folder path.');
  const client = ip(clientAddress, 'Client address'), address = ip(bindAddress, 'Bind address');
  if (client === '0.0.0.0' || client === '::' || client === '255.255.255.255' || (net.isIP(client) === 4 && Number(client.split('.')[0]) >= 224) || (net.isIP(client) === 6 && client.startsWith('ff'))) throw new Error('Client address must identify one unicast client.');
  if (net.isIP(client) !== net.isIP(address)) throw new Error('Client and bind addresses must use the same IP family.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('TFTP port must be from 0 to 65535.');
  if (typeof allowWrite !== 'boolean' || typeof onStatus !== 'function' || typeof onTransfer !== 'function') throw new Error('TFTP write permission and callbacks are invalid.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000 || !Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error('TFTP timeout or retry count is invalid.');

  let state = 'stopped', server = null, boundAddress = null, rootReal = null, rootIdentity = null;
  let startPromise = null, stopPromise = null, lastError = '', completedTransfers = 0, failedTransfers = 0;
  const transfers = new Map();
  const type = net.isIP(address) === 6 ? 'udp6' : 'udp4';
  const safeCallback = (callback, value) => { try { callback(value); } catch { /* UI callbacks do not own UDP/file cleanup. */ } };
  function details(entry, transferState, message = '') {
    return { id: entry.id, filename: entry.request.filename, direction: entry.direction, clientAddress: entry.remote.address, clientPort: entry.remote.port, bytes: entry.bytes, state: transferState, message };
  }
  function status() {
    return { state, running: state === 'running', root: rootReal || root, clientAddress: client, bindAddress: address, port: boundAddress?.port ?? port, allowWrite, activeTransfers: transfers.size, transfers: [...transfers.values()].map(entry => details(entry, entry.done ? 'completed' : 'active')), completedTransfers, failedTransfers, lastError };
  }
  const notify = () => safeCallback(onStatus, status());
  function report(entry, transferState, message = '') {
    if (transferState === 'progress' && entry.bytes - entry.reportedBytes < 64 * 1024) return false;
    entry.reportedBytes = entry.bytes;
    safeCallback(onTransfer, details(entry, transferState, message));
    return true;
  }
  function allowed(remote) {
    return remote && Number.isInteger(remote.port) && remote.port >= 1 && remote.port <= 65535 && net.isIP(remote.address) && ip(remote.address, 'Remote address') === client;
  }
  function send(socket, bytes, remote, entry) {
    if (!socket) return Promise.resolve();
    return new Promise(resolve => {
      try {
        socket.send(bytes, remote.port, remote.address, error => {
          if (error && entry && !entry.closed) abort(entry, new TftpError(0, 'UDP packet could not be sent.'));
          resolve();
        });
      } catch (error) { if (entry && !entry.closed) abort(entry, error); resolve(); }
    });
  }

  async function safePath(parts, { missingFinal = false } = {}) {
    const rootStat = await fs.promises.lstat(rootReal);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== rootIdentity.dev || rootStat.ino !== rootIdentity.ino) throw new TftpError(2, 'The shared folder changed.');
    let current = rootReal, parentStat = rootStat;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.promises.lstat(current); } catch (error) {
        if (missingFinal && i === parts.length - 1 && error.code === 'ENOENT') return { target: current, parent: path.dirname(current), parentStat, stat: null };
        throw error;
      }
      if (stat.isSymbolicLink()) throw new TftpError(2, 'Symbolic links are not served.');
      if (i < parts.length - 1 && !stat.isDirectory()) throw new TftpError(2, 'Destination folder is invalid.');
      const real = await fs.promises.realpath(current);
      const relative = path.relative(rootReal, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new TftpError(2, 'Path escapes the shared folder.');
      if (i === parts.length - 1) return { target: current, parent: path.dirname(current), parentStat, stat };
      parentStat = stat;
    }
    throw new TftpError(2, 'Filename is invalid.');
  }
  async function unchangedParent(entry) {
    const result = await safePath(entry.request.parts, { missingFinal: true });
    if (result.parent !== entry.parent || result.parentStat.dev !== entry.parentIdentity.dev || result.parentStat.ino !== entry.parentIdentity.ino) throw new TftpError(2, 'Destination folder changed.');
    if (result.stat) throw new TftpError(6, 'File already exists.');
    return result;
  }

  function finish(entry, transferState, message = '') {
    if (entry.closed) return entry.closePromise;
    entry.closed = true; clearTimeout(entry.timer); entry.timer = null;
    if (!entry.done) {
      if (transferState === 'failed') { failedTransfers++; lastError = message; }
      report(entry, transferState, message);
    }
    entry.closePromise = (async () => {
      // This Promise is never awaited by entry.operation itself: its operation
      // may still be assigning a file or socket, and must settle before cleanup.
      await entry.operation.catch(() => {});
      // dgram.send can defer its actual send until the next tick even for a
      // literal IP. Closing first would silently discard the courtesy ERROR.
      if (entry.errorSend) await entry.errorSend;
      const results = await Promise.allSettled([
        closeSocket(entry.socket),
        (async () => {
          if (entry.file) { const file = entry.file; entry.file = null; await file.close(); }
          if (entry.partial) {
            try { await fs.promises.unlink(entry.partial); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            entry.partial = null;
          }
        })(),
      ]);
      transfers.delete(entry.key); notify();
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    })();
    entry.closePromise.catch(error => { lastError = `TFTP cleanup failed: ${error.message}`; notify(); });
    return entry.closePromise;
  }
  function abort(entry, error, reply = true) {
    if (entry.closed) return;
    const failure = protocolError(error, entry.direction);
    if (reply && entry.socket) entry.errorSend = send(entry.socket, errorPacket(failure.code, failure.message), entry.remote);
    finish(entry, 'failed', failure.message);
  }
  function arm(entry) {
    clearTimeout(entry.timer);
    if (entry.closed) return;
    if (entry.done) {
      // RFC 1350 recommends dallying so a lost final ACK can be repeated.
      entry.timer = setTimeout(() => finish(entry, 'completed'), timeoutMs * (retries + 1));
      return;
    }
    entry.timer = setTimeout(() => {
      if (entry.closed || entry.done) return;
      if (entry.attempts >= retries) { abort(entry, new TftpError(0, 'Transfer timed out.')); return; }
      entry.attempts++; send(entry.socket, entry.lastPacket, entry.remote, entry); arm(entry);
    }, timeoutMs);
  }
  function transmit(entry, bytes) {
    entry.lastPacket = bytes; entry.attempts = 0;
    send(entry.socket, bytes, entry.remote, entry); arm(entry);
  }
  function run(entry, operation) {
    if (entry.busy || entry.closed) return;
    entry.busy = true;
    entry.operation = Promise.resolve().then(operation).catch(error => abort(entry, error)).finally(() => { entry.busy = false; });
  }
  async function nextData(entry) {
    const length = Math.min(BLOCK_BYTES, entry.size - entry.bytes);
    const data = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await entry.file.read(data, read, length - read, entry.bytes + read);
      if (!result.bytesRead) throw new TftpError(0, 'The source file changed during transfer.');
      read += result.bytesRead;
    }
    if (entry.closed) return;
    entry.payloadBytes = length;
    transmit(entry, packet(DATA, entry.block, data));
  }
  async function commit(entry) {
    await unchangedParent(entry);
    await entry.file.sync(); await entry.file.close(); entry.file = null;
    if (entry.closed) return;
    await unchangedParent(entry);
    // Hard-link creation publishes the completed inode atomically and fails if
    // a destination appeared concurrently. rename() could overwrite that file.
    await fs.promises.link(entry.partial, entry.target);
    await fs.promises.unlink(entry.partial); entry.partial = null;
  }
  function transferMessage(entry, bytes, remote) {
    if (entry.closed || !allowed(remote)) return;
    if (remote.port !== entry.remote.port || ip(remote.address, 'Remote address') !== entry.remote.address) {
      send(entry.socket, errorPacket(5, 'Unknown transfer ID.'), remote); return;
    }
    if (entry.busy) return; // Lockstep retransmission recovers dropped duplicates.
    if (bytes.length < 4 || bytes.length > 516) { abort(entry, new TftpError(4, 'Invalid TFTP packet.')); return; }
    const opcode = bytes.readUInt16BE(0), block = bytes.readUInt16BE(2);
    if (opcode === ERROR) {
      if (bytes.length < 5 || bytes[bytes.length - 1] !== 0) abort(entry, new TftpError(4, 'Invalid TFTP error packet.'));
      else abort(entry, new TftpError(0, 'Client ended the transfer.'), false);
      return;
    }
    if (entry.direction === 'read') {
      if (opcode !== ACK || bytes.length !== 4) { abort(entry, new TftpError(4, 'Expected an acknowledgment.')); return; }
      if (block === ((entry.block - 1) & 0xffff)) return; // No Sorcerer's Apprentice retransmit loop.
      if (block !== entry.block) { abort(entry, new TftpError(4, 'Unexpected acknowledgment block.')); return; }
      clearTimeout(entry.timer); entry.bytes += entry.payloadBytes;
      if (report(entry, 'progress')) notify();
      if (entry.payloadBytes < BLOCK_BYTES) {
        entry.done = true; completedTransfers++; report(entry, 'completed'); finish(entry, 'completed');
      } else {
        entry.block = (entry.block + 1) & 0xffff;
        run(entry, () => nextData(entry));
      }
      return;
    }
    if (opcode !== DATA) { abort(entry, new TftpError(4, 'Expected a data packet.')); return; }
    if (block === entry.block) { send(entry.socket, entry.lastPacket, entry.remote, entry); return; }
    if (entry.done || block !== ((entry.block + 1) & 0xffff)) { abort(entry, new TftpError(4, 'Unexpected data block.')); return; }
    const payload = Buffer.from(bytes.subarray(4));
    if (entry.bytes + payload.length > MAX_FILE_BYTES) { abort(entry, new TftpError(3, 'File exceeds the 64 MiB limit.')); return; }
    clearTimeout(entry.timer);
    run(entry, async () => {
      let written = 0;
      while (written < payload.length) {
        const result = await entry.file.write(payload, written, payload.length - written, entry.bytes + written);
        if (!result.bytesWritten) throw new TftpError(3, 'File could not be written.');
        written += result.bytesWritten;
      }
      if (entry.closed) return;
      entry.bytes += payload.length; entry.block = block;
      const progressed = report(entry, 'progress');
      if (payload.length < BLOCK_BYTES) {
        await commit(entry);
        if (entry.closed) return;
        entry.done = true; completedTransfers++; report(entry, 'completed');
      }
      transmit(entry, packet(ACK, block));
      if (entry.done || progressed) notify();
    });
  }

  function incoming(bytes, remote) {
    if (state !== 'running' || !allowed(remote)) return;
    let parsed;
    try { parsed = request(bytes); } catch (error) { const failure = protocolError(error); send(server, errorPacket(failure.code, failure.message), remote); return; }
    if (parsed.opcode === WRQ && !allowWrite) { send(server, errorPacket(2, 'Uploads are disabled.'), remote); return; }
    const normalized = ip(remote.address, 'Remote address'), key = `${normalized}:${remote.port}`;
    const existing = transfers.get(key);
    if (existing) {
      if (existing.request.opcode === parsed.opcode && existing.request.filename === parsed.filename && !existing.closed) {
        if (existing.lastPacket) send(existing.socket, existing.lastPacket, existing.remote, existing);
      } else send(server, errorPacket(4, 'A transfer is already active for this client port.'), remote);
      return;
    }
    if (transfers.size >= MAX_TRANSFERS) { send(server, errorPacket(0, 'The server already has eight active transfers.'), remote); return; }
    const entry = { id: randomUUID(), key, request: parsed, direction: parsed.opcode === RRQ ? 'read' : 'write', remote: { address: normalized, port: remote.port }, socket: null, file: null, partial: null, target: null, bytes: 0, block: parsed.opcode === RRQ ? 1 : 0, payloadBytes: 0, size: 0, reportedBytes: 0, lastPacket: null, attempts: 0, timer: null, done: false, closed: false, busy: false, operation: Promise.resolve(), closePromise: null };
    transfers.set(key, entry); notify();
    run(entry, async () => {
      try {
        const selected = await safePath(parsed.parts, { missingFinal: entry.direction === 'write' });
        if (entry.closed) return;
        entry.target = selected.target;
        if (entry.direction === 'read') {
          if (!selected.stat?.isFile()) throw new TftpError(2, 'Only regular files can be downloaded.');
          entry.file = await fs.promises.open(selected.target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const actual = await entry.file.stat(), checked = await safePath(parsed.parts);
          if (!actual.isFile() || actual.dev !== checked.stat.dev || actual.ino !== checked.stat.ino) throw new TftpError(2, 'The source file changed.');
          if (actual.size > MAX_FILE_BYTES) throw new TftpError(3, 'File exceeds the 64 MiB limit.');
          entry.size = actual.size;
        } else {
          if (selected.stat) throw new TftpError(6, 'File already exists.');
          entry.parent = selected.parent; entry.parentIdentity = selected.parentStat;
          entry.partial = path.join(entry.parent, `.termforge-tftp-${entry.id}.part`);
          entry.file = await fs.promises.open(entry.partial, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
          await unchangedParent(entry);
        }
        if (entry.closed) return;
        entry.socket = dgram.createSocket(type);
        entry.socket.on('error', error => abort(entry, error));
        entry.socket.on('message', (data, sender) => transferMessage(entry, data, sender));
        await bind(entry.socket, 0, address);
        if (entry.closed) return;
        report(entry, 'started');
        if (entry.direction === 'read') await nextData(entry); else transmit(entry, packet(ACK, 0));
      } catch (error) {
        if (!entry.closed && !entry.socket) {
          const failure = protocolError(error, entry.direction);
          send(server, errorPacket(failure.code, failure.message), entry.remote);
        }
        throw error;
      }
    });
  }

  async function start() {
    if (state === 'running') return { ...boundAddress };
    if (startPromise) return startPromise;
    if (state === 'stopping') throw new Error('TFTP server is stopping.');
    state = 'starting'; lastError = ''; notify();
    startPromise = (async () => {
      try {
        rootReal = await fs.promises.realpath(root);
        rootIdentity = await fs.promises.lstat(rootReal);
        if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new Error('TFTP root must be a real directory.');
        if (state !== 'starting') throw new Error('TFTP start was canceled.');
        server = dgram.createSocket(type);
        server.on('message', incoming);
        server.on('error', error => {
          lastError = `TFTP listener error: ${error.message}`; notify();
          if (state === 'running') stop().catch(() => {});
        });
        boundAddress = await bind(server, port, address);
        if (state !== 'starting') throw new Error('TFTP start was canceled.');
        state = 'running'; notify(); return { ...boundAddress };
      } catch (error) {
        lastError = error.message;
        await closeSocket(server); server = null; boundAddress = null;
        if (state !== 'stopping') state = 'stopped';
        notify(); throw error;
      } finally { startPromise = null; }
    })();
    return startPromise;
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    if (state === 'stopped') return;
    state = 'stopping'; notify();
    stopPromise = (async () => {
      try {
        if (startPromise) await startPromise.catch(() => {});
        const listener = server; server = null;
        const closing = [...transfers.values()].map(entry => finish(entry, 'stopped', 'Server stopped.'));
        const results = await Promise.allSettled([closeSocket(listener), ...closing]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      } finally {
        boundAddress = null; state = 'stopped'; stopPromise = null; notify();
      }
    })();
    return stopPromise;
  }
  return { start, status, stop };
}

module.exports = { createTftpServer };
