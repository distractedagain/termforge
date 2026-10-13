'use strict';
// Real transfer renderer with a synthetic IPC bridge. No Electron or remote servers.
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const repo = path.resolve(__dirname, '..');
const output = path.resolve(process.env.TERMFORGE_REMOTE_FILES_UI_OUTPUT || path.join(os.tmpdir(), 'termforge-remote-files-ui-check'));
let complete = false;
process.on('beforeExit', () => { if (!complete && !process.exitCode) { process.stderr.write('Remote file UI checks did not complete.\n'); process.exitCode = 1; } });
function bridge() {
  const calls = {open:[],close:[],local:[],remote:[],prepare:[],apply:[],discard:[],start:[],cancel:[],toasts:[]};
  const entries = [
    {name:'logs',type:'directory',permissions:'750'},
    {name:'report.txt',type:'file',permissions:'640',size:4096},
    {name:'second.txt',type:'file',permissions:'600',size:128},
    {name:'<img src=x onerror=alert(1)>.txt',type:'file',permissions:'<img src=x>',size:32},
    {name:'remote-link',type:'symlink',permissions:'777'},
    {name:'device',type:'other'}
  ];
  const held = new Set(), failures = new Map(), pending = new Map(); let listener, connection = 0, plan = 0;
  const reply = (method, input, result) => { calls[method].push(structuredClone(input)); if (failures.has(method)) return Promise.reject(new Error(failures.get(method))); if (held.has(method)) { held.delete(method); return new Promise((resolve,reject) => pending.set(method,{resolve,reject,result})); } return Promise.resolve(result); };
  window.remoteQa = {calls,entries,emit:event=>listener?.(event),hold:method=>held.add(method),release(method,result,error) { held.delete(method); const item = pending.get(method); pending.delete(method); if (!item) throw new Error(`No pending ${method}`); error ? item.reject(new Error(error)) : item.resolve(result === undefined ? item.result : result); },fail:(method,message)=>failures.set(method,message),unfail:method=>failures.delete(method)};
  window.remoteApi = {
    transferOpen:input=>reply('open',input,{id:`connection-${++connection}`,host:input.profile.host,port:22,remotePath:'/srv/demo'}),
    transferClose:id=>reply('close',id,true),
    transferListLocal:input=>reply('local',input,{path:input.path || '/local/demo',entries:[{name:'local.txt',type:'file',size:20}]}),
    transferListRemote:input=>reply('remote',input,{path:input.path,entries}),
    transferChooseLocal:async()=>({path:'/local/chosen'}),
    transferStart:input=>reply('start',input,{transferId:'queued-job'}),
    transferCancel:id=>reply('cancel',id,true),
    transferPrepareRemoteOperation:input=>reply('prepare',input,{planId:`plan-${++plan}`,id:input.id,operation:input.operation,path:input.operation==='mkdir'?`${input.path}/${input.name}`:input.path,...(input.operation==='rename'?{destination:`${input.path.slice(0,input.path.lastIndexOf('/'))}/${input.name}`}:{}) ,...(input.operation==='chmod'?{permissions:input.permissions,currentPermissions:'600'}:{}),type:input.operation==='mkdir'||input.path.endsWith('/logs')?'directory':'file'}),
    transferApplyRemoteOperation:input=>reply('apply',input,{applied:true}),
    transferDiscardRemoteOperation:input=>reply('discard',input,true),
    onTransferEvent:callback=>{listener=callback;}
  };
}
(async () => {
  await fs.mkdir(output,{recursive:true});
  const build = await esbuild.build({stdin:{contents:"import './renderer/style.css'; import './renderer/secure-connections.css'; import { createSecureTransferUi } from './renderer/secure-transfers.js'; window.remoteUi = createSecureTransferUi({api:window.remoteApi,toast:message=>window.remoteQa.calls.toasts.push(message),confirmAction:async()=>true}); window.remoteUi.install();",resolveDir:repo},bundle:true,write:false,outfile:'fixture.js'});
  const checks = [], errors = []; let browser,page;
  const fixture = async () => {
    await page?.close(); page = await browser.newPage({viewport:{width:1300,height:980}}); page.setDefaultTimeout(7000);
    page.on('pageerror',error=>errors.push(error.message)); page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
    await page.setContent('<!doctype html><html data-platform="darwin" data-theme="dark"><head><meta charset="utf-8"></head><body></body></html>');
    await page.addStyleTag({content:build.outputFiles.find(item=>item.path.endsWith('.css')).text}); await page.evaluate(bridge); await page.addScriptTag({content:build.outputFiles.find(item=>item.path.endsWith('.js')).text});
  };
  const open = async(host='lab.example.test') => { await page.evaluate(host=>window.remoteUi.open({host,name:'Synthetic server'}),host); await page.locator('#file-remote-entries .file-entry').first().waitFor(); };
  const choose = async(name='report.txt')=>page.locator('#file-remote-entries .file-entry').filter({has:page.locator('.file-entry-name > span',{hasText:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`)})}).click();
  const begin = async(kind)=>{ await page.locator(`#file-remote-${kind}`).click(); await page.locator('#remote-operation-dialog').waitFor({state:'visible'}); };
  const review = async()=>{await page.locator('#remote-operation-submit').click();await page.locator('#remote-operation-review').waitFor({state:'visible'});};
  const cancel = async()=>{await page.locator('#remote-operation-cancel').click();await page.locator('#remote-operation-dialog').waitFor({state:'hidden'});};
  const check = async(name,callback)=>{await fixture();await callback();checks.push(name);process.stdout.write(`PASS ${name}\n`);};
  try {
    browser = await chromium.launch({headless:true});
    await check('Remote actions require a connection and a single regular target; links and multi-selection stay disabled',async()=>{
      for(const kind of ['mkdir','rename','delete','chmod']) assert.equal(await page.locator(`#file-remote-${kind}`).isDisabled(),true);
      await open();assert.equal(await page.locator('#file-remote-mkdir').isDisabled(),false);assert.equal(await page.locator('#file-remote-delete').isDisabled(),true);
      await choose('remote-link');assert.equal(await page.locator('#file-remote-chmod').isDisabled(),true);await choose('device');assert.equal(await page.locator('#file-remote-rename').isDisabled(),true);
      await choose();for(const kind of ['rename','delete','chmod']) assert.equal(await page.locator(`#file-remote-${kind}`).isDisabled(),false);
      await page.locator('#file-remote-entries [data-name="second.txt"]').click({modifiers:['Meta']});assert.equal(await page.locator('#file-remote-delete').isDisabled(),true);assert.equal(await page.locator('#file-remote-mkdir').isDisabled(),false);
      assert.equal(await page.locator('#file-remote-entries img').count(),0);assert.match(await page.locator('#file-remote-entries').textContent(),/<img src=x/);assert.equal(await page.locator('#file-remote-entries [data-name="report.txt"] .file-entry-permissions').textContent(),'640');
    });
    await check('Name validation precedes IPC, and cancelling an edit has no server request',async()=>{
      await open();await begin('mkdir');for(const value of ['', '..', 'nested/folder', 'nested\\folder']) { await page.locator('#remote-operation-name').fill(value);await page.locator('#remote-operation-submit').click();assert.match(await page.locator('#remote-operation-error').textContent(),/single file or folder name/); }
      assert.equal(await page.evaluate(()=>window.remoteQa.calls.prepare.length),0);await page.keyboard.press('Escape');await page.locator('#remote-operation-dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.remoteQa.calls.discard.length),0);
    });
    await check('Preparation is single-flight and blocks Escape, backdrop, navigation and session switching',async()=>{
      await open();await page.evaluate(()=>window.remoteQa.hold('prepare'));await begin('mkdir');await page.locator('#remote-operation-name').fill('new folder');await page.locator('#remote-operation-submit').click();await page.waitForFunction(()=>window.remoteQa.calls.prepare.length===1);
      await page.evaluate(()=>document.querySelector('#remote-operation-form').requestSubmit());await page.keyboard.press('Escape');await page.mouse.click(1,1);
      assert.equal(await page.locator('#remote-operation-dialog').isVisible(),true);assert.equal(await page.locator('#remote-operation-cancel').isDisabled(),true);assert.equal(await page.locator('#file-remote-path').isDisabled(),true);assert.equal(await page.locator('#file-upload').isDisabled(),true);
      await page.evaluate(()=>window.remoteUi.open({host:'other.example.test'}));assert.equal(await page.evaluate(()=>window.remoteQa.calls.open.length),1);assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.prepare),[{id:'connection-1',operation:'mkdir',path:'/srv/demo',name:'new folder'}]);
      await page.evaluate(()=>window.remoteQa.release('prepare'));await page.locator('#remote-operation-review').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.remoteQa.calls.apply.length),0);await cancel();
    });
    await check('Server-derived review shows exact paths as text and cancelling discards its single-use plan',async()=>{
      await open();await choose();await begin('rename');await page.locator('#remote-operation-name').fill('<img src=x>');await review();
      assert.match(await page.locator('#remote-operation-review').textContent(),/lab.example.test:22/);assert.match(await page.locator('#remote-operation-review').textContent(),/\/srv\/demo\/report.txt/);assert.match(await page.locator('#remote-operation-review').textContent(),/\/srv\/demo\/<img src=x>/);assert.equal(await page.locator('#remote-operation-review img').count(),0);assert.equal(await page.locator('#remote-operation-name').isDisabled(),true);
      await page.keyboard.press('Escape');await page.locator('#remote-operation-dialog').waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.discard),[{planId:'plan-1'}]);assert.equal(await page.evaluate(()=>window.remoteQa.calls.apply.length),0);
    });
    await check('Editing a review discards its reservation and prepares a fresh exact destination',async()=>{
      await open();await choose();await begin('rename');await page.locator('#remote-operation-name').fill('first.txt');await review();await page.locator('#remote-operation-edit').click();await page.waitForFunction(()=>!document.querySelector('#remote-operation-name').disabled);await page.locator('#remote-operation-name').fill('second-name.txt');await review();
      assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.discard),[{planId:'plan-1'}]);assert.equal(await page.evaluate(()=>window.remoteQa.calls.prepare.at(-1).name),'second-name.txt');assert.match(await page.locator('#remote-operation-review').textContent(),/second-name.txt/);await cancel();
    });
    await check('Apply sends only a plan token, blocks duplicate submit and refreshes the original folder once',async()=>{
      await open();await choose();await begin('rename');await page.locator('#remote-operation-name').fill('new-report.txt');await review();await page.evaluate(()=>window.remoteQa.hold('apply'));await page.locator('#remote-operation-submit').click();await page.waitForFunction(()=>window.remoteQa.calls.apply.length===1);
      await page.evaluate(()=>{document.querySelector('#remote-operation-form').requestSubmit();document.querySelector('#file-remote-form').requestSubmit();document.querySelector('#file-transfer-done').click();});await page.keyboard.press('Escape');await page.mouse.click(1,1);
      assert.equal(await page.locator('#remote-operation-dialog').isVisible(),true);assert.equal(await page.locator('#remote-operation-cancel').isDisabled(),true);assert.equal(await page.locator('#file-transfer-disconnect').isDisabled(),true);assert.equal(await page.locator('#file-transfer-protocol').isDisabled(),true);assert.equal(await page.evaluate(()=>window.remoteQa.calls.remote.length),1);
      await page.evaluate(()=>window.remoteUi.open({host:'other.example.test'}));assert.equal(await page.evaluate(()=>window.remoteQa.calls.open.length),1);assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.apply),[{planId:'plan-1'}]);
      await page.evaluate(()=>window.remoteQa.release('apply'));await page.locator('#remote-operation-dialog').waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.remote),[{id:'connection-1',path:'/srv/demo'},{id:'connection-1',path:'/srv/demo'}]);assert.equal(await page.evaluate(()=>window.remoteQa.calls.toasts[0]),'Rename completed.');assert.equal(await page.locator('#file-remote-rename').isDisabled(),true);
    });
    await check('Native confirmation decline reports cancellation without refreshing or applying twice',async()=>{
      await open();await choose();await begin('delete');assert.match(await page.locator('#remote-operation-note').textContent(),/cannot be undone/);await review();await page.evaluate(()=>window.remoteQa.hold('apply'));await page.locator('#remote-operation-submit').click();await page.evaluate(()=>window.remoteQa.release('apply',{applied:false,cancelled:true}));await page.waitForFunction(()=>!document.querySelector('#remote-operation-submit').disabled);assert.match(await page.locator('#remote-operation-status').textContent(),/No change was applied/);assert.equal(await page.locator('#remote-operation-review').isVisible(),false);assert.equal(await page.evaluate(()=>window.remoteQa.calls.remote.length),1);await cancel();
    });
    await check('Permissions explain owner/group/other, validate octal digits and review current and requested modes',async()=>{
      await open();await choose();await begin('chmod');assert.equal(await page.locator('#remote-operation-permissions').inputValue(),'640');assert.match(await page.locator('#remote-permissions-preview').textContent(),/Owner: read, write · Group: read · Other: none/);
      for(const value of ['','999','u+x','64']) {await page.locator('#remote-operation-permissions').fill(value);await page.locator('#remote-operation-submit').click();assert.match(await page.locator('#remote-operation-error').textContent(),/exactly three octal/);}assert.equal(await page.evaluate(()=>window.remoteQa.calls.prepare.length),0);
      await page.locator('#remote-operation-permissions').fill('750');await review();assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.prepare[0]),{id:'connection-1',operation:'chmod',path:'/srv/demo/report.txt',permissions:'750'});assert.match(await page.locator('#remote-operation-review-fields').textContent(),/Current permissions600New permissions750/);await cancel();
    });
    await check('Server rejection of nonempty-folder deletion keeps a retryable form without an apply call',async()=>{
      await open();await choose('logs');await page.evaluate(()=>window.remoteQa.fail('prepare','Folder is not empty. Recursive deletion is not supported.'));await begin('delete');await page.locator('#remote-operation-submit').click();await page.waitForFunction(()=>!document.querySelector('#remote-operation-error').hidden);assert.match(await page.locator('#remote-operation-error').textContent(),/not empty/);assert.equal(await page.locator('#remote-operation-submit').isDisabled(),false);assert.equal(await page.evaluate(()=>window.remoteQa.calls.apply.length),0);await cancel();
    });
    await check('Expired or changed plans return to fresh review, never blindly retry a mutation',async()=>{
      await open();await choose();await begin('delete');await review();await page.evaluate(()=>window.remoteQa.fail('apply','Review expired. Inspect the target again.'));await page.locator('#remote-operation-submit').click();await page.waitForFunction(()=>!document.querySelector('#remote-operation-error').hidden);assert.equal(await page.locator('#remote-operation-submit').textContent(),'Review');assert.equal(await page.locator('#remote-operation-review').isVisible(),false);assert.match(await page.locator('#remote-operation-error').textContent(),/Review expired/);assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.discard),[{planId:'plan-1'}]);await cancel();
    });
    await check('A disconnect during inspection discards late plans and disables stale apply',async()=>{
      await open();await choose();await page.evaluate(()=>window.remoteQa.hold('prepare'));await begin('delete');await page.locator('#remote-operation-submit').click();await page.waitForFunction(()=>window.remoteQa.calls.prepare.length===1);await page.evaluate(()=>window.remoteQa.emit({type:'connection',id:'connection-1',status:'closed'}));await page.evaluate(()=>window.remoteQa.release('prepare'));await page.waitForFunction(()=>!document.querySelector('#remote-operation-cancel').disabled);assert.equal(await page.locator('#remote-operation-submit').isDisabled(),true);assert.deepEqual(await page.evaluate(()=>window.remoteQa.calls.discard),[{planId:'plan-1'}]);assert.equal(await page.evaluate(()=>window.remoteQa.calls.apply.length),0);await cancel();await open('other.example.test');assert.equal(await page.locator('#file-remote-path').inputValue(),'/srv/demo');
    });
    await check('A disconnect during native apply never refreshes an unrelated connection',async()=>{
      await open();await choose();await begin('delete');await review();await page.evaluate(()=>window.remoteQa.hold('apply'));await page.locator('#remote-operation-submit').click();await page.waitForFunction(()=>window.remoteQa.calls.apply.length===1);await page.evaluate(()=>window.remoteQa.emit({type:'connection',id:'connection-1',status:'closed'}));await page.evaluate(()=>window.remoteQa.release('apply',{applied:true}));await page.waitForFunction(()=>!document.querySelector('#remote-operation-cancel').disabled);assert.match(await page.locator('#remote-operation-error').textContent(),/server reported the change/);assert.equal(await page.locator('#remote-operation-submit').isDisabled(),true);assert.equal(await page.evaluate(()=>window.remoteQa.calls.remote.length),1);await cancel();await open('other.example.test');assert.equal(await page.evaluate(()=>window.remoteQa.calls.remote.at(-1).id),'connection-2');assert.equal(await page.locator('#file-remote-path').inputValue(),'/srv/demo');
    });
    await check('Active transfers disable remote changes and completion restores actions',async()=>{
      await open();await choose();await page.evaluate(()=>window.remoteQa.emit({id:'connection-1',transferId:'external-job',direction:'upload',protocol:'sftp',localPath:'/local/a',remotePath:'/srv/demo/a',status:'running',bytes:1,total:10}));for(const kind of ['mkdir','rename','delete','chmod']) assert.equal(await page.locator(`#file-remote-${kind}`).isDisabled(),true);assert.equal(await page.locator('#file-download').isDisabled(),false);
      await page.evaluate(()=>window.remoteQa.emit({id:'connection-1',transferId:'external-job',direction:'upload',protocol:'sftp',localPath:'/local/a',remotePath:'/srv/demo/a',status:'completed',bytes:10,total:10}));await page.waitForFunction(()=>!document.querySelector('#file-remote-mkdir').disabled);await choose();assert.equal(await page.locator('#file-remote-delete').isDisabled(),false);
    });
    await check('A stale folder response after disconnect cannot replace the next connection destination',async()=>{
      await open();await page.evaluate(()=>window.remoteQa.hold('remote'));await page.locator('#file-remote-path').fill('/old/pending');await page.locator('#file-remote-form button[type=submit]').click();await page.waitForFunction(()=>window.remoteQa.calls.remote.length===2);assert.equal(await page.locator('#file-remote-delete').isDisabled(),true);await page.evaluate(()=>window.remoteQa.emit({type:'connection',id:'connection-1',status:'closed'}));await open('other.example.test');await page.evaluate(()=>window.remoteQa.release('remote',{path:'/old/pending',entries:[]}));assert.equal(await page.locator('#file-remote-path').inputValue(),'/srv/demo');assert.equal(await page.locator('#file-remote-entries .file-entry').count(),6);
    });
    await check('Successful mutation plus refresh failure reports the change accurately and offers no duplicate apply',async()=>{
      await open();await choose();await begin('delete');await review();await page.evaluate(()=>window.remoteQa.fail('remote','Listing unavailable'));await page.locator('#remote-operation-submit').click();await page.locator('#remote-operation-dialog').waitFor({state:'hidden'});assert.match(await page.locator('#file-transfer-error').textContent(),/Change applied, but the folder could not be refreshed: Listing unavailable/);assert.equal(await page.evaluate(()=>window.remoteQa.calls.apply.length),1);assert.equal(await page.evaluate(()=>window.remoteQa.calls.toasts[0]),'Delete completed.');
    });
    await check('Compact light and dark review layouts stay in the viewport and keep keyboard focus inside the dialog',async()=>{
      await open();await choose();await begin('rename');await page.locator('#remote-operation-name').fill('a-very-long-destination-'.repeat(8)+'.txt');await review();
      for(const theme of ['dark','light']) { await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width:430,height:620});await page.screenshot({path:path.join(output,`remote-review-${theme}-narrow.png`),animations:'disabled'});const sizes=await page.locator('#remote-operation-dialog').evaluate(element=>({width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height,innerWidth,innerHeight,scroll:element.scrollWidth,client:element.clientWidth}));assert.ok(sizes.width<=sizes.innerWidth);assert.ok(sizes.height<=sizes.innerHeight);assert.equal(sizes.scroll,sizes.client);for(let index=0;index<5;index++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('#remote-operation-dialog'))),true);} }
      await cancel();await page.setViewportSize({width:1300,height:980});await page.screenshot({path:path.join(output,'remote-files-light.png'),animations:'disabled'});
    });
    assert.deepEqual(errors,[]);checks.push('No page or console errors across remote file workflows');
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:checks.length,checks,errors,scope:'Real transfer UI and styles with synthetic IPC. Server-side SFTP semantics and native confirmations are verified separately.'},null,2));complete=true;process.stdout.write(`PASS ${checks.length} remote file UI checks; ${output}\n`);
  } finally {await browser?.close();}
})().catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
