import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createCatalogStore} from './catalog-store.mjs';
import {createFileLibrary} from './ebook-files.mjs';

const fixtureRoot=path.join(path.dirname(fileURLToPath(import.meta.url)),'.test-data');
const sample={title:'研究资料',author:'Émile',category:'能源',status:'未读',location:'',borrower:'',notes:'',created:1,resourceType:'期刊论文',year:'2024',tags:['研究'],favorite:true};
const params=value=>new URLSearchParams(value);
function database(filename=':memory:'){
  const db=new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE library(id INTEGER PRIMARY KEY,books TEXT NOT NULL,version INTEGER NOT NULL);
    INSERT INTO library VALUES(1,'[]',0);
    CREATE TABLE ebook_files(id TEXT PRIMARY KEY,relative_path TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,available INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE reading_progress(id TEXT PRIMARY KEY);PRAGMA user_version=4;`);
  return db;
}
const indexFile=(db,id,relative,available=1)=>db.prepare('INSERT INTO ebook_files(id,relative_path,size,mtime,available) VALUES(?,?,1,1,?)').run(id,relative,available);
function add(db,store,id,relative,overrides={},available=1){
  indexFile(db,id,relative,available);
  db.prepare('UPDATE ebook_files SET format=? WHERE id=?').run(path.posix.extname(relative).slice(1).toUpperCase(),id);
  store.put({...sample,id,...overrides});
}

test('directory migration is idempotent, keeps missing records and excludes orphan file indexes',()=>{
  const db=database();
  try{
    const books=[{...sample,id:'old-root'},{...sample,id:'old-nested'}];
    db.prepare('UPDATE library SET books=?').run(JSON.stringify(books));
    indexFile(db,'old-root','根目录资料.pdf');
    indexFile(db,'old-nested','中文 空格/研究%_/资料.pdf',0);
    indexFile(db,'orphan','未关联/幽灵.pdf');
    let store=createCatalogStore(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);
    assert.equal(db.prepare('SELECT directory FROM ebook_files WHERE id=?').get('old-nested').directory,'中文 空格/研究%_');
    assert.deepEqual(store.directories(params()).items.map(x=>({...x})),[{path:'中文 空格',name:'中文 空格',count:1}]);
    assert.equal(store.search(params({directory:'中文 空格',availability:'missing'})).total,1);
    assert.equal(store.search(params({directory:'',recursive:'0'})).items[0].id,'old-root');
    store=createCatalogStore(db);
    assert.equal(store.directories(params()).items[0].count,1);
    assert.equal(store.search(params()).total,2);
    assert.equal(db.prepare('SELECT books FROM library').get().books,'[]');
  }finally{db.close();}
});

test('directory counts follow both insert orders, edits, moves, deletion and restore',()=>{
  const db=database(),store=createCatalogStore(db);
  try{
    add(db,store,'first','A/子/one.pdf');
    store.put({...sample,id:'second'});indexFile(db,'second','A/two.pdf');
    assert.equal(store.directories(params()).items[0].count,2);
    store.put({...store.get('first'),notes:'人工笔记'},{manual:true});
    db.prepare('UPDATE ebook_files SET relative_path=relative_path WHERE id=?').run('first');
    assert.equal(store.directories(params()).items[0].count,2);
    db.prepare('UPDATE ebook_files SET relative_path=? WHERE id=?').run('B/新目录/one.pdf','first');
    assert.deepEqual(store.directories(params()).items.map(x=>[x.path,x.count]),[['A',1],['B',1]]);
    assert.equal(store.directories(params({path:'A'})).total,0);
    store.remove('second');assert.deepEqual(store.directories(params()).items.map(x=>x.path),['B']);
    store.put({...sample,id:'second'});assert.equal(store.directories(params()).total,2);
    db.prepare('DELETE FROM ebook_files WHERE id=?').run('second');assert.equal(store.directories(params()).total,1);
    db.exec('BEGIN');store.replace([{...store.get('first'),title:'恢复记录'}]);db.exec('COMMIT');
    assert.equal(store.directories(params()).items[0].count,1);
    db.exec('BEGIN');store.replace([]);db.exec('COMMIT');
    assert.equal(store.directories(params()).total,0);
    assert.equal(db.prepare('SELECT count(*) n FROM ebook_files').get().n,1);
  }finally{db.close();}
});

test('directory paths are literal, case-sensitive and combine with catalog filters',()=>{
  const db=database(),store=createCatalogStore(db);
  try{
    add(db,store,'root','根目录.pdf');
    add(db,store,'direct','研究 A/资料.pdf');
    add(db,store,'nested','研究 A/论文/太阳能.pdf',{title:'太阳能 论文',doi:'10.1234/solar',abstract:'节能'},0);
    add(db,store,'percent','研究 A/百分%_文档/太阳能.pdf',{year:'2022'});
    add(db,store,'slash','研究 A/反\\斜杠/资料.pdf');
    add(db,store,'sibling','研究 A2/资料.pdf');
    add(db,store,'case','研究 a/资料.pdf');
    add(db,store,'unicode','École 学习/资料.pdf');
    add(db,store,'manual-file','资料目录/资料.txt',{resourceType:'资料文档'});
    store.put({...sample,id:'manual'});indexFile(db,'orphan','不可见/资料.pdf');store.bump();
    assert.equal(store.search(params({directory:'研究 A'})).total,4);
    assert.equal(store.search(params({directory:'研究 A',recursive:'0'})).total,1);
    assert.equal(store.search(params({directory:'研究 A/百分%_文档'})).items[0].id,'percent');
    assert.equal(store.search(params({directory:'研究 A/反\\斜杠'})).items[0].id,'slash');
    assert.equal(store.search(params({directory:'研究 A',q:'太阳能',type:'期刊论文',category:'能源',tag:'研究',yearFrom:'2023',yearTo:'2025',format:'pdf',availability:'missing',favorite:'1'})).items[0].id,'nested');
    assert.equal(store.search(params({directory:'研究 A',availability:'available'})).total,3);
    assert.equal(store.search(params({directory:'研究 A',tag:'其他标签'})).total,0);
    assert.equal(store.search(params({directory:'',recursive:'0'})).total,1);
    assert.equal(store.search(params({directory:''})).total,10);
    assert.equal(store.directories(params({path:'研究 A'})).items.find(x=>x.path==='研究 A/论文').count,1);
    assert.equal(store.directories(params({path:'研究 A',q:'%_'})).items[0].name,'百分%_文档');
    assert.equal(store.directories(params({q:'école'})).items[0].name,'École 学习');
    assert.equal(store.directories(params({path:'不存在'})).total,0);
    assert.equal(store.directories(params({page:'9999',pageSize:'2'})).page,3);
    assert.equal(store.directories(params({pageSize:'99999'})).pageSize,100);
    for(const invalid of ['../秘密','/绝对路径','A//B','A/..','A/','A\0B']){
      assert.throws(()=>store.directories(params({path:invalid})),e=>e.status===400);
      assert.throws(()=>store.search(params({directory:invalid})),e=>e.status===400);
    }
    assert.throws(()=>store.search(params({directory:'A',recursive:'yes'})),e=>e.status===400);
  }finally{db.close();}
});

test('scanner updates directory indexes and safe file handles without duplicating counts',async t=>{
  await fs.mkdir(fixtureRoot,{recursive:true});
  const directory=await fs.mkdtemp(path.join(fixtureRoot,'directory-files-'));
  const db=database(),store=createCatalogStore(db),files=createFileLibrary(db,directory,store);
  t.after(async()=>{files.stop();db.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(fixtureRoot));await fs.rm(directory,{recursive:true,force:true});});
  await fs.mkdir(path.join(directory,'中文 %_ 目录'));
  await fs.writeFile(path.join(directory,'中文 %_ 目录','记录.txt'),'可安全读取的正文');
  await files.scan();await files.scan();
  assert.equal(store.directories(params()).items[0].count,1);
  const book=files.attach(store.search(params()).items)[0];
  assert.equal(book.file.directory,'中文 %_ 目录');assert.equal(book.file.folder,book.file.directory);
  await assert.rejects(files.openFileSafe(book.id,()=>false),e=>e.status===401);
  const opened=await files.openFileSafe(book.id,()=>true);
  assert.equal(await opened.handle.readFile('utf8'),'可安全读取的正文');await opened.handle.close();
  await fs.unlink(path.join(directory,'中文 %_ 目录','记录.txt'));await files.scan();
  assert.equal(store.directories(params()).items[0].count,1);
  assert.equal(store.search(params({directory:'中文 %_ 目录',availability:'missing'})).total,1);
  if(process.platform!=='win32'){
    await fs.writeFile(path.join(directory,'含\\反斜杠.txt'),'literal backslash');await files.scan();
    const literal=store.search(params({directory:'',recursive:'0'})).items[0];
    const handle=await files.openFileSafe(literal.id,()=>true);await handle.handle.close();
  }
});

test('200001 file records use persistent directory counts and indexed paginated lookup',async t=>{
  await fs.mkdir(fixtureRoot,{recursive:true});
  const directory=await fs.mkdtemp(path.join(fixtureRoot,'directory-scale-'));
  const db=database(path.join(directory,'library.sqlite')),store=createCatalogStore(db);
  t.after(async()=>{db.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(fixtureRoot));await fs.rm(directory,{recursive:true,force:true});});
  const insertFile=db.prepare('INSERT INTO ebook_files(id,relative_path,size,mtime,available) VALUES(?,?,1,1,1)');
  const started=Date.now();db.exec('BEGIN');
  for(let i=0;i<200001;i++){
    const id='file-'+i,folder='资料/目录'+String(Math.floor(i/100)).padStart(4,'0');
    insertFile.run(id,folder+'/'+i+'.pdf');store.put({...sample,id,tags:[],created:i});
  }
  store.bump();db.exec('COMMIT');
  const indexedMs=Date.now()-started,queryStart=Date.now();
  assert.equal(store.directories(params()).items[0].count,200001);
  const page=store.directories(params({path:'资料',page:'21',pageSize:'100'}));
  assert.equal(page.total,2001);assert.equal(page.pages,21);assert.equal(page.items.length,1);
  assert.deepEqual({...page.items[0]},{path:'资料/目录2000',name:'目录2000',count:1});
  assert.equal(store.search(params({directory:'资料/目录2000'})).total,1);
  assert.equal(store.search(params({directory:'资料',page:'8001',pageSize:'25'})).items.length,1);
  assert.equal(store.search(params({directory:'资料',recursive:'0'})).total,0);
  const directoryPlan=db.prepare('EXPLAIN QUERY PLAN SELECT path,name,count FROM catalog_directories WHERE parent=? ORDER BY path LIMIT 100').all('资料').map(x=>x.detail).join('\n');
  const filePlan=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM ebook_files WHERE directory=? UNION ALL SELECT id FROM ebook_files WHERE directory>=? AND directory<?').all('资料/目录2000','资料/目录2000/','资料/目录20000').map(x=>x.detail).join('\n');
  assert.match(directoryPlan,/USING INDEX directories_parent/);
  assert.match(filePlan,/USING COVERING INDEX files_directory/);
  assert.doesNotMatch(filePlan,/SCAN ebook_files/);
  console.log(JSON.stringify({directoryRecords:200001,indexedMs,queryMs:Date.now()-queryStart,directoryPlan,filePlan}));
});
