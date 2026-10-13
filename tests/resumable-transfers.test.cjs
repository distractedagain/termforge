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
const { generateEd25519Fixture } = require('../scripts/ssh-key-fixtures.cjs');

const key = generateEd25519Fixture().private;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


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
          let openFlags = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.READ ? fs.constants.O_RDWR : fs.constants.O_WRONLY) : fs.constants.O_RDONLY;
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
          await lookup(handle).file.write(data, 0, data.length, offset);
          if (options.afterWrite && await options.afterWrite({remote, local, offset, disconnect: () => client.destroy()}) === false) return;
          stream.status(id, STATUS_CODE.OK);
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
  const recoveryDirectory = path.join(directory, 'recovery'); const managers = [];
  const endpoint = {host:'127.0.0.1', port:server.address().port};
  const identity = { ...endpoint, username:'fixture-user', algorithm:'ssh-ed25519', fingerprint:'SHA256:fixture-key' };
  function createManager(overrides = {}) {
    const manager = createSecureTransfers({ home: local, recoveryDirectory,
      emit: event => { events.push(event); options.onEvent?.(event, manager); },
      confirmOverwrite: options.confirmOverwrite || (async () => true), confirmResume: options.confirmResume || (async () => true),
      confirmDiscardPartial: options.confirmDiscardPartial || (async () => true),
      getConnectionIdentity: () => ({...identity}), commitTimeoutMs: options.commitTimeoutMs || 30000,
      connect: () => new Promise((resolve, reject) => {
        const client = new Client(); client.on('error', () => {}); client.once('error', reject); client.once('ready', () => resolve(client));
        client.connect({ ...endpoint, username:'test', password:'test-only', hostVerifier: () => true });
      }), ...overrides });
    managers.push(manager); return manager;
  }
  const manager = createManager();
  t.after(async () => {
    for (const item of managers) await item.closeAll();
    for (const child of children) child.kill(); for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve)); await fsp.rm(directory, {recursive:true,force:true});
  });
  const connection = await manager.open({ host: '127.0.0.1', port: server.address().port });
  async function run(input) {
    const started = manager.start({ id: connection.id, protocol: 'sftp', resumable:true, ...input });
    return waitJob(started.transferId);
  }
  async function waitJob(id) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const job = manager.listJobs().find(item => item.transferId === id); if (['failed', 'cancelled', 'completed', 'paused', 'interrupted'].includes(job.status)) return job; await delay(15); }
    throw new Error(`Transfer did not finish: ${JSON.stringify(manager.listJobs())}`);
  }
  return { manager, connection, run, waitJob, remote, local, commands, events, recoveryDirectory, identity, endpoint, createManager, disconnect: () => { for (const client of clients) client.end(); } };
}


async function waitStatus(manager, transferId, statuses) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const job = manager.listJobs().find(item => item.transferId === transferId);
    if (job && statuses.includes(job.status)) return job;
    await delay(10);
  }
  throw new Error(`No expected status: ${JSON.stringify(manager.listJobs())}`);
}
async function beginPaused(t, direction, options = {}) {
  let requested = false;
  const fx = await fixture(t, { ...options, onEvent(event, manager) {
    if (event.type === 'transfer' && event.status === 'running' && event.bytes >= 65536 && !requested) {
      requested = true; void manager.pause(event.transferId);
    }
    options.onEvent?.(event, manager);
  }});
  const payload = Buffer.alloc(360000); for (let i=0;i<payload.length;i++) payload[i]=i%251;
  const localPath = path.join(fx.local,'payload.bin'), remotePath='/payload.bin';
  if (direction === 'upload') await fsp.writeFile(localPath,payload); else await fsp.writeFile(path.join(fx.remote,'payload.bin'),payload);
  const job = fx.manager.start({id:fx.connection.id,direction,protocol:'sftp',resumable:true,localPath,remotePath});
  const paused = await waitStatus(fx.manager,job.transferId,['paused','interrupted','failed','completed']);
  assert.equal(paused.status,'paused',paused.error); assert.ok(paused.bytes>0 && paused.bytes<payload.length);
  return {...fx,payload,job:paused,localPath,remotePath};
}

for (const direction of ['upload','download']) test(`resumable ${direction} pauses between acknowledged chunks and resumes exact bytes`, {timeout:25000}, async t=> {
  const f=await beginPaused(t,direction);
  assert.equal(f.job.resumeAvailable,true); assert.equal(f.job.retainedBytes,f.job.bytes);
  assert.throws(()=>f.manager.start({id:f.connection.id,direction,protocol:'sftp',localPath:f.localPath,remotePath:'/other'}),/retained/);
  await f.manager.resume({transferId:f.job.transferId,id:f.connection.id});
  const done=await waitStatus(f.manager,f.job.transferId,['completed','interrupted','failed']);
  assert.equal(done.status,'completed',done.error); assert.equal(done.bytes,f.payload.length);
  const destination=direction==='upload'?path.join(f.remote,'payload.bin'):f.localPath;
  assert.deepEqual(await fsp.readFile(destination),f.payload); assert.deepEqual(await fsp.readdir(f.recoveryDirectory),[]);
});

for (const direction of ['upload','download']) test(`retained ${direction} survives manager restart without journaling credentials`, {timeout:25000},async t=> {
  const f=await beginPaused(t,direction);
  const filename=path.join(f.recoveryDirectory,(await fsp.readdir(f.recoveryDirectory))[0]);
  const json=await fsp.readFile(filename,'utf8'); assert.ok(!json.includes('fixture-user')); assert.ok(!json.includes('test-only')); assert.ok(!json.includes('fixture-key'));
  if(process.platform!=='win32') assert.equal((await fsp.stat(filename)).mode&0o777,0o600);
  await f.manager.closeAll();
  const restored=f.createManager(); await restored.initializeRecovery();
  assert.equal(restored.listJobs()[0].status,'interrupted');
  const connection=await restored.open(f.endpoint); await restored.resume({transferId:f.job.transferId,id:connection.id});
  const done=await waitStatus(restored,f.job.transferId,['completed','interrupted','failed']);
  assert.equal(done.status,'completed',done.error);
  assert.deepEqual(await fsp.readFile(direction==='upload'?path.join(f.remote,'payload.bin'):f.localPath),f.payload);
});

test('resume rejects a different authenticated principal or host key before invoking approval',{timeout:25000},async t=> {
  let approvals=0;const f=await beginPaused(t,'upload',{confirmResume:async()=>{approvals++;return true;}});
  f.identity.username='another';await assert.rejects(f.manager.resume({transferId:f.job.transferId,id:f.connection.id}),/original authenticated/);
  f.identity.username='fixture-user';f.identity.fingerprint='SHA256:other';await assert.rejects(f.manager.resume({transferId:f.job.transferId,id:f.connection.id}),/original authenticated/);
  assert.equal(approvals,0);
});

test('native resume denial leaves the retained transfer unchanged',{timeout:25000},async t=> {
  const f=await beginPaused(t,'download',{confirmResume:async()=>false});
  assert.deepEqual(await f.manager.resume({transferId:f.job.transferId,id:f.connection.id}),{cancelled:true});
  assert.equal(f.manager.listJobs()[0].status,'paused');assert.equal(f.manager.listJobs()[0].bytes,f.job.bytes);
});

for(const direction of ['upload','download']) test(`changed ${direction} source is refused and retained stage is untouched`,{timeout:25000},async t=> {
  const f=await beginPaused(t,direction);const source=direction==='upload'?f.localPath:path.join(f.remote,'payload.bin');
  const cp=JSON.parse(await fsp.readFile(path.join(f.recoveryDirectory,(await fsp.readdir(f.recoveryDirectory))[0]),'utf8'));
  const stage=direction==='upload'?path.join(f.remote,path.basename(cp.stagePath)):cp.stagePath;const before=await fsp.readFile(stage);
  const times=await fsp.stat(source);await fsp.writeFile(source,Buffer.alloc(f.payload.length,7));await fsp.utimes(source,times.atime,times.mtime);
  await f.manager.resume({transferId:f.job.transferId,id:f.connection.id});const result=await waitStatus(f.manager,f.job.transferId,['interrupted','failed']);
  assert.match(result.error,/source.*changed/i);assert.deepEqual(await fsp.readFile(stage),before);
});

for(const direction of ['upload','download']) test(`modified ${direction} staging bytes are refused and cannot be discarded silently`,{timeout:25000},async t=> {
  const f=await beginPaused(t,direction);const cp=JSON.parse(await fsp.readFile(path.join(f.recoveryDirectory,(await fsp.readdir(f.recoveryDirectory))[0]),'utf8'));
  const stage=direction==='upload'?path.join(f.remote,path.basename(cp.stagePath)):cp.stagePath;const bytes=await fsp.readFile(stage);bytes[0]^=255;await fsp.writeFile(stage,bytes);
  await f.manager.resume({transferId:f.job.transferId,id:f.connection.id});const result=await waitStatus(f.manager,f.job.transferId,['interrupted','failed']);
  assert.match(result.error,/partial bytes/);await assert.rejects(f.manager.discardPartial({transferId:f.job.transferId,id:f.connection.id}),/contents changed/);
  assert.deepEqual(await fsp.readFile(stage),bytes);
});

test('a destination created while paused is never overwritten',{timeout:25000},async t=> {
  const f=await beginPaused(t,'upload');await fsp.writeFile(path.join(f.remote,'payload.bin'),'concurrent');
  await f.manager.resume({transferId:f.job.transferId,id:f.connection.id});const result=await waitStatus(f.manager,f.job.transferId,['interrupted','failed']);
  assert.match(result.error,/destination changed/i);assert.equal(await fsp.readFile(path.join(f.remote,'payload.bin'),'utf8'),'concurrent');
});

test('verified partial discard requires native approval and removes only the owned stage',{timeout:25000},async t=> {
  let accepted=false;const f=await beginPaused(t,'upload',{confirmDiscardPartial:async()=>accepted});
  const cp=JSON.parse(await fsp.readFile(path.join(f.recoveryDirectory,(await fsp.readdir(f.recoveryDirectory))[0]),'utf8'));
  assert.deepEqual(await f.manager.discardPartial({transferId:f.job.transferId,id:f.connection.id}),{cancelled:true});
  accepted=true;assert.deepEqual(await f.manager.discardPartial({transferId:f.job.transferId,id:f.connection.id}),{discarded:true,retainedFiles:[]});
  assert.deepEqual(await fsp.readdir(f.recoveryDirectory),[]);await assert.rejects(fsp.stat(path.join(f.remote,path.basename(cp.stagePath))),/ENOENT/);
  assert.equal(f.manager.listJobs()[0].status,'cancelled');
});

test('a lost write acknowledgement retains actual server bytes and resumes after reconnect',{timeout:25000},async t=> {
  let dropped=false;const f=await fixture(t,{afterWrite:async({disconnect})=>{if(!dropped){dropped=true;disconnect();return false;}}});
  const payload=Buffer.alloc(200000,11),filename=path.join(f.local,'file');await fsp.writeFile(filename,payload);
  const job=f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:filename,remotePath:'/file'});
  const interrupted=await waitStatus(f.manager,job.transferId,['interrupted','failed']);assert.equal(interrupted.status,'interrupted',interrupted.error);
  const connection=await f.manager.open(f.endpoint);await f.manager.resume({transferId:job.transferId,id:connection.id});
  const done=await waitStatus(f.manager,job.transferId,['completed','interrupted','failed']);assert.equal(done.status,'completed',done.error);
  assert.deepEqual(await fsp.readFile(path.join(f.remote,'file')),payload);
});

test('malformed or public-readable recovery records fail closed before any transfer',{timeout:10000},async t=> {
  const f=await fixture(t);await fsp.writeFile(path.join(f.recoveryDirectory,'00000000-0000-0000-0000-000000000000.json'),'{}',{mode:0o600});
  const restored=f.createManager();const result=await restored.initializeRecovery();assert.match(result.error,/Invalid/);assert.equal(restored.listJobs().length,0);
  await assert.rejects(restored.open(f.endpoint),/disabled/);assert.throws(()=>restored.start({}),/disabled/);
});


test('two retained queued jobs can resume serially after shutdown',{timeout:25000},async t=> {
  const pausing=new Set();const f=await fixture(t,{onEvent(event,manager){if(event.type==='transfer'&&event.status==='running'&&event.bytes>=65536&&!pausing.has(event.transferId)){pausing.add(event.transferId);void manager.pause(event.transferId);}}});await fsp.writeFile(path.join(f.local,'a'),Buffer.alloc(200000,1));await fsp.writeFile(path.join(f.local,'b'),Buffer.alloc(200000,2));
  const a=f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:path.join(f.local,'a'),remotePath:'/a'});
  const b=f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:path.join(f.local,'b'),remotePath:'/b'});
  await waitStatus(f.manager,a.transferId,['paused']);await waitStatus(f.manager,b.transferId,['paused']);await f.manager.closeAll();assert.equal(f.manager.listJobs().filter(j=>j.status==='paused').length,2);
  const restored=f.createManager();await restored.initializeRecovery();const connection=await restored.open(f.endpoint);
  for(const job of [a,b]) {await restored.resume({transferId:job.transferId,id:connection.id});const done=await waitStatus(restored,job.transferId,['completed','interrupted','failed']);assert.equal(done.status,'completed',done.error);}
  assert.deepEqual(await fsp.readFile(path.join(f.remote,'a')),Buffer.alloc(200000,1));assert.deepEqual(await fsp.readFile(path.join(f.remote,'b')),Buffer.alloc(200000,2));
});

test('shutdown cancels a pending resume approval and retains the checkpoint',{timeout:10000},async t=> {
  let shown;const ready=new Promise(r=>shown=r);const f=await beginPaused(t,'upload',{confirmResume:async()=>{shown();return new Promise(()=>{});}});
  const resuming=f.manager.resume({transferId:f.job.transferId,id:f.connection.id});const rejected=assert.rejects(resuming,/cancelled/);
  await ready;await f.manager.closeAll();await rejected;assert.equal(f.manager.listJobs()[0].status,'paused');assert.equal((await fsp.readdir(f.recoveryDirectory)).length,1);
});

test('pending discard reserves the retained stage and shutdown aborts its prompt',{timeout:10000},async t=> {
  let shown;const ready=new Promise(r=>shown=r);const f=await beginPaused(t,'upload',{confirmDiscardPartial:async()=>{shown();return new Promise(()=>{});}});
  const discarding=f.manager.discardPartial({transferId:f.job.transferId,id:f.connection.id});const rejected=assert.rejects(discarding,/cancelled/);
  await ready;await assert.rejects(f.manager.resume({transferId:f.job.transferId,id:f.connection.id}),/no resumable/);
  await f.manager.closeAll();await rejected;assert.equal(f.manager.listJobs()[0].status,'paused');assert.equal((await fsp.readdir(f.recoveryDirectory)).length,1);
});

test('an uncertain final rename is never resumed or cleaned automatically',{timeout:10000},async t=> {
  const f=await fixture(t,{commitTimeoutMs:30,afterRename:async()=>false});const payload=Buffer.alloc(80000,4),filename=path.join(f.local,'file');await fsp.writeFile(filename,payload);
  const job=f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:filename,remotePath:'/file'});
  const result=await waitStatus(f.manager,job.transferId,['interrupted','failed']);assert.equal(result.status,'interrupted',result.error);assert.equal(result.resumeAvailable,false);assert.equal(result.forgetOnly,true);
  assert.deepEqual(await fsp.readFile(path.join(f.remote,'file')),payload);
  const discard=await f.manager.discardPartial({transferId:job.transferId});assert.equal(discard.discarded,true);assert.ok(discard.retainedFiles.includes('/file'));
  assert.deepEqual(await fsp.readFile(path.join(f.remote,'file')),payload);assert.deepEqual(await fsp.readdir(f.recoveryDirectory),[]);
});

test('pause during final commit waits for the acknowledgement and reports completed',{timeout:10000},async t=> {
  let reached,release;const ready=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
  const f=await fixture(t,{afterRename:async()=>{reached();await gate;}});await fsp.writeFile(path.join(f.local,'file'),Buffer.alloc(80000,2));
  const job=f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:path.join(f.local,'file'),remotePath:'/file'});
  await ready;let settled=false;const pausing=f.manager.pause(job.transferId).then(result=>{settled=true;return result;});await delay(20);assert.equal(settled,false);
  release();assert.equal(await pausing,false);assert.equal(f.manager.listJobs()[0].status,'completed');
});

test('offline download partial cleanup needs no network connection',{timeout:10000},async t=> {
  const f=await beginPaused(t,'download');await f.manager.close(f.connection.id);
  assert.deepEqual(await f.manager.discardPartial({transferId:f.job.transferId}),{discarded:true,retainedFiles:[]});assert.deepEqual(await fsp.readdir(f.recoveryDirectory),[]);
});

for(const direction of ['upload','download']) test(`replaced ${direction} partial symlink is rejected without following it`,{skip:process.platform==='win32',timeout:10000},async t=> {
  const f=await beginPaused(t,direction);const cp=JSON.parse(await fsp.readFile(path.join(f.recoveryDirectory,(await fsp.readdir(f.recoveryDirectory))[0]),'utf8'));
  const stage=direction==='upload'?path.join(f.remote,path.basename(cp.stagePath)):cp.stagePath;const protectedFile=path.join(f.local,'protected');await fsp.writeFile(protectedFile,'untouched');await fsp.unlink(stage);await fsp.symlink(protectedFile,stage);
  await f.manager.resume({transferId:f.job.transferId,id:f.connection.id});const result=await waitStatus(f.manager,f.job.transferId,['interrupted','failed']);assert.match(result.error,/regular files/);
  await assert.rejects(f.manager.discardPartial({transferId:f.job.transferId,id:f.connection.id}),/partial file changed/);assert.equal(await fsp.readFile(protectedFile,'utf8'),'untouched');
});


test('changed remote destination permissions invalidate resumed overwrite approval',{skip:process.platform==='win32',timeout:15000},async t=> {
  let requested=false;const f=await fixture(t,{onEvent(event,manager){if(event.type==='transfer'&&event.status==='running'&&event.bytes>=65536&&!requested){requested=true;void manager.pause(event.transferId);}}});
  await fsp.writeFile(path.join(f.remote,'file'),'old contents',{mode:0o600});await fsp.writeFile(path.join(f.local,'file'),Buffer.alloc(200000,2));
  const job=f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:path.join(f.local,'file'),remotePath:'/file'});
  const paused=await waitStatus(f.manager,job.transferId,['paused','failed','interrupted']);assert.equal(paused.status,'paused',paused.error);
  await fsp.chmod(path.join(f.remote,'file'),0o640);await f.manager.resume({transferId:job.transferId,id:f.connection.id});
  const result=await waitStatus(f.manager,job.transferId,['failed','interrupted']);assert.match(result.error,/destination changed/);
  assert.equal(await fsp.readFile(path.join(f.remote,'file'),'utf8'),'old contents');assert.equal((await fsp.stat(path.join(f.remote,'file'))).mode&0o777,0o640);
});

test('recovery loader rejects public records and linked journals without touching payloads',{skip:process.platform==='win32',timeout:15000},async t=> {
  const f=await beginPaused(t,'download');const filename=path.join(f.recoveryDirectory,(await fsp.readdir(f.recoveryDirectory))[0]);
  await fsp.chmod(filename,0o644);const publicManager=f.createManager();assert.match((await publicManager.initializeRecovery()).error,/private bounded/);assert.equal(publicManager.listJobs().length,0);
  await fsp.chmod(filename,0o600);const protectedFile=path.join(f.local,'unrelated');await fsp.writeFile(protectedFile,'untouched');await fsp.unlink(filename);await fsp.symlink(protectedFile,filename);
  const linkedManager=f.createManager();assert.match((await linkedManager.initializeRecovery()).error,/private bounded/);assert.equal(await fsp.readFile(protectedFile,'utf8'),'untouched');
});


test('shutdown aborts an initial remote fingerprint read without waiting for the full source',{timeout:10000},async t=> {
  let reached,release;const ready=new Promise(r=>reached=r),gate=new Promise(r=>release=r);let held=true;
  const f=await fixture(t,{onRead:async()=>{if(held){reached();await gate;}}});await fsp.writeFile(path.join(f.remote,'file'),Buffer.alloc(200000,2));
  const job=f.manager.start({id:f.connection.id,direction:'download',protocol:'sftp',resumable:true,localPath:path.join(f.local,'file'),remotePath:'/file'});
  await ready;await f.manager.closeAll();held=false;release();assert.equal(f.manager.listJobs()[0].status,'cancelled');assert.deepEqual(await fsp.readdir(f.recoveryDirectory),[]);
});

test('shutdown aborts initial overwrite approval before creating a partial file',{timeout:10000},async t=> {
  let reached;const ready=new Promise(r=>reached=r);const f=await fixture(t,{confirmOverwrite:async()=>{reached();return new Promise(()=>{});}});
  await fsp.writeFile(path.join(f.remote,'file'),'original');await fsp.writeFile(path.join(f.local,'file'),Buffer.alloc(200000,1));
  f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:path.join(f.local,'file'),remotePath:'/file'});
  await ready;await f.manager.closeAll();assert.equal(f.manager.listJobs()[0].status,'cancelled');assert.equal(await fsp.readFile(path.join(f.remote,'file'),'utf8'),'original');assert.deepEqual(await fsp.readdir(f.recoveryDirectory),[]);
});

test('shutdown aborts resume fingerprint reads and preserves a resumable checkpoint',{timeout:10000},async t=> {
  let hold=false,reached,release;const ready=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
  const f=await beginPaused(t,'download',{onRead:async()=>{if(hold){reached();await gate;}}});hold=true;
  await f.manager.resume({transferId:f.job.transferId,id:f.connection.id});await ready;await f.manager.closeAll();hold=false;release();
  const result=f.manager.listJobs()[0];assert.equal(result.status,'interrupted');assert.equal(result.resumeAvailable,true);assert.equal((await fsp.readdir(f.recoveryDirectory)).length,1);
});

test('shutdown aborts remote discard fingerprint reads before deleting its partial file',{timeout:10000},async t=> {
  let hold=false,reached,release;const ready=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
  const f=await beginPaused(t,'upload',{onRead:async()=>{if(hold){reached();await gate;}}});hold=true;
  const discarding=f.manager.discardPartial({transferId:f.job.transferId,id:f.connection.id});const rejected=assert.rejects(discarding,/cancelled/);
  await ready;await f.manager.closeAll();hold=false;release();await rejected;
  assert.equal(f.manager.listJobs()[0].status,'paused');assert.equal((await fsp.readdir(f.recoveryDirectory)).length,1);assert.equal((await fsp.readdir(f.remote)).filter(name=>name.endsWith('.part')).length,1);
});


for(const pass of [1,2]) test(`shutdown aborts ${pass===1?'completed-stage':'reopened named-stage'} hashing before commit`,{timeout:15000},async t=> {
  let reached,release,zeroReads=0;const ready=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
  const f=await fixture(t,{onRead:async({offset})=>{if(offset===0&&++zeroReads===pass){reached();await gate;}}});
  const payload=Buffer.alloc(180000,9);await fsp.writeFile(path.join(f.local,'file'),payload);
  const job=f.manager.start({id:f.connection.id,direction:'upload',protocol:'sftp',resumable:true,localPath:path.join(f.local,'file'),remotePath:'/file'});
  await ready;await f.manager.closeAll();release();
  const retained=f.manager.listJobs()[0];assert.equal(retained.status,'interrupted',retained.error);assert.equal(retained.resumeAvailable,true);assert.equal(retained.retainedBytes,payload.length);
  await assert.rejects(fsp.stat(path.join(f.remote,'file')),/ENOENT/);
  const restored=f.createManager();await restored.initializeRecovery();const connection=await restored.open(f.endpoint);
  await restored.resume({transferId:job.transferId,id:connection.id});const done=await waitStatus(restored,job.transferId,['completed','interrupted','failed']);assert.equal(done.status,'completed',done.error);
  assert.deepEqual(await fsp.readFile(path.join(f.remote,'file')),payload);
});
