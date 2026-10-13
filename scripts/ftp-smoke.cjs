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
  const fixtures = [], report = {}; let allowPlaintext = false, plaintextReviews = 0, allowResume = false, allowFolder = false, resumeReviews = 0, folderReviews = 0;
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
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.buttons[0], 'Cancel');
      if (options.title === 'Resume retained transfer') {
        assert.match(options.detail, /Protocol: FTPS/); assert.match(options.detail, /original certificate identity/);
        if (resumeReviews < 2) assert.match(options.detail, /Retained bytes: Verify on server before resuming/);
        else assert.match(options.detail, /Retained bytes: [1-9][0-9]*/);
        resumeReviews++; return {response:allowResume?1:0};
      }
      if (options.title === 'Copy reviewed folder') {
        assert.match(options.detail, /Protocol: FTPS/); assert.match(options.detail, /Files: 2/); assert.match(options.detail, /Folders: 3/);
        assert.match(options.detail, /Completed changes remain/); folderReviews++; return {response:allowFolder?1:0};
      }
      if (options.title !== 'Connect using unencrypted FTP') throw new Error('Unexpected native FTP smoke dialog: ' + options.title);
      assert.match(options.detail, /without encryption/); plaintextReviews++; return { response: allowPlaintext ? 1 : 0 };
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
    // Resume goes through the same real preload routes and native decisions as
    // ordinary transfers. The initial upload uses STOR, then verified APPE;
    // the retained folder download uses REST and preserves completed children.
    const uploadPayload=Buffer.alloc(8*1024*1024,0x39),uploadFile=path.join(local,'resume-upload.bin');
    await fsp.writeFile(uploadFile,uploadPayload);
    let requestPause=false,pauseCompletion,pauseError,appendStart;
    const recovery=await fixture({slowUpload:true,beforeStore:async({verb,path:remotePath})=>{if(verb==='APPE')appendStart=(await fsp.stat(path.join(recovery.remote,path.posix.basename(remotePath)))).size;},afterStoreChunk:({bytes})=>{
      if(bytes<65536||requestPause)return;requestPause=true;
      // Do not await IPC from the server callback: the pause closes this data
      // connection and must allow its current server write to unwind.
      pauseCompletion=evaluate(`const state=window.__termforgeFtpSmoke;await wait(()=>Boolean(state.recoveryId),'recovery job registration');if(!await window.termforge.transferPause(state.recoveryId))throw new Error('Native FTP upload did not pause');`);
      pauseCompletion.catch(error=>{pauseError=error;});
    }});
    let recoverySession=await connect(recovery.peer,'ftps');
    const recoveryId=await evaluate(`
      const state=window.__termforgeFtpSmoke;
      const job=await window.termforge.transferStart(${JSON.stringify({id:recoverySession.id,protocol:'ftps',direction:'upload',resumable:true,localPath:uploadFile,remotePath:'/resumed-upload.bin'})});state.recoveryId=job.transferId;
      await wait(()=>['paused','interrupted','failed','completed'].includes(state.jobs[job.transferId]?.status),'retained FTP upload');
      if(state.jobs[job.transferId].status!=='paused'||!state.jobs[job.transferId].resumeAvailable||state.jobs[job.transferId].retainedBytesVerified!==false)throw new Error('FTP upload checkpoint not resumable: '+JSON.stringify(state.jobs[job.transferId]));return job.transferId;
    `);
    await pauseCompletion;if(pauseError)throw pauseError;
    const recoveryDirectory=path.join(process.env.TERMFORGE_DATA_DIR,'transfer-recovery','ftp');
    const uploadCheckpoint=JSON.parse(await fsp.readFile(path.join(recoveryDirectory,`${recoveryId}.json`),'utf8'));
    const stagePath=path.join(recovery.remote,path.posix.basename(uploadCheckpoint.stagePath));
    // Let buffered fixture writes unwind before comparing the retained prefix.
    let previousSize=-1,stable=0;const settleDeadline=Date.now()+3000;
    while(stable<3&&Date.now()<settleDeadline){const size=(await fsp.stat(stagePath)).size;stable=size===previousSize?stable+1:0;previousSize=size;await new Promise(resolve=>setTimeout(resolve,30));}
    assert.ok(stable>=3&&previousSize>0&&previousSize<uploadPayload.length,'Upload must retain an actual partial server prefix');
    const retainedPrefix=await fsp.readFile(stagePath);assert.deepEqual(retainedPrefix,uploadPayload.subarray(0,retainedPrefix.length));
    assert.ok(!JSON.stringify(uploadCheckpoint).includes('Synthetic-FTP-password-123!'));
    recovery.peer.tuning.uploadDelayMs=0;recoverySession=await connect(recovery.peer,'ftps');
    const declined=await evaluate(`return window.termforge.transferResume(${JSON.stringify({transferId:recoveryId,id:recoverySession.id})});`);
    assert.equal(declined.cancelled,true);assert.deepEqual((await fsp.readFile(stagePath)).subarray(0,retainedPrefix.length),retainedPrefix);
    allowResume=true;
    await evaluate(`
      const state=window.__termforgeFtpSmoke;await window.termforge.transferResume(${JSON.stringify({transferId:recoveryId,id:recoverySession.id})});
      await wait(()=>['completed','failed','interrupted'].includes(state.jobs[${JSON.stringify(recoveryId)}]?.status),'verified FTP upload resume');
      if(state.jobs[${JSON.stringify(recoveryId)}].status!=='completed')throw new Error(JSON.stringify(state.jobs[${JSON.stringify(recoveryId)}]));
    `);
    assert.deepEqual(await fsp.readFile(path.join(recovery.remote,'resumed-upload.bin')),uploadPayload);
    assert.ok(recovery.peer.transfers.some(item=>item.verb==='STOR'&&item.path===uploadCheckpoint.stagePath&&item.offset===0));
    assert.ok(appendStart>=retainedPrefix.length&&appendStart<uploadPayload.length);
    assert.ok(recovery.peer.transfers.some(item=>item.verb==='APPE'&&item.path===uploadCheckpoint.stagePath&&item.offset===appendStart));
    await assert.rejects(fsp.stat(path.join(recoveryDirectory,`${recoveryId}.json`)),{code:'ENOENT'});
    report.nativeFtpUploadResumeApproval=true;report.nativeFtpVerifiedAppendResume=true;

    const remoteTree=path.join(recovery.remote,'folder-source'),localTree=path.join(local,'folder-copy'),folderPayload=Buffer.alloc(512*1024,0x72);
    await fsp.mkdir(path.join(remoteTree,'z-nested'),{recursive:true});await fsp.mkdir(path.join(remoteTree,'empty'));
    await fsp.writeFile(path.join(remoteTree,'a-complete.txt'),'done');await fsp.writeFile(path.join(remoteTree,'z-nested','binary.bin'),folderPayload);
    const folderInput={id:recoverySession.id,direction:'download',protocol:'ftps',mode:'copy',resumable:true,localPath:localTree,remotePath:'/folder-source'};
    await evaluate(`
      const review=await window.termforge.transferPrepareFolder(${JSON.stringify(folderInput)});
      if(review.files!==2||review.directories!==3||review.totalBytes!==${folderPayload.length+4}||!review.resumable)throw new Error('FTP folder review counts are incorrect');
      const result=await window.termforge.transferStartFolder({planId:review.planId});if(!result.cancelled)throw new Error('FTP folder native decline was ignored');
    `);
    await assert.rejects(fsp.stat(localTree),{code:'ENOENT'});allowFolder=true;recovery.peer.tuning.downloadDelayMs=2;
    const folderId=await evaluate(`
      const state=window.__termforgeFtpSmoke;
      const dispose=window.termforge.onTransferEvent(event=>{
        if(event.transferId===state.folderRecoveryId&&event.status==='running'&&event.filesCompleted===1&&event.bytes>4&&!state.folderPause){state.folderPause=window.termforge.transferPause(event.transferId);state.folderPause.catch(()=>{});}
      });state.subscriptions.push(dispose);
      const review=await window.termforge.transferPrepareFolder(${JSON.stringify(folderInput)});
      const job=await window.termforge.transferStartFolder({planId:review.planId});state.folderRecoveryId=job.transferId;
      await wait(()=>['paused','interrupted','failed','completed'].includes(state.jobs[job.transferId]?.status),'FTP folder pause');
      const result=state.jobs[job.transferId];if(result.status!=='paused'||!result.resumeAvailable||result.filesCompleted!==1||!await state.folderPause)throw new Error('FTP folder checkpoint failed: '+JSON.stringify(result));return job.transferId;
    `);
    const folderCheckpoint=JSON.parse(await fsp.readFile(path.join(recoveryDirectory,`${folderId}.json`),'utf8'));
    assert.equal(folderCheckpoint.completed.length,1);assert.ok(folderCheckpoint.child.bytes>0&&folderCheckpoint.child.bytes<folderPayload.length);
    assert.equal(await fsp.readFile(path.join(localTree,'a-complete.txt'),'utf8'),'done');assert.equal((await fsp.stat(path.join(localTree,'empty'))).isDirectory(),true);
    const childPrefix=await fsp.readFile(folderCheckpoint.child.stagePath);assert.deepEqual(childPrefix,folderPayload.subarray(0,childPrefix.length));
    recovery.peer.tuning.downloadDelayMs=0;recoverySession=await connect(recovery.peer,'ftps');
    await evaluate(`
      const state=window.__termforgeFtpSmoke;await window.termforge.transferResume(${JSON.stringify({transferId:folderId,id:recoverySession.id})});
      await wait(()=>['completed','failed','interrupted'].includes(state.jobs[${JSON.stringify(folderId)}]?.status),'FTP folder resume');
      const result=state.jobs[${JSON.stringify(folderId)}];if(result.status!=='completed'||result.filesCompleted!==2||result.directoriesCreated!==3)throw new Error('FTP folder resume failed: '+JSON.stringify(result));
    `);
    assert.deepEqual(await fsp.readFile(path.join(localTree,'z-nested','binary.bin')),folderPayload);
    assert.equal(await fsp.readFile(path.join(localTree,'a-complete.txt'),'utf8'),'done');
    assert.ok(recovery.peer.transfers.some(item=>item.verb==='RETR'&&item.path==='/folder-source/z-nested/binary.bin'&&item.offset===childPrefix.length));
    assert.deepEqual((await fsp.readdir(recoveryDirectory)).filter(name=>name.endsWith('.json')),[]);
    assert.equal(resumeReviews,3);assert.equal(folderReviews,2);
    report.nativeFtpFolderReviewApproval=true;report.nativeFtpFolderResumeCompletedChildren=true;report.nativeFtpRestResume=true;
    await evaluate(`await window.termforge.transferClose(${JSON.stringify(recoverySession.id)});`);
    const badControl = await fixture({ controlWrong: true }); await connect(badControl.peer, 'ftps', true); assert.deepEqual(badControl.peer.encryptedLogins, []); report.nativeFtpsControlCertificateRejected = true;
    const badData = await fixture({ dataWrong: true }); const badSession = await connect(badData.peer, 'ftps');
    assert.equal(await evaluate(`try { await window.termforge.transferListRemote({id:${JSON.stringify(badSession.id)},path:'/'}); return false; } catch (error) { return /certificate|self.signed|altname|hostname/i.test(error.message); }`), true);
    report.nativeFtpsDataCertificateRejected = true;
    const observed = await evaluate('return {prompts:window.__termforgeFtpSmoke.prompts,jobs:Object.values(window.__termforgeFtpSmoke.jobs)};');
    assert.ok(observed.prompts.every(item => item.kind === 'password' && item.prompts[0].echo === false && ['ftp','ftps','ftps-implicit'].includes(item.protocol))); assert.ok(!JSON.stringify(observed).includes('Synthetic-FTP-password-123!'));
    assert.equal(plaintextReviews, 2); report.nativeFtpMaskedCredentials = true;
    await fsp.writeFile(path.join(directory, 'ftp-native.json'), JSON.stringify(report, null, 2)); console.log('PASS native FTP/FTPS round trips, reviewed folder resume, verified APPE/REST recovery, native approvals, masked credentials and certificate rejection'); return report;
  } catch (error) { await fsp.writeFile(path.join(directory, 'ftp-native-failure.json'), JSON.stringify({ message: error.message, stack: error.stack, completed: report }, null, 2)); throw error; }
  finally {
    await evaluate(`const state = window.__termforgeFtpSmoke; if (state) { for (const id of state.ids) await window.termforge.transferClose(id).catch(() => {}); for (const dispose of state.subscriptions) dispose(); document.getElementById('auth-cancel')?.click(); delete window.__termforgeFtpSmoke; }`).catch(() => {});
    dialog.showMessageBox = originalDialog; for (const peer of fixtures) await peer.close();
  }
};
