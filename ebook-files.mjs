import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileType } from './file-types.mjs';
import { createCatalogStore } from './catalog-store.mjs';

const TEXT_LIMIT = 2 * 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};

// Unsupported or malformed ranges can be ignored; multipart ranges are not expanded.
function byteRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const startValue = match[1] === '' ? null : Number(match[1]);
  const endValue = match[2] === '' ? null : Number(match[2]);
  if ((startValue !== null && !Number.isSafeInteger(startValue)) || (endValue !== null && !Number.isSafeInteger(endValue))) return null;
  if (size === 0) return { unsatisfiable: true };
  if (startValue === null) {
    if (endValue === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - endValue), end: size - 1 };
  }
  if (startValue >= size || (endValue !== null && endValue < startValue)) return { unsatisfiable: true };
  return { start: startValue, end: endValue === null ? size - 1 : Math.min(endValue, size - 1) };
}

export function createFileLibrary(db, booksDir, store = createCatalogStore(db)) {
  let scanning = false;
  const enabled = !!booksDir;

  async function rootPath() {
    if (!enabled) throw fail(400, '尚未配置资料目录');
    try {
      const root = await fs.promises.realpath(booksDir);
      if (!(await fs.promises.stat(root)).isDirectory()) throw Error();
      return root;
    } catch { throw fail(503, '资料目录不可读取，请检查 /books 挂载与目录权限'); }
  }

  function attach(books) {
    const getFile=db.prepare('SELECT f.*,m.status metadata_status FROM ebook_files f LEFT JOIN metadata_jobs m ON m.id=f.id WHERE f.id=?');
    return books.map(book => {
      const file = getFile.get(book.id);
      const { file: ignored, ...clean } = book;
      if (!file) return clean;
      const type = fileType(file.relative_path);
      const directory = path.posix.dirname(file.relative_path);
      return {
        ...clean,
        resourceType: clean.resourceType || type?.resourceType || '其他',
        file: {
          name: path.posix.basename(file.relative_path),
          format: path.posix.extname(file.relative_path).slice(1).toUpperCase(),
          size: file.size, available: !!file.available,
          preview: type?.preview || null,
          folder: directory === '.' ? '' : directory,
          directory: file.directory,
          mtime: file.mtime,
          metadataStatus: file.metadata_status||null,
        },
      };
    });
  }

  let scanState={running:false,found:0,added:0,visited:0,skipped:0,missing:0,error:null};
  let stopped=false;
  async function scan(authorize = () => true, {retryMetadata=false}={}) {
    if (scanning) throw fail(409, '正在扫描，请稍后再试');
    scanning = true;
    scanState={running:true,found:0,added:0,visited:0,skipped:0,missing:0,error:null,started:Date.now()};
    try {
      const root = await rootPath();
      if(!db.prepare('SELECT id FROM library WHERE id=1').get())throw fail(401,'请先设置家庭账号');
      if(retryMetadata)db.prepare("UPDATE metadata_jobs SET status='pending' WHERE status='failed'").run();
      const scanId=randomBytes(16).toString('hex');
      let batch=[];
      const lookup=db.prepare('SELECT size,mtime,available FROM ebook_files WHERE id=?');
      const exists=db.prepare('SELECT 1 FROM catalog_items WHERE id=?');
      const upsert=db.prepare('INSERT INTO ebook_files (id,relative_path,size,mtime,available,format,scan_id) VALUES (?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path,size=excluded.size,mtime=excluded.mtime,available=1,format=excluded.format,scan_id=excluded.scan_id');
      const queue=db.prepare("INSERT INTO metadata_jobs(id,size,mtime,status) VALUES (?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,status='pending',updated=0 WHERE metadata_jobs.size<>excluded.size OR metadata_jobs.mtime<>excluded.mtime");
      async function flush() {
        if(stopped)throw fail(503,'扫描已暂停，下次扫描会继续收录');
        if(!authorize())throw fail(401,'登录已失效，请重新登录');
        if(!batch.length)return;
        db.exec('BEGIN IMMEDIATE');let changed=false,added=0;
        try {
          for(const file of batch){
            const previous=lookup.get(file.id);
            if(!previous||!previous.available||previous.size!==file.size||previous.mtime!==file.mtime)changed=true;
            const extension=path.posix.extname(file.relative),format=extension.slice(1).toUpperCase();
            upsert.run(file.id,file.relative,file.size,file.mtime,format,scanId);
            if(!exists.get(file.id)){
              store.put({id:file.id,title:path.posix.basename(file.relative,extension).slice(0,300)||'未命名资料',author:'',category:'其他',status:'未读',
                location:(path.posix.dirname(file.relative)==='.'?'资料目录':path.posix.dirname(file.relative)).slice(0,300),borrower:'',notes:'',
                created:Date.now(),color:'#456258',demo:false,resourceType:fileType(file.relative).resourceType});
              added++;changed=true;
              db.prepare('DELETE FROM metadata_jobs WHERE id=?').run(file.id);
            }
            if(['PDF','EPUB'].includes(format))queue.run(file.id,file.size,file.mtime);
          }
          if(changed)store.bump();db.exec('COMMIT');scanState.added+=added;
        } catch(error){db.exec('ROLLBACK');throw error;}
        batch=[];
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      async function walk(directory, depth = 0) {
        if(depth>128)throw fail(400,'目录层级超过128层，已收录的资料已保存');
        const entries=await fs.promises.opendir(directory);
        for await (const entry of entries) {
          if(stopped)throw fail(503,'扫描已暂停，下次扫描会继续收录');
          scanState.visited++;
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) { scanState.skipped++; continue; }
          const full = path.join(directory, entry.name);
          const stat = await fs.promises.lstat(full);
          if (stat.isSymbolicLink()) { scanState.skipped++; continue; }
          const resolved = await fs.promises.realpath(full);
          if (!inside(root, resolved)) { scanState.skipped++; continue; }
          if (stat.isDirectory()) { await walk(full, depth + 1); continue; }
          if (!stat.isFile() || !fileType(entry.name)) { scanState.skipped++; continue; }
          const relative = path.relative(root, full).split(path.sep).join('/');
          batch.push({
            id: 'file-' + createHash('sha256').update(relative).digest('hex'),
            relative, size: stat.size, mtime: Math.round(stat.mtimeMs),
          });
          scanState.found++;
          if(batch.length>=200)await flush();
        }
      }
      try { await walk(root);await flush(); }
      catch (error) {
        if (error.status) throw error;
        throw fail(503, '扫描中断：有目录或文件无法读取。已收录的资料已保存，检查权限后可重新扫描。');
      }
      if (!authorize()) throw fail(401, '登录已失效，请重新登录');
      db.exec('BEGIN IMMEDIATE');
      try {
        // Missing status is only finalized after a successful complete traversal.
        const changed=db.prepare('UPDATE ebook_files SET available=0 WHERE scan_id<>? AND available=1').run(scanId).changes;
        if(changed)store.bump();
        scanState.missing=db.prepare('SELECT count(*) n FROM ebook_files f JOIN catalog_items c ON c.id=f.id WHERE f.available=0').get().n;
        db.exec('COMMIT');
        return {...scanState,running:false,version:store.version()};
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch(error){scanState.error=error.message;throw error;}
    finally { scanning=false;scanState.running=false;scanState.finished=Date.now(); }
  }

  async function openIndexedFile(id, authorize) {
    if (!authorize()) throw fail(401, '登录已失效，请重新登录');
    if (typeof id !== 'string' || !/^file-[a-f0-9]{64}$/.test(id)) throw fail(404, '文件不存在');
    const file = db.prepare('SELECT * FROM ebook_files WHERE id=? AND available=1').get(id);
    if (!file) throw fail(404, '文件不存在，请重新扫描资料目录');
    const root = await rootPath();
    const parts = file.relative_path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || process.platform==='win32'&&part.includes('\\'))) throw fail(404, '文件路径无效');
    let full = root;
    let handle;
    try {
      for (const part of parts) {
        full = path.join(full, part);
        if ((await fs.promises.lstat(full)).isSymbolicLink()) throw fail(404, '不支持读取符号链接');
      }
      const real = await fs.promises.realpath(full);
      if (!inside(root, real)) throw fail(404, '文件不在资料目录中');
      handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      // Check the opened descriptor, not just the path that existed before open.
      if (process.platform === 'linux') {
        const opened = await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
        if (!inside(root, opened)) throw fail(404, '文件路径已变化，请重新扫描');
      }
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw fail(404, '文件不存在或大小无法读取');
      if (!authorize()) throw fail(401, '登录已失效，请重新登录');
      return { handle, stat, file, name: path.posix.basename(file.relative_path), type: fileType(file.relative_path) };
    } catch (error) {
      if (handle) await handle.close();
      if (error.status) throw error;
      throw fail(404, '文件无法读取或已移动，请重新扫描');
    }
  }

  async function serve(req, res, id, authorize, inline) {
    const opened = await openIndexedFile(id, authorize);
    let { handle } = opened;
    const { stat, name, type } = opened;
    try {
      if (inline && !type?.preview) throw fail(415, '此格式暂不支持在线预览，请下载后打开');
      const encoded = encodeURIComponent(name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      const extension = path.posix.extname(name).toLowerCase();
      const headers = {
        'Content-Type': inline ? type.mime : 'application/octet-stream',
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="file${extension}"; filename*=UTF-8''${encoded}`,
        'Accept-Ranges': 'bytes',
      };
      // Without a strong validator, If-Range falls back to the full current file.
      const range = req.method === 'HEAD' || req.headers['if-range'] ? null : byteRange(req.headers.range, stat.size);
      if (range?.unsatisfiable) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
        res.end();
        return;
      }
      const length = range ? range.end - range.start + 1 : stat.size;
      if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': length });
      if (req.method === 'HEAD' || length === 0) { res.end(); return; }
      const stream = handle.createReadStream({ autoClose: true, ...(range ? { start: range.start, end: range.end } : { start: 0 }) });
      handle = null;
      await pipeline(stream, res);
    } catch (error) {
      if (error.status) throw error;
      if (!res.headersSent) throw fail(404, '文件无法读取或已移动，请重新扫描');
      if (!res.destroyed) res.destroy();
    } finally { if (handle) await handle.close(); }
  }

  async function text(id, authorize = () => true, encoding = 'auto') {
    if (!['auto', 'utf-8', 'gb18030', 'utf-16le'].includes(encoding)) throw fail(400, '不支持的文本编码');
    const { handle, type } = await openIndexedFile(id, authorize);
    try {
      if (type?.preview !== 'text') throw fail(415, '此格式不支持文本预览');
      const buffer = Buffer.alloc(TEXT_LIMIT + 4);
      let received = 0;
      while (received < buffer.length) {
        const { bytesRead } = await handle.read(buffer, received, buffer.length - received, received);
        if (!bytesRead) break;
        received += bytesRead;
      }
      if (!authorize()) throw fail(401, '登录已失效，请重新登录');
      const truncated = received > TEXT_LIMIT;
      const bytes = buffer.subarray(0, Math.min(received, TEXT_LIMIT));
      const decode = selected => new TextDecoder(selected, { fatal: true }).decode(bytes, { stream: truncated });
      let selected = encoding;
      let content;
      if (selected === 'auto') {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
          selected = 'utf-16le';
          try { content = decode(selected); } catch { throw fail(422, '文本编码无法识别，请选择编码后重试'); }
        } else {
          try { content = decode('utf-8'); selected = 'utf-8'; }
          catch {
            selected = 'gb18030';
            try { content = decode(selected); } catch { throw fail(422, '文本编码无法识别，请选择编码后重试'); }
          }
        }
      } else {
        try { content = decode(selected); } catch { throw fail(422, '文本与所选编码不匹配，请更换编码后重试'); }
      }
      return { text: content, encoding: selected, truncated };
    } finally { await handle.close(); }
  }

  const download = (req, res, id, authorize = () => true) => serve(req, res, id, authorize, false);
  const preview = (req, res, id, authorize = () => true) => serve(req, res, id, authorize, true);
  return { enabled, attach, scan, download, preview, text, status:()=>({...scanState,version:store.version()}), stop:()=>{stopped=true;}, openMetadata:id=>openIndexedFile(id,()=>!stopped), openFileSafe:(id,authorize)=>openIndexedFile(id,authorize) };
}
