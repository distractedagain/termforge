'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const nofollow = fs.constants.O_NOFOLLOW || 0;
const stable = value => value && typeof value === 'object' ? (Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]))) : value;
const equal = (a,b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const identity = info => Object.fromEntries(['type','mode','uid','gid','ino','dev'].filter(key=>info[key]!==undefined).map(key=>[key,info[key]]));
const snapshot = (stat, remote) => ({type:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':stat.isFile()?'file':'other',
  size:stat.size,mode:stat.mode,uid:stat.uid,gid:stat.gid,mtime:remote?stat.mtime*1000:stat.mtimeMs,
  ...(!remote?{ino:stat.ino,dev:stat.dev,ctime:stat.ctimeMs}:{})});
const join = (root, relative, remote) => (remote?path.posix:path).join(root,...relative.split('/').filter(Boolean));

// This journal records the reviewed tree, completed commits and one retained
// child stage. A mutation whose acknowledgement is uncertain is never replayed.
function createFolderRecovery({ call, remoteStat, recovery, identityFor, copy, timeout=30000 }) {
  async function persist(job) { job.checkpoint.updatedAt=Date.now(); await recovery.save(job.checkpoint); }
  function check(job) { if(job.controller.signal.aborted) throw Object.assign(new Error('Folder transfer interrupted.'),{name:'AbortError'}); }
  async function stat(job,session,filename,remote) {
    check(job);
    try { const value=remote ? await remoteStat(session.sftp,filename,job.controller.signal) : await fsp.lstat(filename); return value?snapshot(value,remote):null; }
    catch(error) { if(error.code==='ENOENT')return null; throw error; }
  }
  async function hash(job,session,filename,remote,expected) {
    const signal=job.controller.signal;let handle;
    try {
      handle=remote?await call(session.sftp,'open',[filename,'r'],signal):await fsp.open(filename,fs.constants.O_RDONLY|nofollow);
      const opened=snapshot(remote?await call(session.sftp,'fstat',[handle],signal):await handle.stat(),remote);
      if(!equal(opened,expected)||opened.type!=='file')throw new Error('A folder recovery file changed while opening.');
      const hash=createHash('sha256'),buffer=Buffer.alloc(65536);
      for(let offset=0;offset<opened.size;) {
        check(job);const length=Math.min(buffer.length,opened.size-offset);
        const count=remote?await call(session.sftp,'read',[handle,buffer,0,length,offset],signal):(await handle.read(buffer,0,length,offset)).bytesRead;
        if(!Number.isInteger(count)||count<1||count>length)throw new Error('A folder recovery file changed while hashing.');
        hash.update(buffer.subarray(0,count));offset+=count;
      }
      if(!equal(opened,snapshot(remote?await call(session.sftp,'fstat',[handle],signal):await handle.stat(),remote))
        ||!equal(opened,await stat(job,session,filename,remote)))throw new Error('A folder recovery file changed while hashing.');
      return hash.digest('hex');
    }finally{if(handle) {if(remote){try{await call(session.sftp,'close',[handle],undefined,timeout);}catch{}}else await handle.close();}}
  }
  async function parents(job,session,filename,remote) {
    const api=remote?path.posix:path,root=api.parse(filename).root,names=[root];
    for(const part of filename.slice(root.length).split(api.sep).filter(Boolean)) names.push(api.join(names.at(-1),part));
    const result=[];
    for(const name of names) {
      const info=await stat(job,session,name,remote);if(info?.type!=='directory')throw new Error('A folder recovery parent changed or is a symbolic link.');
      result.push({path:name,...identity(info)});
    }
    const canonical=remote?await call(session.sftp,'realpath',[filename],job.controller.signal):await fsp.realpath(filename);
    if(canonical!==filename)throw new Error('A folder recovery parent changed or is a symbolic link.');
    return result;
  }
  async function tree(job,session,root,remote,ignoreStage) {
    const values=[];let total=0;
    async function walk(relative,depth) {
      if(depth>32||values.length>=2000)throw new Error('A folder recovery tree exceeds the reviewed limits.');
      const filename=join(root,relative,remote),info=await stat(job,session,filename,remote);
      if(!info&&!relative)return;
      if(!info||!['file','directory'].includes(info.type))throw new Error('A folder recovery tree contains a missing, linked or special item.');
      if(info.type==='file' && (!Number.isSafeInteger(info.size) || info.size<0 || (total+=info.size)>1024**4))throw new Error('A folder recovery tree exceeds the reviewed byte limit.');
      const item={relativePath:relative,type:info.type,size:info.type==='file'?info.size:0,expected:info};
      if(info.type==='file')item.hash=await hash(job,session,filename,remote,info);
      values.push(item);
      if(info.type==='directory') {
        const listed=remote?await call(session.sftp,'readdir',[filename],job.controller.signal):await fsp.readdir(filename);
        if(!Array.isArray(listed)||listed.length>2000)throw new Error('A folder recovery tree exceeds the reviewed limits.');
        const names=listed.map(item=>remote?item.filename:item).sort();const seen=new Set();
        for(const name of names) {
          if(typeof name!=='string'||!name||name==='.'||name==='..'||/[\\/\x00-\x1f\x7f]/.test(name)||seen.has(name))throw new Error('A folder recovery tree contains an unsafe filename.');
          seen.add(name);
          const next=relative?relative+'/'+name:name;
          if(join(root,next,remote)===ignoreStage)continue;
          await walk(next,depth+1);
        }
        const after=await stat(job,session,filename,remote);
        if(!after||!equal(identity(info),identity(after)))throw new Error('A folder changed while verifying recovery.');
      }
    }
    await walk('',0);return values;
  }
  function compareTree(actual,expected,source) {
    if(actual.length!==expected.length)throw new Error(`The ${source?'source':'destination'} folder tree changed since review. Review it again instead of resuming.`);
    const map=new Map(expected.map(entry=>[entry.relativePath,entry]));
    for(const item of actual) {
      const old=map.get(item.relativePath);
      if(!old||old.type!==item.type||!equal(item.type==='directory'?identity(item.expected):item.expected,item.type==='directory'?identity(old.expected):old.expected)
        ||(item.type==='file'&&item.hash!==old.hash))throw new Error(`A ${source?'source':'destination'} folder item changed since review. Review it again instead of resuming.`);
    }
  }
  async function verify(job,session) {
    const cp=job.checkpoint,upload=cp.direction==='upload',sourceRoot=upload?cp.localPath:cp.remotePath,destinationRoot=upload?cp.remotePath:cp.localPath;
    if(identityFor(session)!==cp.identity)throw new Error('Folder recovery requires the original authenticated server and account.');
    if(!equal(cp.expected.sourceParents,await parents(job,session,(upload?path:path.posix).dirname(sourceRoot),!upload))
      ||!equal(cp.expected.destinationParents,await parents(job,session,(upload?path.posix:path).dirname(destinationRoot),upload)))throw new Error('A folder recovery parent identity changed.');
    compareTree(await tree(job,session,sourceRoot,!upload),cp.expected.entries,true);
    const expected=new Map(cp.expected.destination.map(entry=>[entry.relativePath,entry]));
    for(const item of [...cp.created,...cp.completed])expected.set(item.relativePath,item);
    compareTree(await tree(job,session,destinationRoot,upload,cp.child?.stagePath),[...expected.values()],false);
  }
  async function ancestry(job,session,entry) {
    const cp=job.checkpoint,upload=cp.direction==='upload',sourceRoot=upload?cp.localPath:cp.remotePath,targetRoot=upload?cp.remotePath:cp.localPath;
    if(!equal(cp.expected.sourceParents,await parents(job,session,(upload?path:path.posix).dirname(sourceRoot),!upload))
      ||!equal(cp.expected.destinationParents,await parents(job,session,(upload?path.posix:path).dirname(targetRoot),upload)))throw new Error('A folder recovery parent identity changed.');
    const relatives=[];if(entry.relativePath){relatives.push('');const parts=entry.relativePath.split('/').slice(0,-1);for(const part of parts)relatives.push(relatives.at(-1)?relatives.at(-1)+'/'+part:part);}
    for(const relative of relatives) {
      const expectedSource=cp.expected.entries.find(item=>item.relativePath===relative)?.expected;
      const source=await stat(job,session,join(sourceRoot,relative,!upload),!upload);
      if(!source||!expectedSource||!equal(identity(source),identity(expectedSource)))throw new Error('A source folder ancestor changed before copying.');
      const expectedTarget=cp.created.find(item=>item.relativePath===relative)?.expected || cp.expected.destination.find(item=>item.relativePath===relative)?.expected;
      const target=await stat(job,session,join(targetRoot,relative,upload),upload);
      if(!target||!expectedTarget||!equal(identity(target),identity(expectedTarget)))throw new Error('A destination folder ancestor changed before copying.');
      const filename=join(targetRoot,relative,upload),canonical=upload?await call(session.sftp,'realpath',[filename],job.controller.signal):await fsp.realpath(filename);
      if(canonical!==filename)throw new Error('A destination folder ancestor contains a symbolic link.');
    }
  }
  async function run(job,session) {
    let cp=job.checkpoint;
    try {
      if(!cp) {
        const plan=job.folderPlan;
        cp={version:2,kind:'folder',transferId:job.transferId,direction:job.direction,phase:'retained',identity:identityFor(session),host:session.host,port:session.port,
          localPath:job.localPath,remotePath:job.remotePath,mode:plan.review.mode,conflictPolicy:plan.review.conflictPolicy,
          expected:structuredClone(plan.expected),completed:[],created:[],child:null,createdAt:Date.now(),updatedAt:Date.now()};
        job.checkpoint=cp;await persist(job);
      }
      if(cp.phase!=='retained'||cp.child&&cp.child.phase!=='retained')throw new Error('A folder mutation outcome is unknown. Inspect retained files; this record cannot be resumed.');
      job.recoveryPhase='hashing';await verify(job,session);
      const upload=cp.direction==='upload',destinationRoot=upload?cp.remotePath:cp.localPath;
      for(const entry of cp.expected.entries) {
        check(job);
        if(job.pauseRequested)return 'paused';
        if(entry.action==='skip'||cp.completed.some(item=>item.relativePath===entry.relativePath)||cp.created.some(item=>item.relativePath===entry.relativePath))continue;
        job.currentPath=entry.relativePath||path.basename(cp.localPath);job.publish();job.recoveryPhase='copying';
        await ancestry(job,session,entry);
        const target=join(destinationRoot,entry.relativePath,upload);
        if(entry.action==='mkdir') {
          // Persist intent first. A crash between mkdir and its durable receipt
          // is conservatively indeterminate rather than blindly repeated.
          cp.phase='committing';await persist(job);
          if(upload)await call(session.sftp,'mkdir',[target,{mode:0o700}],undefined,timeout);else await fsp.mkdir(target,{mode:0o700});
          const info=await stat(job,session,target,upload);if(info?.type!=='directory')throw new Error('The created folder could not be verified.');
          cp.created.push({relativePath:entry.relativePath,type:'directory',size:0,expected:info});cp.phase='retained';job.directoriesCreated=cp.created.length;await persist(job);job.publish();
        }else {
          const before=await stat(job,session,target,upload);
          if(!equal(before,entry.destinationExpected))throw new Error('A reviewed folder destination changed before copying.');
          const source=join(upload?cp.localPath:cp.remotePath,entry.relativePath,!upload);
          const validate=async()=>{
            await ancestry(job,session,entry);
            const info=await stat(job,session,source,!upload);
            if(!equal(info,entry.expected)||await hash(job,session,source,!upload,info)!==entry.hash)throw new Error('A reviewed folder source changed before commit.');
            const current=await stat(job,session,target,upload);
            if(!equal(current,entry.destinationExpected)||(current&&await hash(job,session,target,upload,current)!==entry.destinationHash))throw new Error('A reviewed folder destination changed before commit.');
          };
          const result=await copy(job,session,{entry,localPath:join(cp.localPath,entry.relativePath,false),remotePath:join(cp.remotePath,entry.relativePath,true),validate,
            save:async checkpoint=>{cp.child=checkpoint;await persist(job);},
            committed:async()=>{
              const info=await stat(job,session,target,upload);if(info?.type!=='file'||await hash(job,session,target,upload,info)!==entry.hash)throw new Error('The committed folder child could not be verified.');
              cp.completed.push({relativePath:entry.relativePath,type:'file',size:entry.size,expected:info,hash:entry.hash});cp.child=null;job.filesCompleted=cp.completed.length;await persist(job);
            }});
          if(result==='paused')return result;
          job.publish();
        }
      }
      job.recoveryPhase='hashing';await verify(job,session);await recovery.remove(job.transferId);job.checkpoint=null;job.currentPath='';return 'completed';
    }catch(error) {
      if(cp) {
        if(cp.phase==='committing'||cp.child?.phase==='indeterminate'||cp.child?.phase==='committing')cp.phase='indeterminate';
        try{await persist(job);}catch(saveError){job.warning=`Folder recovery checkpoint could not be updated: ${saveError.message}`;}
        error.recoverable=true;
      }
      throw error;
    }
  }
  return {run,verify};
}
module.exports={createFolderRecovery};
