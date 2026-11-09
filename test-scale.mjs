import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createCatalogStore} from './catalog-store.mjs';
import {createLibraryServer} from './server.mjs';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'.test-data');
const sample={title:'家庭资料',author:'',category:'其他',status:'未读',location:'',borrower:'',notes:'',created:1700000000000,resourceType:'资料文档'};
async function temporary(prefix){await fs.mkdir(root,{recursive:true});return fs.mkdtemp(path.join(root,prefix));}
async function remove(directory){assert.equal(path.dirname(path.resolve(directory)),path.resolve(root));await fs.rm(directory,{recursive:true,force:true});}

test('200001 indexed records remain paginated and individually editable without a giant JSON catalog',async t=>{
  const temp=await temporary('scale-index-'),db=new DatabaseSync(path.join(temp,'library.sqlite'));
  t.after(async()=>{db.close();await remove(temp);});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE library(id INTEGER PRIMARY KEY,books TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO library VALUES(1,'[]',0);
    CREATE TABLE ebook_files(id TEXT PRIMARY KEY,relative_path TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,available INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE reading_progress(id TEXT PRIMARY KEY);`);
  const store=createCatalogStore(db),started=Date.now();
  db.exec('BEGIN');
  for(let i=0;i<200001;i++)store.put({...sample,id:'record-'+i,title:'资料 '+String(i).padStart(6,'0'),created:sample.created+i,category:i%2?'工程':'其他',year:String(2020+i%6),tags:i%10===0?['研究']:[]});
  store.bump();db.exec('COMMIT');
  const indexedMs=Date.now()-started,queried=Date.now();
  const page=store.search(new URLSearchParams('page=8001&pageSize=25'));
  assert.equal(page.total,200001);assert.equal(page.items.length,1);assert.equal(page.page,8001);assert.equal(page.stats.total,200001);
  assert.equal(page.items[0].id,'record-0');
  assert.equal(store.search(new URLSearchParams('tag='+encodeURIComponent('研究'))).total,20001);
  const changed={...store.get('record-200000'),title:'École study',author:'Émile Zola',notes:'保留这条笔记'};
  store.put(changed,{manual:true});store.bump();
  assert.equal(store.search(new URLSearchParams({field:'author',q:'émile'})).total,1);
  assert.equal(store.search(new URLSearchParams({field:'title',q:'école'})).total,1);
  assert.equal(store.search(new URLSearchParams({q:'保留 笔记'})).items[0].id,changed.id);
  assert.equal(store.get('record-0').notes,'');
  assert.equal(db.prepare('SELECT books FROM library WHERE id=1').get().books,'[]');
  console.log(JSON.stringify({scaleRecords:200001,indexedMs,queryChecksMs:Date.now()-queried}));
});

test('background scan passes 10000 real files, exposes incremental results and preserves edits on rescan',async t=>{
  const temp=await temporary('scale-files-'),dataDir=path.join(temp,'data'),booksDir=path.join(temp,'books');
  await fs.mkdir(booksDir);const count=10025;
  for(let start=0;start<count;start+=100)await Promise.all(Array.from({length:Math.min(100,count-start)},(_,i)=>fs.writeFile(path.join(booksDir,`资料-${String(start+i).padStart(5,'0')}.txt`),'中文资料')));
  const origin='http://scale.test',app=createLibraryServer({dataDir,booksDir,origin});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();await remove(temp);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const setupToken=(await fs.readFile(path.join(dataDir,'setup-token.txt'),'utf8')).trim();
  const setup=await fetch(base+'/api/family/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'scale_test',password:'Scale-family-password-2026!',setupToken})});
  assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0];
  const req=(route,method='GET',body)=>fetch(base+'/api/family/'+route,{method,headers:{Cookie:cookie,Origin:origin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal((await req('scan','POST',{background:true})).status,202);
  let incremental=false,scan;const started=Date.now();
  do {
    scan=await (await req('scan')).json();
    if(scan.running&&scan.added>0){
      const page=await(await req('resources')).json();assert.ok(page.items.length<=25);assert.ok(page.total>0);incremental=true;
      assert.equal((await fetch(base+'/healthz')).status,200);
    }
    if(scan.running)await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(Date.now()-started<120000,'scan should finish within the test budget');
  }while(scan.running);
  assert.equal(scan.error,null);assert.equal(scan.found,count);assert.equal(scan.added,count);assert.ok(incremental);
  const catalog=await(await req('resources?pageSize=1')).json(),book=catalog.items[0];
  const detail=await(await req('document?id='+book.id)).json();
  // A different record changes the global version; per-record edit remains safe.
  app.store.put({...sample,id:'manual-other'});app.store.bump();
  const saved=await req('document','PUT',{book:{...detail.book,author:'人工作者',notes:'不会丢失'},version:detail.version,recordVersion:detail.recordVersion});assert.equal(saved.status,200);
  assert.equal((await req('document','PUT',{book:detail.book,version:detail.version,recordVersion:detail.recordVersion})).status,409);
  assert.equal((await req('scan','POST',{})).status,200);
  const current=await(await req('document?id='+book.id)).json();assert.equal(current.book.author,'人工作者');assert.equal(current.book.notes,'不会丢失');
  assert.equal((await(await req('resources')).json()).total,count+1);
  console.log(JSON.stringify({scannedFiles:count,scanAndRescanMs:Date.now()-started}));
});

test('v3 migration snapshots the old JSON catalog and preserves sessions, annotations and progress',async t=>{
  const temp=await temporary('scale-upgrade-'),dataDir=path.join(temp,'data');await fs.mkdir(dataDir);
  const original=new DatabaseSync(path.join(dataDir,'library.sqlite'));
  const book={...sample,id:'legacy',title:'旧记录',notes:'重要旧笔记'};
  original.exec(`CREATE TABLE account(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT,salt TEXT);
    INSERT INTO account VALUES(1,'family','hash','salt');CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,expires INTEGER);
    INSERT INTO sessions VALUES('session-preserved',9999999999999);
    CREATE TABLE library(id INTEGER PRIMARY KEY,books TEXT,version INTEGER);
    CREATE TABLE attempts(key TEXT PRIMARY KEY,count INTEGER,expires INTEGER);
    CREATE TABLE ebook_files(id TEXT PRIMARY KEY,relative_path TEXT,size INTEGER,mtime INTEGER,available INTEGER);
    CREATE TABLE reading_progress(id TEXT PRIMARY KEY,kind TEXT,location TEXT,progress REAL,updated INTEGER);
    INSERT INTO reading_progress VALUES('legacy','pdf','7',0.7,1);PRAGMA user_version=3;`);
  const oldJson=JSON.stringify([book]);original.prepare('INSERT INTO library VALUES(1,?,19)').run(oldJson);original.close();
  const app=createLibraryServer({dataDir,origin:'http://migration.test'});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();await remove(temp);});
  assert.deepEqual(app.store.get(book.id),book);assert.equal(app.store.version(),19);
  assert.equal(app.db.prepare('SELECT token_hash FROM sessions').get().token_hash,'session-preserved');
  assert.equal(app.db.prepare('SELECT location FROM reading_progress').get().location,'7');
  const snapshots=await fs.readdir(path.join(dataDir,'backups'));assert.equal(snapshots.length,1);
  const backup=new DatabaseSync(path.join(dataDir,'backups',snapshots[0]),{readOnly:true});
  assert.equal(backup.prepare('SELECT books FROM library').get().books,oldJson);assert.equal(backup.prepare('PRAGMA user_version').get().user_version,3);backup.close();
  assert.equal(app.db.prepare('PRAGMA user_version').get().user_version,4);
});
