'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTransferRecovery } = require('../app/transfer-recovery.cjs');

test('folder journal preserves opaque Windows-style inode/device IDs beyond the safe arithmetic range', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forgecrt-journal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const recovery=createTransferRecovery(directory);
  const metadata={type:'directory',size:0,mtime:1234.5,ctime:1234.5,mode:0o40700,uid:-1,gid:-1,ino:2**60,dev:2**54};
  assert.equal(Number.isSafeInteger(metadata.ino),false);
  const record={version:2,kind:'folder',transferId:randomUUID(),direction:'upload',phase:'retained',identity:'a'.repeat(64),host:'fixture',port:22,
    localPath:path.join(directory,'source'),remotePath:'/destination',mode:'copy',conflictPolicy:'skip',
    expected:{entries:[{relativePath:'',type:'directory',size:0,action:'mkdir',expected:metadata,destinationExpected:null}],destination:[],
      sourceParents:[{path:directory,type:'directory',mode:metadata.mode,uid:-1,gid:-1,ino:metadata.ino,dev:metadata.dev}],
      destinationParents:[{path:'/',type:'directory',mode:metadata.mode,uid:0,gid:0}],files:0,directories:1,totalBytes:0,copied:0,replaced:0,skipped:0,kept:0,sourceFiles:0,sourceDirectories:1},
    completed:[],created:[],child:null,createdAt:Date.now(),updatedAt:Date.now()};
  await recovery.save(record);
  const [loaded]=await recovery.load();
  assert.deepEqual(loaded.expected.entries[0].expected,metadata);
  for(const value of [Infinity,NaN,1.5,'9007199254740992']) {
    const invalid=structuredClone(record);invalid.expected.entries[0].expected.ino=value;
    await assert.rejects(recovery.save(invalid),/Invalid folder recovery metadata/);
  }
  const invalid=structuredClone(record);invalid.expected.entries[0].expected.size=2**54;
  await assert.rejects(recovery.save(invalid),/Invalid folder recovery metadata/);
});
