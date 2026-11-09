import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createLibraryServer} from './server.mjs';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'.test-data');
const origin='http://family.test';
test('knowledge library: upgrade, catalog, media access and shared reading',async t=>{
  await fs.mkdir(root,{recursive:true});
  const temp=await fs.mkdtemp(path.join(root,'knowledge-')),dataDir=path.join(temp,'data'),booksDir=path.join(temp,'books');
  await fs.mkdir(booksDir);
  await fs.writeFile(path.join(booksDir,'家庭阅读.pdf'),'%PDF-1.4\nA small byte fixture\n%%EOF');
  await fs.writeFile(path.join(booksDir,'研究记录.md'),'# 研究记录\n家庭资料正文\n<script>alert(1)</script>');
  await fs.writeFile(path.join(booksDir,'实验.csv'),'项目,数量\n样本,12');
  await fs.writeFile(path.join(booksDir,'课堂录音.mp3'),Buffer.alloc(1024,1));
  await fs.writeFile(path.join(booksDir,'文档.docx'),'download-only fixture');
  let app,base,cookie,version,pdf,textBook;
  async function start(){app=createLibraryServer({dataDir,booksDir,origin});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;}
  async function stop(){if(app){const current=app;app=null;await current.close();}}
  async function request(action,{method='GET',data,auth=true,originHeader=origin,headers={}}={}){
    const h={...headers};if(auth&&cookie)h.Cookie=cookie;if(originHeader)h.Origin=originHeader;
    if(data!==undefined)h['Content-Type']='application/json';
    const response=await fetch(base+'/api/family/'+action,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});
    const raw=await response.text();let json;try{json=JSON.parse(raw)}catch{}
    return {status:response.status,json,raw,headers:response.headers};
  }
  t.after(async()=>{await stop();assert.equal(path.dirname(path.resolve(temp)),path.resolve(root));assert.ok(path.basename(temp).startsWith('knowledge-'));await fs.rm(temp,{recursive:true,force:true});});
  await start();
  const setupToken=(await fs.readFile(path.join(dataDir,'setup-token.txt'),'utf8')).trim();
  const setup=await request('setup',{method:'POST',data:{username:'family_test',password:'Family-test-password-983!',setupToken}});
  assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie').split(';')[0];
  await t.test('protects catalog, content, text and progress from unauthenticated requests',async()=>{
    for(const action of ['resources','document?id=missing','content?id=missing','text?id=missing','download?id=missing']){
      assert.equal((await request(action,{auth:false})).status,401,action);
    }
    assert.equal((await request('content?id=missing',{auth:false,method:'HEAD',originHeader:null})).status,401);
    assert.equal((await request('progress',{auth:false,method:'POST',data:{}})).status,401);
  });
  await t.test('scans mixed formats and returns server-controlled preview capabilities',async()=>{
    assert.equal((await request('scan',{method:'POST',data:{}})).status,200);
    const catalog=await request('resources');assert.equal(catalog.status,200);assert.equal(catalog.json.total,5);
    version=catalog.json.version;pdf=catalog.json.items.find(b=>b.file.format==='PDF');textBook=catalog.json.items.find(b=>b.file.format==='MD');
    assert.equal(pdf.file.preview,'pdf');assert.equal(textBook.file.preview,'text');
    assert.equal(catalog.json.items.find(b=>b.file.format==='MP3').file.preview,'audio');
    assert.equal(catalog.json.items.find(b=>b.file.format==='DOCX').file.preview,null);
    assert.equal(catalog.json.stats.files,5);assert.ok(catalog.json.facets.formats.some(f=>f.value==='CSV'));
  });
  await t.test('supports editing extended metadata without losing legacy notes',async()=>{
    const detail=await request('document?id='+pdf.id);assert.equal(detail.status,200);
    const edited={...detail.json.book,title:'家庭能源研究与数据分析',author:'研究小组',category:'能源科学',resourceType:'期刊论文',year:'2024',source:'家庭研究记录',doi:'10.1234/family.example',abstract:'记录太阳能与家庭用电数据。',tags:['能源','数据分析','能源'],favorite:true,notes:'保留原有的阅读笔记',borrower:'家人',file:{relative_path:'../secret',preview:'video'}};
    const saved=await request('document',{method:'PUT',data:{book:edited,version:detail.json.version}});assert.equal(saved.status,200);version=saved.json.version;
    const current=await request('document?id='+pdf.id);assert.equal(current.json.book.notes,edited.notes);assert.deepEqual(current.json.book.tags,['能源','数据分析']);assert.equal(current.json.book.file.preview,'pdf');assert.equal(current.json.book.file.relative_path,undefined);
    const conflict=await request('document',{method:'PUT',data:{book:{...edited,title:'过期更新'},version:detail.json.version}});assert.equal(conflict.status,409);
    assert.equal((await request('document?id='+pdf.id)).json.book.title,edited.title);
  });
  await t.test('filters metadata with AND terms, year, format, type, tags and pagination',async()=>{
    const result=await request('resources?q='+encodeURIComponent('太阳能 用电')+'&type='+encodeURIComponent('期刊论文')+'&format=PDF&tag='+encodeURIComponent('能源')+'&yearFrom=2020&yearTo=2025&favorite=1');
    assert.equal(result.json.total,1);assert.equal(result.json.items[0].id,pdf.id);
    assert.equal((await request('resources?q='+encodeURIComponent('太阳能')+'&field=title')).json.total,0);
    assert.equal((await request('resources?q=10.1234&field=doi')).json.total,1);
    assert.equal((await request('resources?yearFrom=2025')).json.total,0);
    const page=await request('resources?page=2&pageSize=2&sort=title');assert.equal(page.json.page,2);assert.equal(page.json.items.length,2);assert.equal(page.json.total,5);
    assert.equal((await request('resources?page=-1&pageSize=100000')).json.pageSize,100);
    const stats=(await request('resources')).json.stats;assert.equal(stats.favorites,1);
  });
  await t.test('requires origin validation for writes and rejects invalid fields',async()=>{
    const current=(await request('document?id='+pdf.id)).json;
    assert.equal((await request('document',{method:'PUT',originHeader:'http://foreign.test',data:{book:current.book,version:current.version}})).status,403);
    for(const fields of [{tags:['x'.repeat(41)]},{resourceType:'猜出来的论文'},{year:'tomorrow'},{favorite:'yes'},{abstract:'x'.repeat(8001)}]){
      assert.equal((await request('document',{method:'PUT',data:{book:{...current.book,...fields},version:current.version}})).status,400);
    }
    assert.equal((await request('resources?yearFrom=2026&yearTo=2020')).status,400);
    assert.equal((await request('resources?yearFrom=oops')).status,400);
  });
  await t.test('legacy clients retain new metadata and backups larger than 5 MiB can be restored',async()=>{
    let current=(await request('books')).json;
    const legacy=current.books.map(b=>{const copy={...b};for(const key of ['resourceType','year','source','doi','abstract','tags','favorite'])delete copy[key];return copy;});
    assert.equal((await request('books',{method:'PUT',data:{books:legacy,version:current.version}})).status,200);
    assert.equal((await request('document?id='+pdf.id)).json.book.year,'2024');
    current=(await request('books')).json;const original=current.books;
    const sample={id:'bulk-0',title:'长笔记',author:'',category:'其他',status:'未读',location:'',borrower:'',notes:'x'.repeat(20000),created:1700000000000};
    const large=Array.from({length:280},(_,i)=>({...sample,id:'bulk-'+i}));
    assert.ok(Buffer.byteLength(JSON.stringify(large))>5*1024*1024);
    assert.equal((await request('books',{method:'PUT',data:{books:large,version:current.version}})).status,200);
    const exported=(await request('books')).json;assert.equal(exported.books.length,280);
    assert.equal((await request('books',{method:'PUT',data:{books:exported.books,version:exported.version}})).status,200);
    const next=(await request('books')).json;
    assert.equal((await request('books',{method:'PUT',data:{books:original,version:next.version}})).status,200);
  });
  await t.test('serves exact byte ranges and text safely, with login required for HEAD',async()=>{
    const range=await request('content?id='+pdf.id,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.equal(range.raw,'%PDF-1.4');assert.match(range.headers.get('content-type'),/application\/pdf/);assert.match(range.headers.get('content-range'),/^bytes 0-7\//);
    const head=await request('content?id='+pdf.id,{method:'HEAD',originHeader:null});assert.equal(head.status,200);assert.equal(head.raw,'');
    const text=await request('text?id='+textBook.id);assert.equal(text.status,200);assert.match(text.json.text,/<script>/);assert.equal(text.json.truncated,false);assert.match(text.headers.get('content-type'),/application\/json/);
    const office=(await request('resources?format=DOCX')).json.items[0];assert.equal((await request('content?id='+office.id)).status,415);
    assert.match((await request('download?id='+office.id)).headers.get('content-disposition'),/^attachment;/);
  });
  await t.test('persists family reading progress independently of catalog edits',async()=>{
    const before=(await request('resources')).json.version;
    const saved=await request('progress',{method:'POST',data:{id:pdf.id,kind:'pdf',location:'3',progress:0.25}});assert.equal(saved.status,200);
    const detail=await request('document?id='+pdf.id);assert.equal(detail.json.progress.location,'3');assert.equal(detail.json.progress.progress,0.25);assert.equal(detail.json.version,before);
    assert.equal((await request('progress',{method:'POST',originHeader:null,data:{id:pdf.id,kind:'pdf',location:'4',progress:0.3}})).status,403);
    assert.equal((await request('progress',{method:'POST',data:{id:pdf.id,kind:'video',location:'3',progress:0.2}})).status,400);
    assert.equal((await request('progress',{method:'POST',data:{id:pdf.id,kind:'pdf',location:'3',progress:2}})).status,400);
    await stop();await start();assert.equal((await request('document?id='+pdf.id)).json.progress.location,'3');
  });
  await t.test('preserves v2 accounts and metadata and creates a recoverable upgrade snapshot',async()=>{
    await stop();const previous=new DatabaseSync(path.join(dataDir,'library.sqlite'));
    const legacy={id:'legacy-paper-book',title:'旧版实体藏书',author:'家人',category:'文学小说',status:'在读',location:'书房',borrower:'',notes:'旧版原样保留',color:'#456258',demo:false,created:1700000000000};
    const oldBooks=previous.prepare('SELECT data FROM catalog_items').all().map(row=>JSON.parse(row.data));oldBooks.push(legacy);
    const oldJson=JSON.stringify(oldBooks);previous.prepare('UPDATE library SET books=? WHERE id=1').run(oldJson);
    previous.exec('DROP TABLE catalog_tags; DROP TABLE catalog_items; DROP TABLE metadata_locks; DROP TABLE metadata_jobs; DROP TABLE reading_progress; PRAGMA user_version=2;');previous.close();
    await start();const state=await request('session');assert.equal(state.json.authenticated,true);
    const saved=(await request('document?id='+pdf.id)).json;assert.equal(saved.book.notes,'保留原有的阅读笔记');assert.equal(saved.book.resourceType,'期刊论文');
    const backups=await fs.readdir(path.join(dataDir,'backups'));assert.equal(backups.length,1);
    const backup=new DatabaseSync(path.join(dataDir,'backups',backups[0]),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,2);assert.equal(backup.prepare('SELECT username FROM account').get().username,'family_test');assert.equal(backup.prepare('SELECT books FROM library WHERE id=1').get().books,oldJson);backup.close();
    assert.deepEqual((await request('books')).json.books.find(b=>b.id===legacy.id),legacy);
    assert.equal((await fetch(base+'/backups/'+backups[0])).status,404);
  });
  await t.test('deletes only the record; scanning restores the untouched original file',async()=>{
    const current=(await request('document?id='+textBook.id)).json;
    assert.equal((await request('document?id='+textBook.id,{method:'DELETE',data:{version:current.version}})).status,200);
    assert.equal((await request('document?id='+textBook.id)).status,404);
    assert.match(await fs.readFile(path.join(booksDir,'研究记录.md'),'utf8'),/家庭资料正文/);
    await request('scan',{method:'POST',data:{}});assert.equal((await request('document?id='+textBook.id)).status,200);
  });
  await t.test('serves local pinned readers and restricts arbitrary vendor paths',async()=>{
    for(const p of ['/reader.html','/reader.js','/reader.css','/vendor/pdfjs/pdf.mjs','/vendor/pdfjs/worker.mjs','/vendor/epub.min.js','/vendor/jszip.min.js','/vendor/purify.min.js'])assert.equal((await fetch(base+p)).status,200,p);
    for(const p of ['/vendor/package.json','/vendor/pdfjs/../../server.mjs','/node_modules/epubjs/package.json'])assert.equal((await fetch(base+p)).status,404,p);
    const reader=await fetch(base+'/reader.html');assert.match(reader.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(reader.headers.get('content-security-policy'),/worker-src 'self' blob:/);
  });
});
