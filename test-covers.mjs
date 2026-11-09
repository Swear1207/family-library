import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas,loadImage } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { createFileLibrary } from './ebook-files.mjs';
import { createCoverService } from './cover-service.mjs';
import { createLibraryServer } from './server.mjs';

const root=fileURLToPath(new URL('./.test-data/',import.meta.url));
const id=name=>'file-'+createHash('sha256').update(name).digest('hex');
async function png(color,width=800,height=1000){const c=createCanvas(width,height);c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,width,height);const out=await c.encode('png');c.width=1;c.height=1;return out;}
function pdf(){
  const contents=['0.1 0.2 0.9 rg 0 0 600 800 re f 1 1 1 rg BT /F1 36 Tf 30 720 Td (Family cover) Tj ET','0.1 0.9 0.2 rg 0 0 600 800 re f'];
  const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for(let i=0;i<2;i++){objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4+i*2} 0 R >>`);objects.push(`<< /Length ${Buffer.byteLength(contents[i])} >>\nstream\n${contents[i]}\nendstream`);}
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[0];let offset=chunks[0].length;
  for(let i=1;i<objects.length;i++){offsets.push(offset);const chunk=Buffer.from(`${i} 0 obj\n${objects[i]}\nendobj\n`);chunks.push(chunk);offset+=chunk.length;}
  chunks.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
async function scannedPdf(){
  // A common 300 dpi A4 scan must survive PDF.js's full-resolution image canvas.
  const width=2480,height=3508,c=createCanvas(width,height);c.getContext('2d').fillStyle='#24b6ce';c.getContext('2d').fillRect(0,0,width,height);const image=await c.encode('jpeg',90);c.width=1;c.height=1;
  const content='q 600 0 0 800 0 0 cm /Cover Do Q';
  const objects=[null,Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Cover 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')])];
  const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[0];let offset=chunks[0].length;
  for(let i=1;i<objects.length;i++){offsets.push(offset);const chunk=Buffer.concat([Buffer.from(`${i} 0 obj\n`),objects[i],Buffer.from('\nendobj\n')]);chunks.push(chunk);offset+=chunk.length;}
  chunks.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
async function epub(image,{external=false,entities=false,oversized=false,legacy=false}={}){
  const zip=new JSZip();
  zip.file('META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf',(entities?'<!DOCTYPE package [<!ENTITY x SYSTEM "https://example.invalid/private">]>':'')+'<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata>'+(legacy?'<meta name="cover" content="front"/>':'')+'</metadata><manifest><item id="front" '+(legacy?'':'properties="cover-image" ')+'media-type="image/png" href="'+(external?'https://example.invalid/cover.png':'../images/front.png')+'"/></manifest></package>'+(oversized?' '.repeat(2*1024*1024):''));
  zip.file('images/front.png',image);
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
async function sample(filename){const image=await loadImage(await readFile(filename)),c=createCanvas(image.width,image.height);c.getContext('2d').drawImage(image,0,0);const rgba=c.getContext('2d').getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data;return{width:image.width,height:image.height,rgba};}

test('covers: authenticated on-demand PDF, EPUB and image derivatives with bounded worker cache', {timeout:30000}, async t=>{
  await mkdir(root,{recursive:true});const temp=await mkdtemp(path.join(root,'covers-')),booksDir=path.join(temp,'books'),dataDir=path.join(temp,'data');
  await mkdir(booksDir);await mkdir(dataDir);
  const red=await png('#dc2424');
  const inputs={
    'paper.pdf':pdf(),'scanned.pdf':await scannedPdf(),'book.epub':await epub(red),'legacy.epub':await epub(red,{legacy:true}),'photo.png':red,
    'broken.pdf':Buffer.from('not a PDF'),'broken.jpg':Buffer.from('not an image'),'unsupported.svg':Buffer.from('<svg><image href="https://example.invalid/private"/></svg>'),
    'disguised.jpg':Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>'),
    'remote.epub':await epub(red,{external:true}),'entities.epub':await epub(red,{entities:true}),'bomb.epub':await epub(red,{oversized:true}),
  };
  const huge=Buffer.from(red);huge.writeUInt32BE(50000,16);inputs['huge.png']=huge;
  for(const[name,bytes]of Object.entries(inputs))await writeFile(path.join(booksDir,name),bytes);
  const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON; CREATE TABLE library(id INTEGER PRIMARY KEY,books TEXT,version INTEGER); INSERT INTO library VALUES(1,'[]',0); CREATE TABLE ebook_files(id TEXT PRIMARY KEY,relative_path TEXT,size INTEGER,mtime INTEGER,available INTEGER); CREATE TABLE reading_progress(id TEXT PRIMARY KEY);");
  const fileLibrary=createFileLibrary(db,booksDir);await fileLibrary.scan(()=>true);
  let openedCount=0,peakHandles=0;
  const files={async openFileSafe(...args){const opened=await fileLibrary.openFileSafe(...args);openedCount++;peakHandles=Math.max(peakHandles,openedCount);const handle=opened.handle;let closed=false;return{...opened,handle:{fd:handle.fd,stat:()=>handle.stat(),async close(){if(!closed){closed=true;openedCount--;await handle.close();}}}};}};
  let service=createCoverService({dataDir,files,timeoutMs:5000,maxQueued:3});
  async function finish(name,expected='ready'){
    const end=Date.now()+10000;
    while(Date.now()<end){const result=await service.get(id(name),()=>true);if(result.status!=='pending'){assert.equal(result.status,expected,name);return result;}await delay(30);}
    assert.fail('Cover did not finish: '+name);
  }
  t.after(async()=>{await service.stop();fileLibrary.stop();db.close();assert.equal(openedCount,0);assert.equal(path.dirname(path.resolve(temp)),path.resolve(root));await rm(temp,{recursive:true,force:true});});

  await t.test('requires auth before lookup and leaves unseen documents unrendered',async()=>{
    await assert.rejects(()=>service.get(id('photo.png'),()=>false),{status:401});
    await assert.rejects(()=>service.get('../private',()=>true),{status:404});
    await assert.rejects(()=>service.get(id('missing.png'),()=>true),{status:404});
    assert.deepEqual(await readdir(dataDir),[]);
  });
  let pdfReady,imageReady;
  await t.test('renders the PDF first page, EPUB declared cover and raster image to real bounded JPEGs',async()=>{
    for(const name of ['paper.pdf','book.epub','legacy.epub','photo.png'])assert.equal((await service.get(id(name),()=>true)).status,'pending');
    pdfReady=await finish('paper.pdf');const bookReady=await finish('book.epub');await finish('legacy.epub');imageReady=await finish('photo.png');
    for(const result of [pdfReady,bookReady,imageReady]){
      assert.equal(result.mime,'image/jpeg');assert.ok(result.size>100&&result.size<1024*1024);assert.match(result.etag,/^"[a-f0-9]{64}"$/);
      assert.ok(path.resolve(result.path).startsWith(path.resolve(dataDir)+path.sep));
      const content=await readFile(result.path);assert.equal(content[0],255);assert.equal(content[1],216);
      const image=await sample(result.path);assert.ok(image.width<=320&&image.height<=420);
    }
    const paper=await sample(pdfReady.path);assert.ok(paper.rgba[2]>180&&paper.rgba[1]<100,'first blue page, not second green page');
    const scan=await sample((await finish('scanned.pdf')).path);assert.ok(scan.rgba[0]<100&&scan.rgba[1]>130&&scan.rgba[2]>150,'2480×3508 scanned JPEG produces cyan pixels rather than a blank white thumbnail');
    const book=await sample(bookReady.path);assert.ok(book.rgba[0]>180&&book.rgba[1]<100);
    const unseenFolder=path.join(dataDir,'covers',id('broken.pdf').slice(5,7),id('broken.pdf').slice(5));
    await assert.rejects(()=>stat(unseenFolder),{code:'ENOENT'});
  });
  await t.test('serves persistent cache after restart and still checks authorization',async()=>{
    const before=await stat(imageReady.path);await service.stop();assert.equal(openedCount,0);
    service=createCoverService({dataDir,files,timeoutMs:5000,maxQueued:3});
    const cached=await service.get(id('photo.png'),()=>true);assert.equal(cached.status,'ready');assert.equal(cached.etag,imageReady.etag);assert.equal((await stat(cached.path)).mtimeMs,before.mtimeMs);
    await assert.rejects(()=>service.get(id('photo.png'),()=>false),{status:401});
  });
  await t.test('source changes invalidate cached thumbnails without requiring another scan',async()=>{
    await delay(20);await writeFile(path.join(booksDir,'photo.png'),await png('#24dc24',900,700));
    assert.equal((await service.get(id('photo.png'),()=>true)).status,'pending');
    const updated=await finish('photo.png');assert.notEqual(updated.etag,imageReady.etag);const image=await sample(updated.path);assert.ok(image.rgba[1]>180&&image.rgba[0]<100);
    await assert.rejects(()=>stat(imageReady.path),{code:'ENOENT'});imageReady=updated;
    assert.equal((await service.get(id('paper.pdf'),()=>true)).etag,pdfReady.etag,'another document cache remains independent');
  });
  await t.test('malformed, unsupported, oversized and external EPUB covers fall back and do not block later work',async()=>{
    for(const name of ['broken.pdf','broken.jpg','unsupported.svg','disguised.jpg','remote.epub','entities.epub','bomb.epub','huge.png']){
      const result=await finish(name,'unavailable');assert.equal(result.path,undefined);
      assert.equal((await service.get(id(name),()=>true)).status,'unavailable');
    }
    await writeFile(path.join(booksDir,'after.png'),await png('#3333dd',300,200));await fileLibrary.scan(()=>true);
    await finish('after.png');assert.equal(openedCount,0);
  });
  await t.test('duplicate requests share one job; shutdown closes queued and active source handles',async()=>{
    for(let index=0;index<6;index++)await writeFile(path.join(booksDir,`queue-${index}.png`),red);
    await fileLibrary.scan(()=>true);
    const requests=Array.from({length:8},()=>service.get(id('queue-0.png'),()=>true));
    await Promise.all(requests);
    for(let index=1;index<6;index++)await service.get(id(`queue-${index}.png`),()=>true);
    assert.ok(openedCount<=4,'one active worker plus a bounded queue');
    await service.stop();assert.equal(openedCount,0);assert.equal((await service.get(id('photo.png'),()=>true)).status,'unavailable');
  });
  await t.test('worker timeouts yield an icon and release the source descriptor',async()=>{
    service=createCoverService({dataDir,files,timeoutMs:1});
    await finish('queue-5.png','unavailable');assert.equal(openedCount,0);
  });
});

test('cover HTTP: authenticated GET/HEAD, pending to JPEG, fallback and logout', {timeout:20000}, async t=>{
  await mkdir(root,{recursive:true});const temp=await mkdtemp(path.join(root,'covers-http-')),dataDir=path.join(temp,'data'),booksDir=path.join(temp,'books');
  await mkdir(booksDir);await writeFile(path.join(booksDir,'photo.png'),await png('#da3535',500,600));await writeFile(path.join(booksDir,'text.txt'),'No raster cover');
  const origin='http://covers.test',app=createLibraryServer({dataDir,booksDir,origin,metadataEnabled:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;let cookie;
  t.after(async()=>{await app.close();assert.equal(path.dirname(path.resolve(temp)),path.resolve(root));await rm(temp,{recursive:true,force:true});});
  async function request(action,{method='GET',data,auth=true}={}){
    const headers={Origin:origin};if(cookie&&auth)headers.Cookie=cookie;if(data!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+'/api/family/'+action,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});const bytes=Buffer.from(await response.arrayBuffer());let json;try{json=JSON.parse(bytes.toString());}catch{}return{status:response.status,headers:response.headers,bytes,json};
  }
  for(const method of ['GET','HEAD'])assert.equal((await request('cover?id='+id('photo.png'),{method})).status,401);
  const setup=await request('setup',{method:'POST',data:{username:'covers_family',password:'Covers-test-password-729!',setupToken:(await readFile(path.join(dataDir,'setup-token.txt'),'utf8')).trim()}});
  assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('scan',{method:'POST',data:{}})).status,200);
  assert.equal((await request('cover?id='+id('missing.png'))).status,404);
  assert.equal((await request('cover?id='+id('text.txt'))).status,204);
  const pending=await request('cover?id='+id('photo.png'));assert.equal(pending.status,202);assert.equal(pending.json.status,'pending');assert.ok(Number(pending.headers.get('retry-after'))>0);
  let ready;const end=Date.now()+10000;
  do{await delay(30);ready=await request('cover?id='+id('photo.png'));}while(ready.status===202&&Date.now()<end);
  assert.equal(ready.status,200);assert.equal(ready.headers.get('content-type'),'image/jpeg');assert.equal(ready.bytes[0],255);assert.equal(ready.bytes[1],216);assert.equal(Number(ready.headers.get('content-length')),ready.bytes.length);
  const image=await loadImage(ready.bytes);assert.ok(image.width<=320&&image.height<=420);
  const head=await request('cover?id='+id('photo.png'),{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers.get('content-length')),ready.bytes.length);assert.equal(head.headers.get('etag'),ready.headers.get('etag'));
  assert.equal((await request('logout',{method:'POST',data:{}})).status,200);
  for(const method of ['GET','HEAD'])assert.equal((await request('cover?id='+id('photo.png'),{method})).status,401);
});
