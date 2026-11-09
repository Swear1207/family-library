import { read as readCallback } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas, loadImage, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const read = promisify(readCallback), MiB = 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024, MAX_IMAGE_BYTES = 24 * MiB;
const OPF = 'http://www.idpf.org/2007/opf', CONTAINER = 'urn:oasis:names:tc:opendocument:xmlns:container';
globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;
const pdfDirectory = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

async function bytes(fd, begin, end, size) {
  if (![begin,end,size].every(Number.isSafeInteger) || begin < 0 || end < begin || end > size) throw Error('Invalid range');
  const result = new Uint8Array(end - begin); let offset = 0;
  while (offset < result.length) {
    const { bytesRead } = await read(fd, result, offset, Math.min(MiB, result.length - offset), begin + offset);
    if (!bytesRead) throw Error('Truncated file');
    offset += bytesRead;
  }
  return result;
}
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > MAX_PIXELS) throw Error('Image dimensions exceed limit');
  return { width, height };
}
function imageSize(data) {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 10 || b.length > MAX_IMAGE_BYTES) throw Error('Image input exceeds limit');
  if (b.length >= 24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16) === 'IHDR') return dimensions(b.readUInt32BE(16), b.readUInt32BE(20));
  if (['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))) return dimensions(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 26 && b.toString('ascii',0,2) === 'BM') {
    if (b.readUInt32LE(14) === 12) return dimensions(b.readUInt16LE(18), b.readUInt16LE(20));
    return dimensions(b.readInt32LE(18), Math.abs(b.readInt32LE(22)));
  }
  if (b[0] === 255 && b[1] === 216) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at++] !== 255) throw Error('Invalid JPEG marker');
      while (at < b.length && b[at] === 255) at++;
      const marker = b[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (at + 2 > b.length) break;
      const size = b.readUInt16BE(at);
      if (size < 2 || at + size > b.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 7) return dimensions(b.readUInt16BE(at + 5), b.readUInt16BE(at + 3));
      at += size;
    }
  }
  if (b.length >= 30 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') {
    const kind = b.toString('ascii',12,16);
    if (kind === 'VP8X') return dimensions(1 + b.readUIntLE(24,3), 1 + b.readUIntLE(27,3));
    if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) return dimensions(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (kind === 'VP8L' && b[20] === 0x2f) { const bits = b.readUInt32LE(21); return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
  }
  throw Error('Unsupported image bytes');
}
function targetSize(width, height) {
  const scale = Math.min(320 / width, 420 / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
async function jpeg(canvas) {
  const output = await canvas.encode('jpeg', 78);
  if (output.length > MiB) throw Error('Cover output exceeds limit');
  return new Uint8Array(output);
}
async function imageCover(data) {
  const expected = imageSize(data);
  // Only already validated raster bytes enter the native decoder; never a URL or SVG.
  const image = await loadImage(data);
  dimensions(image.width, image.height);
  if (image.width * image.height !== expected.width * expected.height) throw Error('Unexpected decoded image dimensions');
  const size = targetSize(image.width, image.height), canvas = createCanvas(size.width, size.height);
  try {
    const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0,0,size.width,size.height);
    context.drawImage(image,0,0,size.width,size.height);
    return await jpeg(canvas);
  } finally { canvas.width = 1; canvas.height = 1; }
}

async function pdfCover(fd, size) {
  if (size > 512 * MiB) throw Error('PDF exceeds limit');
  const { getDocument, PDFDataRangeTransport } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let used = Math.min(size,65536), fail;
  const initial = await bytes(fd,0,used,size), failure = new Promise((_,reject) => { fail = reject; }); failure.catch(()=>{});
  class Range extends PDFDataRangeTransport {
    aborted = false; pending = new Set();
    requestDataRange(begin,end) {
      if (this.aborted) return;
      const length = end-begin;
      if (length < 0 || length > 16*MiB || used+length > 64*MiB) { fail(Error('PDF read limit')); return; }
      used += length;
      const task = bytes(fd,begin,end,size).then(data => { if (!this.aborted) this.onDataRange(begin,data); }).catch(fail).finally(()=>this.pending.delete(task));
      this.pending.add(task);
    }
    abort() { this.aborted = true; }
  }
  class LocalPdfResources {
    async fetch({kind,filename}) {
      const directories = { cMapUrl:'cmaps', standardFontDataUrl:'standard_fonts' };
      if (!directories[kind] || typeof filename !== 'string' || !/^[a-z0-9_.-]+$/i.test(filename) || filename.includes('..')) throw Error('External PDF resource forbidden');
      return new Uint8Array(await readFile(path.join(pdfDirectory,directories[kind],filename)));
    }
  }
  class BoundedCanvasFactory {
    used = 0;
    create(width,height) {
      width=Math.ceil(width);height=Math.ceil(height);dimensions(width,height);
      if (width*height > 4*MiB || this.used+width*height > 8*MiB) throw Error('PDF canvas limit');
      const canvas=createCanvas(width,height);this.used+=width*height;
      return {canvas,context:canvas.getContext('2d'),pixels:width*height};
    }
    reset(entry,width,height) {
      width=Math.ceil(width);height=Math.ceil(height);dimensions(width,height);
      if(width*height>4*MiB||this.used-entry.pixels+width*height>8*MiB)throw Error('PDF canvas limit');
      this.used+=width*height-entry.pixels;entry.pixels=width*height;entry.canvas.width=width;entry.canvas.height=height;
    }
    destroy(entry) {if(entry.canvas){this.used-=entry.pixels;entry.canvas.width=1;entry.canvas.height=1;entry.canvas=null;entry.context=null;entry.pixels=0;}}
    getNoAlphaContext(canvas) {return canvas.getContext('2d',{alpha:false});}
  }
  const transport = new Range(size,initial,true), task = getDocument({ range:transport,length:size,rangeChunkSize:65536,
    disableAutoFetch:true,disableStream:true,enableXfa:false,useWorkerFetch:false,useSystemFonts:false,useWasm:false,
    disableFontFace:true,isEvalSupported:false,isOffscreenCanvasSupported:false,isImageDecoderSupported:false,
    maxImageSize:MAX_PIXELS,CanvasFactory:BoundedCanvasFactory,BinaryDataFactory:LocalPdfResources,verbosity:0 });
  const guarded = operation => Promise.race([operation,failure]);
  let canvas;
  try {
    const document=await guarded(task.promise),page=await guarded(document.getPage(1));
    const natural=page.getViewport({scale:1});
    if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width<=0 || natural.height<=0) throw Error('Invalid page size');
    const scale=Math.min(320/natural.width,420/natural.height),viewport=page.getViewport({scale});
    canvas=createCanvas(Math.max(1,Math.ceil(viewport.width)),Math.max(1,Math.ceil(viewport.height)));
    await guarded(page.render({canvasContext:canvas.getContext('2d'),viewport,background:'#ffffff'}).promise);
    return await jpeg(canvas);
  } finally {
    transport.abort();
    try { await task.destroy(); } finally { await Promise.allSettled(transport.pending);if(canvas){canvas.width=1;canvas.height=1;} }
  }
}

function zipDirectory(bytes) {
  if (bytes.length < 22) throw Error('Invalid ZIP');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--)if(view.getUint32(at,true)===0x06054b50&&at+22+view.getUint16(at+20,true)===bytes.length){end=at;break;}
  if(end<0)throw Error('Invalid ZIP');
  const count=view.getUint16(end+10,true),start=view.getUint32(end+16,true),length=view.getUint32(end+12,true);
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||!count||count>2000||length>4*MiB||start+length!==end||end>=20&&view.getUint32(end-20,true)===0x07064b50)throw Error('Unsupported ZIP');
  let at=start,actual=0;
  while(at<end){
    if(++actual>2000||at+46>end||view.getUint32(at,true)!==0x02014b50)throw Error('Invalid ZIP directory');
    const name=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),next=at+46+name+extra+view.getUint16(at+32,true),local=view.getUint32(at+42,true);
    if(next>end||view.getUint16(at+34,true)||(view.getUint16(at+8,true)&1)||![0,8].includes(view.getUint16(at+10,true))||view.getUint32(at+20,true)===0xffffffff||view.getUint32(at+24,true)===0xffffffff||local+30>start||view.getUint32(local,true)!==0x04034b50)throw Error('Invalid ZIP member');
    if(local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true)+view.getUint32(at+20,true)>start)throw Error('Invalid ZIP range');
    for(let x=at+46+name,stop=x+extra;x<stop;){if(x+4>stop||view.getUint16(x,true)===1)throw Error('ZIP64 unsupported');x+=4+view.getUint16(x+2,true);if(x>stop)throw Error('Invalid ZIP extra');}
    at=next;
  }
  if(actual!==count||at!==end)throw Error('Invalid ZIP count');
}
function safeName(name) {return typeof name==='string'&&name.length>0&&name.length<=600&&!/(^\/|\\|[\u0000-\u001f\u007f])/.test(name)&&!/^[a-z][a-z0-9+.-]*:/i.test(name)&&!name.split('/').some(p=>p==='..'||p==='.');}
function resolveMember(href,from,zip) {
  if(typeof href!=='string'||!href||href.length>2048||/[\\\u0000-\u0020]/.test(href)||/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('/'))throw Error('External EPUB resource forbidden');
  const url=new URL(href,'https://epub.invalid/'+from);
  const name=decodeURIComponent(url.pathname.slice(1));
  if(url.origin!=='https://epub.invalid'||url.search||!safeName(name)||!zip.file(name))throw Error('Missing EPUB member');
  return name;
}
function entryBytes(entry,limit) {
  if(!entry||entry.dir)throw Error('Missing EPUB metadata');
  return new Promise((resolve,reject)=>{
    let size=0,done=false;const chunks=[],stream=entry.internalStream('uint8array');
    stream.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>limit){done=true;stream.pause();chunks.length=0;reject(Error('EPUB expansion limit'));return;}chunks.push(chunk);});
    stream.on('error',error=>{if(!done){done=true;reject(error);}});
    stream.on('end',()=>{if(done)return;done=true;const result=new Uint8Array(size);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length;}resolve(result);});stream.resume();
  });
}
function xml(data) {
  const encoding=data[0]===255&&data[1]===254?'utf-16le':data[0]===254&&data[1]===255?'utf-16be':'utf-8';
  const source=new TextDecoder(encoding,{fatal:true}).decode(data);if(/<!DOCTYPE|<!ENTITY/i.test(source))throw Error('XML declarations forbidden');
  let broken=false;const mark=()=>{broken=true;};
  const document=new DOMParser({errorHandler:{warning:mark,error:mark,fatalError:mark}}).parseFromString(source,'application/xml');
  if(broken||!document.documentElement)throw Error('Invalid XML');return document;
}
async function epubCover(fd,size) {
  if(size>64*MiB)throw Error('EPUB size limit');
  const data=await bytes(fd,0,size,size);zipDirectory(data);
  const zip=await JSZip.loadAsync(data,{createFolders:false,checkCRC32:false});
  for(const entry of Object.values(zip.files))if(!safeName(entry.name)||entry.unsafeOriginalName&&entry.unsafeOriginalName!==entry.name)throw Error('Invalid EPUB path');
  const container=xml(await entryBytes(zip.file('META-INF/container.xml'),65536));
  const root=Array.from(container.getElementsByTagNameNS(CONTAINER,'rootfile')).find(node=>node.getAttribute('media-type')==='application/oebps-package+xml');
  const opf=root?.getAttribute('full-path');if(!safeName(opf)||!opf.endsWith('.opf'))throw Error('Missing OPF');
  const document=xml(await entryBytes(zip.file(opf),2*MiB));
  if(document.documentElement.namespaceURI!==OPF||document.documentElement.localName!=='package')throw Error('Invalid OPF');
  const items=Array.from(document.getElementsByTagNameNS(OPF,'item'));
  const coverId=Array.from(document.getElementsByTagNameNS(OPF,'meta')).find(node=>node.getAttribute('name')==='cover')?.getAttribute('content');
  let cover=items.find(node=>node.getAttribute('properties').split(/\s+/).includes('cover-image'))||items.find(node=>coverId&&node.getAttribute('id')===coverId);
  let href=cover?.getAttribute('href');
  if(!href)href=Array.from(document.getElementsByTagNameNS(OPF,'reference')).find(node=>node.getAttribute('type')==='cover')?.getAttribute('href');
  let member=resolveMember(href,opf,zip);
  if(/\.(?:xhtml|html|htm)$/i.test(member)){
    const page=xml(await entryBytes(zip.file(member),256*1024));
    const image=Array.from(page.getElementsByTagNameNS('*','img'))[0];
    member=resolveMember(image?.getAttribute('src'),member,zip);
  }
  if(!/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(member))throw Error('Unsupported EPUB cover format');
  return imageCover(await entryBytes(zip.file(member),MAX_IMAGE_BYTES));
}

// fd was opened and validated by the server; this worker never opens source paths.
export async function renderCover({fd,size,format}) {
  if(!Number.isSafeInteger(fd)||fd<0||!Number.isSafeInteger(size)||size<1)throw Error('Invalid cover input');
  format=String(format).toLowerCase();
  if(format==='pdf')return pdfCover(fd,size);
  if(format==='epub')return epubCover(fd,size);
  if(['png','jpg','jpeg','webp','gif','bmp'].includes(format)&&size<=MAX_IMAGE_BYTES)return imageCover(await bytes(fd,0,size,size));
  throw Error('Unsupported cover format');
}
