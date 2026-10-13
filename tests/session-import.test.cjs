'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSessionImport, parseDelimited, detectDelimiter, MAX_BYTES } = require('../app/session-import.cjs');
const { validateSession } = require('../app/core.cjs');
async function fixture(t, text = 'Name,Host\nRouter,router.example\n', extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'termforge-session-import-')); const filename = path.join(directory,'sessions.csv'); await fs.writeFile(filename,text);
  let config = {sessions:[]}, writes = 0, approvals = []; const options = {chooseFile:async()=>({path:filename}),loadConfig:async()=>structuredClone(config),commitSessions:async(next,{expectedSessions})=>{assert.deepEqual(expectedSessions,config.sessions);config.sessions=next;writes++;},approveApply:async counts=>{approvals.push(counts);return true;},...extra};
  const service = createSessionImport(options); t.after(async()=>{service.close();await fs.rm(directory,{recursive:true,force:true});});
  return {service,filename,directory,read:()=>structuredClone(config),write:next=>{config=structuredClone(next);},writes:()=>writes,approvals,async choose(){return service.choose();},async preview(chosen,request={}){return service.preview({fileId:chosen.fileId,delimiter:chosen.delimiter,header:chosen.header,mapping:chosen.suggestedMapping,collision:'skip',...request});}};
}
test('CSV parser preserves quoted delimiters, escaped quotes and multiline descriptions with physical row numbers',()=>{
  const rows=parseDelimited('\uFEFFName,Host,Description\r\n"Router, A",a.example,"A ""quoted"" line\r\ncontinued"\r\nB,b.example,plain\r\n');
  assert.deepEqual(rows.map(row=>row.row),[1,2,4]); assert.equal(rows[1].cells[0],'Router, A');assert.equal(rows[1].cells[2],'A "quoted" line\r\ncontinued');assert.equal(rows[2].error,'');
});
test('delimiter detection respects quoted delimiters and recognizes TSV and semicolon',()=>{
  assert.equal(detectDelimiter('Name\tHost\n"A,B"\ta.example\n'),'tab');assert.equal(detectDelimiter('Name;Host\nA;a.example\n'),'semicolon');
});
test('parser diagnoses malformed rows and rejects controls and resource overflows',()=>{
  assert.match(parseDelimited('A,b\n"bad"suffix,x\n')[1].error,/quoting/);assert.match(parseDelimited('A,b\n"unclosed,x')[1].error,/Unclosed/);
  for(const value of ['a\0,b','a'.repeat(8193),Array(34).fill('a').join(','),Array(2003).fill('a,b').join('\n'),'a'.repeat(MAX_BYTES+1)])assert.throws(()=>parseDelimited(value));
});
test('choose returns opaque IDs and column metadata without paths, raw rows or secret values',async t=>{
  const f=await fixture(t,'Name,Host,Password,Private key\nA,a.example,SECRET_MARKER,KEY_MARKER\n');const chosen=await f.choose();assert.ok(chosen.fileId);assert.equal(chosen.columns[2].sensitive,true);assert.equal(chosen.columns[3].sensitive,true);assert.deepEqual(chosen.suggestedMapping,{name:0,host:1});assert.doesNotMatch(JSON.stringify(chosen),/SECRET_MARKER|KEY_MARKER|termforge-session-import-/);assert.equal(f.writes(),0);
});
test('validated preview imports only allowlisted metadata, preserves source bytes and never auto-connects',async t=>{
  const contents='Name,Host,Protocol,Port,Username,Folder,Description,Password\nA,a.example,SSH2,2222,alice,Network,"two\nlines",SECRET_MARKER\n';
  const f=await fixture(t,contents);const chosen=await f.choose(),plan=await f.preview(chosen);assert.equal(plan.canApply,true);assert.equal(plan.rows[0].protocol,'ssh');assert.equal(plan.rows[0].port,2222);assert.equal(plan.rows[0].description,'two\nlines');assert.equal(f.writes(),0);
  const result=await f.service.apply({planId:plan.planId});assert.equal(result.added,1);assert.equal(f.writes(),1);assert.equal(f.read().sessions[0].credentialId,'');assert.equal(f.read().sessions[0].ssh.remoteCommand,'');assert.doesNotMatch(JSON.stringify(f.read()),/SECRET_MARKER/);assert.equal(await fs.readFile(f.filename,'utf8'),contents);assert.equal(f.approvals[0].name,'sessions.csv');
});
test('malformed rows and invalid hosts block apply until user explicitly excludes them',async t=>{
  const f=await fixture(t,'Name,Host\nGood,good.example\nBad,user@bad.example\nOdd,odd.example,extra\n');const c=await f.choose(),bad=await f.preview(c);assert.equal(bad.canApply,false);assert.equal(bad.counts.errors,2);assert.equal(bad.planId,null);assert.equal(f.writes(),0);
  const good=await f.preview(c,{selectedRows:[2]});assert.equal(good.canApply,true);assert.equal(good.counts.excluded,2);await f.service.apply({planId:good.planId});assert.deepEqual(f.read().sessions.map(s=>s.name),['Good']);
});
test('unknown and sensitive mapping keys and protected header columns are rejected',async t=>{
  const f=await fixture(t,'Host,Password\na.example,secret\n');const c=await f.choose();
  for(const mapping of [{host:0,password:1},{host:0,description:1},{host:0,name:0},{host:99}])await assert.rejects(f.preview(c,{mapping}));assert.equal(f.writes(),0);
});
test('local/serial/command-like protocols are rejected, and safe protocols validate default ports',async t=>{
  const f=await fixture(t,'Host,Protocol\na.example,local\nb.example,serial\nc.example,ssh -oProxyCommand=x\nd.example,sftp\ne.example,telnet\nf.example,raw\n');const c=await f.choose(),plan=await f.preview(c);assert.equal(plan.counts.errors,3);assert.deepEqual(plan.rows.slice(3).map(row=>[row.protocol,row.port]),[['sftp',22],['telnet',23],['raw',23]]);
});
test('no-header TSV requires explicit mapping and supports a host-only imported name',async t=>{
  const f=await fixture(t,'a.example\t2222\nalias.example\t22\n');const c=await f.choose();assert.equal(c.header,false);const unmapped=await f.preview(c);assert.equal(unmapped.canApply,false);const plan=await f.preview(c,{mapping:{host:0,port:1}});assert.equal(plan.rows[0].name,'a.example');assert.equal(plan.rows[0].port,2222);assert.equal(plan.canApply,true);
});
test('skip collisions compare normalized folder/name including earlier import rows',async t=>{
  const f=await fixture(t,'Name,Host,Folder\nRouter,new.example,Group\nrouter,again.example,group\nB,b.example,Group\n');f.write({sessions:[validateSession({id:'existing',name:'ROUTER',host:'old.example',folder:'GROUP'})]});const c=await f.choose(),p=await f.preview(c);assert.equal(p.counts.skipped,2);assert.equal(p.counts.added,1);await f.service.apply({planId:p.planId});assert.equal(f.read().sessions[0].host,'old.example');
});
test('rename collisions creates unique bounded names without changing existing profiles',async t=>{
  const name='n'.repeat(120);const f=await fixture(t,`Name,Host\n${name},new.example\n${name},other.example\n`);f.write({sessions:[validateSession({name,host:'old.example'})]});const c=await f.choose(),p=await f.preview(c,{collision:'rename'});assert.equal(p.rows[0].name.length,120);assert.ok(p.rows[0].name.endsWith(' (2)'));assert.ok(p.rows[1].name.endsWith(' (3)'));await f.service.apply({planId:p.planId});assert.equal(new Set(f.read().sessions.map(s=>s.name)).size,3);
});
test('replace preserves existing IDs while clearing credentials and old execution settings',async t=>{
  const f=await fixture(t);f.write({sessions:[validateSession({id:'kept-id',name:'Router',host:'old.example',credentialId:'old-credential',ssh:{backend:'managed',remoteCommand:'old command'}})]});const c=await f.choose(),p=await f.preview(c,{collision:'replace'});assert.equal(p.counts.replaced,1);await f.service.apply({planId:p.planId});assert.equal(f.read().sessions[0].id,'kept-id');assert.equal(f.read().sessions[0].credentialId,'');assert.equal(f.read().sessions[0].ssh.remoteCommand,'');assert.equal(f.read().sessions[0].host,'router.example');
});
test('ambiguous existing and repeated input replacements fail before any writes',async t=>{
  const f=await fixture(t,'Name,Host\nRouter,one.example\nRouter,two.example\n');const c=await f.choose();let p=await f.preview(c,{collision:'replace'});assert.equal(p.canApply,false);assert.match(p.rows[1].message,/ambiguous/);f.write({sessions:[validateSession({name:'Router',host:'a.example'}),validateSession({name:'Router',host:'b.example'})]});p=await f.preview(c,{collision:'replace'});assert.equal(p.canApply,false);assert.equal(f.writes(),0);
});
test('full-session freshness detects unrelated changes before approval and commit',async t=>{
  const f=await fixture(t);f.write({sessions:[validateSession({id:'other',name:'Other',host:'other.example'})]});const c=await f.choose(),p=await f.preview(c);const changed=f.read();changed.sessions[0].terminal.fontSize=18;f.write(changed);await assert.rejects(f.service.apply({planId:p.planId}),/changed after preview/);assert.equal(f.writes(),0);assert.equal(f.approvals.length,0);
});
test('approval-time changes are rechecked and declined approval never writes',async t=>{
  let f;f=await fixture(t,undefined,{approveApply:async()=>{f.write({sessions:[validateSession({name:'Changed',host:'change.example'})]});return true;}});let c=await f.choose(),p=await f.preview(c);await assert.rejects(f.service.apply({planId:p.planId}),/changed after preview/);assert.equal(f.writes(),0);
  const g=await fixture(t,undefined,{approveApply:async()=>false});c=await g.choose();p=await g.preview(c);assert.deepEqual(await g.service.apply({planId:p.planId}),{canceled:true});assert.equal(g.writes(),0);await assert.rejects(g.service.apply({planId:p.planId}),/Preview/);
});
test('limits reject oversized collections, invalid selections, and empty or fully skipped plans',async t=>{
  const f=await fixture(t);f.write({sessions:Array.from({length:1000},(_,i)=>validateSession({id:`s${i}`,name:`s${i}`,host:'host.example'}))});const c=await f.choose(),p=await f.preview(c);assert.equal(p.canApply,false);assert.match(p.message,/1,000/);assert.equal((await f.preview(c,{selectedRows:[]})).canApply,false);await assert.rejects(f.preview(c,{selectedRows:[2,2]}));await assert.rejects(f.preview(c,{selectedRows:[999]}));assert.equal(f.writes(),0);
});
test('plans expire, discard invalidates, and new preview supersedes previous plans',async t=>{
  let clock=0;const f=await fixture(t,undefined,{now:()=>clock});let c=await f.choose(),p=await f.preview(c);const p2=await f.preview(c);await assert.rejects(f.service.apply({planId:p.planId}),/Preview/);f.service.discard({fileId:c.fileId});await assert.rejects(f.service.apply({planId:p2.planId}),/Preview/);c=await f.choose();p=await f.preview(c);clock=16*60*1000;await assert.rejects(f.service.apply({planId:p.planId}),/Preview/);assert.equal(f.writes(),0);
});
test('source validation rejects invalid UTF-8, oversized files, directories and symlinks',async t=>{
  const f=await fixture(t);await fs.writeFile(f.filename,Buffer.from([0xff,0xfe,0x00]));await assert.rejects(f.choose(),/UTF-8/);await fs.writeFile(f.filename,Buffer.alloc(MAX_BYTES+1,65));await assert.rejects(f.choose(),/2 MiB/);await fs.rm(f.filename);await fs.mkdir(f.filename);await assert.rejects(f.choose(),/regular file/);await fs.rmdir(f.filename);
  if(process.platform!=='win32'){await fs.writeFile(path.join(f.directory,'target'),'Host\na.example');await fs.symlink(path.join(f.directory,'target'),f.filename);await assert.rejects(f.choose(),/links/);}
});
test('closing while a native picker waits prevents retaining its later result',async t=>{
  let resolve;const f=await fixture(t,undefined,{chooseFile:()=>new Promise(done=>resolve=done)});const pending=f.choose();f.service.close();resolve({path:f.filename});assert.deepEqual(await pending,{canceled:true});assert.equal(f.writes(),0);
});
test('failed atomic commit cannot be retried with consumed plan and does not edit the source',async t=>{
  let attempts=0;const f=await fixture(t,undefined,{commitSessions:async()=>{attempts++;throw new Error('Atomic conflict');}});const c=await f.choose(),p=await f.preview(c);await assert.rejects(f.service.apply({planId:p.planId}),/Atomic conflict/);await assert.rejects(f.service.apply({planId:p.planId}),/Preview/);assert.equal(attempts,1);assert.equal(await fs.readFile(f.filename,'utf8'),'Name,Host\nRouter,router.example\n');
});
test('inherited delimiter properties cannot select formats and headerless rows honor the data limit',async t=>{
  for(const delimiter of ['constructor','__proto__','toString'])assert.throws(()=>parseDelimited('Host\na.example\n',delimiter));
  const f=await fixture(t);const c=await f.choose();for(const delimiter of ['constructor','__proto__','toString'])await assert.rejects(f.preview(c,{delimiter}));
  await fs.writeFile(f.filename,Array(2001).fill('a.example').join('\n'));await assert.rejects(f.choose(),/2,000 data rows/);assert.equal(f.writes(),0);
});
test('closing while picker waits does not even read its selected path',async t=>{
  let resolve;const f=await fixture(t,undefined,{chooseFile:()=>new Promise(done=>resolve=done)});const pending=f.choose();f.service.close();resolve({path:path.join(f.directory,'nonexistent')});assert.deepEqual(await pending,{canceled:true});
});
test('discard during asynchronous freshness load blocks a pending apply',async t=>{
  let wait=false,resolve;const f=await fixture(t,undefined,{loadConfig:async()=>{if(wait)await new Promise(done=>resolve=done);return {sessions:[]};}});const c=await f.choose(),p=await f.preview(c);wait=true;const pending=f.service.apply({planId:p.planId});f.service.discard({fileId:c.fileId});resolve();await assert.rejects(pending,/expired|canceled/);assert.equal(f.writes(),0);assert.equal(f.approvals.length,0);
});
test('concurrent previews cannot resurrect a superseded plan',async t=>{
  let wait=false,resolve;const f=await fixture(t,undefined,{loadConfig:async()=>{if(wait){wait=false;await new Promise(done=>resolve=done);}return {sessions:[]};}});const c=await f.choose();wait=true;const older=f.preview(c);const current=await f.preview(c);resolve();await assert.rejects(older,/options changed/);await f.service.apply({planId:current.planId});assert.equal(f.writes(),1);
});
