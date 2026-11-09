import path from 'node:path';
import { Worker } from 'node:worker_threads';

// One bounded worker at a time. Source documents are never modified or sent away.
export function createMetadataQueue(db, files, store, {enabled=true,delayMs=300,timeoutMs=15000}={}) {
  let stopped=false,running=false,currentWorker=null,currentTask=null,timer=null;
  db.prepare("UPDATE metadata_jobs SET status='pending' WHERE status='running'").run();
  const next=db.prepare("SELECT j.*,f.relative_path FROM metadata_jobs j JOIN ebook_files f ON f.id=j.id JOIN catalog_items c ON c.id=j.id WHERE j.status='pending' AND f.available=1 ORDER BY j.id LIMIT 1");
  function status(){
    const counts={pending:0,running:0,done:0,empty:0,failed:0};
    for(const row of db.prepare('SELECT j.status,count(*) n FROM metadata_jobs j JOIN ebook_files f ON f.id=j.id JOIN catalog_items c ON c.id=j.id WHERE f.available=1 GROUP BY j.status').all())counts[row.status]=row.n;
    return {...counts,total:Object.values(counts).reduce((a,b)=>a+b,0),enabled};
  }
  function extract(opened){return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./metadata-worker.mjs',import.meta.url),{workerData:{fd:opened.handle.fd,size:opened.stat.size,format:path.extname(opened.name).slice(1)},resourceLimits:{maxOldGenerationSizeMb:192},stdout:true,stderr:true});
    currentWorker=worker;
    // Parser warnings may contain document text; discard worker output.
    worker.stdout.resume();worker.stderr.resume();
    let result,received=false,problem;
    const timeout=setTimeout(()=>{problem=Error('提取超时');void worker.terminate();},timeoutMs);
    worker.once('message',message=>{received=true;if(message.ok)result=message.metadata;else problem=Error('无法提取');});
    worker.once('error',error=>{problem=error;});
    worker.once('exit',code=>{clearTimeout(timeout);currentWorker=null;problem||code!==0||!received?reject(problem||Error('提取未完成')):resolve(result);});
  });}
  async function tick(){
    if(stopped||running||!enabled)return;
    const job=next.get();if(!job){timer=setTimeout(tick,2000);timer.unref();return;}
    running=true;
    currentTask=(async()=>{
      let opened;
      try {
        db.prepare("UPDATE metadata_jobs SET status='running' WHERE id=? AND size=? AND mtime=?").run(job.id,job.size,job.mtime);
        opened=await files.openMetadata(job.id);
        if(stopped)return;
        if(opened.stat.size!==job.size||Math.round(opened.stat.mtimeMs)!==job.mtime)throw Error('文件已变化');
        const metadata=await extract(opened);
        if(stopped)return;
        const stat=await opened.handle.stat();
        if(stat.size!==job.size||Math.round(stat.mtimeMs)!==job.mtime)throw Error('文件已变化');
        const latest=db.prepare('SELECT size,mtime FROM metadata_jobs WHERE id=?').get(job.id);
        if(!latest||latest.size!==job.size||latest.mtime!==job.mtime)return;
        db.exec('BEGIN IMMEDIATE');
        try {
          const title=path.posix.basename(job.relative_path,path.posix.extname(job.relative_path)).slice(0,300)||'未命名资料';
          const changed=store.enrich(job.id,metadata||{},title);
          if(changed)store.bump();
          db.prepare('UPDATE metadata_jobs SET status=?,updated=? WHERE id=?').run(Object.keys(metadata||{}).length?'done':'empty',Date.now(),job.id);
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
      }catch{
        if(!stopped)db.prepare("UPDATE metadata_jobs SET status='failed',updated=? WHERE id=? AND size=? AND mtime=?").run(Date.now(),job.id,job.size,job.mtime);
      }finally{if(opened)await opened.handle.close();}
    })();
    try{await currentTask;}finally{running=false;currentTask=null;if(!stopped){timer=setTimeout(tick,delayMs);timer.unref();}}
  }
  async function stop(){stopped=true;clearTimeout(timer);if(currentWorker)await currentWorker.terminate();if(currentTask)await currentTask;db.prepare("UPDATE metadata_jobs SET status='pending' WHERE status='running'").run();}
  if(enabled){timer=setTimeout(tick,1000);timer.unref();}
  return {status,stop};
}
