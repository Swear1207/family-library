import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { createFileLibrary } from './ebook-files.mjs';

const publicDir=fileURLToPath(new URL('./public/',import.meta.url));
const derive=promisify(scrypt),TTL=7*86400,MAX_BYTES=5*1024*1024;
const token=()=>randomBytes(32).toString('hex');
const digest=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function hashPassword(password,salt){return (await derive(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024})).toString('hex')}
const error=(status,message)=>Object.assign(new Error(message),{status});
const passwords=p=>typeof p==='string'&&p.length>=12&&p.length<=128;
const validBook=b=>b&&typeof b.id==='string'&&b.id.length>0&&b.id.length<=100&&typeof b.title==='string'&&b.title.trim().length>0&&b.title.length<=100&&['未读','在读','读完'].includes(b.status)&&['文学小说','儿童绘本','科普知识','生活艺术','其他'].includes(b.category)&&['author','location','borrower','notes'].every(k=>typeof b[k]==='string')&&b.author.length<=80&&b.location.length<=80&&b.borrower.length<=60&&b.notes.length<=2000&&Number.isFinite(b.created);

export function createLibraryServer({dataDir,origin,booksDir,autoScanMs=0}={}){
 const appOrigin=new URL(origin).origin;
 if(!['http:','https:'].includes(new URL(appOrigin).protocol))throw Error('APP_ORIGIN must use http:// or https://');
 if(new URL(origin).pathname!=='/'||new URL(origin).search||new URL(origin).hash)throw Error('APP_ORIGIN must be an origin without path, query or fragment');
 const secure=appOrigin.startsWith('https:');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(path.join(dataDir,'library.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
 const schemaVersion=db.prepare('PRAGMA user_version').get().user_version;
 if(schemaVersion>2){db.close();throw Error('Database version is newer than this application')}
 if(schemaVersion===0){db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE account (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL);
 CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
 CREATE TABLE library (id INTEGER PRIMARY KEY CHECK(id=1), books TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
 PRAGMA user_version=1; COMMIT;`)}
 if(schemaVersion<2){db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE ebook_files (id TEXT PRIMARY KEY, relative_path TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1);
 PRAGMA user_version=2; COMMIT;`)}
 const files=createFileLibrary(db,booksDir);
 const setupPath=path.join(dataDir,'setup-token.txt');
 const getAccount=()=>db.prepare('SELECT * FROM account WHERE id=1').get();
 if(!getAccount()&&!fs.existsSync(setupPath))fs.writeFileSync(setupPath,token()+'\n',{flag:'wx',mode:0o600});
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}
 let backgroundScan=null,closing=false;
 function autoScan(){if(closing||!files.enabled||!getAccount()||backgroundScan)return; backgroundScan=files.scan().catch(e=>{if(e.status!==409)console.error('自动扫描未完成，请检查书籍目录挂载和读取权限。')}).finally(()=>{backgroundScan=null})}
 const scanTimer=autoScanMs>0?setInterval(autoScan,Math.max(autoScanMs,60000)):null;scanTimer?.unref();
 const firstScan=autoScanMs>0?setTimeout(autoScan,1000):null;firstScan?.unref();
 function cookie(value,clear=false){return `family_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:TTL}${secure?'; Secure':''}`}
 function session(req){const raw=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('family_session='))?.slice(15);if(!raw||!/^[a-f0-9]{64}$/.test(raw))return null;const key=digest(raw);return db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires>?').get(key,Date.now())?key:null}
 function insertSession(){const raw=token();db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('INSERT INTO sessions (token_hash,expires) VALUES (?,?)').run(digest(raw),Date.now()+TTL*1000);return cookie(raw)}
 function limited(req){const now=Date.now(),slot=Math.floor(now/900000);const keys=[`ip:${digest(req.socket.remoteAddress||'unknown')}:${slot}`,`global:${slot}`];db.prepare('DELETE FROM attempts WHERE expires<?').run(now);const counts=keys.map(key=>db.prepare('INSERT INTO attempts (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').get(key,now+1800000).count);if(counts[0]>30||counts[1]>150)throw error(429,'尝试次数过多，请 15 分钟后重试')}
 let pendingHashes=0;
 async function passwordHash(p,s){if(pendingHashes>=4)throw error(429,'服务正忙，请稍后重试');pendingHashes++;try{return await hashPassword(p,s)}finally{pendingHashes--}}
 function send(res,body,status=200,cookieValue){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private',...(cookieValue?{'Set-Cookie':cookieValue}:{})});res.end(JSON.stringify(body))}
 async function readBody(req){if(!req.headers['content-type']?.startsWith('application/json'))throw error(415,'请使用 JSON 请求');if(Number(req.headers['content-length']||0)>MAX_BYTES)throw error(413,'请求内容不能超过 5 MB');let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_BYTES)throw error(413,'请求内容不能超过 5 MB');chunks.push(chunk)}try{const d=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!d||typeof d!=='object'||Array.isArray(d))throw Error();return d}catch{throw error(400,'请求格式不正确')}}
 async function api(req,res,action){
  if(!['GET','POST','PUT'].includes(req.method))throw error(405,'请求方法不支持');
  if(req.method!=='GET'&&req.headers.origin!==appOrigin)throw error(403,'访问地址与 APP_ORIGIN 配置不一致，请从正确的网址打开');
  if(action==='session'&&req.method==='GET'){const a=getAccount(),signedIn=!!session(req);return send(res,{configured:!!a,authenticated:signedIn,canSetup:!a,fileLibraryEnabled:files.enabled,username:signedIn?a.username:undefined})}
  if(action==='scan'&&req.method==='POST'){if(!session(req))throw error(401,'请先登录家庭账号');await readBody(req);return send(res,await files.scan(()=>!!session(req)))}
  if(action==='download'&&req.method==='GET'){if(!session(req))throw error(401,'请先登录家庭账号');const id=new URL(req.url,'http://localhost').searchParams.get('id');return await files.download(req,res,id,()=>!!session(req))}
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
   if(req.method==='GET'){const row=db.prepare('SELECT * FROM library WHERE id=1').get();return send(res,{books:files.attach(JSON.parse(row.books)),version:row.version})}
   if(req.method==='PUT'){const d=await readBody(req);if(!session(req))throw error(401,'登录已失效，请重新登录');if(!Number.isSafeInteger(d.version)||!Array.isArray(d.books)||d.books.length>10000||!d.books.every(validBook)||new Set(d.books.map(b=>b.id)).size!==d.books.length)throw error(400,'图书数据格式不正确');
    const clean=d.books.map(b=>({id:b.id,title:b.title.trim(),author:b.author,category:b.category,status:b.status,location:b.location,borrower:b.borrower,notes:b.notes,created:b.created,color:/^#[a-f0-9]{6}$/i.test(b.color)?b.color:'#456258',demo:b.demo===true}));const row=db.prepare('UPDATE library SET books=?,version=version+1 WHERE id=1 AND version=? RETURNING version').get(JSON.stringify(clean),d.version);if(!row)throw error(409,'家人刚更新了书架，请取回最新数据再保存');return send(res,{ok:true,version:row.version});
   }
  }
  throw error(404,'接口不存在');
 }
 const staticFiles=new Map([['/','library.html'],['/library.html','library.html'],['/app.js','app.js'],['/style.css','style.css'],['/icon.svg','icon.svg'],['/manifest.webmanifest','manifest.webmanifest'],['/sw.js','sw.js']]);
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  try{const p=new URL(req.url,'http://localhost').pathname;
   if(p==='/healthz'&&req.method==='GET'){db.prepare('SELECT 1').get();return send(res,{ok:true})}
   if(p.startsWith('/api/family/'))return await api(req,res,p.slice('/api/family/'.length));
   if(!['GET','HEAD'].includes(req.method))throw error(405,'请求方法不支持');
   const name=staticFiles.get(p);if(!name)throw error(404,'页面不存在');const bytes=fs.readFileSync(path.join(publicDir,name));res.writeHead(200,{'Content-Type':mime[path.extname(name)],'Cache-Control':'no-cache','Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(e){if(!e.status)console.error('Request failed:',e.name);if(!res.headersSent)send(res,{error:e.status?e.message:'服务暂时不可用，请稍后重试'},e.status||503);else res.end()}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 const close=()=>new Promise((resolve,reject)=>{closing=true;clearInterval(scanTimer);clearTimeout(firstScan);server.close(async e=>{if(backgroundScan)await backgroundScan;try{db.close()}catch{}e?reject(e):resolve()});server.closeIdleConnections()});
 return {server,db,close};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.env.APP_ORIGIN){console.error('请设置 APP_ORIGIN，例如 http://192.168.1.100:8787');process.exit(1)}
 const dataDir=process.env.DATA_DIR||path.resolve('./data'),port=Number(process.env.PORT||8787);
 const app=createLibraryServer({dataDir,origin:process.env.APP_ORIGIN,booksDir:process.env.BOOKS_DIR,autoScanMs:Number(process.env.SCAN_INTERVAL_SECONDS||600)*1000});
 app.server.listen(port,process.env.BIND_HOST||'0.0.0.0',()=>{console.log(`一屋书已启动：${process.env.APP_ORIGIN}`);if(fs.existsSync(path.join(dataDir,'setup-token.txt')))console.log('首次设置所需密钥保存在 /data/setup-token.txt。请在 NAS 终端运行：docker compose exec library cat /data/setup-token.txt')});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
