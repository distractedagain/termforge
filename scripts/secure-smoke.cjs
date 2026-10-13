'use strict';
// Native CI-only integration checks use synthetic secrets, ephemeral host keys,
// loopback SSH, and fixture files under the already-isolated smoke directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { once } = require('node:events');
const { Server, utils } = require('ssh2');
const { generateEd25519Fixture } = require('./ssh-key-fixtures.cjs');
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

async function startFixture(directory, approved, options = {}) {
  const remote = path.join(directory, 'remote'), local = path.join(directory, 'local');
  await fsp.mkdir(remote, { recursive: true }); await fsp.mkdir(local, { recursive: true });
  const peers = new Set(), authentication = [], windows = [], controls = { readDelayMs: 0, writeDelayMs: 0 };
  function remoteFile(value) {
    const parts = path.posix.resolve('/', value).split('/').filter(Boolean);
    const result = path.join(remote, ...parts);
    assert.ok(result === remote || result.startsWith(remote + path.sep), 'Fixture path escaped its isolated directory');
    return result;
  }
  const server = new Server({ hostKeys: [generateEd25519Fixture().private] }, peer => {
    peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    peer.on('authentication', context => {
      authentication.push({ reviewed: approved(), method: context.method, valid: context.username === 'native-fixture-user' && context.password === 'Native-fixture-password-123!' });
      if (approved() && context.method === 'password' && context.username === 'native-fixture-user' && context.password === 'Native-fixture-password-123!') context.accept();
      else context.reject(['password']);
    });
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept();
      session.on('pty', (acceptPty, reject, size) => { windows.push(size); acceptPty(); });
      session.on('window-change', (acceptWindow, reject, size) => { windows.push(size); acceptWindow?.(); });
      session.on('shell', acceptShell => {
        const channel = acceptShell(); channel.write('TERMFORGE_MANAGED_READY\r\n');
        channel.on('data', data => { if (data.toString().includes('native-managed-probe')) channel.write('TERMFORGE_MANAGED_PROBE_OK\r\n'); });
      });
      session.on('sftp', acceptSftp => {
        const stream = acceptSftp(), handles = new Map(); let next = 1;
        const attributes = stat => ({ mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
        const action = (name, fn) => stream.on(name, (id, ...args) => { Promise.resolve().then(() => fn(id, ...args)).catch(error => { try { stream.status(id, error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, 'Synthetic fixture operation failed'); } catch {} }); });
        const remember = value => { const id = next++; handles.set(id, value); const result = Buffer.alloc(4); result.writeUInt32BE(id); return result; };
        const lookup = value => { const handle = value.length === 4 && handles.get(value.readUInt32BE()); if (!handle) throw new Error('Invalid fixture handle'); return handle; };
        action('REALPATH', (id, name) => stream.name(id, [{ filename: path.posix.resolve('/', name), longname: '', attrs: {} }]));
        action('LSTAT', async (id, name) => stream.attrs(id, attributes(await fsp.lstat(remoteFile(name)))));
        action('STAT', async (id, name) => stream.attrs(id, attributes(await fsp.stat(remoteFile(name)))));
        action('FSTAT', async (id, handle) => stream.attrs(id, attributes(await lookup(handle).file.stat())));
        action('OPENDIR', (id, name) => stream.handle(id, remember({ directory: remoteFile(name), sent: false })));
        action('READDIR', async (id, handle) => {
          const record = lookup(handle); if (record.sent) return stream.status(id, STATUS_CODE.EOF); record.sent = true;
          const entries = await Promise.all((await fsp.readdir(record.directory)).map(async name => ({ filename: name, longname: '', attrs: attributes(await fsp.lstat(path.join(record.directory, name))) })));
          entries.length ? stream.name(id, entries) : stream.status(id, STATUS_CODE.EOF);
        });
        action('OPEN', async (id, name, flags, attrs) => {
          let mode = flags & OPEN_MODE.WRITE ? flags & OPEN_MODE.READ ? fs.constants.O_RDWR : fs.constants.O_WRONLY : fs.constants.O_RDONLY;
          if (flags & OPEN_MODE.CREAT) mode |= fs.constants.O_CREAT;
          if (flags & OPEN_MODE.EXCL) mode |= fs.constants.O_EXCL;
          if (flags & OPEN_MODE.TRUNC) mode |= fs.constants.O_TRUNC;
          stream.handle(id, remember({ file: await fsp.open(remoteFile(name), mode, attrs.mode || 0o600) }));
        });
        action('READ', async (id, handle, offset, length) => { if (controls.readDelayMs) await new Promise(resolve => setTimeout(resolve, controls.readDelayMs)); const data = Buffer.alloc(Math.min(length, 65536)); const result = await lookup(handle).file.read(data, 0, data.length, offset); result.bytesRead ? stream.data(id, data.subarray(0, result.bytesRead)) : stream.status(id, STATUS_CODE.EOF); });
        action('WRITE', async (id, handle, offset, data) => { if (controls.writeDelayMs) await new Promise(resolve => setTimeout(resolve, controls.writeDelayMs)); let written = 0; const file = lookup(handle).file; while (written < data.length) { const result = await file.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) throw new Error('Fixture write made no progress'); written += result.bytesWritten; } stream.status(id, STATUS_CODE.OK); });
        action('CLOSE', async (id, handle) => { const record = lookup(handle); handles.delete(handle.readUInt32BE()); await record.file?.close(); stream.status(id, STATUS_CODE.OK); });
        action('REMOVE', async (id, name) => { await fsp.unlink(remoteFile(name)); stream.status(id, STATUS_CODE.OK); });
        action('MKDIR', async (id, name, attrs) => { await fsp.mkdir(remoteFile(name), { mode: attrs.mode || 0o755 }); stream.status(id, STATUS_CODE.OK); });
        action('RMDIR', async (id, name) => { await fsp.rmdir(remoteFile(name)); stream.status(id, STATUS_CODE.OK); });
        action('FSETSTAT', async (id, handle, attrs) => { assert.equal(typeof attrs.mode, 'number'); await lookup(handle).file.chmod(attrs.mode); stream.status(id, STATUS_CODE.OK); });
        action('SETSTAT', async (id, name, attrs) => { assert.equal(typeof attrs.mode, 'number'); await fsp.chmod(remoteFile(name), attrs.mode); stream.status(id, STATUS_CODE.OK); });
        action('RENAME', async (id, from, to) => { await fsp.link(remoteFile(from), remoteFile(to)); await fsp.unlink(remoteFile(from)); stream.status(id, STATUS_CODE.OK); });
        stream.on('close', () => { for (const handle of handles.values()) handle.file?.close().catch(() => {}); handles.clear(); });
      });
    }));
  });
  server.listen(options.port || 0, '127.0.0.1'); await once(server, 'listening');
  let stopped = false;
  return { local, remote, controls, port: server.address().port, authentication, windows,
    async close() { if (stopped) return; stopped = true; for (const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = async ({ window, terminals, directory }) => {
  const { dialog } = require('electron');
  const profileDirectory = path.resolve(process.env.TERMFORGE_DATA_DIR || '');
  assert.equal(path.dirname(profileDirectory), path.resolve(directory), 'Secure smoke requires a profile inside the isolated smoke directory');
  assert.equal(path.basename(profileDirectory), 'profile', 'Secure smoke cannot use a real application profile');
  const fixtureDirectory = await fsp.mkdtemp(path.join(directory, 'secure-fixture-'));
  let approved = false, approvals = 0, credentialApprovals = 0, deletionApprovals = 0, remoteApprovals = 0, folderApprovals = 0, allowFolder = false, resumeApprovals = 0, discardApprovals = 0, editApprovals = 0, allowResume = false, allowDiscard = false, allowEdit = false, allowForgetPair = false, forgottenPairs = 0, fixture, changed;
  const originalDialog = dialog.showMessageBox, originalWrite = terminals.write;
  const writes = [], report = {};
  const secret = { name: 'Native smoke credential', username: 'native-fixture-user', password: 'Native-fixture-password-123!' };
  const evaluate = source => window.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, label, timeoutMs = 15000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Native secure smoke timed out: ' + label); };
    ${source}
  })()`);
  const respondToPassword = `
    await wait(() => document.getElementById('ssh-auth-dialog')?.open, 'masked SSH authentication dialog');
    const field = document.getElementById('auth-response-0');
    if (!field || field.type !== 'password' || field.value !== '') throw new Error('SSH password field must be empty and masked');
    if (!document.getElementById('auth-target').textContent.includes('127.0.0.1')) throw new Error('Authentication dialog must identify the target');
    field.value = ${JSON.stringify(secret.password)};
    document.getElementById('ssh-auth-form').requestSubmit();
    await wait(() => !document.getElementById('ssh-auth-dialog').open && document.getElementById('auth-fields').children.length === 0, 'closed and cleared password dialog');
    if (field.value !== '') throw new Error('Removed password input still retains its value');
  `;
  try {
    fixture = await startFixture(fixtureDirectory, () => approved);
    const profile = { name: 'Native managed fixture', protocol: 'ssh', host: '127.0.0.1', port: fixture.port, username: secret.username, ssh: { backend: 'managed', authOrder: ['password'] } };
    const expectedEndpoint = `127.0.0.1:${fixture.port}`;
    dialog.showMessageBox = async (_window, options) => {
      assert.deepEqual(options.buttons?.slice(0, 1), ['Cancel'], 'Sensitive native dialog must default to cancellation');
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
      if (options.title === 'Verify SSH server identity') {
        assert.equal(options.message, `Trust ${expectedEndpoint}?`); assert.match(options.detail, /Fingerprint: SHA256:[A-Za-z0-9+/]{43}/);
        assert.equal(approvals, 0, 'Known or changed fixture keys must not be silently approved again');
        approved = true; approvals++; return { response: 1 };
      }
      if (options.title === 'Allow saved credential') {
        assert.equal(options.message, `Use “${secret.name}” with ${expectedEndpoint}?`); assert.match(options.detail, /Verified server key: SHA256:/);
        credentialApprovals++; return { response: 1 };
      }
      if (options.title === 'Copy reviewed folder') {
        assert.ok(options.detail.includes(`Server: ${expectedEndpoint}`));
        if (options.detail.includes('Mode: copy')) { assert.match(options.detail, /Files: 2/); assert.match(options.detail, /Folders: 3/); assert.match(options.detail, /Bytes: 140000/); } else { assert.match(options.detail, /Mode: (merge|sync)/); assert.match(options.detail, /Only the reviewed copies, replacements and deletions will be applied/); }
        assert.match(options.detail, /Completed changes remain/);
        if (allowFolder) folderApprovals++;
        return { response: allowFolder ? 1 : 0 };
      }
      if (['Apply reviewed mirror','Apply reviewed two-way synchronization'].includes(options.title)) {
        assert.ok(options.detail.includes(`Server: ${expectedEndpoint}`));
        if(options.title==='Apply reviewed mirror'){assert.match(options.detail,/permanently deleted/);assert.match(options.detail,/Delete files: 1/);assert.match(options.detail,/Delete folders: 1/);}
        else {
          assert.match(options.detail,/Both local and remote folders may change/);
          if (options.detail.includes('Saved pair: Native persistent sync') && options.detail.includes('Delete files: 1')) {
            assert.match(options.detail,/permanently deleted/); assert.match(options.detail,/There is no undo/);
            assert.equal(options.buttons[1],'Apply changes and deletions');
          }
        }
        if(allowFolder)folderApprovals++;return {response:allowFolder?1:0};
      }
      if (options.title === 'Resume retained transfer') { assert.ok(options.detail.includes(`Server: ${expectedEndpoint}`)); assert.match(options.detail, /Retained bytes: [1-9][0-9]*/); if (allowResume) resumeApprovals++; return { response: allowResume ? 1 : 0 }; }
      if (options.title === 'Discard retained transfer') { assert.ok(options.detail.includes(`Server: ${expectedEndpoint}`)); assert.match(options.detail, /Partial:/); if (allowDiscard) discardApprovals++; return { response: allowDiscard ? 1 : 0 }; }
      if (options.title === 'Forget synchronization baseline') {
        assert.match(options.detail, /Files on both sides remain untouched/); assert.match(options.detail, /persistent-sync/);
        if (allowForgetPair) forgottenPairs++; return { response: allowForgetPair ? 1 : 0 };
      }
      if (options.title === 'Save remote file') { assert.ok(options.detail.includes(`Server: ${expectedEndpoint}`)); assert.match(options.detail, /Path: \/folder-copy\/zero\.txt/); assert.match(options.detail, /Before: [0-9]+ bytes/); assert.match(options.detail, /After: [0-9]+ bytes/); if (allowEdit) editApprovals++; return { response: allowEdit ? 1 : 0 }; }
      if (options.title === 'Delete saved credential') {
        assert.equal(options.message, `Delete “${secret.name}”?`); deletionApprovals++; return { response: 1 };
      }
      if (['Create remote folder', 'Rename remote item', 'Delete remote item', 'Change remote permissions'].includes(options.title)) {
        assert.ok(options.detail.includes(`Server: ${expectedEndpoint}`));
        assert.match(options.detail, /Path: \/(native-folder|upload\.bin|renamed\.bin)/);
        remoteApprovals++; return { response: 1 };
      }
      throw new Error('Unexpected native dialog during isolated secure smoke: ' + options.title);
    };
    terminals.write = (...args) => { writes.push(args[0]); return originalWrite.apply(terminals, args); };
    await evaluate(`
      if (location.href !== 'termforge://app/index.html') throw new Error('Secure smoke requires the packaged protocol and preload');
      const state = window.__termforgeSecureSmoke = { output:{}, exited:[], prompts:[], closed:[], jobs:{}, ids:[], transferIds:[], subscriptions:[] };
      state.subscriptions.push(window.termforge.onTerminalData(event => { state.output[event.id] = (state.output[event.id] || '') + event.data; }));
      state.subscriptions.push(window.termforge.onTerminalExit(event => state.exited.push(event.id)));
      state.subscriptions.push(window.termforge.onAuthPrompt(event => state.prompts.push({id:event.id,kind:event.kind,host:event.host,port:event.port,prompts:event.prompts})));
      state.subscriptions.push(window.termforge.onAuthPromptClosed(event => state.closed.push(event.id)));
      state.subscriptions.push(window.termforge.onTransferEvent(event => { if (event.transferId) state.jobs[event.transferId] = event; }));
    `);
    const status = await evaluate('return await window.termforge.credentialStatus();');
    assert.equal(typeof status.available, 'boolean'); assert.equal(typeof status.backend, 'string');
    assert.deepEqual(await evaluate('return await window.termforge.credentialList();'), [], 'Isolated smoke starts with no saved credentials');
    if (status.available) {
      const saved = await evaluate(`return await window.termforge.credentialSave(${JSON.stringify(secret)});`);
      assert.deepEqual(Object.keys(saved).sort(), ['id', 'name', 'updatedAt']);
      assert.deepEqual(await evaluate('return await window.termforge.credentialList();'), [saved]);
      const stored = await fsp.readFile(path.join(profileDirectory, 'credentials.json'), 'utf8');
      assert.ok(!stored.includes(secret.username) && !stored.includes(secret.password), 'Native credential file must contain neither plaintext username nor password');
      await evaluate(`window.__termforgeSecureSmoke.credentialId = ${JSON.stringify(saved.id)};`);
      report.nativeCredentialEncryption = true;
    } else {
      const error = await evaluate(`try { await window.termforge.credentialSave(${JSON.stringify(secret)}); return ''; } catch (error) { return error.message; }`);
      assert.match(error, /Secure OS storage|could not encrypt/u); assert.ok(!error.includes(secret.username) && !error.includes(secret.password));
      assert.deepEqual(await evaluate('return await window.termforge.credentialList();'), []);
      await assert.rejects(fsp.stat(path.join(profileDirectory, 'credentials.json')), { code: 'ENOENT' });
      report.nativeInsecureStorageRefused = true;
    }
    report.nativeCredentialProvider = { available: status.available, backend: status.backend };
    console.log('PASS native credential IPC: ' + (status.available ? 'real OS-encrypted metadata-only storage' : 'unavailable OS storage refused saving'));
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const opened = await window.termforge.terminalOpen({profile:${JSON.stringify(profile)}}); state.ids.push(opened.id); state.manualId = opened.id;
      ${respondToPassword}
      await wait(() => state.output[opened.id]?.includes('TERMFORGE_MANAGED_READY'), 'managed shell over real preload');
      await window.termforge.terminalResize({id:opened.id,cols:119,rows:37});
      await window.termforge.terminalWrite({id:opened.id,data:'native-managed-probe\\r'});
      await wait(() => state.output[opened.id]?.includes('TERMFORGE_MANAGED_PROBE_OK'), 'managed shell command output');
      await window.termforge.terminalClose(opened.id); await wait(() => state.exited.includes(opened.id), 'managed terminal exit event');
    `);
    assert.equal(approvals, 1); assert.ok(fixture.authentication.every(event => event.reviewed && event.valid));
    assert.ok(fixture.windows.some(size => size.cols === 119 && size.rows === 37));
    if (status.available) {
      await evaluate(`
        const state = window.__termforgeSecureSmoke, before = state.prompts.length;
        const opened = await window.termforge.terminalOpen({profile:{...${JSON.stringify(profile)},credentialId:state.credentialId}}); state.ids.push(opened.id);
        await wait(() => state.output[opened.id]?.includes('TERMFORGE_MANAGED_READY'), 'saved credential authenticated over managed SSH');
        if (state.prompts.length !== before) throw new Error('Saved password unexpectedly reached renderer authentication prompt');
        await window.termforge.terminalClose(opened.id); await wait(() => state.exited.includes(opened.id), 'saved credential terminal exit');
      `);
      assert.equal(credentialApprovals, 1); report.nativeCredentialAuthentication = true;
    }
    const payload = Buffer.alloc(140000); for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    const source = path.join(fixture.local, 'upload.bin'), download = path.join(fixture.local, 'download.bin');
    await fsp.writeFile(source, payload);
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const connecting = window.termforge.transferOpen({profile:${JSON.stringify(profile)}});
      ${respondToPassword}
      const connection = await connecting; state.transferIds.push(connection.id);
      const local = await window.termforge.transferListLocal({path:${JSON.stringify(fixture.local)}});
      if (!local.entries.some(entry => entry.name === 'upload.bin' && entry.type === 'file')) throw new Error('Local transfer listing did not read the real fixture');
      const uploaded = await window.termforge.transferStart({id:connection.id,direction:'upload',protocol:'sftp',localPath:${JSON.stringify(source)},remotePath:'/upload.bin'});
      await wait(() => ['completed','failed','cancelled'].includes(state.jobs[uploaded.transferId]?.status), 'SFTP upload completion IPC');
      if (state.jobs[uploaded.transferId].status !== 'completed' || state.jobs[uploaded.transferId].bytes !== 140000) throw new Error('Native SFTP upload failed');
      const remote = await window.termforge.transferListRemote({id:connection.id,path:'/'});
      if (!remote.entries.some(entry => entry.name === 'upload.bin' && entry.type === 'file' && entry.size === 140000)) throw new Error('Remote listing did not reflect the real SFTP upload');
      const downloaded = await window.termforge.transferStart({id:connection.id,direction:'download',protocol:'sftp',localPath:${JSON.stringify(download)},remotePath:'/upload.bin'});
      await wait(() => ['completed','failed','cancelled'].includes(state.jobs[downloaded.transferId]?.status), 'SFTP download completion IPC');
      if (state.jobs[downloaded.transferId].status !== 'completed' || state.jobs[downloaded.transferId].bytes !== 140000) throw new Error('Native SFTP download failed');
      const operations = [
        {operation:'mkdir',path:'/',name:'native-folder'},
        {operation:'rename',path:'/upload.bin',name:'renamed.bin'},
        {operation:'chmod',path:'/renamed.bin',permissions:'640'},
        {operation:'delete',path:'/native-folder'},
        {operation:'rename',path:'/renamed.bin',name:'upload.bin'}
      ];
      for (const operation of operations) {
        const plan = await window.termforge.transferPrepareRemoteOperation({id:connection.id,...operation});
        if (!plan.planId || plan.id !== connection.id) throw new Error('Native remote operation did not return its reviewed target');
        const applied = await window.termforge.transferApplyRemoteOperation({planId:plan.planId});
        if (!applied.applied) throw new Error('Native remote operation did not apply');
        let reused = false; try { await window.termforge.transferApplyRemoteOperation({planId:plan.planId}); reused = true; } catch {}
        if (reused) throw new Error('Remote operation token was reusable');
      }
      const afterOperations = await window.termforge.transferListRemote({id:connection.id,path:'/'});
      const changedFile = afterOperations.entries.find(entry => entry.name === 'upload.bin');
      if (afterOperations.entries.length !== 1 || changedFile?.permissions !== '640') throw new Error('Native remote operations did not update listing and permissions');
      await window.termforge.transferClose(connection.id);
    `);
    assert.deepEqual(await fsp.readFile(path.join(fixture.remote, 'upload.bin')), payload);
    assert.deepEqual(await fsp.readFile(download), payload);
    assert.deepEqual((await fsp.readdir(fixture.local)).sort(), ['download.bin', 'upload.bin']);
    assert.deepEqual(await fsp.readdir(fixture.remote), ['upload.bin']);
    assert.equal((await fsp.stat(path.join(fixture.remote, 'upload.bin'))).mode & 0o777, 0o640);
    assert.equal(remoteApprovals, 5);
    report.nativeRemoteFileManagement = true;
    report.nativeSftpRoundTrip = true;
    console.log('PASS native managed SSH masked prompts, trust, terminal I/O and SFTP upload/download over real preload');
    const folderSource = path.join(fixture.local, 'folder-source'), folderDownload = path.join(fixture.local, 'folder-download');
    await fsp.mkdir(path.join(folderSource, 'nested'), { recursive: true });
    await fsp.mkdir(path.join(folderSource, 'empty'));
    await fsp.writeFile(path.join(folderSource, 'nested', 'payload.bin'), payload);
    await fsp.writeFile(path.join(folderSource, 'zero.txt'), '');
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const connecting = window.termforge.transferOpen({profile:${JSON.stringify(profile)}});
      ${respondToPassword}
      const connection = await connecting; state.transferIds.push(connection.id); state.folderConnection = connection.id;
      const review = await window.termforge.transferPrepareFolder({id:connection.id,direction:'upload',localPath:${JSON.stringify(folderSource)},remotePath:'/folder-copy'});
      if (review.files !== 2 || review.directories !== 3 || review.totalBytes !== 140000 || review.entries.length !== 5) throw new Error('Native folder review counts are incorrect');
      const result = await window.termforge.transferStartFolder({planId:review.planId});
      if (!result.cancelled) throw new Error('Native decline must cancel folder copy');
      let reused = false; try { await window.termforge.transferStartFolder({planId:review.planId}); reused = true; } catch {}
      if (reused) throw new Error('Declined folder token was reusable');
    `);
    await assert.rejects(fsp.stat(path.join(fixture.remote, 'folder-copy')), { code: 'ENOENT' });
    allowFolder = true;
    await evaluate(`
      const state = window.__termforgeSecureSmoke, id = state.folderConnection;
      for (const input of [
        {id,direction:'upload',localPath:${JSON.stringify(folderSource)},remotePath:'/folder-copy'},
        {id,direction:'download',localPath:${JSON.stringify(folderDownload)},remotePath:'/folder-copy'}
      ]) {
        const plan = await window.termforge.transferPrepareFolder(input);
        const job = await window.termforge.transferStartFolder({planId:plan.planId});
        await wait(() => ['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status), 'native nested folder copy');
        const done = state.jobs[job.transferId];
        if (done.status !== 'completed' || done.filesCompleted !== 2 || done.directoriesCreated !== 3 || done.bytes !== 140000) throw new Error('Native folder copy failed: ' + JSON.stringify(done));
        let reused = false; try { await window.termforge.transferStartFolder({planId:plan.planId}); reused = true; } catch {}
        if (reused) throw new Error('Applied folder token was reusable');
      }
      const disposable = await window.termforge.transferPrepareFolder({id,direction:'upload',localPath:${JSON.stringify(folderSource)},remotePath:'/discarded-folder'});
      if (!await window.termforge.transferDiscardFolder({planId:disposable.planId})) throw new Error('Native folder discard did not release review');
    `);
    assert.equal(folderApprovals, 2);
    for (const root of [path.join(fixture.remote, 'folder-copy'), folderDownload]) {
      assert.deepEqual((await fsp.readdir(root)).sort(), ['empty', 'nested', 'zero.txt']);
      assert.deepEqual(await fsp.readdir(path.join(root, 'empty')), []);
      assert.deepEqual(await fsp.readFile(path.join(root, 'nested', 'payload.bin')), payload);
      assert.equal((await fsp.readFile(path.join(root, 'zero.txt'))).length, 0);
    }
    await assert.rejects(fsp.stat(path.join(fixture.remote, 'discarded-folder')), { code: 'ENOENT' });
    report.nativeFolderRoundTrip = true; report.nativeFolderDeclineAndDiscard = true;
    console.log('PASS native reviewed nested folder upload/download, empty folders, approval decline and single-use tokens');
    await fsp.writeFile(path.join(folderSource, 'zero.txt'), 'source-value');
    await fsp.writeFile(path.join(folderSource, 'merge-only.txt'), 'added');
    await fsp.writeFile(path.join(fixture.remote, 'folder-copy', 'zero.txt'), 'old');
    await fsp.writeFile(path.join(fixture.remote, 'folder-copy', 'target-only.txt'), 'retain this');
    await evaluate(`
      const state = window.__termforgeSecureSmoke, id = state.folderConnection;
      const merge = await window.termforge.transferPrepareFolder({id,direction:'upload',mode:'merge',conflictPolicy:'skip',localPath:${JSON.stringify(folderSource)},remotePath:'/folder-copy'});
      if (merge.mode !== 'merge' || !merge.entries.some(entry => entry.relativePath === 'merge-only.txt' && entry.action === 'copy') || !merge.entries.some(entry => entry.relativePath === 'zero.txt' && entry.action === 'skip')) throw new Error('Native merge review did not preserve conflict policy');
      const job = await window.termforge.transferStartFolder({planId:merge.planId});
      await wait(() => ['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status), 'native folder merge');
      if (state.jobs[job.transferId].status !== 'completed') throw new Error('Native merge failed: ' + JSON.stringify(state.jobs[job.transferId]));
    `);
    assert.equal(await fsp.readFile(path.join(fixture.remote, 'folder-copy', 'zero.txt'), 'utf8'), 'old');
    assert.equal(await fsp.readFile(path.join(fixture.remote, 'folder-copy', 'merge-only.txt'), 'utf8'), 'added');
    await evaluate(`
      const state = window.__termforgeSecureSmoke, id = state.folderConnection;
      const sync = await window.termforge.transferPrepareFolder({id,direction:'upload',mode:'sync',conflictPolicy:'replace',localPath:${JSON.stringify(folderSource)},remotePath:'/folder-copy'});
      if (sync.mode !== 'sync' || sync.kept !== 1 || !sync.entries.some(entry => entry.relativePath === 'zero.txt' && entry.action === 'replace') || !sync.entries.some(entry => entry.relativePath === 'nested/payload.bin' && entry.action === 'skip')) throw new Error('Native content synchronization review was incorrect');
      const job = await window.termforge.transferStartFolder({planId:sync.planId});
      await wait(() => ['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status), 'native content synchronization');
      if (state.jobs[job.transferId].status !== 'completed') throw new Error('Native synchronization failed: ' + JSON.stringify(state.jobs[job.transferId]));
    `);
    assert.equal(await fsp.readFile(path.join(fixture.remote, 'folder-copy', 'zero.txt'), 'utf8'), 'source-value');
    assert.equal(await fsp.readFile(path.join(fixture.remote, 'folder-copy', 'target-only.txt'), 'utf8'), 'retain this');
    assert.equal(folderApprovals, 4); report.nativeFolderMerge = true; report.nativeContentSynchronization = true;
    console.log('PASS native reviewed folder merge, content synchronization, conflict decisions and retained target-only files');
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      state.edit = await window.termforge.remoteEditOpen({id:state.folderConnection,path:'/folder-copy/zero.txt'});
      if (state.edit.text !== 'source-value') throw new Error('Native remote editor did not read the SFTP file');
      const plan = await window.termforge.remoteEditPrepareSave({documentId:state.edit.documentId,text:'edited-value\\n',revision:state.edit.revision});
      if (plan.before !== 'source-value' || plan.after !== 'edited-value\\n') throw new Error('Native editor review content mismatch');
      const declined = await window.termforge.remoteEditSave({planId:plan.planId}); if (!declined.cancelled) throw new Error('Native remote edit decline was not honored');
    `);
    assert.equal(await fsp.readFile(path.join(fixture.remote, 'folder-copy', 'zero.txt'), 'utf8'), 'source-value');
    allowEdit = true;
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const plan = await window.termforge.remoteEditPrepareSave({documentId:state.edit.documentId,text:'edited-value\\n',revision:state.edit.revision});
      const saved = await window.termforge.remoteEditSave({planId:plan.planId});
      if (!saved.saved || saved.text !== 'edited-value\\n' || !saved.revision || saved.revision === state.edit.revision) throw new Error('Native editor did not acknowledge a new saved revision');
      let reused = false; try { await window.termforge.remoteEditSave({planId:plan.planId}); reused = true; } catch {}
      if (reused) throw new Error('Native editor save token was reusable');
      await window.termforge.remoteEditClose({documentId:state.edit.documentId});
      state.edit = await window.termforge.remoteEditOpen({id:state.folderConnection,path:'/folder-copy/zero.txt'});
    `);
    assert.equal(await fsp.readFile(path.join(fixture.remote, 'folder-copy', 'zero.txt'), 'utf8'), 'edited-value\n');
    await fsp.writeFile(path.join(fixture.remote, 'folder-copy', 'zero.txt'), 'external-change');
    await evaluate(`
      const state = window.__termforgeSecureSmoke; let rejected = false;
      try { await window.termforge.remoteEditPrepareSave({documentId:state.edit.documentId,text:'stale edit',revision:state.edit.revision}); } catch (error) { rejected = /changed/i.test(error.message); }
      if (!rejected) throw new Error('Native editor failed to detect the externally changed revision');
      await window.termforge.remoteEditClose({documentId:state.edit.documentId}); state.edit = null;
    `);
    assert.equal(await fsp.readFile(path.join(fixture.remote, 'folder-copy', 'zero.txt'), 'utf8'), 'external-change');
    assert.equal(editApprovals, 1); report.nativeRemoteEditing = true; report.nativeRemoteEditConflictAndDecline = true;
    console.log('PASS native remote editor read, reviewed save, decline, single-use token and external-change conflict');
    const resumeSource = path.join(fixture.local, 'resume-source.bin'), resumeDownload = path.join(fixture.local, 'resume-download.bin');
    const resumePayload = Buffer.alloc(2 * 1024 * 1024); for (let index = 0; index < resumePayload.length; index++) resumePayload[index] = index % 239;
    await fsp.writeFile(resumeSource, resumePayload); fixture.controls.writeDelayMs = 15;
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const job = await window.termforge.transferStart({id:state.folderConnection,direction:'upload',protocol:'sftp',resumable:true,localPath:${JSON.stringify(resumeSource)},remotePath:'/resumed.bin'}); state.recoveryId = job.transferId;
      await wait(() => state.jobs[job.transferId]?.status === 'running' && state.jobs[job.transferId].bytes > 0, 'resumable upload progress');
      if (!await window.termforge.transferPause(job.transferId)) throw new Error('Native upload pause did not pause');
      const paused = (await window.termforge.transferListJobs()).find(item => item.transferId === job.transferId);
      if (paused?.status !== 'paused' || !paused.resumeAvailable || paused.retainedBytes <= 0 || paused.retainedBytes >= paused.total) throw new Error('Native upload did not retain a partial recovery record');
      const declined = await window.termforge.transferResume({transferId:job.transferId,id:state.folderConnection}); if (!declined.cancelled) throw new Error('Native resume decline was not honored');
    `);
    assert.equal((await fsp.readdir(path.join(profileDirectory, 'transfer-recovery'))).filter(name => name.endsWith('.json')).length, 1);
    await assert.rejects(fsp.stat(path.join(fixture.remote, 'resumed.bin')), { code: 'ENOENT' });
    allowResume = true;
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      await window.termforge.transferResume({transferId:state.recoveryId,id:state.folderConnection});
      await wait(() => ['completed','failed','cancelled','interrupted'].includes(state.jobs[state.recoveryId]?.status), 'native verified resume', 30000);
      if (state.jobs[state.recoveryId].status !== 'completed') throw new Error('Native resume failed: ' + JSON.stringify(state.jobs[state.recoveryId]));
    `);
    fixture.controls.writeDelayMs = 0;
    assert.deepEqual(await fsp.readFile(path.join(fixture.remote, 'resumed.bin')), resumePayload);
    assert.equal((await fsp.readdir(path.join(profileDirectory, 'transfer-recovery'))).filter(name => name.endsWith('.json')).length, 0);
    const resumeFolder = path.join(fixture.local,'resume-folder-source');
    await fsp.mkdir(path.join(resumeFolder,'nested'),{recursive:true});await fsp.mkdir(path.join(resumeFolder,'empty'));
    await fsp.writeFile(path.join(resumeFolder,'a.txt'),'abc');await fsp.writeFile(path.join(resumeFolder,'nested','b.bin'),payload.subarray(3));
    fixture.controls.writeDelayMs=30;
    await evaluate(`
      const state=window.__termforgeSecureSmoke,id=state.folderConnection;
      const plan=await window.termforge.transferPrepareFolder({id,direction:'upload',localPath:${JSON.stringify(resumeFolder)},remotePath:'/resumed-folder',resumable:true});
      if(!plan.resumable)throw new Error('Folder review did not expose durable recovery');
      const job=await window.termforge.transferStartFolder({planId:plan.planId});state.folderRecoveryId=job.transferId;
      await wait(()=>state.jobs[job.transferId]?.status==='running'&&state.jobs[job.transferId].filesCompleted===1&&state.jobs[job.transferId].bytes>3,'partial folder after completed child');
      if(!await window.termforge.transferPause(job.transferId))throw new Error('Native folder did not pause');
      const paused=(await window.termforge.transferListJobs()).find(item=>item.transferId===job.transferId);
      if(paused.kind!=='folder'||!paused.resumeAvailable||paused.filesCompleted!==1||paused.retainedBytes>=paused.total)throw new Error('Native folder recovery state is incorrect: '+JSON.stringify(paused));
    `);
    assert.equal((await fsp.readdir(path.join(profileDirectory,'transfer-recovery'))).filter(name=>name.endsWith('.json')).length,1);
    assert.equal(await fsp.readFile(path.join(fixture.remote,'resumed-folder','a.txt'),'utf8'),'abc');
    await assert.rejects(fsp.stat(path.join(fixture.remote,'resumed-folder','nested','b.bin')),{code:'ENOENT'});
    await evaluate(`
      const state=window.__termforgeSecureSmoke;await window.termforge.transferResume({transferId:state.folderRecoveryId,id:state.folderConnection});
      await wait(()=>['completed','failed','interrupted'].includes(state.jobs[state.folderRecoveryId]?.status),'native verified folder resume',30000);
      const done=state.jobs[state.folderRecoveryId];if(done.status!=='completed'||done.filesCompleted!==2||done.directoriesCreated!==3)throw new Error('Native folder resume failed: '+JSON.stringify(done));
    `);
    fixture.controls.writeDelayMs=0;
    assert.deepEqual(await fsp.readFile(path.join(fixture.remote,'resumed-folder','nested','b.bin')),payload.subarray(3));
    assert.equal((await fsp.readdir(path.join(profileDirectory,'transfer-recovery'))).filter(name=>name.endsWith('.json')).length,0);
    report.nativeFolderResume=true;console.log('PASS native folder recovery retains completed children and verifies the resumed partial');
    const syncLocal=path.join(fixture.local,'two-way'),syncRemote=path.join(fixture.remote,'two-way');
    await fsp.mkdir(syncLocal);await fsp.mkdir(syncRemote);await fsp.writeFile(path.join(syncLocal,'local.txt'),'local-only');await fsp.writeFile(path.join(syncRemote,'remote.txt'),'remote-only');
    await fsp.writeFile(path.join(syncLocal,'conflict.txt'),'local conflict');await fsp.writeFile(path.join(syncRemote,'conflict.txt'),'remote winner');
    await evaluate(`
      const state=window.__termforgeSecureSmoke,id=state.folderConnection,input={id,direction:'upload',mode:'two-way',localPath:${JSON.stringify(syncLocal)},remotePath:'/two-way'};
      const unresolved=await window.termforge.transferPrepareFolder(input);if(unresolved.unresolved!==1)throw new Error('Native two-way conflict was not detected');
      let refused=false;try{await window.termforge.transferStartFolder({planId:unresolved.planId});}catch{refused=true;}if(!refused)throw new Error('Unresolved two-way conflict was applied');
      const review=await window.termforge.transferPrepareFolder({...input,resolutions:[{relativePath:'conflict.txt',source:'remote'}]});
      const job=await window.termforge.transferStartFolder({planId:review.planId});await wait(()=>['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status),'native two-way sync');
      if(state.jobs[job.transferId].status!=='completed'||state.jobs[job.transferId].filesCompleted!==3)throw new Error('Native two-way sync failed: '+JSON.stringify(state.jobs[job.transferId]));
    `);
    for(const root of [syncLocal,syncRemote]){assert.equal(await fsp.readFile(path.join(root,'local.txt'),'utf8'),'local-only');assert.equal(await fsp.readFile(path.join(root,'remote.txt'),'utf8'),'remote-only');assert.equal(await fsp.readFile(path.join(root,'conflict.txt'),'utf8'),'remote winner');}
    await fsp.mkdir(path.join(syncRemote,'remove'));await fsp.writeFile(path.join(syncRemote,'remove','extra.txt'),'delete this');await fsp.writeFile(path.join(syncLocal,'local.txt'),'updated source');
    allowFolder=false;
    await evaluate(`
      const state=window.__termforgeSecureSmoke,review=await window.termforge.transferPrepareFolder({id:state.folderConnection,direction:'upload',mode:'mirror',localPath:${JSON.stringify(syncLocal)},remotePath:'/two-way'});
      if(review.deletedFiles!==1||review.deletedDirectories!==1)throw new Error('Native mirror deletion inventory is incorrect');const result=await window.termforge.transferStartFolder({planId:review.planId});if(!result.cancelled)throw new Error('Native mirror decline was ignored');
    `);
    assert.equal(await fsp.readFile(path.join(syncRemote,'remove','extra.txt'),'utf8'),'delete this');assert.equal(await fsp.readFile(path.join(syncRemote,'local.txt'),'utf8'),'local-only');
    allowFolder=true;
    await evaluate(`
      const state=window.__termforgeSecureSmoke,review=await window.termforge.transferPrepareFolder({id:state.folderConnection,direction:'upload',mode:'mirror',localPath:${JSON.stringify(syncLocal)},remotePath:'/two-way'});
      const job=await window.termforge.transferStartFolder({planId:review.planId});await wait(()=>['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status),'native reviewed mirror');
      const done=state.jobs[job.transferId];if(done.status!=='completed'||done.deletedFiles!==1||done.deletedDirectories!==1)throw new Error('Native mirror failed: '+JSON.stringify(done));
    `);
    assert.equal(await fsp.readFile(path.join(syncRemote,'local.txt'),'utf8'),'updated source');await assert.rejects(fsp.stat(path.join(syncRemote,'remove')),{code:'ENOENT'});
    report.nativeTwoWaySynchronization=true;report.nativeTwoWayExplicitConflict=true;report.nativeMirror=true;report.nativeMirrorNativeDecline=true;
    console.log('PASS native two-way direction choices and reviewed mirror deletions with decline');
    const persistentLocal=path.join(fixture.local,'persistent-sync'),persistentRemote=path.join(fixture.remote,'persistent-sync');
    await fsp.mkdir(persistentLocal);await fsp.mkdir(persistentRemote);
    await Promise.all([persistentLocal,persistentRemote].flatMap(root=>[fsp.writeFile(path.join(root,'file.txt'),'common baseline'),fsp.writeFile(path.join(root,'obsolete.txt'),'reviewed deletion target')]));
    await evaluate(`
      const state=window.__termforgeSecureSmoke;
      if((await window.termforge.transferListSyncPairs({id:state.folderConnection})).length)throw new Error('Isolated native sync history must begin empty');
      const input={id:state.folderConnection,direction:'upload',mode:'two-way',persistentSync:true,pairName:'Native persistent sync',localPath:${JSON.stringify(persistentLocal)},remotePath:'/persistent-sync'};
      const review=await window.termforge.transferPrepareFolder(input);
      if(!review.syncPair?.isNew||review.baselineUsed||review.files!==0)throw new Error('First converged sync must explicitly initialize a new baseline');
      state.syncPairId=review.syncPair.pairId;
      const job=await window.termforge.transferStartFolder({planId:review.planId});
      await wait(()=>['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status),'initialize persistent sync');
      if(state.jobs[job.transferId].status!=='completed')throw new Error('Persistent sync initialization failed: '+JSON.stringify(state.jobs[job.transferId]));
      const pairs=await window.termforge.transferListSyncPairs({id:state.folderConnection});
      if(pairs.length!==1||pairs[0].pairId!==state.syncPairId||!pairs[0].lastSyncedAt)throw new Error('Committed baseline missing from saved pairs');
      state.syncRevision=pairs[0].revision;
      await window.termforge.transferClose(state.folderConnection);
      const connecting=window.termforge.transferOpen({profile:${JSON.stringify(profile)}});
      ${respondToPassword}
      const connection=await connecting;state.folderConnection=connection.id;state.transferIds.push(connection.id);
      const restored=await window.termforge.transferListSyncPairs({id:connection.id});
      if(restored.length!==1||restored[0].pairId!==state.syncPairId||restored[0].revision!==state.syncRevision)throw new Error('Reconnect lost or advanced the persistent baseline');
    `);
    for(const [side,content,direction] of [['local','changed locally','upload'],['remote','changed remotely','download']]) {
      await fsp.writeFile(path.join(side==='local'?persistentLocal:persistentRemote,'file.txt'),content);
      await evaluate(`
        const state=window.__termforgeSecureSmoke;
        const review=await window.termforge.transferPrepareFolder({id:state.folderConnection,direction:'upload',mode:'two-way',persistentSync:true,syncPairId:state.syncPairId,localPath:${JSON.stringify(persistentLocal)},remotePath:'/persistent-sync'});
        const entry=review.entries.find(item=>item.relativePath==='file.txt');
        if(!review.baselineUsed||review.unresolved!==0||review.files!==1||entry?.action!=='replace'||entry.direction!==${JSON.stringify(direction)})throw new Error('Baseline did not infer the one-sided change: '+JSON.stringify(review));
        const job=await window.termforge.transferStartFolder({planId:review.planId});
        await wait(()=>['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status),'apply persistent ${direction}');
        if(state.jobs[job.transferId].status!=='completed'||state.jobs[job.transferId].filesCompleted!==1)throw new Error('Persistent direction failed: '+JSON.stringify(state.jobs[job.transferId]));
        const pairs=await window.termforge.transferListSyncPairs({id:state.folderConnection});
        if(pairs.length!==1||pairs[0].revision<=state.syncRevision)throw new Error('Verified sync did not advance baseline revision');
        state.syncRevision=pairs[0].revision;
      `);
      for(const root of [persistentLocal,persistentRemote])assert.equal(await fsp.readFile(path.join(root,'file.txt'),'utf8'),content);
    }
    await fsp.unlink(path.join(persistentLocal,'obsolete.txt'));allowFolder=false;
    await evaluate(`
      const state=window.__termforgeSecureSmoke;
      const input={id:state.folderConnection,direction:'upload',mode:'two-way',persistentSync:true,syncPairId:state.syncPairId,localPath:${JSON.stringify(persistentLocal)},remotePath:'/persistent-sync'};
      const review=await window.termforge.transferPrepareFolder(input),deletions=review.entries.filter(entry=>entry.action.startsWith('delete-'));
      if(!review.baselineUsed||review.unresolved!==0||review.files!==0||review.deletedFiles!==1||review.deletedDirectories!==0||deletions.length!==1||deletions[0].relativePath!=='obsolete.txt'||deletions[0].direction!=='upload')throw new Error('Persistent deletion review did not identify exactly the removed local file: '+JSON.stringify(review));
      const result=await window.termforge.transferStartFolder({planId:review.planId});if(!result.cancelled)throw new Error('Persistent deletion native decline was ignored');
      const pair=(await window.termforge.transferListSyncPairs({id:state.folderConnection}))[0];
      if(pair.revision!==state.syncRevision)throw new Error('Declined persistent deletion advanced the baseline');
    `);
    assert.equal(await fsp.readFile(path.join(persistentRemote,'obsolete.txt'),'utf8'),'reviewed deletion target');
    assert.equal(await fsp.readFile(path.join(persistentRemote,'file.txt'),'utf8'),'changed remotely');
    allowFolder=true;
    await evaluate(`
      const state=window.__termforgeSecureSmoke;
      const review=await window.termforge.transferPrepareFolder({id:state.folderConnection,direction:'upload',mode:'two-way',persistentSync:true,syncPairId:state.syncPairId,localPath:${JSON.stringify(persistentLocal)},remotePath:'/persistent-sync'});
      if(review.deletedFiles!==1||review.deletedDirectories!==0||review.files!==0||review.unresolved!==0)throw new Error('Persistent deletion changed after decline');
      const job=await window.termforge.transferStartFolder({planId:review.planId});
      await wait(()=>['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status),'apply persistent deletion');
      const result=state.jobs[job.transferId];if(result.status!=='completed'||result.deletedFiles!==1||result.deletedDirectories!==0||result.filesCompleted!==0)throw new Error('Approved persistent deletion failed: '+JSON.stringify(result));
      const pair=(await window.termforge.transferListSyncPairs({id:state.folderConnection}))[0];
      if(pair.revision<=state.syncRevision)throw new Error('Verified persistent deletion did not advance baseline');state.syncRevision=pair.revision;
    `);
    for(const root of [persistentLocal,persistentRemote]) {
      assert.deepEqual(await fsp.readdir(root),['file.txt']);
      assert.equal(await fsp.readFile(path.join(root,'file.txt'),'utf8'),'changed remotely');
    }
    report.nativePersistentDeletionReview=true;
    await fsp.writeFile(path.join(persistentLocal,'file.txt'),'local divergent edit');await fsp.writeFile(path.join(persistentRemote,'file.txt'),'remote divergent edit');
    await evaluate(`
      const state=window.__termforgeSecureSmoke,input={id:state.folderConnection,direction:'upload',mode:'two-way',persistentSync:true,syncPairId:state.syncPairId,localPath:${JSON.stringify(persistentLocal)},remotePath:'/persistent-sync'};
      const unresolved=await window.termforge.transferPrepareFolder(input);
      if(unresolved.unresolved!==1||!unresolved.entries.find(item=>item.relativePath==='file.txt')?.conflictReason)throw new Error('Concurrent baseline changes did not require a conflict decision');
      await window.termforge.transferDiscardFolder({planId:unresolved.planId});
      const skipped=await window.termforge.transferPrepareFolder({...input,resolutions:[{relativePath:'file.txt',source:'skip'}]});
      const job=await window.termforge.transferStartFolder({planId:skipped.planId});
      await wait(()=>['completed','failed','cancelled'].includes(state.jobs[job.transferId]?.status),'skip persistent conflict');
      if(state.jobs[job.transferId].status!=='completed'||state.jobs[job.transferId].filesCompleted!==0)throw new Error('Skipped conflict unexpectedly copied files');
      const again=await window.termforge.transferPrepareFolder(input);
      if(again.unresolved!==1||!again.baselineUsed)throw new Error('Skipped divergent conflict was silently recorded as synchronized');
      await window.termforge.transferDiscardFolder({planId:again.planId});
      const pair=(await window.termforge.transferListSyncPairs({id:state.folderConnection}))[0];state.syncRevision=pair.revision;
      const declined=await window.termforge.transferForgetSyncPair({id:state.folderConnection,pairId:state.syncPairId,revision:state.syncRevision});
      if(declined.forgotten||(await window.termforge.transferListSyncPairs({id:state.folderConnection})).length!==1)throw new Error('Native baseline forget decline was ignored');
    `);
    allowForgetPair=true;
    await evaluate(`
      const state=window.__termforgeSecureSmoke;
      const forgotten=await window.termforge.transferForgetSyncPair({id:state.folderConnection,pairId:state.syncPairId,revision:state.syncRevision});
      if(!forgotten.forgotten||(await window.termforge.transferListSyncPairs({id:state.folderConnection})).length)throw new Error('Approved baseline forget did not remove only its record');
    `);
    assert.equal(forgottenPairs,1);
    assert.equal(await fsp.readFile(path.join(persistentLocal,'file.txt'),'utf8'),'local divergent edit');assert.equal(await fsp.readFile(path.join(persistentRemote,'file.txt'),'utf8'),'remote divergent edit');
    report.nativePersistentTwoWayBaseline=true;report.nativeSyncSkippedConflictPreserved=true;report.nativeSyncBaselineForgetApproval=true;
    console.log('PASS native persistent sync reconnect, inferred changes, skipped conflict preservation and baseline-only forgetting');
    fixture.controls.readDelayMs = 10;
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const job = await window.termforge.transferStart({id:state.folderConnection,direction:'download',protocol:'sftp',resumable:true,localPath:${JSON.stringify(resumeDownload)},remotePath:'/resumed.bin'}); state.downloadRecoveryId = job.transferId;
      await wait(() => state.jobs[job.transferId]?.status === 'running' && state.jobs[job.transferId].bytes > 0, 'resumable download progress');
      if (!await window.termforge.transferPause(job.transferId)) throw new Error('Native download pause did not pause');
      await window.termforge.transferClose(state.folderConnection);
      const declined = await window.termforge.transferDiscardPartial({transferId:job.transferId}); if (!declined.cancelled) throw new Error('Native partial discard decline was not honored');
    `);
    fixture.controls.readDelayMs = 0; allowDiscard = true;
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const discarded = await window.termforge.transferDiscardPartial({transferId:state.downloadRecoveryId});
      if (!discarded.discarded || discarded.retainedFiles.length) throw new Error('Native offline partial discard did not complete');
    `);
    assert.equal((await fsp.readdir(path.join(profileDirectory, 'transfer-recovery'))).filter(name => name.endsWith('.json')).length, 0);
    await assert.rejects(fsp.stat(resumeDownload), { code: 'ENOENT' });
    assert.ok(!(await fsp.readdir(fixture.local)).some(name => name.startsWith('.termforge-')), 'Native partial cleanup left a local staging file');
    assert.equal(resumeApprovals, 2); assert.equal(discardApprovals, 1);
    report.nativeResumableUpload = true; report.nativePausedDownloadDiscard = true; report.nativeRecoveryNativeDecline = true;
    console.log('PASS native durable pause, verified SFTP resume, native approval decline and offline local partial cleanup');
    const authBeforeCancel = fixture.authentication.length;
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      const opened = await window.termforge.terminalOpen({profile:${JSON.stringify(profile)}}); state.ids.push(opened.id);
      await wait(() => document.getElementById('ssh-auth-dialog')?.open, 'cancel fixture prompt');
      const field = document.getElementById('auth-response-0'); field.value = 'cancelled-fixture-secret';
      document.getElementById('auth-cancel').click();
      await wait(() => !document.getElementById('ssh-auth-dialog').open && document.getElementById('auth-fields').children.length === 0 && state.exited.includes(opened.id), 'cancelled authentication closes terminal and dialog');
      if (field.value !== '') throw new Error('Cancelled input was not cleared');
    `);
    assert.equal(fixture.authentication.length, authBeforeCancel, 'Cancelled password must never reach SSH authentication');
    await fixture.close(); changed = await startFixture(fixtureDirectory, () => false, { port: fixture.port });
    await evaluate(`
      const state = window.__termforgeSecureSmoke, promptCount = state.prompts.length;
      const opened = await window.termforge.terminalOpen({profile:${JSON.stringify(profile)}}); state.ids.push(opened.id);
      await wait(() => state.exited.includes(opened.id), 'changed host rejected through real IPC');
      if (!state.output[opened.id]?.includes('SSH host key changed')) throw new Error('Changed host did not report a blocked connection');
      if (state.prompts.length !== promptCount || document.getElementById('ssh-auth-dialog').open) throw new Error('Changed host reached the password dialog');
    `);
    assert.equal(approvals, 1); assert.deepEqual(changed.authentication, []);
    if (status.available) {
      assert.deepEqual(await evaluate('return await window.termforge.credentialDelete(window.__termforgeSecureSmoke.credentialId);'), { deleted: true });
      assert.deepEqual(await evaluate('return await window.termforge.credentialList();'), []); assert.equal(deletionApprovals, 1);
    }
    const observed = await evaluate(`const state = window.__termforgeSecureSmoke; return {prompts:state.prompts,closed:state.closed,output:Object.values(state.output).join(''),jobs:Object.values(state.jobs).map(job => ({status:job.status,bytes:job.bytes}))};`);
    assert.equal(observed.prompts.length, 5); assert.deepEqual([...observed.closed].sort(), observed.prompts.map(prompt => prompt.id).sort());
    assert.ok(observed.prompts.every(prompt => prompt.kind === 'password' && prompt.prompts.length === 1 && prompt.prompts[0].echo === false));
    assert.ok(!JSON.stringify(observed).includes(secret.password) && !observed.output.includes('cancelled-fixture-secret'));
    assert.equal(writes.length, 1, 'Only the explicit command probe may reach terminalWrite'); assert.equal(writes[0].data, 'native-managed-probe\r');
    report.nativeManagedSsh = true; report.nativeHostVerificationBeforeAuthentication = true; report.nativeChangedHostBlocked = true;
    report.nativeAuthPromptCleared = true; report.nativeAuthCancellation = true; report.nativeNoPasswordTerminalWrite = true;
    Object.assign(report, await require('./ftp-smoke.cjs')({ window, directory }));
    await fsp.writeFile(path.join(directory, 'secure-native.json'), JSON.stringify(report, null, 2));
    console.log('PASS native cancelled authentication cleanup, changed host refusal, and no password terminal writes');
    return report;
  } catch (error) {
    await fsp.writeFile(path.join(directory, 'secure-native-failure.json'), JSON.stringify({ message: error.message, stack: error.stack, completed: report }, null, 2)).catch(() => {});
    throw error;
  } finally {
    await evaluate(`
      const state = window.__termforgeSecureSmoke;
      if (state) {
        for (const id of state.ids) await window.termforge.terminalClose(id).catch(() => {});
        for (const id of state.transferIds) await window.termforge.transferClose(id).catch(() => {});
        if (state.credentialId) await window.termforge.credentialDelete(state.credentialId).catch(() => {});
        for (const dispose of state.subscriptions) dispose();
        document.getElementById('auth-cancel')?.click();
        delete window.__termforgeSecureSmoke;
      }
    `).catch(() => {});
    dialog.showMessageBox = originalDialog; terminals.write = originalWrite;
    await changed?.close(); await fixture?.close();
  }
};
