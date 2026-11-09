import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createLibraryServer} from './server.mjs';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'.test-data');
test('member profiles isolate reading state and retain the shared catalog',async t=>{
  await fs.mkdir(root,{recursive:true});
  const temp=await fs.mkdtemp(path.join(root,'members-')),dataDir=path.join(temp,'data'),booksDir=path.join(temp,'books');
  await fs.mkdir(booksDir);
  for(const name of ['阅读一.txt','阅读二.txt','仅下载.docx'])await fs.writeFile(path.join(booksDir,name),'家庭阅读正文');
  const origin='http://members.test';let app,base,cookie;
  async function start(){app=createLibraryServer({dataDir,booksDir,origin});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;}
  async function stop(){if(app){const old=app;app=null;await old.close();}}
  const request=async(route,method='GET',data,options={})=>{
    const response=await fetch(base+'/api/family/'+route,{method,headers:{Origin:options.origin||origin,...(options.auth===false?{}:{Cookie:cookie}),...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  t.after(async()=>{await stop();assert.equal(path.dirname(path.resolve(temp)),path.resolve(root));await fs.rm(temp,{recursive:true,force:true});});
  await start();
  const setupToken=(await fs.readFile(path.join(dataDir,'setup-token.txt'),'utf8')).trim();
  const setup=await request('setup','POST',{username:'family_test',password:'Family-members-test-2026!',setupToken},{auth:false});
  assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie').split(';')[0];
  await request('scan','POST',{});
  const books=(await request('resources')).body.items,book=books.find(b=>b.file.name==='阅读一.txt'),second=books.find(b=>b.file.name==='阅读二.txt');
  let alice,bob;
  await t.test('requires login and same-origin mutations; validates member names',async()=>{
    for(const route of ['members','recent','document?id='+book.id+'&member=family'])assert.equal((await request(route,'GET',undefined,{auth:false})).status,401);
    for(const route of ['members','reading-open','progress'])assert.equal((await request(route,'POST',{}, {auth:false})).status,401);
    assert.equal((await request('members','POST',{name:'成员'},{origin:'http://outside.test'})).status,403);
    for(const name of ['', '   ', 'x'.repeat(41), 'bad\nname', null])assert.equal((await request('members','POST',{name})).status,400);
    assert.deepEqual((await request('members')).body,{members:[{id:'family',name:'家庭共享'}],defaultMemberId:'family'});
    const a=await request('members','POST',{name:'  Alice  '});assert.equal(a.status,201);alice=a.body.member;assert.equal(alice.name,'Alice');
    assert.equal((await request('members','POST',{name:'alice'})).status,409);
    bob=(await request('members','POST',{name:'家人乙'})).body.member;
    assert.equal((await request('members','PUT',{id:alice.id,name:'家人乙'})).status,409);
    assert.equal((await request('members','PUT',{name:'不应创建'})).status,400);
    assert.equal((await request('members','PUT',{id:'unknown',name:'不应创建'})).status,404);
  });
  await t.test('same book has independent progress across devices and legacy default',async()=>{
    const saved={id:book.id,kind:'text',location:'0.4',progress:0.4};
    assert.equal((await request('progress','POST',saved)).status,200);
    assert.equal((await request('progress','POST',{...saved,memberId:alice.id,location:'0.7',progress:0.7})).status,200);
    assert.equal((await request('progress','POST',{...saved,memberId:bob.id,location:'0.1',progress:0.1})).status,200);
    const detail=async member=>(await request('document?id='+book.id+(member===undefined?'':'&member='+member))).body;
    assert.equal((await detail()).progress.progress,0.4);assert.equal((await detail(alice.id)).progress.progress,0.7);assert.equal((await detail(bob.id)).progress.progress,0.1);
    // Switching one browser has no server-global selected member to redirect another reader's writes.
    await request('recent?member='+bob.id);
    await request('progress','POST',{...saved,memberId:alice.id,location:'0.8',progress:0.8});
    assert.equal((await detail(bob.id)).progress.progress,0.1);assert.equal((await detail(alice.id)).progress.progress,0.8);
    for(const route of ['recent?member=unknown','document?id='+book.id+'&member=unknown'])assert.equal((await request(route)).status,404);
    assert.equal((await request('progress','POST',{...saved,memberId:'unknown'})).status,404);
    assert.equal((await request('progress','POST',{...saved,memberId:''})).status,400);
    assert.equal((await request('progress','POST',{...saved,memberId:null})).status,400);
    assert.equal((await request('document?id='+book.id+'&member=')).status,400);
    assert.equal(app.db.prepare('SELECT count(*) n FROM reading_progress WHERE id=?').get(book.id).n,3);
  });
  await t.test('opening adds recent history without resetting progress; recent order and limit are member-specific',async()=>{
    await request('reading-open','POST',{id:book.id,memberId:alice.id});
    const before=(await request('document?id='+book.id+'&member='+alice.id)).body.progress;
    assert.equal(before.progress,0.8);
    await new Promise(r=>setTimeout(r,5));
    assert.equal((await request('reading-open','POST',{id:second.id,memberId:alice.id})).status,200);
    const recent=(await request('recent?member='+alice.id+'&limit=1')).body;
    assert.equal(recent.total,2);assert.equal(recent.items.length,1);assert.equal(recent.items[0].id,second.id);assert.equal(recent.items[0].progress,null);assert.ok(recent.items[0].lastOpened>0);
    assert.deepEqual(recent.member,alice);assert.equal((await request('recent?member='+bob.id)).body.total,1);
    assert.equal((await request('reading-open','POST',{id:books.find(b=>b.file.format==='DOCX').id,memberId:alice.id})).status,400);
    assert.equal((await request('reading-open','POST',{id:'missing',memberId:alice.id})).status,404);
    const after=(await request('document?id='+book.id+'&member='+alice.id)).body.progress;assert.deepEqual(after,before);
  });
  await t.test('renaming and restart preserve histories, member IDs and the session',async()=>{
    assert.equal((await request('members','PUT',{id:alice.id,name:'家人甲'})).status,200);
    await stop();await start();
    assert.equal((await request('session')).body.authenticated,true);
    const recent=(await request('recent?member='+alice.id)).body;
    assert.equal(recent.member.name,'家人甲');assert.equal(recent.total,2);
    assert.equal(recent.items.find(b=>b.id===book.id).progress.progress,0.8);
    assert.equal((await request('document?id='+book.id)).body.progress.progress,0.4);
  });
  await t.test('deleting a catalog record removes every member history but preserves the source file',async()=>{
    const detail=(await request('document?id='+second.id)).body;
    assert.equal((await request('document?id='+second.id,'DELETE',{version:detail.version,recordVersion:detail.recordVersion})).status,200);
    assert.equal((await request('recent?member='+alice.id)).body.total,1);
    assert.equal(app.db.prepare('SELECT count(*) n FROM reading_history WHERE id=?').get(second.id).n,0);
    assert.equal(await fs.readFile(path.join(booksDir,'阅读二.txt'),'utf8'),'家庭阅读正文');
  });
  await t.test('v4 upgrade snapshots old schema and migrates shared progress to the default member',async()=>{
    await stop();
    const old=new DatabaseSync(path.join(dataDir,'library.sqlite'));
    old.exec(`DROP TABLE reading_progress; DROP TABLE reading_history; DROP TABLE members;
      CREATE TABLE reading_progress(id TEXT PRIMARY KEY,kind TEXT NOT NULL,location TEXT NOT NULL,progress REAL NOT NULL,updated INTEGER NOT NULL);
      PRAGMA user_version=4;`);
    old.prepare('INSERT INTO reading_progress VALUES (?,?,?,?,?)').run(book.id,'text','0.55',0.55,1234);old.close();
    await start();
    assert.equal((await request('session')).body.authenticated,true);
    assert.equal((await request('document?id='+book.id)).body.progress.progress,0.55);
    assert.equal((await request('recent')).body.items[0].id,book.id);
    assert.equal(app.db.prepare('PRAGMA user_version').get().user_version,5);
    const backups=await fs.readdir(path.join(dataDir,'backups'));assert.equal(backups.length,1);
    const snapshot=new DatabaseSync(path.join(dataDir,'backups',backups[0]),{readOnly:true});
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,4);
    assert.equal(snapshot.prepare('SELECT progress FROM reading_progress').get().progress,0.55);snapshot.close();
    await stop();await start();assert.equal((await fs.readdir(path.join(dataDir,'backups'))).length,1);
    assert.equal((await request('recent')).body.total,1);
  });
});
