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
  const peers = new Set(), authentication = [], windows = [];
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
          let mode = flags & OPEN_MODE.WRITE ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
          if (flags & OPEN_MODE.CREAT) mode |= fs.constants.O_CREAT;
          if (flags & OPEN_MODE.EXCL) mode |= fs.constants.O_EXCL;
          if (flags & OPEN_MODE.TRUNC) mode |= fs.constants.O_TRUNC;
          stream.handle(id, remember({ file: await fsp.open(remoteFile(name), mode, attrs.mode || 0o600) }));
        });
        action('READ', async (id, handle, offset, length) => { const data = Buffer.alloc(Math.min(length, 65536)); const result = await lookup(handle).file.read(data, 0, data.length, offset); result.bytesRead ? stream.data(id, data.subarray(0, result.bytesRead)) : stream.status(id, STATUS_CODE.EOF); });
        action('WRITE', async (id, handle, offset, data) => { await lookup(handle).file.write(data, 0, data.length, offset); stream.status(id, STATUS_CODE.OK); });
        action('CLOSE', async (id, handle) => { const record = lookup(handle); handles.delete(handle.readUInt32BE()); await record.file?.close(); stream.status(id, STATUS_CODE.OK); });
        action('REMOVE', async (id, name) => { await fsp.unlink(remoteFile(name)); stream.status(id, STATUS_CODE.OK); });
        action('RENAME', async (id, from, to) => { await fsp.link(remoteFile(from), remoteFile(to)); await fsp.unlink(remoteFile(from)); stream.status(id, STATUS_CODE.OK); });
        stream.on('close', () => { for (const handle of handles.values()) handle.file?.close().catch(() => {}); handles.clear(); });
      });
    }));
  });
  server.listen(options.port || 0, '127.0.0.1'); await once(server, 'listening');
  let stopped = false;
  return { local, remote, port: server.address().port, authentication, windows,
    async close() { if (stopped) return; stopped = true; for (const peer of peers) peer.end(); await new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = async ({ window, terminals, directory }) => {
  const { dialog } = require('electron');
  const profileDirectory = path.resolve(process.env.TERMFORGE_DATA_DIR || '');
  assert.equal(path.dirname(profileDirectory), path.resolve(directory), 'Secure smoke requires a profile inside the isolated smoke directory');
  assert.equal(path.basename(profileDirectory), 'profile', 'Secure smoke cannot use a real application profile');
  const fixtureDirectory = await fsp.mkdtemp(path.join(directory, 'secure-fixture-'));
  let approved = false, approvals = 0, credentialApprovals = 0, deletionApprovals = 0, fixture, changed;
  const originalDialog = dialog.showMessageBox, originalWrite = terminals.write;
  const writes = [], report = {};
  const secret = { name: 'Native smoke credential', username: 'native-fixture-user', password: 'Native-fixture-password-123!' };
  const evaluate = source => window.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, label) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Native secure smoke timed out: ' + label); };
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
      if (options.title === 'Delete saved credential') {
        assert.equal(options.message, `Delete “${secret.name}”?`); deletionApprovals++; return { response: 1 };
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
      await window.termforge.transferClose(connection.id);
    `);
    assert.deepEqual(await fsp.readFile(path.join(fixture.remote, 'upload.bin')), payload);
    assert.deepEqual(await fsp.readFile(download), payload);
    assert.deepEqual((await fsp.readdir(fixture.local)).sort(), ['download.bin', 'upload.bin']);
    assert.deepEqual(await fsp.readdir(fixture.remote), ['upload.bin']);
    report.nativeSftpRoundTrip = true;
    console.log('PASS native managed SSH masked prompts, trust, terminal I/O and SFTP upload/download over real preload');
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
    assert.equal(observed.prompts.length, 3); assert.deepEqual([...observed.closed].sort(), observed.prompts.map(prompt => prompt.id).sort());
    assert.ok(observed.prompts.every(prompt => prompt.kind === 'password' && prompt.prompts.length === 1 && prompt.prompts[0].echo === false));
    assert.ok(!JSON.stringify(observed).includes(secret.password) && !observed.output.includes('cancelled-fixture-secret'));
    assert.equal(writes.length, 1, 'Only the explicit command probe may reach terminalWrite'); assert.equal(writes[0].data, 'native-managed-probe\r');
    report.nativeManagedSsh = true; report.nativeHostVerificationBeforeAuthentication = true; report.nativeChangedHostBlocked = true;
    report.nativeAuthPromptCleared = true; report.nativeAuthCancellation = true; report.nativeNoPasswordTerminalWrite = true;
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
