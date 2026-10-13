'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Server, utils } = require('ssh2');
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const { createSecureTransfers } = require('../app/secure-transfers.cjs');

const key = utils.generateKeyPairSync('ed25519').private;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scpAvailable = !spawnSync('scp', ['-V'], { windowsHide: true, timeout: 5000 }).error;

async function fixture(t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'termforge-transfer-'));
  const remote = path.join(directory, 'remote'); const local = path.join(directory, 'local');
  await fsp.mkdir(remote); await fsp.mkdir(local);
  const clients = new Set(); const commands = []; const events = []; const children = new Set();
  function remoteFile(filename) {
    const normalized = path.posix.resolve('/', filename);
    return path.join(remote, ...normalized.split('/').filter(Boolean));
  }
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'password' && context.username === 'test' && context.password === 'test-only' ? context.accept() : context.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', acceptSftp => {
        const stream = acceptSftp(); const handles = new Map(); let next = 1;
        const attrs = stat => ({ mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
        const fail = (id, error) => { try { stream.status(id, error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, error.message); } catch {} };
        const action = (name, fn) => stream.on(name, (id, ...args) => { Promise.resolve().then(() => fn(id, ...args)).catch(error => fail(id, error)); });
        const remember = value => { const number = next++; handles.set(number, value); const handle = Buffer.alloc(4); handle.writeUInt32BE(number); return handle; };
        const lookup = handle => { const value = handle.length === 4 && handles.get(handle.readUInt32BE()); if (!value) throw new Error('Invalid handle'); return value; };
        action('REALPATH', async (id, name) => stream.name(id, [{ filename: path.posix.resolve('/', name), longname: '', attrs: {} }]));
        action('LSTAT', async (id, name) => stream.attrs(id, attrs(await fsp.lstat(remoteFile(name)))));
        action('STAT', async (id, name) => stream.attrs(id, attrs(await fsp.stat(remoteFile(name)))));
        action('FSTAT', async (id, handle) => stream.attrs(id, attrs(await lookup(handle).file.stat())));
        action('OPENDIR', async (id, name) => stream.handle(id, remember({ directory: remoteFile(name), sent: false })));
        action('READDIR', async (id, handle) => {
          const item = lookup(handle);
          if (item.sent) return stream.status(id, STATUS_CODE.EOF);
          item.sent = true;
          const names = await fsp.readdir(item.directory);
          const entries = await Promise.all(names.map(async name => ({ filename: name, longname: '', attrs: attrs(await fsp.lstat(path.join(item.directory, name))) })));
          entries.length ? stream.name(id, entries) : stream.status(id, STATUS_CODE.EOF);
        });
        action('OPEN', async (id, name, flags, attr) => {
          let openFlags = flags & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
          if (flags & OPEN_MODE.CREAT) openFlags |= fs.constants.O_CREAT;
          if (flags & OPEN_MODE.EXCL) openFlags |= fs.constants.O_EXCL;
          if (flags & OPEN_MODE.TRUNC) openFlags |= fs.constants.O_TRUNC;
          const file = await fsp.open(remoteFile(name), openFlags, attr.mode || 0o600);
          stream.handle(id, remember({ file }));
        });
        action('READ', async (id, handle, offset, length) => {
          if (options.onRead) await options.onRead({ local, remote, offset });
          if (options.delayRead) await delay(options.delayRead);
          const buffer = Buffer.alloc(Math.min(length, 65536));
          const { bytesRead } = await lookup(handle).file.read(buffer, 0, buffer.length, offset);
          bytesRead ? stream.data(id, buffer.subarray(0, bytesRead)) : stream.status(id, STATUS_CODE.EOF);
        });
        action('WRITE', async (id, handle, offset, data) => {
          if (options.onWrite) await options.onWrite({ remote, local, offset });
          await lookup(handle).file.write(data, 0, data.length, offset); stream.status(id, STATUS_CODE.OK);
        });
        action('CLOSE', async (id, handle) => { const item = lookup(handle); handles.delete(handle.readUInt32BE()); await item.file?.close(); stream.status(id, STATUS_CODE.OK); });
        action('REMOVE', async (id, name) => { await fsp.unlink(remoteFile(name)); stream.status(id, STATUS_CODE.OK); });
        action('RENAME', async (id, from, to) => {
          const source = remoteFile(from); const target = remoteFile(to);
          if (options.onRename) await options.onRename({ remote, local, from, to });
          // SFTP v3 has no overwrite flag: linking then unlinking accurately
          // models its required no-clobber semantics for regular files.
          await fsp.link(source, target); await fsp.unlink(source);
          if (options.afterRename && await options.afterRename({ remote, local, from, to }) === false) return;
          stream.status(id, STATUS_CODE.OK);
        });
        stream.on('close', () => { for (const item of handles.values()) item.file?.close().catch(() => {}); handles.clear(); });
      });
      session.on('exec', (acceptExec, rejectExec, info) => {
        commands.push(info.command);
        const match = /^scp (-[tf]) -- '((?:[^']|'\\'')*)'$/.exec(info.command);
        if (!match) return rejectExec();
        const stream = acceptExec();
        const filename = match[2].replace(/'\\''/g, "'");
        if (options.maliciousScpName) {
          let sent = false;
          stream.on('data', () => { if (!sent) { sent = true; stream.write(`C0600 5 ${options.maliciousScpName}\n`); } });
          return;
        }
        const child = spawn('scp', [match[1], '--', remoteFile(filename)], { windowsHide: true }); children.add(child);
        child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false }); stream.pipe(child.stdin);
        child.on('error', () => { stream.exit(127); stream.end(); });
        child.on('close', code => { children.delete(child); stream.exit(code || 0); stream.end(); });
        stream.on('close', () => { if (!child.killed) child.kill(); });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const manager = createSecureTransfers({ home: local, emit: event => events.push(event), confirmOverwrite: options.confirmOverwrite, commitTimeoutMs: options.commitTimeoutMs || 30000,
    connect: () => new Promise((resolve, reject) => {
      const client = new Client(); client.once('error', reject); client.once('ready', () => resolve(client));
      if (options.wrapSftp) {
        const original = client.sftp.bind(client);
        client.sftp = callback => original((error, sftp) => { if (!error) options.wrapSftp(sftp); callback(error, sftp); });
      }
      // Isolated, ephemeral loopback fixture only. Production trust is owned
      // and separately tested by the verified SSH connection factory.
      client.connect({ host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test-only', hostVerifier: () => true });
    }) });
  t.after(async () => {
    await manager.closeAll(); for (const child of children) child.kill(); for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve)); await fsp.rm(directory, { recursive: true, force: true });
  });
  const connection = await manager.open({ host: '127.0.0.1', port: server.address().port });
  async function run(input) {
    const started = manager.start({ id: connection.id, protocol: 'sftp', ...input });
    return waitJob(started.transferId);
  }
  async function waitJob(id) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const job = manager.listJobs().find(item => item.transferId === id); if (['failed', 'cancelled', 'completed'].includes(job.status)) return job; await delay(15); }
    throw new Error(`Transfer did not finish: ${JSON.stringify(manager.listJobs())}`);
  }
  return { manager, connection, run, waitJob, remote, local, commands, events, disconnect: () => { for (const client of clients) client.end(); } };
}

test('real SSH/SFTP lists directories and uploads/downloads exact bytes through a serial queue', { timeout: 20000 }, async t => {
  const { manager, connection, local, remote, run, events } = await fixture(t);
  assert.equal(manager.count, 1);
  await fsp.mkdir(path.join(remote, 'folder'));
  const payload = Buffer.alloc(190000); for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const source = path.join(local, 'upload.bin'); await fsp.writeFile(source, payload);
  assert.equal((await manager.listLocal({ path: '' })).path, await fsp.realpath(local));
  assert.equal((await manager.listRemote({ id: connection.id, path: '/' })).entries[0].type, 'directory');
  const uploaded = await run({ direction: 'upload', localPath: source, remotePath: '/upload.bin' });
  assert.equal(uploaded.status, 'completed', uploaded.error); assert.equal(uploaded.bytes, payload.length);
  assert.deepEqual(await fsp.readFile(path.join(remote, 'upload.bin')), payload);
  const downloaded = await run({ direction: 'download', localPath: path.join(local, 'copy.bin'), remotePath: '/upload.bin' });
  assert.equal(downloaded.status, 'completed', downloaded.error); assert.deepEqual(await fsp.readFile(path.join(local, 'copy.bin')), payload);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(path.join(local, 'copy.bin'))).mode & 0o777, 0o600);
  assert(events.some(event => event.status === 'running' && event.bytes > 0));
  assert((await fsp.readdir(local)).every(name => !name.startsWith('.termforge-')));
  assert((await fsp.readdir(remote)).every(name => !name.startsWith('.termforge-')));
});

test('existing destinations require confirmation and confirmed SFTP replacements preserve exact bytes', { timeout: 20000 }, async t => {
  const confirmations = [];
  const { local, remote, run } = await fixture(t, { confirmOverwrite: async input => { confirmations.push(input); return input.direction === 'download'; } });
  const localFile = path.join(local, 'file'); const remoteFile = path.join(remote, 'file');
  await fsp.writeFile(localFile, 'local old'); await fsp.writeFile(remoteFile, 'remote original');
  const declined = await run({ direction: 'upload', localPath: localFile, remotePath: '/file' });
  assert.equal(declined.status, 'failed'); assert.match(declined.error, /declined/); assert.equal(await fsp.readFile(remoteFile, 'utf8'), 'remote original');
  const approved = await run({ direction: 'download', localPath: localFile, remotePath: '/file' });
  assert.equal(approved.status, 'completed', approved.error); assert.equal(await fsp.readFile(localFile, 'utf8'), 'remote original');
  assert.equal(confirmations.length, 2); assert.deepEqual((await fsp.readdir(local)).sort(), ['file']);
});

test('remote replacement uses standard no-clobber rename and removes its verified recovery file', { timeout: 20000 }, async t => {
  const { local, remote, run } = await fixture(t, { confirmOverwrite: async () => true });
  await fsp.writeFile(path.join(local, 'file'), 'replacement'); await fsp.writeFile(path.join(remote, 'file'), 'old');
  const result = await run({ direction: 'upload', localPath: path.join(local, 'file'), remotePath: '/file' });
  assert.equal(result.status, 'completed', result.error); assert.equal(await fsp.readFile(path.join(remote, 'file'), 'utf8'), 'replacement');
  assert.deepEqual(await fsp.readdir(remote), ['file']);
});

test('changes after overwrite confirmation abort without replacing the changed destination', { timeout: 20000 }, async t => {
  let changed = false;
  const { local, remote, run } = await fixture(t, { confirmOverwrite: async () => true, onWrite: async ({ remote: root }) => {
    if (!changed) { changed = true; await fsp.writeFile(path.join(root, 'file'), 'concurrent change with different size'); }
  } });
  await fsp.writeFile(path.join(local, 'file'), 'replacement'); await fsp.writeFile(path.join(remote, 'file'), 'original');
  const result = await run({ direction: 'upload', localPath: path.join(local, 'file'), remotePath: '/file' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /changed/);
  assert.equal(await fsp.readFile(path.join(remote, 'file'), 'utf8'), 'concurrent change with different size');
  assert.deepEqual(await fsp.readdir(remote), ['file']);
});

test('symlink uploads and download destinations are refused without modifying their targets', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const { local, remote, run } = await fixture(t, { confirmOverwrite: async () => true });
  await fsp.writeFile(path.join(local, 'original'), 'private local'); await fsp.symlink(path.join(local, 'original'), path.join(local, 'link'));
  await fsp.writeFile(path.join(remote, 'file'), 'remote bytes');
  let result = await run({ direction: 'upload', localPath: path.join(local, 'link'), remotePath: '/copy' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /symbolic links/);
  result = await run({ direction: 'download', localPath: path.join(local, 'link'), remotePath: '/file' });
  assert.equal(result.status, 'failed'); assert.equal(await fsp.readFile(path.join(local, 'original'), 'utf8'), 'private local');
  await fsp.symlink(path.join(remote, 'file'), path.join(remote, 'link'));
  result = await run({ direction: 'download', localPath: path.join(local, 'download'), remotePath: '/link' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /symbolic links/);
});

test('queued and active cancellation remove partial data and preserve existing files', { timeout: 20000 }, async t => {
  const { local, remote, manager, connection, waitJob } = await fixture(t, { delayRead: 200, confirmOverwrite: async () => true });
  await fsp.writeFile(path.join(remote, 'large'), Buffer.alloc(1024 * 1024, 77)); await fsp.writeFile(path.join(local, 'existing'), 'keep');
  const first = manager.start({ id: connection.id, direction: 'download', protocol: 'sftp', localPath: path.join(local, 'existing'), remotePath: '/large' });
  const second = manager.start({ id: connection.id, direction: 'download', protocol: 'sftp', localPath: path.join(local, 'never'), remotePath: '/large' });
  await manager.cancel(second.transferId); await delay(100); await manager.cancel(first.transferId);
  assert.equal((await waitJob(first.transferId)).status, 'cancelled'); assert.equal((await waitJob(second.transferId)).status, 'cancelled');
  assert.equal(await fsp.readFile(path.join(local, 'existing'), 'utf8'), 'keep'); assert.deepEqual(await fsp.readdir(local), ['existing']);
});

test('SCP streams actual system scp over loopback SSH with shell-quoted paths and exact data', { skip: !scpAvailable, timeout: 30000 }, async t => {
  const { local, remote, run, commands } = await fixture(t);
  const name = "quote' space;$(termforge-probe).bin";
  const payload = Buffer.alloc(150000, 87); await fsp.writeFile(path.join(local, 'source'), payload);
  const upload = await run({ direction: 'upload', protocol: 'scp', localPath: path.join(local, 'source'), remotePath: `/${name}` });
  assert.equal(upload.status, 'completed', upload.error); assert.deepEqual(await fsp.readFile(path.join(remote, name)), payload);
  const download = await run({ direction: 'download', protocol: 'scp', localPath: path.join(local, 'download'), remotePath: `/${name}` });
  assert.equal(download.status, 'completed', download.error); assert.deepEqual(await fsp.readFile(path.join(local, 'download')), payload);
  assert(commands.some(command => command.includes("'\\''"))); assert(commands.every(command => /^scp -[tf] -- '/.test(command)));
});

test('malicious SCP filename cannot escape the selected download destination', { timeout: 20000 }, async t => {
  const { local, remote, run } = await fixture(t, { maliciousScpName: '../outside' });
  await fsp.writeFile(path.join(remote, 'file'), '12345');
  const result = await run({ direction: 'download', protocol: 'scp', localPath: path.join(local, 'selected'), remotePath: '/file' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /invalid or unexpected filename/); assert.deepEqual(await fsp.readdir(local), []);
});

test('invalid paths and protocols are rejected before a job enters the queue', { timeout: 10000 }, async t => {
  const { manager, connection, local } = await fixture(t);
  const base = { id: connection.id, direction: 'download', protocol: 'sftp', localPath: path.join(local, 'file'), remotePath: '/file' };
  assert.throws(() => manager.start({ ...base, remotePath: '/file\nC0600 5 evil' }), /Invalid remote path/);
  assert.throws(() => manager.start({ ...base, protocol: 'ftp' }), /SFTP or SCP/);
  assert.throws(() => manager.start({ ...base, remotePath: '/' }), /individual regular file/);
  assert.deepEqual(manager.listJobs(), []);
  await manager.close(connection.id); assert.throws(() => manager.start(base), /closed/);
});

test('a new remote destination racing the final rename preserves both it and the previous destination', { timeout: 20000 }, async t => {
  let injected = false;
  const { local, remote, run } = await fixture(t, { confirmOverwrite: async () => true, onRename: async ({ remote: directory, from, to }) => {
    if (!injected && from.endsWith('.part') && to === '/file') { injected = true; await fsp.writeFile(path.join(directory, 'file'), 'other writer', { flag: 'wx' }); }
  } });
  await fsp.writeFile(path.join(local, 'file'), 'replacement'); await fsp.writeFile(path.join(remote, 'file'), 'old original');
  const result = await run({ direction: 'upload', localPath: path.join(local, 'file'), remotePath: '/file' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /Previous destination preserved/);
  assert.equal(await fsp.readFile(path.join(remote, 'file'), 'utf8'), 'other writer');
  const recovery = (await fsp.readdir(remote)).find(name => name.endsWith('.recovery'));
  assert(recovery); assert.equal(await fsp.readFile(path.join(remote, recovery), 'utf8'), 'old original');
  assert(!(await fsp.readdir(remote)).some(name => name.endsWith('.part')));
});

test('a local destination modified during download survives unchanged', { timeout: 20000 }, async t => {
  let changed = false;
  const { local, remote, run } = await fixture(t, { confirmOverwrite: async () => true, onRead: async ({ local: directory }) => {
    if (!changed) { changed = true; await fsp.writeFile(path.join(directory, 'file'), 'concurrent local change'); }
  } });
  await fsp.writeFile(path.join(local, 'file'), 'old'); await fsp.writeFile(path.join(remote, 'file'), 'replacement');
  const result = await run({ direction: 'download', localPath: path.join(local, 'file'), remotePath: '/file' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /changed after overwrite confirmation/);
  assert.equal(await fsp.readFile(path.join(local, 'file'), 'utf8'), 'concurrent local change'); assert.deepEqual(await fsp.readdir(local), ['file']);
});

test('shutdown cancels pending connection approval and prevents late connection registration', async () => {
  let signal;
  const manager = createSecureTransfers({ connect: async (_, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled approval')), { once: true }));
  } });
  const opening = manager.open({ host: 'fixture' }); const rejected = assert.rejects(opening, /cancelled/);
  await delay(0); assert.equal(manager.count, 1); await manager.closeAll(); await rejected; assert.equal(signal.aborted, true); assert.equal(manager.count, 0);
  await assert.rejects(manager.open({ host: 'fixture' }), /stopping/);
});

test('overwrite confirmation receives the transfer signal and cancellation closes the pending prompt', { timeout: 10000 }, async t => {
  let showPrompt; const shown = new Promise(resolve => { showPrompt = resolve; }); let receivedSignal;
  const { manager, connection, local, remote, waitJob } = await fixture(t, { confirmOverwrite: ({ signal }) => {
    receivedSignal = signal; showPrompt();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
  } });
  await fsp.writeFile(path.join(local, 'file'), 'replacement'); await fsp.writeFile(path.join(remote, 'file'), 'old');
  const job = manager.start({ id: connection.id, direction: 'upload', protocol: 'sftp', localPath: path.join(local, 'file'), remotePath: '/file' });
  await shown; await manager.cancel(job.transferId);
  assert.equal(receivedSignal.aborted, true); assert.equal((await waitJob(job.transferId)).status, 'cancelled');
  assert.equal(await fsp.readFile(path.join(remote, 'file'), 'utf8'), 'old'); assert.deepEqual(await fsp.readdir(remote), ['file']);
});

test('cancelling an in-flight final rename waits for its acknowledgement and reports committed success', { timeout: 10000 }, async t => {
  let markRename; const renamed = new Promise(resolve => { markRename = resolve; });
  let continueRename; const allowed = new Promise(resolve => { continueRename = resolve; });
  const { manager, connection, local, remote, waitJob } = await fixture(t, { confirmOverwrite: async () => true, onRename: async ({ from }) => {
    if (from.endsWith('.part')) { markRename(); await allowed; }
  } });
  await fsp.writeFile(path.join(local, 'file'), 'replacement'); await fsp.writeFile(path.join(remote, 'file'), 'old');
  const job = manager.start({ id: connection.id, direction: 'upload', protocol: 'sftp', localPath: path.join(local, 'file'), remotePath: '/file' });
  await renamed;
  let cancellationFinished = false;
  const cancellation = manager.cancel(job.transferId).then(() => { cancellationFinished = true; });
  await delay(20); assert.equal(cancellationFinished, false); assert.equal(manager.listJobs()[0].status, 'running');
  continueRename(); await cancellation;
  const result = await waitJob(job.transferId); assert.equal(result.status, 'completed', result.error);
  assert.equal(await fsp.readFile(path.join(remote, 'file'), 'utf8'), 'replacement'); assert.deepEqual(await fsp.readdir(remote), ['file']);
});

test('a lost commit acknowledgement preserves recovery files and reports an indeterminate failure', { timeout: 10000 }, async t => {
  const { local, remote, run, manager, connection } = await fixture(t, { confirmOverwrite: async () => true, commitTimeoutMs: 100,
    afterRename: async ({ from }) => !from.endsWith('.part') });
  await fsp.writeFile(path.join(local, 'file'), 'replacement'); await fsp.writeFile(path.join(remote, 'file'), 'old original');
  const result = await run({ direction: 'upload', localPath: path.join(local, 'file'), remotePath: '/file' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /outcome could not be verified/);
  assert.equal(await fsp.readFile(path.join(remote, 'file'), 'utf8'), 'replacement');
  const recovery = (await fsp.readdir(remote)).find(name => name.endsWith('.recovery'));
  assert(recovery); assert.equal(await fsp.readFile(path.join(remote, recovery), 'utf8'), 'old original');
  assert.throws(() => manager.start({ id: connection.id, direction: 'upload', protocol: 'sftp', localPath: path.join(local, 'file'), remotePath: '/file' }), /closed/);
});

test('a refused final rename after cancellation finishes rollback before reporting failure', { timeout: 10000 }, async t => {
  let markRename; const renamed = new Promise(resolve => { markRename = resolve; });
  let refuseRename; const refused = new Promise(resolve => { refuseRename = resolve; });
  const { manager, connection, local, remote, waitJob } = await fixture(t, { confirmOverwrite: async () => true, onRename: async ({ from }) => {
    if (from.endsWith('.part')) { markRename(); await refused; throw new Error('Fixture destination permission denied'); }
  } });
  await fsp.writeFile(path.join(local, 'file'), 'replacement'); await fsp.writeFile(path.join(remote, 'file'), 'old original');
  const job = manager.start({ id: connection.id, direction: 'upload', protocol: 'sftp', localPath: path.join(local, 'file'), remotePath: '/file' });
  await renamed; const cancellation = manager.cancel(job.transferId); refuseRename(); await cancellation;
  const result = await waitJob(job.transferId); assert.equal(result.status, 'failed'); assert.match(result.error, /permission denied/);
  assert.equal(await fsp.readFile(path.join(remote, 'file'), 'utf8'), 'old original'); assert.deepEqual(await fsp.readdir(remote), ['file']);
});

test('disconnected jobs remain owned and shutdown awaits their pending cleanup', { timeout: 10000 }, async t => {
  let markRead; const reading = new Promise(resolve => { markRead = resolve; });
  let markCleanup; const cleaning = new Promise(resolve => { markCleanup = resolve; });
  let releaseCleanup; const cleanupAllowed = new Promise(resolve => { releaseCleanup = resolve; });
  let holdCleanup = false;
  const { manager, connection, local, remote, disconnect, events } = await fixture(t, {
    delayRead: 200, onRead: async () => markRead(), wrapSftp: sftp => {
      const original = sftp.close.bind(sftp);
      sftp.close = (handle, callback) => {
        if (!holdCleanup) return original(handle, callback);
        markCleanup(); cleanupAllowed.then(() => original(handle, callback));
      };
    },
  });
  try {
    await fsp.writeFile(path.join(remote, 'file'), Buffer.alloc(150000, 77));
    const job = manager.start({ id: connection.id, direction: 'download', protocol: 'sftp', localPath: path.join(local, 'file'), remotePath: '/file' });
    await reading; holdCleanup = true; disconnect(); await cleaning;
    assert.equal(manager.count, 1, 'Disconnected session still owns a job until cleanup completes');
    assert(events.some(event => event.type === 'connection' && event.id === connection.id && event.status === 'closed'));
    let stopped = false; const stopping = manager.closeAll().then(() => { stopped = true; });
    await delay(20); assert.equal(stopped, false); assert.equal(manager.count, 1);
    releaseCleanup(); await stopping;
    assert.equal(manager.count, 0); assert.equal(manager.listJobs().find(item => item.transferId === job.transferId).status, 'cancelled');
    assert.deepEqual(await fsp.readdir(local), []);
  } finally { releaseCleanup(); }
});

test('filesystems without hard links refuse replacement before moving the existing local file', { timeout: 10000 }, async t => {
  const { local, remote, run } = await fixture(t, { confirmOverwrite: async () => true });
  const canonical = await fsp.realpath(local);
  const destination = path.join(local, 'file');
  await fsp.writeFile(destination, 'keep the original bytes'); await fsp.writeFile(path.join(remote, 'file'), 'replacement');
  const originalLink = fsp.link; const originalRename = fsp.rename; let movedExisting = false; let refusedLinks = 0;
  fsp.rename = async (from, to) => { if (from === path.join(canonical, 'file')) movedExisting = true; return originalRename(from, to); };
  try {
    for (const code of ['ENOTSUP', 'EPERM']) {
      fsp.link = async (from, to) => {
        if (path.dirname(from) === canonical) { refusedLinks++; throw Object.assign(new Error('Fixture filesystem does not support hard links'), { code }); }
        return originalLink(from, to);
      };
      const result = await run({ direction: 'download', localPath: destination, remotePath: '/file' });
      assert.equal(result.status, 'failed'); assert.match(result.error, /hard links.*existing file was left in place/);
      assert.equal(movedExisting, false, 'Replacement must not rename the original before checking hard-link support');
      assert.equal(await fsp.readFile(destination, 'utf8'), 'keep the original bytes');
      assert.deepEqual(await fsp.readdir(local), ['file'], 'No recovery rename or staging residue remains');
    }
    assert.equal(refusedLinks, 2);
  } finally { fsp.link = originalLink; fsp.rename = originalRename; }
});
