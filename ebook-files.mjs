import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';

const extensions=new Set(['.pdf','.epub','.mobi','.azw','.azw3','.txt','.cbz','.djvu']);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const inside=(root,target)=>{const rel=path.relative(root,target);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)};

export function createFileLibrary(db,booksDir){
 let scanning=false;
 const enabled=!!booksDir;
 async function rootPath(){if(!enabled)throw fail(400,'尚未配置书籍目录');try{const root=await fs.promises.realpath(booksDir);if(!(await fs.promises.stat(root)).isDirectory())throw Error();return root}catch{throw fail(503,'书籍目录不可读取，请检查 /books 挂载与目录权限')}}
 function attach(books){const index=new Map(db.prepare('SELECT * FROM ebook_files').all().map(f=>[f.id,f]));return books.map(b=>{const f=index.get(b.id);const {file:ignored,...clean}=b;return f?{...clean,file:{name:path.posix.basename(f.relative_path),format:path.posix.extname(f.relative_path).slice(1).toUpperCase(),size:f.size,available:!!f.available}}:clean})}
 async function scan(authorize=()=>true){
  if(scanning)throw fail(409,'正在扫描，请稍后再试');scanning=true;
  try{
   const root=await rootPath(),found=[];let skipped=0,visited=0;
   async function walk(dir,depth=0){if(depth>40)throw fail(400,'目录层级超过 40 层，请缩小书籍目录范围');
    const entries=await fs.promises.readdir(dir,{withFileTypes:true});
    for(const entry of entries){if(++visited>100000)throw fail(400,'目录条目超过 100000，请缩小扫描范围');
     if(entry.name.startsWith('.')||entry.isSymbolicLink()){skipped++;continue}
     const full=path.join(dir,entry.name),s=await fs.promises.lstat(full);if(s.isSymbolicLink()){skipped++;continue}
     const resolved=await fs.promises.realpath(full);if(!inside(root,resolved)){skipped++;continue}
     if(s.isDirectory()){await walk(full,depth+1);continue}
     if(!s.isFile()||!extensions.has(path.extname(entry.name).toLowerCase())){skipped++;continue}
     if(found.length>=10000)throw fail(400,'电子书超过 10000 本，请缩小扫描范围');
     const relative=path.relative(root,full).split(path.sep).join('/');
     found.push({id:'file-'+createHash('sha256').update(relative).digest('hex'),relative,size:s.size,mtime:Math.round(s.mtimeMs)});
    }
   }
   try{await walk(root)}catch(e){if(e.status)throw e;throw fail(503,'扫描中断：有目录或文件无法读取。请检查权限后重试，原书架未改动。')}
   if(!authorize())throw fail(401,'登录已失效，请重新登录');
   db.exec('BEGIN IMMEDIATE');
   try{
    const current=db.prepare('SELECT * FROM library WHERE id=1').get();if(!current)throw fail(401,'请先设置家庭账号');
    const books=JSON.parse(current.books),existing=new Set(books.map(b=>b.id));let added=0;
    const newFiles=found.filter(f=>!existing.has(f.id));if(books.length+newFiles.length>10000)throw fail(400,'书架最多保存 10000 本，请缩小目录范围或整理书架');
    const previous=new Map(db.prepare('SELECT * FROM ebook_files').all().map(f=>[f.id,f]));
    const presentIds=new Set(found.map(f=>f.id));
    const changed=newFiles.length>0||found.some(f=>{const old=previous.get(f.id);return !old||!old.available||old.size!==f.size||old.mtime!==f.mtime})||[...previous.values()].some(f=>f.available&&!presentIds.has(f.id));
    if(!changed){const missing=books.filter(b=>previous.get(b.id)?.available===0).length;db.exec('COMMIT');return {added:0,found:found.length,missing,skipped,version:current.version}}
    db.prepare('UPDATE ebook_files SET available=0').run();
    const upsert=db.prepare('INSERT INTO ebook_files (id,relative_path,size,mtime,available) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path,size=excluded.size,mtime=excluded.mtime,available=1');
    for(const f of found){upsert.run(f.id,f.relative,f.size,f.mtime);if(existing.has(f.id))continue;const ext=path.posix.extname(f.relative);books.push({id:f.id,title:path.posix.basename(f.relative,ext).slice(0,100)||'未命名电子书',author:'',category:'其他',status:'未读',location:(path.posix.dirname(f.relative)==='.'?'电子书目录':path.posix.dirname(f.relative)).slice(0,80),borrower:'',notes:'',created:Date.now(),color:'#456258',demo:false});added++}
    const missing=books.filter(b=>db.prepare('SELECT available FROM ebook_files WHERE id=?').get(b.id)?.available===0).length;
    const version=db.prepare('UPDATE library SET books=?,version=version+1 WHERE id=1 RETURNING version').get(JSON.stringify(books));db.exec('COMMIT');return {added,found:found.length,missing,skipped,version:version.version};
   }catch(e){db.exec('ROLLBACK');throw e}
  }finally{scanning=false}
 }
 async function download(req,res,id,authorize=()=>true){
  if(typeof id!=='string'||!/^file-[a-f0-9]{64}$/.test(id))throw fail(404,'文件不存在');
  const file=db.prepare('SELECT * FROM ebook_files WHERE id=? AND available=1').get(id);
  if(!file)throw fail(404,'文件不存在，请重新扫描书籍目录');
  const root=await rootPath(),parts=file.relative_path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')))throw fail(404,'文件路径无效');
  let full=root,handle;
  try{
   for(const part of parts){full=path.join(full,part);if((await fs.promises.lstat(full)).isSymbolicLink())throw fail(404,'不支持下载符号链接')}
   const real=await fs.promises.realpath(full);if(!inside(root,real))throw fail(404,'文件不在书籍目录中');
   handle=await fs.promises.open(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   // Linux NAS: verify the opened descriptor still resolves inside the mounted book directory.
   if(process.platform==='linux'){const opened=await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);if(!inside(root,opened))throw fail(404,'文件路径已变化，请重新扫描')}
   const stat=await handle.stat();if(!stat.isFile())throw fail(404,'文件不存在');
   if(!authorize())throw fail(401,'登录已失效，请重新登录');
   const name=path.posix.basename(file.relative_path),encoded=encodeURIComponent(name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
   const ext=path.posix.extname(name).toLowerCase();
   res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store, private','Content-Disposition':`attachment; filename="book${ext}"; filename*=UTF-8''${encoded}`});
   const stream=handle.createReadStream({autoClose:true});handle=null;await pipeline(stream,res);
  }catch(e){if(e.status)throw e;if(!res.headersSent)throw fail(404,'文件无法读取或已移动，请重新扫描');if(!res.destroyed)res.destroy()}
  finally{if(handle)await handle.close()}
 }
 return {enabled,attach,scan,download};
}
