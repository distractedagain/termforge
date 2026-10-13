'use strict';
// Synthetic credentials and loopback-served UI only; no Electron or real SSH connections.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const core = require('../app/core.cjs');
const installFixture = require('./ui-fixture.cjs');
const renderer = path.resolve(__dirname, '../renderer');
const output = path.resolve(process.env.TERMFORGE_SECURE_UI_OUTPUT || path.join(os.tmpdir(),'termforge-secure-ui-check'));
const checks = []; const errors = []; let browser, page, server;
function secureBridge() {
  let available = true; let credentials = [{id:'demo-vault-id',name:'Lab admin',updatedAt:new Date().toISOString()}]; let hosts = [{host:'lab.example.test',port:22,algorithm:'ssh-ed25519',fingerprint:'SHA256:synthetic-fingerprint'}];
  const listeners = new Map(); const calls = {saves:[],deletes:[],auth:[],opens:[],closes:[],local:[],remote:[],starts:[],cancels:[],forgets:[]};
  const subscribe = name => callback => { if (!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(callback); return () => listeners.get(name).delete(callback); };
  const emit = (name,event) => { for (const callback of listeners.get(name) || []) callback(event); };
  let job = 0; let connection = 0;
  window.__secureqa = {calls,emit,setAvailable:value => available = value};
  Object.assign(window.termforge,{
    credentialStatus:async () => ({available,backend:available?'synthetic-keychain':'basic_text',message:available?'Synthetic OS-protected storage is ready.':'Protected storage unavailable; credentials cannot be saved.'}),
    credentialList:async () => credentials.map(entry=>({...entry})),
    credentialSave:async input => { calls.saves.push({...input}); const saved = {id:input.id || 'new-vault-id',name:input.name,updatedAt:new Date().toISOString()}; credentials = [...credentials.filter(entry=>entry.id!==saved.id),saved]; return saved; },
    credentialDelete:async id => { calls.deletes.push(id); credentials = credentials.filter(entry=>entry.id!==id); return true; },
    sshHosts:async () => hosts, sshForgetHost:async input => { calls.forgets.push(input); hosts=[]; return {forgotten:true}; },
    onAuthPrompt:subscribe('auth'), onAuthPromptClosed:subscribe('auth-closed'), authRespond:async input => { calls.auth.push(structuredClone(input)); return true; },
    transferOpen:async input => { calls.opens.push(input); return {id:`transfer-session-${++connection}`,host:'lab.example.test',port:22,remotePath:'/home/demo'}; },
    transferClose:async id => { calls.closes.push(id); return true; },
    transferListLocal:async ({path:directory}) => { calls.local.push(directory); return {path:directory || '/synthetic/local',entries:[{name:'configs',type:'directory',size:0},{name:'report.txt',type:'file',size:4096},{name:'second.txt',type:'file',size:128},{name:'local-link',type:'symlink',size:0}]}; },
    transferListRemote:async input => { calls.remote.push(input); return {path:input.path,entries:[{name:'logs',type:'directory',size:0},{name:'remote.txt',type:'file',size:8192},{name:'<img src=x onerror=alert(1)>.txt',type:'file',size:12},{name:'remote-link',type:'symlink',size:0}]}; },
    transferChooseLocal:async () => ({path:'/synthetic/chosen'}),
    transferStart:async input => { calls.starts.push(input); const transferId = `job-${++job}`; setTimeout(()=>emit('transfer',{...input,transferId,status:'running',bytes:1024,total:8192}),30); return {transferId}; },
    transferCancel:async transferId => { calls.cancels.push(transferId); const input=calls.starts[Number(transferId.split('-')[1])-1]; emit('transfer',{...input,transferId,status:'cancelled',bytes:1024,total:8192}); return true; },
    onTransferEvent:subscribe('transfer')
  });
}
async function check(name, callback) { await callback(); checks.push(name); process.stdout.write(`PASS ${name}\n`); }
async function menu(action,id) { await page.evaluate(action=>window.__qa.emitMenu(action),action); await page.locator(`#${id}`).waitFor({state:'visible'}); }
async function screenshot(name) { await page.screenshot({path:path.join(output,name),animations:'disabled'}); }
(async()=>{
  await fs.mkdir(output,{recursive:true});
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2'};
  server=http.createServer(async(req,res)=>{ try { const url=new URL(req.url,'http://127.0.0.1'); if(url.pathname==='/favicon.ico'){res.writeHead(204).end();return;}const target=path.resolve(renderer,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));if(!target.startsWith(renderer+path.sep)||!mime[path.extname(target)]){res.writeHead(403).end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(target)],'Cache-Control':'no-store'});res.end(await fs.readFile(target));}catch{res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1040},deviceScaleFactor:1});page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text());});
  await page.exposeFunction('__validateSettings',settings=>core.validateSettings(settings));await page.exposeFunction('__validateProfile',profile=>core.validateSession(profile));
  await page.addInitScript({content:`(${installFixture.toString()})(${JSON.stringify({platform:'darwin',settings:core.validateSettings({theme:'dark'}),sessions:[],snippets:[]})}); (${secureBridge.toString()})();`});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('#quick-connect').waitFor();
  await check('Native Quick Connect handoff preserves credential references and ordered authentication',async()=>{
    await page.locator('#quick-connect').click(); await page.waitForFunction(()=>window.__qa.calls.quickConnectOpens.length===1); assert.equal(await page.locator('#quick-connect-dialog').count(),0);
    await page.evaluate(()=>window.__qa.emitQuickConnect({profile:{name:'Saved lab',protocol:'ssh',host:'lab.example.test',username:'',credentialId:'demo-vault-id',ssh:{backend:'managed',authOrder:['password','publickey']}},saveSession:true}));
    await page.waitForFunction(()=>window.__qa.calls.opens.length===1);const saved=await page.evaluate(()=>window.__qa.calls.opens[0].profile);assert.deepEqual(saved.ssh.authOrder,['password','publickey']);assert.equal(saved.credentialId,'demo-vault-id');assert.equal(saved.username,'');assert.equal(saved.ssh.backend,'managed');
  });
  await check('Quick Connect credential manager handoff opens the manager and resumes its child on close',async()=>{
    await page.evaluate(()=>window.__qa.emitQuickConnectCredentials());await page.locator('#credential-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#credential-password').inputValue(),'');await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__qa.calls.quickConnectResumes.length===1);
  });
  await check('Credential save and replacement clear secrets without copying them into sessions, storage, or terminal history',async()=>{
    await menu('credentials','credential-dialog');await page.locator('#credential-name').fill('Personal lab');await page.locator('#credential-username').fill('synthetic-user-secret');await page.locator('#credential-password').fill('synthetic-password-secret');await page.locator('#credential-save').click();await page.waitForFunction(()=>window.__secureqa.calls.saves.length===1);
    assert.equal(await page.locator('#credential-username').inputValue(),'');assert.equal(await page.locator('#credential-password').inputValue(),'');assert.equal(await page.locator('#credential-list').textContent().then(v=>v.includes('synthetic-user-secret')),false);
    await page.getByRole('button',{name:'Replace Personal lab',exact:true}).click();assert.equal(await page.locator('#credential-password').inputValue(),'');await page.locator('#credential-username').fill('replacement-user');await page.locator('#credential-password').fill('replacement-password');await page.locator('#credential-save').click();await page.waitForFunction(()=>window.__secureqa.calls.saves.length===2);assert.equal(await page.evaluate(()=>window.__secureqa.calls.saves[1].id),'new-vault-id');
    const surfaces=await page.evaluate(()=>JSON.stringify({storage:{...localStorage},session:{...sessionStorage},state:window.__qa.getState(),calls:window.__qa.calls,html:document.body.innerHTML}));assert.doesNotMatch(surfaces,/synthetic-user-secret|synthetic-password-secret|replacement-password/);await screenshot('credentials-dark.png');await page.locator('[data-secure-close="credential-dialog"]').last().click();
  });
  await check('Cancelling credential entry clears both secrets, and missing OS storage disables saving',async()=>{
    await menu('credentials','credential-dialog');await page.locator('#credential-username').fill('discard-user');await page.locator('#credential-password').fill('discard-secret');await page.keyboard.press('Escape');assert.equal(await page.locator('#credential-username').inputValue(),'');assert.equal(await page.locator('#credential-password').inputValue(),'');
    await page.evaluate(()=>window.__secureqa.setAvailable(false));await menu('credentials','credential-dialog');await page.waitForFunction(()=>document.querySelector('#credential-status').textContent.includes('unavailable'));assert.equal(await page.locator('#credential-save').isDisabled(),true);await page.keyboard.press('Escape');await page.evaluate(()=>window.__secureqa.setAvailable(true));
  });
  await check('Deleting a credential delegates its confirmation once and removes metadata',async()=>{
    await menu('credentials','credential-dialog');await page.getByRole('button',{name:'Delete Personal lab',exact:true}).click();await page.waitForFunction(()=>window.__secureqa.calls.deletes.length===1);assert.equal(await page.locator('#confirm-dialog').isVisible(),false);assert.equal(await page.evaluate(()=>window.__secureqa.calls.deletes[0]),'new-vault-id');await page.keyboard.press('Escape');
  });
  await check('Session Options retain credential references and managed auth order on edit',async()=>{
    await page.locator('.session-row').filter({hasText:'Saved lab'}).first().click();await menu('session-options','profile-dialog');await page.locator('#profile-dialog .category-item[data-category="ssh"]').click();assert.equal(await page.locator('#profile-backend').inputValue(),'managed');assert.equal(await page.locator('#profile-credential').inputValue(),'demo-vault-id');await page.locator('#save-profile').click();await page.waitForFunction(()=>!document.querySelector('#profile-dialog').open);const saved=await page.evaluate(()=>window.__qa.calls.saves.at(-1));assert.equal(saved.credentialId,'demo-vault-id');assert.deepEqual(saved.ssh.authOrder,['password','publickey']);assert.equal(saved.username,'');
  });
  await check('Private authentication prompts queue, mask and clear responses, and handle server cancellation',async()=>{
    await page.evaluate(()=>{window.__secureqa.emit('auth',{id:'prompt-a',host:'lab.example.test',port:22,kind:'password',prompts:[{prompt:'Password:',echo:false}]});window.__secureqa.emit('auth',{id:'prompt-b',host:'second.example.test',port:22,kind:'keyboard-interactive',prompts:[{prompt:'One-time code:',echo:false}]});});
    await page.locator('#ssh-auth-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#auth-response-0').getAttribute('type'),'password');await page.locator('#auth-response-0').fill('private-auth-secret');await page.locator('#ssh-auth-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#auth-target').textContent.includes('second.example.test'));assert.equal(await page.locator('#auth-response-0').inputValue(),'');await page.locator('#auth-response-0').fill('unused-code');await page.evaluate(()=>window.__secureqa.emit('auth-closed',{id:'prompt-b'}));await page.locator('#ssh-auth-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#auth-fields input').count(),0);assert.equal(await page.evaluate(()=>window.__secureqa.calls.auth[0].answers[0]),'private-auth-secret');assert.equal(await page.evaluate(()=>window.__qa.calls.writes.length),0);assert.equal(await page.evaluate(()=>window.__qa.calls.history.length),0);
  });
  await check('Authentication cancel sends null and clears the form',async()=>{
    await page.evaluate(()=>window.__secureqa.emit('auth',{id:'cancel-me',host:'lab.example.test',port:22,kind:'password',prompts:[{prompt:'Password:',echo:false}]}));await page.locator('#auth-response-0').fill('discard-auth-secret');await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__secureqa.calls.auth.length===2);assert.deepEqual(await page.evaluate(()=>window.__secureqa.calls.auth[1]),{id:'cancel-me',answers:null});assert.equal(await page.locator('#auth-fields input').count(),0);
  });
  await check('Native Quick Connect routes SFTP to a graphical workspace without opening a terminal',async()=>{
    await page.evaluate(()=>window.__qa.emitQuickConnect({profile:{name:'SFTP lab',protocol:'sftp',host:'lab.example.test',ssh:{backend:'managed'}}}));await page.locator('#file-remote-entries .file-entry').first().waitFor();assert.equal(await page.evaluate(()=>window.__qa.calls.opens.length),1);assert.equal(await page.evaluate(()=>window.__secureqa.calls.opens.length),1);assert.equal(await page.locator('#file-remote-entries img').count(),0);assert.match(await page.locator('#file-remote-entries').textContent(),/<img src=x/);assert.equal(await page.locator('#file-upload').isDisabled(),true);await screenshot('file-transfer-dark.png');
  });
  await check('Both file panes browse directories, and only regular files enable copying',async()=>{
    await page.locator('#file-local-entries [data-name="configs"]').dblclick();await page.waitForFunction(()=>document.querySelector('#file-local-path').value==='/synthetic/local/configs');await page.locator('#file-local-up').click();await page.waitForFunction(()=>document.querySelector('#file-local-path').value==='/synthetic/local');await page.locator('#file-choose-local').click();await page.waitForFunction(()=>document.querySelector('#file-local-path').value==='/synthetic/chosen');
    await page.locator('#file-remote-entries [data-name="logs"]').dblclick();await page.waitForFunction(()=>document.querySelector('#file-remote-path').value==='/home/demo/logs');await page.locator('#file-remote-up').click();await page.waitForFunction(()=>document.querySelector('#file-remote-path').value==='/home/demo');await page.locator('#file-remote-entries [data-name="remote-link"]').click();assert.equal(await page.locator('#file-download').isDisabled(),true);
  });
  await check('SFTP upload and SCP download send exact reviewed paths and render cancellable progress',async()=>{
    await page.locator('#file-local-entries [data-name="report.txt"]').click();await page.locator('#file-upload').click();await page.waitForFunction(()=>window.__secureqa.calls.starts.length===1);assert.deepEqual(await page.evaluate(()=>window.__secureqa.calls.starts[0]),{id:'transfer-session-1',direction:'upload',protocol:'sftp',localPath:'/synthetic/chosen/report.txt',remotePath:'/home/demo/report.txt'});
    await page.locator('#file-transfer-protocol').selectOption('scp');await page.locator('#file-remote-entries [data-name="remote.txt"]').click();await page.locator('#file-download').click();await page.waitForFunction(()=>window.__secureqa.calls.starts.length===2);assert.equal(await page.evaluate(()=>window.__secureqa.calls.starts[1].protocol),'scp');await page.getByRole('button',{name:'Cancel transfer remote.txt',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-transfer-id="job-2"]').textContent.includes('cancelled'));assert.equal(await page.evaluate(()=>window.__secureqa.calls.cancels[0]),'job-2');
    await page.evaluate(()=>window.__secureqa.emit('transfer',{...window.__secureqa.calls.starts[0],transferId:'job-1',status:'completed',bytes:4096,total:4096,warning:'Transfer complete; recovery backup remains at /home/demo/.recovery-file'}));await page.waitForFunction(()=>document.querySelector('[data-transfer-id="job-1"]').textContent.includes('completed'));assert.match(await page.locator('[data-transfer-id="job-1"] .transfer-job-warning').textContent(),/recovery backup remains at \/home\/demo\/.recovery-file/);await screenshot('transfer-queue-dark.png');
  });
  await check('Command-click selects multiple files and queues each exact path once',async()=>{
    await page.locator('#file-transfer-protocol').selectOption('sftp');await page.locator('#file-local-entries [data-name="report.txt"]').click();await page.locator('#file-local-entries [data-name="second.txt"]').click({modifiers:['Meta']});assert.equal(await page.locator('#file-local-entries [aria-selected="true"]').count(),2);await page.locator('#file-upload').click();await page.waitForFunction(()=>window.__secureqa.calls.starts.length===4);assert.deepEqual(await page.evaluate(()=>window.__secureqa.calls.starts.slice(2).map(job=>job.localPath)),['/synthetic/chosen/report.txt','/synthetic/chosen/second.txt']);
  });
  await check('Windows drive navigation retains an absolute drive root',async()=>{
    await page.locator('#file-local-path').fill('C:\\synthetic\\folder');await page.locator('#file-local-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#file-local-path').value==='C:\\synthetic\\folder');await page.locator('#file-local-up').click();await page.waitForFunction(()=>document.querySelector('#file-local-path').value==='C:\\synthetic');await page.locator('#file-local-up').click();await page.waitForFunction(()=>document.querySelector('#file-local-path').value==='C:\\');
  });
  await check('Disconnect during an active copy requires confirmation',async()=>{
    await page.locator('#file-transfer-disconnect').click();await page.locator('#confirm-dialog').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.__secureqa.calls.closes.length),0);await page.locator('#confirm-cancel').click();assert.equal(await page.evaluate(()=>window.__secureqa.calls.closes.length),0);await page.locator('#file-transfer-disconnect').click();await page.locator('#confirm-accept').click();await page.waitForFunction(()=>window.__secureqa.calls.closes.length===1);await page.locator('#file-transfer-done').click();
  });
  await check('Reopening a hidden workspace for the same saved session preserves its connection',async()=>{
    await page.locator('#sftp-session').click();await page.waitForFunction(()=>window.__secureqa.calls.opens.length===2);await page.locator('#file-transfer-done').click();await page.locator('#sftp-session').click();await page.locator('#file-transfer-dialog').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.__secureqa.calls.opens.length),2);assert.equal(await page.evaluate(()=>window.__secureqa.calls.closes.length),1);await page.locator('#file-transfer-done').click();
  });
  await check('Server disconnect disables its workspace without closing another connection or hiding the dialog',async()=>{
    await page.locator('#sftp-session').click();await page.locator('#file-transfer-dialog').waitFor({state:'visible'});await page.locator('#file-local-entries [data-name="report.txt"]').click();assert.equal(await page.locator('#file-upload').isDisabled(),false);
    await page.evaluate(()=>window.__secureqa.emit('transfer',{type:'connection',id:'unrelated-session',status:'closed'}));assert.equal(await page.locator('#file-upload').isDisabled(),false);assert.match(await page.locator('#file-transfer-status').textContent(),/encrypted SSH connection/);
    await page.evaluate(()=>window.__secureqa.emit('transfer',{type:'connection',id:'transfer-session-2',status:'closed'}));assert.equal(await page.locator('#file-transfer-dialog').isVisible(),true);assert.equal(await page.locator('#file-upload').isDisabled(),true);assert.equal(await page.locator('#file-download').isDisabled(),true);assert.equal(await page.locator('#file-transfer-disconnect').isDisabled(),true);assert.equal(await page.locator('#file-transfer-status').textContent(),'Disconnected');assert.equal(await page.locator('#file-remote-entries .file-entry').count(),0);await page.locator('#file-transfer-done').click();
  });
  await check('Trusted host manager displays fingerprints and delegates forget confirmation to the main process',async()=>{
    await menu('ssh-hosts','ssh-hosts-dialog');assert.match(await page.locator('#ssh-hosts-list').textContent(),/SHA256:synthetic-fingerprint/);await page.getByRole('button',{name:'Forget lab.example.test:22'}).click();await page.waitForFunction(()=>window.__secureqa.calls.forgets.length===1);assert.deepEqual(await page.evaluate(()=>window.__secureqa.calls.forgets[0]),{host:'lab.example.test',port:22});await page.keyboard.press('Escape');
  });
  await check('Native Quick Connect handoff refreshes the startup preference and routes System OpenSSH',async()=>{
    await page.evaluate(()=>window.__qa.emitQuickConnect({profile:{name:'OpenSSH lab',protocol:'ssh',host:'openssh.example.test',ssh:{backend:'openssh'}},showOnStartup:true}));await page.waitForFunction(()=>window.__qa.calls.opens.length===2);assert.equal(await page.evaluate(()=>window.__qa.getState().settings.showQuickConnectOnStartup),true);assert.equal(await page.evaluate(()=>window.__qa.calls.opens.at(-1).profile.ssh.backend),'openssh');assert.deepEqual(await page.evaluate(()=>window.__qa.calls.opens.at(-1).profile.ssh.authOrder),['publickey','keyboard-interactive','password']);
  });
  await check('Switching a legacy GSSAPI profile to managed SSH uses its visible authentication order',async()=>{
    await menu('session-options','profile-dialog');await page.locator('#profile-dialog .category-item[data-category="ssh"]').click();await page.locator('#profile-backend').selectOption('openssh');await page.locator('#profile-auth').selectOption('gssapi');await page.locator('#save-profile').click();await page.waitForFunction(()=>!document.querySelector('#profile-dialog').open);assert.equal(await page.evaluate(()=>window.__qa.calls.saves.at(-1).ssh.authMethod),'gssapi');
    await menu('session-options','profile-dialog');await page.locator('#profile-dialog .category-item[data-category="ssh"]').click();await page.locator('#profile-backend').selectOption('managed');await page.locator('#profile-credential').selectOption('demo-vault-id');await page.locator('#profile-auth-order-keyboard-interactive').uncheck();await page.locator('#save-profile').click();await page.waitForFunction(()=>!document.querySelector('#profile-dialog').open);const profile=await page.evaluate(()=>window.__qa.calls.saves.at(-1));assert.equal(profile.ssh.authMethod,'auto');assert.deepEqual(profile.ssh.authOrder,['publickey','password']);assert.equal(profile.credentialId,'demo-vault-id');
  });
  await check('Changing managed profiles to non-SSH protocols clears hidden credential references and authentication validation',async()=>{
    for (const protocol of ['local','telnet','serial']) {
      await menu('session-options','profile-dialog');await page.locator('#profile-dialog .category-item[data-category="ssh"]').click();for(const method of ['publickey','keyboard-interactive','password']) await page.locator(`#profile-auth-order-${method}`).uncheck();await page.locator('#profile-dialog .category-item[data-category="connection"]').click();await page.locator('#profile-protocol-select').selectOption(protocol);if(protocol==='serial') await page.locator('#profile-serial-path').fill('/dev/cu.synthetic');await page.locator('#save-profile').click();await page.waitForFunction(()=>!document.querySelector('#profile-dialog').open);const saved=await page.evaluate(()=>window.__qa.calls.saves.at(-1));assert.equal(saved.protocol,protocol);assert.equal(saved.credentialId,'');assert.ok(saved.ssh.authOrder.length);
      await menu('session-options','profile-dialog');await page.locator('#profile-protocol-select').selectOption('ssh');await page.locator('#profile-host').fill('lab.example.test');await page.locator('#profile-dialog .category-item[data-category="ssh"]').click();await page.locator('#profile-backend').selectOption('managed');await page.locator('#profile-credential').selectOption('demo-vault-id');await page.locator('#save-profile').click();await page.waitForFunction(()=>!document.querySelector('#profile-dialog').open);
    }
  });
  await check('Light and narrow layouts keep the file workspace inside the viewport',async()=>{
    await page.evaluate(()=>{document.documentElement.dataset.theme='light';});await page.setViewportSize({width:850,height:600});await page.locator('#sftp-session').click();await screenshot('file-transfer-narrow.png');const files=await page.locator('#file-transfer-dialog').evaluate(element=>({width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height,innerWidth,innerHeight,scroll:element.scrollWidth,client:element.clientWidth}));assert.ok(files.width<=files.innerWidth);assert.ok(files.height<=files.innerHeight);assert.equal(files.scroll,files.client);await page.keyboard.press('Escape');
  });
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:checks.length,checks,errors,scope:'Synthetic headless main-renderer interactions, including mocked native Quick Connect handoffs. Standalone Quick Connect form has separate checks. No native title bar, keychain, or SSH assertions.'},null,2));process.stdout.write(`PASS ${checks.length} secure UI checks; ${output}\n`);
})().catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
