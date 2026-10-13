'use strict';
// Native CI-only: real preload IPC, native approval, masked authentication UI,
// and loopback FTP/FTPS. The launcher supplies the public fixture CA through
// NODE_EXTRA_CA_CERTS; application TLS verification remains fully enabled.
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const path = require('node:path');
const { startFtpFixture } = require('../tests/helpers/ftp-fixture.cjs');
module.exports = async ({ window, directory }) => {
  const { dialog } = require('electron'); const originalDialog = dialog.showMessageBox;
  const fixtures = [], report = {}; let allowPlaintext = false, plaintextReviews = 0;
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(directory, 'ftp-fixture-')));
  const local = path.join(root, 'local'); await fsp.mkdir(local); const payload = Buffer.concat([Buffer.from([0, 255, 10]), Buffer.alloc(130000, 0x63)]);
  await fsp.writeFile(path.join(local, 'source.bin'), payload);
  const evaluate = source => window.webContents.executeJavaScript(`(async () => { const wait = async (predicate, label) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Native FTP smoke timed out: ' + label); }; ${source} })()`);
  const fixture = async options => { const remote = path.join(root, `remote-${fixtures.length}`); await fsp.mkdir(remote); const peer = await startFtpFixture(remote, options); fixtures.push(peer); return { peer, remote }; };
  async function connect(peer, protocol, expectedFailure = false) {
    return evaluate(`
      const state = window.__termforgeFtpSmoke;
      const pending = window.termforge.ftpOpen(${JSON.stringify({ host: 'localhost', port: peer.port, protocol, username: 'native-ftp-user' })}).then(value => ({value}), error => ({error:String(error.message)}));
      await wait(() => document.getElementById('ssh-auth-dialog')?.open, 'masked FTP password prompt');
      const field = document.getElementById('auth-response-0'); if (!field || field.type !== 'password' || field.value !== '') throw new Error('FTP password input must be empty and masked');
      if (!document.getElementById('auth-target').textContent.includes('localhost')) throw new Error('FTP authentication must identify the server');
      field.value = 'Synthetic-FTP-password-123!'; document.getElementById('ssh-auth-form').requestSubmit();
      const result = await pending;
      await wait(() => !document.getElementById('ssh-auth-dialog').open && !document.getElementById('auth-fields').children.length, 'cleared FTP prompt');
      if (field.value !== '') throw new Error('Removed FTP password input retained its secret');
      ${expectedFailure ? "if (!result.error) throw new Error('Expected FTPS rejection'); return result;" : "if (result.error) throw new Error(result.error); state.ids.push(result.value.id); return result.value;"}
    `);
  }
  try {
    dialog.showMessageBox = async (_window, options) => {
      if (options.title !== 'Connect using unencrypted FTP') throw new Error('Unexpected native FTP smoke dialog: ' + options.title);
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.buttons[0], 'Cancel'); assert.match(options.detail, /without encryption/); plaintextReviews++; return { response: allowPlaintext ? 1 : 0 };
    };
    await evaluate(`
      if (location.href !== 'termforge://app/index.html') throw new Error('FTP smoke requires real preload');
      const state = window.__termforgeFtpSmoke = {ids:[],jobs:{},prompts:[],subscriptions:[]};
      state.subscriptions.push(window.termforge.onTransferEvent(event => { if (event.transferId) state.jobs[event.transferId] = event; }));
      state.subscriptions.push(window.termforge.onAuthPrompt(event => state.prompts.push({kind:event.kind,protocol:event.protocol,prompts:event.prompts})));
    `);
    const plain = await fixture({});
    const denied = await evaluate(`try { await window.termforge.ftpOpen(${JSON.stringify({ host: 'localhost', port: plain.peer.port, protocol: 'ftp', username: 'native-ftp-user' })}); return false; } catch (error) { return String(error.message).includes('declined'); }`);
    assert.equal(denied, true); assert.equal(plain.peer.controls, 0); assert.equal(await evaluate('return window.__termforgeFtpSmoke.prompts.length;'), 0);
    report.nativeFtpPlaintextDeclineBeforeCredentials = true;
    for (const protocol of ['ftp', 'ftps', 'ftps-implicit']) {
      allowPlaintext = protocol === 'ftp'; const peer = protocol === 'ftp' ? plain : await fixture({ implicit: protocol === 'ftps-implicit' }); const session = await connect(peer.peer, protocol);
      await evaluate(`
        const state = window.__termforgeFtpSmoke;
        const uploaded = await window.termforge.transferStart(${JSON.stringify({ id: session.id, protocol, direction: 'upload', localPath: path.join(local, 'source.bin'), remotePath: '/remote.bin' })});
        await wait(() => ['completed','failed','cancelled'].includes(state.jobs[uploaded.transferId]?.status), 'FTP upload'); if (state.jobs[uploaded.transferId].status !== 'completed') throw new Error(JSON.stringify(state.jobs[uploaded.transferId]));
        const listing = await window.termforge.transferListRemote({id:${JSON.stringify(session.id)},path:'/'}); if (!listing.entries.some(item => item.name === 'remote.bin' && item.size === ${payload.length})) throw new Error('FTP listing missed uploaded file');
        const downloaded = await window.termforge.transferStart(${JSON.stringify({ id: session.id, protocol, direction: 'download', localPath: path.join(local, `${protocol}-download.bin`), remotePath: '/remote.bin' })});
        await wait(() => ['completed','failed','cancelled'].includes(state.jobs[downloaded.transferId]?.status), 'FTP download'); if (state.jobs[downloaded.transferId].status !== 'completed') throw new Error(JSON.stringify(state.jobs[downloaded.transferId]));
        if (!(await window.termforge.transferListJobs()).some(job => job.transferId === downloaded.transferId && job.status === 'completed')) throw new Error('FTP job missing from shared queue');
        await window.termforge.transferClose(${JSON.stringify(session.id)});
      `);
      assert.deepEqual(await fsp.readFile(path.join(peer.remote, 'remote.bin')), payload); assert.deepEqual(await fsp.readFile(path.join(local, `${protocol}-download.bin`)), payload);
      assert.ok(peer.peer.encryptedLogins.every(value => value === (protocol !== 'ftp'))); assert.ok(peer.peer.dataTls.every(value => value === (protocol !== 'ftp')));
      report[protocol === 'ftp' ? 'nativeFtpRoundtrip' : protocol === 'ftps' ? 'nativeExplicitFtpsRoundtrip' : 'nativeImplicitFtpsRoundtrip'] = true;
    }
    const badControl = await fixture({ controlWrong: true }); await connect(badControl.peer, 'ftps', true); assert.deepEqual(badControl.peer.encryptedLogins, []); report.nativeFtpsControlCertificateRejected = true;
    const badData = await fixture({ dataWrong: true }); const badSession = await connect(badData.peer, 'ftps');
    assert.equal(await evaluate(`try { await window.termforge.transferListRemote({id:${JSON.stringify(badSession.id)},path:'/'}); return false; } catch (error) { return /certificate|self.signed|altname|hostname/i.test(error.message); }`), true);
    report.nativeFtpsDataCertificateRejected = true;
    const observed = await evaluate('return {prompts:window.__termforgeFtpSmoke.prompts,jobs:Object.values(window.__termforgeFtpSmoke.jobs)};');
    assert.ok(observed.prompts.every(item => item.kind === 'password' && item.prompts[0].echo === false && ['ftp','ftps','ftps-implicit'].includes(item.protocol))); assert.ok(!JSON.stringify(observed).includes('Synthetic-FTP-password-123!'));
    assert.equal(plaintextReviews, 2); report.nativeFtpMaskedCredentials = true;
    await fsp.writeFile(path.join(directory, 'ftp-native.json'), JSON.stringify(report, null, 2)); console.log('PASS native FTP/explicit FTPS/implicit FTPS round trips, native plaintext approval, masked credentials, control/data certificate rejection'); return report;
  } catch (error) { await fsp.writeFile(path.join(directory, 'ftp-native-failure.json'), JSON.stringify({ message: error.message, stack: error.stack, completed: report }, null, 2)); throw error; }
  finally {
    await evaluate(`const state = window.__termforgeFtpSmoke; if (state) { for (const id of state.ids) await window.termforge.transferClose(id).catch(() => {}); for (const dispose of state.subscriptions) dispose(); document.getElementById('auth-cancel')?.click(); delete window.__termforgeFtpSmoke; }`).catch(() => {});
    dialog.showMessageBox = originalDialog; for (const peer of fixtures) await peer.close();
  }
};
