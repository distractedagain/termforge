'use strict';

const path = require('node:path').posix;
const { randomUUID } = require('node:crypto');

// SFTP v3 has no conditional path mutation or stable inode identity. These
// checks detect visible changes before commit; they cannot make path-based
// operations atomic against another process on the remote host.
function createRemoteFiles({ getSession, isTransferring, call, stat, summary, confirm = async () => false,
  timeout = 30000, planLifetimeMs = 60000 }) {
  const plans = new Map(); const reserved = new Map();
  const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 255
    && value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/.test(value);
  function filename(value, allowRoot = false) {
    if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/')
      || /[\\\x00-\x1f\x7f]/.test(value) || (value !== '/' && value.split('/').slice(1).some(part => !validName(part)))
      || (!allowRoot && value === '/')) throw new Error('Select an absolute remote path without root, dot, or symbolic-link targets.');
    return value;
  }
  function snapshot(attrs) {
    if (!attrs) return null;
    if (![attrs.mode, attrs.uid, attrs.gid, attrs.size, attrs.mtime].every(Number.isSafeInteger)) throw new Error('The SFTP server did not provide complete file metadata.');
    return { ...summary(attrs), mode: attrs.mode, uid: attrs.uid, gid: attrs.gid };
  }
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  function check(plan) {
    if (plan.controller.signal.aborted || getSession(plan.review.id) !== plan.session) throw new Error('The remote file operation was cancelled or its connection closed.');
    if (Date.now() >= plan.expires) throw new Error('The remote file operation expired. Review it again.');
  }
  function release(plan) {
    clearTimeout(plan.timer); plans.delete(plan.review.planId);
    if (reserved.get(plan.review.id) === plan) reserved.delete(plan.review.id);
  }
  function available() {
    for (const current of reserved.values()) {
      if (!current.applying && Date.now() >= current.expires) { current.controller.abort(); release(current); }
    }
    // The transfer queue is global. Reserve across connections too: separate
    // SSH sessions can address the same remote directory through aliases.
    if (reserved.size) throw new Error('Finish or cancel the pending remote file operation before starting a transfer or another file operation.');
  }
  async function inspectParent(plan) {
    const { sftp } = plan.session; const signal = plan.controller.signal;
    const parent = plan.parent; const chain = ['/'];
    for (const part of parent.split('/').filter(Boolean)) chain.push(path.join(chain.at(-1), part));
    const snapshots = [];
    for (const item of chain) {
      const attrs = await stat(sftp, item, signal); const info = snapshot(attrs);
      if (info?.type !== 'directory') throw new Error('A remote parent is missing, is not a directory, or is a symbolic link.');
      snapshots.push({ path: item, ...info });
    }
    const canonical = await call(sftp, 'realpath', [parent], signal);
    if (canonical !== parent) throw new Error('The remote parent path changed or contains a symbolic link.');
    check(plan); return snapshots;
  }
  async function inspect(plan) {
    const parents = await inspectParent(plan); const { sftp } = plan.session; const signal = plan.controller.signal;
    const target = snapshot(await stat(sftp, plan.review.path, signal));
    if (plan.review.operation === 'mkdir') {
      if (target) throw new Error('The remote destination already exists.');
    } else if (!target || !['file', 'directory'].includes(target.type)) {
      throw new Error('Only existing regular files and directories can be changed; symbolic links are not followed.');
    }
    if (plan.review.operation === 'chmod' && (target.mode & 0o7000)) throw new Error('This item has special permission bits (setuid, setgid, or sticky). Change them with a dedicated administration tool; TermForge will not silently clear them.');
    if (plan.review.destination && await stat(sftp, plan.review.destination, signal)) throw new Error('The remote destination already exists. Rename never overwrites a target.');
    if (plan.review.operation === 'delete' && target.type === 'directory') {
      const entries = await call(sftp, 'readdir', [plan.review.path], signal);
      if (!Array.isArray(entries) || entries.some(entry => !['.', '..'].includes(entry.filename))) throw new Error('Only empty remote directories can be deleted.');
    }
    check(plan); return { parents, target };
  }
  async function prepare(input = {}) {
    const session = getSession(input.id); available(input.id);
    if (isTransferring(input.id)) throw new Error('Wait for queued or running transfers before changing remote files.');
    if (!['mkdir', 'rename', 'delete', 'chmod'].includes(input.operation)) throw new Error('Choose a supported remote file operation.');
    const mkdir = input.operation === 'mkdir';
    const selected = filename(input.path, mkdir);
    if ((mkdir || input.operation === 'rename') && !validName(input.name)) throw new Error('Enter a single filename without slash, dot, or control characters.');
    if (input.operation === 'chmod' && (typeof input.permissions !== 'string' || !/^[0-7]{3}$/.test(input.permissions))) throw new Error('Permissions must be exactly three octal digits from 000 to 777; special bits are not supported.');
    const parent = mkdir ? selected : path.dirname(selected);
    const target = mkdir ? path.join(parent, input.name) : selected;
    const destination = input.operation === 'rename' ? path.join(parent, input.name) : undefined;
    if (destination === target) throw new Error('Choose a different remote filename.');
    const review = { planId: randomUUID(), id: input.id, operation: input.operation, path: target,
      host: session.host, port: session.port, ...(destination ? { destination } : {}),
      ...(input.operation === 'chmod' ? { permissions: input.permissions } : {}), type: 'directory' };
    const plan = { review, session, parent, controller: new AbortController(), expires: Date.now() + planLifetimeMs, applying: false };
    // Reserve synchronously before the first await, so start() cannot enqueue
    // a competing transfer while the path is being inspected.
    reserved.set(input.id, plan);
    plan.timer = setTimeout(() => { if (!plan.applying) { plan.controller.abort(); release(plan); } }, planLifetimeMs);
    plan.timer.unref?.();
    try {
      plan.expected = await inspect(plan);
      review.type = mkdir ? 'directory' : plan.expected.target.type;
      if (input.operation === 'chmod') review.currentPermissions = plan.expected.target.permissions;
      plans.set(review.planId, plan); return { ...review };
    } catch (error) { release(plan); throw error; }
  }
  async function apply({ planId } = {}) {
    const plan = plans.get(planId);
    if (!plan || plan.applying) throw new Error('This remote file operation is missing, expired, or has already been used.');
    // Consume before invoking any asynchronous approval code. A second apply
    // cannot replay the mutation, even after denial or an uncertain result.
    plan.applying = true; plans.delete(planId); clearTimeout(plan.timer);
    let finish; plan.done = new Promise(resolve => { finish = resolve; });
    try {
      check(plan);
      const approval = new Promise((resolve, reject) => {
        const onAbort = () => { cleanup(); reject(new Error('The remote file operation was cancelled.')); };
        const timer = setTimeout(() => {
          cleanup(); reject(new Error('The remote file operation expired. Review it again.'));
          plan.controller.abort(); // Dismiss the native prompt as well as releasing its reservation.
        }, Math.max(1, plan.expires - Date.now()));
        const cleanup = () => { clearTimeout(timer); plan.controller.signal.removeEventListener('abort', onAbort); };
        plan.controller.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve().then(() => { check(plan); return confirm({ ...plan.review }, { signal: plan.controller.signal }); }).then(value => { cleanup(); resolve(value === true); }, error => { cleanup(); reject(error); });
      });
      if (!await approval) return { ...plan.review, applied: false, cancelled: true };
      check(plan);
      const current = await inspect(plan);
      if (!equal(current, plan.expected)) throw new Error('The remote file or parent metadata changed after review. Review the operation again.');
      check(plan);
      let method; let args;
      switch (plan.review.operation) {
        case 'mkdir': method = 'mkdir'; args = [plan.review.path, { mode: 0o700 }]; break;
        // Standard SFTP v3 rename requires a missing destination. Never use
        // posix-rename, which can silently overwrite an existing path.
        case 'rename': method = 'rename'; args = [plan.review.path, plan.review.destination]; break;
        case 'delete': method = plan.review.type === 'directory' ? 'rmdir' : 'unlink'; args = [plan.review.path]; break;
        case 'chmod': method = 'chmod'; args = [plan.review.path, parseInt(plan.review.permissions, 8)]; break;
      }
      plan.committing = true;
      try { await call(plan.session.sftp, method, args, undefined, timeout); }
      catch (error) {
        if (Number.isInteger(error.code)) throw error;
        // A transport error or lost reply cannot prove that the server did not
        // mutate the path. Close this connection and require a fresh listing.
        plan.session.closed = true; plan.session.client.end();
        throw Object.assign(new Error(`The remote operation outcome is unknown. Reconnect and inspect ${plan.review.path}${plan.review.destination ? ` and ${plan.review.destination}` : ''} before trying again. ${String(error.message || error).slice(0, 400)}`), { indeterminate: true });
      }
      return { ...plan.review, applied: true };
    } finally { release(plan); finish(); }
  }
  function discard({ planId } = {}) {
    const plan = plans.get(planId); if (!plan || plan.applying) return false;
    plan.controller.abort(); release(plan); return true;
  }
  function disconnected(id) {
    const plan = reserved.get(id); if (!plan) return;
    plan.controller.abort(); if (!plan.applying) release(plan);
  }
  async function close(id) {
    const plan = reserved.get(id); if (!plan) return;
    disconnected(id); if (plan.done) await plan.done;
  }
  async function closeAll() { await Promise.all([...reserved.keys()].map(close)); }
  return { prepare, apply, discard, available, disconnected, close, closeAll, get activeIds() { return [...reserved.keys()]; } };
}

module.exports = { createRemoteFiles };
