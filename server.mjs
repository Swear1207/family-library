import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { createFileLibrary } from './ebook-files.mjs';
import { validBook, cleanBook, normalizeBook } from './catalog.mjs';
import { createCatalogStore } from './catalog-store.mjs';
import { createMetadataQueue } from './metadata-queue.mjs';

const publicDir=fileURLToPath(new URL('./public/',import.meta.url));
const derive=promisify(scrypt),TTL=7*86400,MAX_BYTES=5*1024*1024;
const token=()=>randomBytes(32).toString('hex');
const digest=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function hashPassword(password,salt){return (await derive(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024})).toString('hex')}
const error=(status,message)=>Object.assign(new Error(message),{status});
const passwords=p=>typeof p==='string'&&p.length>=12&&p.length<=128;

export function createLibraryServer({dataDir,origin,booksDir,autoScanMs=0,metadataEnabled=autoScanMs>0,metadataDelayMs=300,metadataTimeoutMs=15000}={}){
 const appOrigin=new URL(origin).origin;
 if(!['http:','https:'].includes(new URL(appOrigin).protocol))throw Error('APP_ORIGIN must use http:// or https://');
 if(new URL(origin).pathname!=='/'||new URL(origin).search||new URL(origin).hash)throw Error('APP_ORIGIN must be an origin without path, query or fragment');
 const secure=appOrigin.startsWith('https:');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path.join(dataDir,'library.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
 const schemaVersion=db.prepare('PRAGMA user_version').get().user_version;
 if(schemaVersion>4){db.close();throw Error('Database version is newer than this application')}
 if(schemaVersion>0&&schemaVersion<4){
  const backupDir=path.join(dataDir,'backups');fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  const backup=path.join(backupDir,`before-v4-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);fs.chmodSync(backup,0o600);
 }
 if(schemaVersion===0){db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE account (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL);
 CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
 CREATE TABLE library (id INTEGER PRIMARY KEY CHECK(id=1), books TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
 PRAGMA user_version=1; COMMIT;`)}
 if(schemaVersion<2){db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE ebook_files (id TEXT PRIMARY KEY, relative_path TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1);
 PRAGMA user_version=2; COMMIT;`)}
 if(schemaVersion<3){db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE reading_progress (id TEXT PRIMARY KEY, kind TEXT NOT NULL, location TEXT NOT NULL, progress REAL NOT NULL, updated INTEGER NOT NULL);
 PRAGMA user_version=3; COMMIT;`)}
 const store=createCatalogStore(db);
 db.exec('PRAGMA user_version=4');
 const files=createFileLibrary(db,booksDir,store);
 const metadata=createMetadataQueue(db,files,store,{enabled:metadataEnabled,delayMs:metadataDelayMs,timeoutMs:metadataTimeoutMs});
 const setupPath=path.join(dataDir,'setup-token.txt');
 const getAccount=()=>db.prepare('SELECT * FROM account WHERE id=1').get();
 if(!getAccount()&&!fs.existsSync(setupPath))fs.writeFileSync(setupPath,token()+'\n',{flag:'wx',mode:0o600});
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}
 let backgroundScan=null,closing=false;
 function autoScan(retryMetadata=false){if(closing||!files.enabled||!getAccount()||backgroundScan||files.status().running)return; backgroundScan=files.scan(()=>!closing,{retryMetadata}).catch(e=>{if(e.status!==409&&!closing)console.error('自动扫描未完成，已收录的资料已保存。请检查目录挂载和读取权限。')}).finally(()=>{backgroundScan=null})}
 const scanTimer=autoScanMs>0?setInterval(autoScan,Math.max(autoScanMs,60000)):null;scanTimer?.unref();
 const firstScan=autoScanMs>0?setTimeout(autoScan,1000):null;firstScan?.unref();
 function cookie(value,clear=false){return `family_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:TTL}${secure?'; Secure':''}`}
 function session(req){const raw=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('family_session='))?.slice(15);if(!raw||!/^[a-f0-9]{64}$/.test(raw))return null;const key=digest(raw);return db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires>?').get(key,Date.now())?key:null}
 function insertSession(){const raw=token();db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('INSERT INTO sessions (token_hash,expires) VALUES (?,?)').run(digest(raw),Date.now()+TTL*1000);return cookie(raw)}
 function limited(req){const now=Date.now(),slot=Math.floor(now/900000);const keys=[`ip:${digest(req.socket.remoteAddress||'unknown')}:${slot}`,`global:${slot}`];db.prepare('DELETE FROM attempts WHERE expires<?').run(now);const counts=keys.map(key=>db.prepare('INSERT INTO attempts (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').get(key,now+1800000).count);if(counts[0]>30||counts[1]>150)throw error(429,'尝试次数过多，请 15 分钟后重试')}
 let pendingHashes=0;
 async function passwordHash(p,s){if(pendingHashes>=4)throw error(429,'服务正忙，请稍后重试');pendingHashes++;try{return await hashPassword(p,s)}finally{pendingHashes--}}
 function send(res,body,status=200,cookieValue){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private',...(cookieValue?{'Set-Cookie':cookieValue}:{})});res.end(JSON.stringify(body))}
 async function readBody(req,limit=MAX_BYTES){if(!req.headers['content-type']?.startsWith('application/json'))throw error(415,'请使用 JSON 请求');const tooLarge=()=>error(413,`请求内容不能超过 ${limit/1024/1024} MiB`);if(Number(req.headers['content-length']||0)>limit)throw tooLarge();let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw tooLarge();chunks.push(chunk)}try{const d=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!d||typeof d!=='object'||Array.isArray(d))throw Error();return d}catch{throw error(400,'请求格式不正确')}}
 async function api(req,res,action){
  if(!['GET','HEAD','POST','PUT','DELETE'].includes(req.method))throw error(405,'请求方法不支持');
  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==appOrigin)throw error(403,'访问地址与 APP_ORIGIN 配置不一致，请从正确的网址打开');
  if(action==='session'&&req.method==='GET'){const a=getAccount(),signedIn=!!session(req);return send(res,{configured:!!a,authenticated:signedIn,canSetup:!a,fileLibraryEnabled:files.enabled,username:signedIn?a.username:undefined})}
  if(action==='scan'&&req.method==='GET'){if(!session(req))throw error(401,'请先登录家庭账号');return send(res,{...files.status(),metadata:metadata.status()})}
  if(action==='scan'&&req.method==='POST'){if(!session(req))throw error(401,'请先登录家庭账号');const d=await readBody(req);if(d.background===true){autoScan(true);return send(res,{...files.status(),metadata:metadata.status()},202)}return send(res,await files.scan(()=>!!session(req),{retryMetadata:true}))}
  if(['download','content'].includes(action)&&['GET','HEAD'].includes(req.method)){
   if(!session(req))throw error(401,'请先登录家庭账号');const id=new URL(req.url,'http://localhost').searchParams.get('id');
   return await files[action==='download'?'download':'preview'](req,res,id,()=>!!session(req));
  }
  if(action==='text'&&req.method==='GET'){
   if(!session(req))throw error(401,'请先登录家庭账号');const params=new URL(req.url,'http://localhost').searchParams;
   return send(res,await files.text(params.get('id'),()=>!!session(req),params.get('encoding')||'auto'));
  }
  if(action==='resources'&&req.method==='GET'){
   if(!session(req))throw error(401,'请先登录家庭账号');const result=store.search(new URL(req.url,'http://localhost').searchParams);
   return send(res,{...result,items:files.attach(result.items).map(normalizeBook)});
  }
  if(action==='document'){
   if(!session(req))throw error(401,'请先登录家庭账号');const id=new URL(req.url,'http://localhost').searchParams.get('id');
   if(req.method==='GET'){
    const book=store.get(id);
    if(!book)throw error(404,'资料不存在，请刷新资料库');
    return send(res,{book:normalizeBook(files.attach([book])[0]),version:store.version(),recordVersion:digest(JSON.stringify(book)),progress:db.prepare('SELECT kind,location,progress,updated FROM reading_progress WHERE id=?').get(id)||null});
   }
   if(req.method==='PUT'||req.method==='DELETE'){
    const d=await readBody(req);if(!session(req))throw error(401,'登录已失效，请重新登录');
    if(!Number.isSafeInteger(d.version)||d.version<0)throw error(400,'资料版本不正确');
    if(d.recordVersion!==undefined&&d.recordVersion!=='new'&&!/^[a-f0-9]{64}$/.test(d.recordVersion))throw error(400,'资料版本不正确');
    if(req.method==='PUT'&&!validBook(d.book))throw error(400,'资料信息格式不正确');
    const result=transaction(()=>{
     const target=req.method==='PUT'?d.book.id:id;
     const current=store.get(target);
     if(d.recordVersion!==undefined ? (current?digest(JSON.stringify(current)): 'new')!==d.recordVersion : store.version()!==d.version)throw error(409,'这条资料刚有更新，请刷新后重新核对保存');
     if(req.method==='DELETE'){
      if(!store.get(target))throw error(404,'资料不存在');store.remove(target);db.prepare('DELETE FROM reading_progress WHERE id=?').run(target);
     }else{
      store.put(cleanBook(d.book),{manual:true});
     }
     return {ok:true,version:store.bump()};
    });return send(res,result);
   }
  }
  if(action==='progress'&&req.method==='POST'){
   if(!session(req))throw error(401,'请先登录家庭账号');const d=await readBody(req);
   if(typeof d.id!=='string'||!['pdf','epub','text','audio','video','image'].includes(d.kind)||typeof d.location!=='string'||d.location.length>2048||!Number.isFinite(d.progress)||d.progress<0||d.progress>1)throw error(400,'阅读进度格式不正确');
   const book=store.get(d.id);
   if(!book)throw error(404,'资料不存在');const attached=files.attach([book])[0];
   if(!attached.file?.available||attached.file.preview!==d.kind)throw error(400,'该资料不支持此类型的阅读进度');
   if(!session(req))throw error(401,'登录已失效，请重新登录');const updated=Date.now();
   db.prepare('INSERT INTO reading_progress (id,kind,location,progress,updated) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,location=excluded.location,progress=excluded.progress,updated=excluded.updated').run(d.id,d.kind,d.location,d.progress,updated);
   return send(res,{ok:true,updated});
  }
  if(action==='setup'&&req.method==='POST'){
   limited(req);if(getAccount())throw error(409,'账号已设置，请直接登录');const d=await readBody(req);
   const expected=fs.existsSync(setupPath)?fs.readFileSync(setupPath,'utf8').trim():'';
   if(!expected||typeof d.setupToken!=='string'||!equal(d.setupToken.trim(),expected))throw error(403,'初始化密钥不正确，请从 NAS 数据目录读取');
   if(typeof d.username!=='string'||!/^[a-zA-Z0-9_-]{3,32}$/.test(d.username)||!passwords(d.password))throw error(400,'账号需为 3–32 位字母、数字或下划线；密码需为 12–128 位');
   const salt=token(),hash=await passwordHash(d.password,salt);
   const c=transaction(()=>{if(getAccount())throw error(409,'账号已设置，请直接登录');db.prepare('INSERT INTO account VALUES (1,?,?,?)').run(d.username,hash,salt);db.prepare("INSERT INTO library VALUES (1,'[]',0)").run();return insertSession()});
   try{fs.unlinkSync(setupPath)}catch{}
   if(autoScanMs>0)autoScan();
   return send(res,{ok:true},200,c);
  }
  if(action==='login'&&req.method==='POST'){
   limited(req);const d=await readBody(req);if(typeof d.username!=='string'||typeof d.password!=='string'||d.username.length>32||d.password.length>128)throw error(401,'账号或密码不正确');
   const a=getAccount(),hash=await passwordHash(d.password,a?.salt||'not-configured');
   if(!a||!equal(hash,a.password_hash)||!equal(d.username,a.username))throw error(401,'账号或密码不正确');
   const c=transaction(()=>{if(getAccount()?.password_hash!==a.password_hash)throw error(401,'密码刚刚被修改，请重新登录');return insertSession()});return send(res,{ok:true},200,c);
  }
  if(action==='logout'&&req.method==='POST'){const s=session(req);if(s)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s);return send(res,{ok:true},200,cookie('',true))}
  if(action==='password'&&req.method==='POST'){
   if(!session(req))throw error(401,'请先登录');limited(req);const d=await readBody(req);if(typeof d.currentPassword!=='string'||d.currentPassword.length>128||!passwords(d.password))throw error(400,'新密码需为 12–128 位');
   const a=getAccount();if(!equal(await passwordHash(d.currentPassword,a.salt),a.password_hash))throw error(401,'原密码不正确');
   const salt=token(),hash=await passwordHash(d.password,salt);
   const c=transaction(()=>{if(!session(req))throw error(401,'登录已失效，请重新登录');const result=db.prepare('UPDATE account SET password_hash=?,salt=? WHERE id=1 AND password_hash=?').run(hash,salt,a.password_hash);if(!result.changes)throw error(409,'密码已被其他设备修改，请重新登录');db.prepare('DELETE FROM sessions').run();return insertSession()});return send(res,{ok:true},200,c);
  }
  if(action==='books'){
   if(!session(req))throw error(401,'请先登录家庭账号');
   if(req.method==='GET')return send(res,{books:files.attach(store.all()),version:store.version()});
   if(req.method==='PUT'){const d=await readBody(req,256*1024*1024);if(!session(req))throw error(401,'登录已失效，请重新登录');if(!Number.isSafeInteger(d.version)||!Array.isArray(d.books)||!d.books.every(validBook)||new Set(d.books.map(b=>b.id)).size!==d.books.length)throw error(400,'图书数据格式不正确');
    const result=transaction(()=>{if(store.version()!==d.version)throw error(409,'家人刚更新了书架，请取回最新数据再保存');store.replace(d.books);return {ok:true,version:store.bump()};});
    return send(res,result);
   }
  }
  throw error(404,'接口不存在');
 }
 const staticFiles=new Map([['/','library.html'],['/library.html','library.html'],['/app.js','app.js'],['/style.css','style.css'],['/icon.svg','icon.svg'],['/manifest.webmanifest','manifest.webmanifest'],['/sw.js','sw.js'],['/reader.html','reader.html'],['/reader.js','reader.js'],['/reader.css','reader.css']]);
 const vendorDir=fileURLToPath(new URL('./node_modules/',import.meta.url));
 const vendors=new Map([['/vendor/jszip.min.js','jszip/dist/jszip.min.js'],['/vendor/epub.min.js','epubjs/dist/epub.min.js'],['/vendor/purify.min.js','dompurify/dist/purify.min.js'],['/vendor/pdfjs/pdf.mjs','pdfjs-dist/legacy/build/pdf.mjs'],['/vendor/pdfjs/pdf.worker.mjs','pdfjs-dist/legacy/build/pdf.worker.mjs'],['/vendor/pdfjs/worker.mjs','pdfjs-dist/legacy/build/pdf.worker.mjs']]);
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.wasm':'application/wasm','.ttf':'font/ttf','.otf':'font/otf'};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  try{const p=new URL(req.url,'http://localhost').pathname;
   if(p==='/reader.html'||p.startsWith('/vendor/'))res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' blob:; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
   if(p==='/healthz'&&req.method==='GET'){db.prepare('SELECT 1').get();return send(res,{ok:true})}
   if(p.startsWith('/api/family/'))return await api(req,res,p.slice('/api/family/'.length));
   if(!['GET','HEAD'].includes(req.method))throw error(405,'请求方法不支持');
   let filename;const name=staticFiles.get(p);
   if(name)filename=path.join(publicDir,name);
   else if(vendors.has(p))filename=path.join(vendorDir,vendors.get(p));
   else {const asset=/^\/vendor\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:bcmap|pfb|ttf|otf|wasm|js|mjs|bin|icc))$/.exec(p);if(asset)filename=path.join(vendorDir,'pdfjs-dist',asset[1],asset[2]);}
   if(!filename||!fs.existsSync(filename))throw error(404,'页面不存在');const bytes=fs.readFileSync(filename);res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-cache','Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(e){if(!e.status)console.error('Request failed:',e.name);if(!res.headersSent)send(res,{error:e.status?e.message:'服务暂时不可用，请稍后重试'},e.status||503);else res.end()}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 const close=()=>new Promise((resolve,reject)=>{closing=true;files.stop();clearInterval(scanTimer);clearTimeout(firstScan);server.close(async e=>{if(backgroundScan)await backgroundScan;await metadata.stop();try{db.close()}catch{}e?reject(e):resolve()});server.closeIdleConnections()});
 return {server,db,store,files,metadata,close};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.env.APP_ORIGIN){console.error('请设置 APP_ORIGIN，例如 http://192.168.1.100:8787');process.exit(1)}
 const dataDir=process.env.DATA_DIR||path.resolve('./data'),port=Number(process.env.PORT||8787);
 const app=createLibraryServer({dataDir,origin:process.env.APP_ORIGIN,booksDir:process.env.BOOKS_DIR,autoScanMs:Number(process.env.SCAN_INTERVAL_SECONDS||600)*1000,metadataEnabled:true});
 app.server.listen(port,process.env.BIND_HOST||'0.0.0.0',()=>{console.log(`家庭知库 · 一屋书已启动：${process.env.APP_ORIGIN}`);if(fs.existsSync(path.join(dataDir,'setup-token.txt')))console.log('首次设置所需密钥保存在 /data/setup-token.txt。请在 NAS 终端运行：docker compose exec library cat /data/setup-token.txt')});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
