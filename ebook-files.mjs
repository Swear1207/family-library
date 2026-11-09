import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileType } from './file-types.mjs';
import { serializeCatalog } from './catalog.mjs';

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

export function createFileLibrary(db, booksDir) {
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
    const index = new Map(db.prepare('SELECT * FROM ebook_files').all().map(file => [file.id, file]));
    return books.map(book => {
      const file = index.get(book.id);
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
          mtime: file.mtime,
        },
      };
    });
  }

  async function scan(authorize = () => true) {
    if (scanning) throw fail(409, '正在扫描，请稍后再试');
    scanning = true;
    try {
      const root = await rootPath();
      const found = [];
      let skipped = 0;
      let visited = 0;
      async function walk(directory, depth = 0) {
        if (depth > 40) throw fail(400, '目录层级超过 40 层，请缩小资料目录范围');
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (++visited > 100000) throw fail(400, '目录条目超过 100000，请缩小扫描范围');
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) { skipped++; continue; }
          const full = path.join(directory, entry.name);
          const stat = await fs.promises.lstat(full);
          if (stat.isSymbolicLink()) { skipped++; continue; }
          const resolved = await fs.promises.realpath(full);
          if (!inside(root, resolved)) { skipped++; continue; }
          if (stat.isDirectory()) { await walk(full, depth + 1); continue; }
          if (!stat.isFile() || !fileType(entry.name)) { skipped++; continue; }
          if (found.length >= 10000) throw fail(400, '资料超过 10000 项，请缩小扫描范围');
          const relative = path.relative(root, full).split(path.sep).join('/');
          found.push({
            id: 'file-' + createHash('sha256').update(relative).digest('hex'),
            relative, size: stat.size, mtime: Math.round(stat.mtimeMs),
          });
        }
      }
      try { await walk(root); }
      catch (error) {
        if (error.status) throw error;
        throw fail(503, '扫描中断：有目录或文件无法读取。请检查权限后重试，原资料库未改动。');
      }
      if (!authorize()) throw fail(401, '登录已失效，请重新登录');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT * FROM library WHERE id=1').get();
        if (!current) throw fail(401, '请先设置家庭账号');
        const books = JSON.parse(current.books);
        const existing = new Set(books.map(book => book.id));
        let added = 0;
        const newFiles = found.filter(file => !existing.has(file.id));
        if (books.length + newFiles.length > 10000) throw fail(400, '资料库最多保存 10000 项，请缩小目录范围或整理资料库');
        const previous = new Map(db.prepare('SELECT * FROM ebook_files').all().map(file => [file.id, file]));
        const presentIds = new Set(found.map(file => file.id));
        const changed = newFiles.length > 0 || found.some(file => {
          const old = previous.get(file.id);
          return !old || !old.available || old.size !== file.size || old.mtime !== file.mtime;
        }) || [...previous.values()].some(file => file.available && !presentIds.has(file.id));
        if (!changed) {
          const missing = books.filter(book => previous.get(book.id)?.available === 0).length;
          db.exec('COMMIT');
          return { added: 0, found: found.length, missing, skipped, version: current.version };
        }
        db.prepare('UPDATE ebook_files SET available=0').run();
        const upsert = db.prepare('INSERT INTO ebook_files (id,relative_path,size,mtime,available) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path,size=excluded.size,mtime=excluded.mtime,available=1');
        for (const file of found) {
          upsert.run(file.id, file.relative, file.size, file.mtime);
          if (existing.has(file.id)) continue;
          const extension = path.posix.extname(file.relative);
          books.push({
            id: file.id, title: path.posix.basename(file.relative, extension).slice(0, 300) || '未命名资料',
            author: '', category: '其他', status: '未读',
            location: (path.posix.dirname(file.relative) === '.' ? '资料目录' : path.posix.dirname(file.relative)).slice(0, 300),
            borrower: '', notes: '', created: Date.now(), color: '#456258', demo: false,
            resourceType: fileType(file.relative).resourceType,
          });
          added++;
        }
        const missing = books.filter(book => previous.has(book.id) && !presentIds.has(book.id)).length;
        const version = db.prepare('UPDATE library SET books=?,version=version+1 WHERE id=1 RETURNING version').get(serializeCatalog(books));
        db.exec('COMMIT');
        return { added, found: found.length, missing, skipped, version: version.version };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { scanning = false; }
  }

  async function openIndexedFile(id, authorize) {
    if (!authorize()) throw fail(401, '登录已失效，请重新登录');
    if (typeof id !== 'string' || !/^file-[a-f0-9]{64}$/.test(id)) throw fail(404, '文件不存在');
    const file = db.prepare('SELECT * FROM ebook_files WHERE id=? AND available=1').get(id);
    if (!file) throw fail(404, '文件不存在，请重新扫描资料目录');
    const root = await rootPath();
    const parts = file.relative_path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw fail(404, '文件路径无效');
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
  return { enabled, attach, scan, download, preview, text };
}
