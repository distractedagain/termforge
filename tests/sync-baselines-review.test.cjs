'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createSyncBaselines}=require('../app/sync-baselines.cjs');

async function fixture(t) {
  const root=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'forgecrt-baseline-review-')));
  const directory=path.join(root,'store');t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const store=createSyncBaselines(directory);
  const reference={pairId:randomUUID(),identity:'a'.repeat(64),localPath:path.join(root,'local'),remotePath:'/remote',name:'Reviewed pair',revision:0,lastSyncedAt:null,entries:[]};
  const lease=await store.begin(reference);const saved=await lease.commit([{relativePath:'',type:'directory',size:0},{relativePath:'file',type:'file',size:3,hash:'b'.repeat(64)}]);await lease.release();
  return {root,directory,store,saved,filename:path.join(directory,'pairs.json'),lock:path.join(directory,'pairs.lock')};
}

test('baseline commit and release refuse a replaced lock without deleting its new owner',async t=>{
  const f=await fixture(t),lease=await f.store.begin(f.saved);const before=await fsp.readFile(f.filename);
  await fsp.rename(f.lock,path.join(f.directory,'prior.lock'));
  const foreign={version:1,pid:process.pid,nonce:randomUUID()};await fsp.writeFile(f.lock,JSON.stringify(foreign),{mode:0o600});
  await assert.rejects(lease.commit(f.saved.entries),/lease changed/);await assert.rejects(lease.release(),/lease changed/);
  assert.deepEqual(await fsp.readFile(f.filename),before);assert.deepEqual(JSON.parse(await fsp.readFile(f.lock)),foreign);
});

test('baseline lease refuses a swapped storage directory and preserves both stores',async t=>{
  const f=await fixture(t),lease=await f.store.begin(f.saved);const before=await fsp.readFile(f.filename);
  const moved=path.join(f.root,'original');await fsp.rename(f.directory,moved);await fsp.mkdir(f.directory,{mode:0o700});
  const marker=path.join(f.directory,'unrelated');await fsp.writeFile(marker,'keep');
  await assert.rejects(lease.commit(f.saved.entries));await assert.rejects(lease.release());
  assert.deepEqual(await fsp.readFile(path.join(moved,'pairs.json')),before);assert.equal(await fsp.readFile(marker,'utf8'),'keep');
  assert.deepEqual(await fsp.readdir(f.directory),['unrelated']);
});

test('baseline loader bounds bytes even when a private file grows after its initial stat',async t=>{
  const f=await fixture(t);const originalOpen=fsp.open;let grew=false;
  fsp.open=async function(filename,...args){
    const handle=await originalOpen.call(this,filename,...args);
    if(filename===f.filename){const originalStat=handle.stat.bind(handle);handle.stat=async()=>{const stat=await originalStat();if(!grew){grew=true;await fsp.appendFile(f.filename,' '.repeat(16*1024*1024));}return stat;};}
    return handle;
  };
  try{await assert.rejects(f.store.load(),/large|limit|unsafe|bound|changed/i);}finally{fsp.open=originalOpen;}
  assert.equal(grew,true);
});
