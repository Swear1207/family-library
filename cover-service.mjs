import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const MiB = 1024 * 1024;
const fail = (status,message) => Object.assign(Error(message),{status});
const hash = value => createHash('sha256').update(value).digest('hex');
const supported = new Set(['pdf','epub','png','jpg','jpeg','webp','gif','bmp']);
const signature = (id,stat,format) => hash(JSON.stringify(['cover-v1',id,stat.size,stat.mtimeMs,stat.ctimeMs,stat.dev,stat.ino,format]));

/** On-demand, single-worker cover cache. Caller must check auth on every request.
 * ready: {path,mime,size,etag}; pending: retryAfter seconds; unavailable: icon.
 * Never send path to clients. Source handles remain open until worker exit.
 */
export function createCoverService({dataDir,files,timeoutMs=10000,maxQueued=64}={}) {
  let stopped=false,currentWorker=null,currentTask=null,rootPromise;
  const jobs=new Map(),queue=[];
  maxQueued=Math.max(1,Math.min(128,Number.isSafeInteger(maxQueued)?maxQueued:64));
  timeoutMs=Math.max(1,Math.min(15000,Number.isSafeInteger(timeoutMs)?timeoutMs:10000));
  async function directory(parent,name) {
    const location=path.join(parent,name);
    try { await mkdir(location,{mode:0o700}); } catch(error) { if(error.code!=='EEXIST')throw error; }
    const stat=await lstat(location);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe cover cache directory');
    const actual=await realpath(location);
    if(path.dirname(actual)!==parent)throw Error('Unsafe cover cache path');
    return actual;
  }
  async function cachePaths(id,key) {
    rootPromise ||= (async()=>directory(await realpath(dataDir),'covers'))();
    const root=await rootPromise,first=await directory(root,id.slice(5,7)),folder=await directory(first,id.slice(5));
    return {folder,image:path.join(folder,key+'.jpg'),empty:path.join(folder,key+'.none')};
  }
  async function cached(paths,key) {
    try {
      const stat=await lstat(paths.image);
      if(stat.isSymbolicLink()||!stat.isFile()||stat.size<4||stat.size>MiB)return {status:'unavailable'};
      const handle=await open(paths.image,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      try {const head=Buffer.alloc(3);await handle.read(head,0,3,0);if(!head.equals(Buffer.from([255,216,255])))return {status:'unavailable'};}
      finally {await handle.close();}
      return {status:'ready',path:paths.image,mime:'image/jpeg',size:stat.size,etag:'"'+key+'"'};
    } catch(error) {if(error.code!=='ENOENT')throw error;}
    try {const stat=await lstat(paths.empty);if(stat.isFile()&&!stat.isSymbolicLink())return {status:'unavailable'};} catch(error) {if(error.code!=='ENOENT')throw error;}
    return null;
  }
  function render(job) {
    return new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./cover-worker.mjs',import.meta.url),{workerData:{fd:job.opened.handle.fd,size:job.opened.stat.size,format:job.format},
        resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:16},stdout:true,stderr:true});
      currentWorker=worker;worker.stdout.resume();worker.stderr.resume();
      let result,received=false,problem;
      const timer=setTimeout(()=>{problem=Error('Cover timeout');void worker.terminate();},timeoutMs);
      worker.once('message',message=>{received=true;if(message.ok&&message.bytes instanceof Uint8Array)result=message.bytes;});
      worker.once('error',error=>{problem=error;});
      worker.once('exit',code=>{clearTimeout(timer);currentWorker=null;problem||code!==0||!received?reject(problem||Error('Cover worker failed')):resolve(result);});
    });
  }
  async function persist(job,data) {
    if(data&&(!(data instanceof Uint8Array)||data.length<4||data.length>MiB||data[0]!==255||data[1]!==216||data[2]!==255))throw Error('Invalid cover result');
    const target=data?job.paths.image:job.paths.empty,temp=target+'.'+randomBytes(8).toString('hex')+'.tmp';
    try {
      await writeFile(temp,data||'',{flag:'wx',mode:0o600});await rename(temp,target);
      // A per-document directory contains only its current derivative, never originals.
      for(const name of await readdir(job.paths.folder))if(name!==path.basename(target)&&/^[a-f0-9]{64}\.(?:jpg|none)$/.test(name))await unlink(path.join(job.paths.folder,name)).catch(()=>{});
    } finally {await unlink(temp).catch(()=>{});}
  }
  function pump() {
    if(stopped||currentTask||!queue.length)return;
    const job=queue.shift();
    currentTask=(async()=>{
      try {
        let data;
        try {data=await render(job);} catch {data=null;}
        if(stopped)return;
        const stat=await job.opened.handle.stat();
        if(signature(job.id,stat,job.format)!==job.key)return;
        await persist(job,data);
      } catch { /* Cache or rendering errors degrade to the format icon. */ }
      finally {jobs.delete(job.key);await job.opened.handle.close();}
    })().finally(()=>{currentTask=null;pump();});
  }
  async function get(id,authorized) {
    const authorize=typeof authorized==='function'?authorized:()=>false;
    if(!authorize())throw fail(401,'请先登录家庭账号');
    if(typeof id!=='string'||!/^file-[a-f0-9]{64}$/.test(id))throw fail(404,'文件不存在');
    let opened=await files.openFileSafe(id,authorize);
    try {
      const format=path.extname(opened.name).slice(1).toLowerCase(),size=opened.stat.size;
      if(!supported.has(format)||size<=0||size>(format==='pdf'?512*MiB:format==='epub'?64*MiB:24*MiB)||stopped)return {status:'unavailable'};
      const key=signature(id,opened.stat,format),paths=await cachePaths(id,key),existing=await cached(paths,key);
      if(!authorize())throw fail(401,'登录已失效，请重新登录');
      if(stopped)return {status:'unavailable'};
      if(existing)return existing;
      if(jobs.has(key)||queue.length>=maxQueued)return {status:'pending',retryAfter:2};
      const job={id,key,format,paths,opened};jobs.set(key,job);queue.push(job);opened=null;pump();
      return {status:'pending',retryAfter:2};
    } catch(error) {
      if(error.status)throw error;
      return {status:'unavailable'};
    } finally {if(opened)await opened.handle.close();}
  }
  async function stop() {
    stopped=true;
    for(const job of queue.splice(0)){jobs.delete(job.key);await job.opened.handle.close();}
    if(currentWorker)await currentWorker.terminate();
    if(currentTask)await currentTask;
  }
  return {get,stop};
}
