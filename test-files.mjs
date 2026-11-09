import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, symlink, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createLibraryServer } from './server.mjs';
import { createFileLibrary } from './ebook-files.mjs';
import { fileType, supportedExtensions } from './file-types.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = path.join(projectDir, '.test-data');
const trustedOrigin = 'http://nas-files.test';
const fileId = relative => 'file-' + createHash('sha256').update(relative.replaceAll('\\', '/')).digest('hex');

test('NAS ebook directory: authenticated scan, exact downloads and filesystem boundaries', async t => {
  await mkdir(temporaryRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(temporaryRoot, 'files-'));
  const dataDir = path.join(runDir, 'data');
  const booksDir = path.join(runDir, 'books');
  const outsideDir = path.join(runDir, 'outside');
  await mkdir(booksDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  const fixtures = [
    ['文学/小 王子.PDF', Buffer.from('%PDF-1.7\n家庭图书馆测试\n\u0000\u0001\u00ff', 'utf8')],
    ['文学/第二层/阅读 空间.epub', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 127, 128, 255])],
    ['Books/reader.mobi', Buffer.from('test mobi bytes\n')],
    ['Books/reader.azw', Buffer.from('test azw bytes\n')],
    ['Books/reader.azw3', Buffer.from('test azw3 bytes\n')],
    ['笔记/家庭 阅读.txt', Buffer.from('第一行：一起阅读。\n第二行：书在家里。\n', 'utf8')],
    ['漫画/comic.cbz', Buffer.from([0x50, 0x4b, 1, 2, 3, 255])],
    ['archive.djvu', Buffer.from('AT&TFORM-test-djvu\n')],
  ].map(([relative, bytes]) => ({ relative, bytes, id: fileId(relative) }));
  for (const fixture of fixtures) {
    const location = path.join(booksDir, ...fixture.relative.split('/'));
    await mkdir(path.dirname(location), { recursive: true });
    await writeFile(location, fixture.bytes);
  }
  await writeFile(path.join(booksDir, 'program.exe'), 'unsupported executable');
  await writeFile(path.join(booksDir, 'README.bin'), 'unsupported binary');
  const outsideBytes = Buffer.from('PRIVATE OUTSIDE CONTENT: must never be downloaded');
  const outsideFile = path.join(outsideDir, 'private.epub');
  await writeFile(outsideFile, outsideBytes);

  const manualBook = {
    id: 'manual-paper-book', title: '家里的纸质书', author: '家人', category: '文学小说',
    status: '在读', location: '客厅书架', borrower: '', notes: '纸质书也必须保留。',
    color: '#456258', demo: false, created: 1700000000000,
  };
  let instance;
  let baseUrl;
  let cookie;

  async function start() {
    instance = await createLibraryServer({ dataDir, booksDir, origin: trustedOrigin, host: '127.0.0.1', port: 0 });
    await new Promise((resolve, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(0, '127.0.0.1', () => {
        instance.server.off('error', reject);
        resolve();
      });
    });
    baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  }

  async function stop() {
    if (!instance) return;
    const current = instance;
    instance = undefined;
    await current.close();
  }

  async function request(route, options = {}) {
    const { method = 'GET', data, session = cookie, origin = trustedOrigin } = options;
    const headers = {};
    if (session) headers.Cookie = session;
    if (origin !== null) headers.Origin = origin;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${route}`, {
      method, headers, body: data !== undefined ? JSON.stringify(data) : undefined, redirect: 'manual',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { /* Downloads may be arbitrary bytes. */ }
    return { status: response.status, headers: response.headers, bytes, json };
  }

  async function expectStatus(route, options, expected) {
    const result = await request(route, options);
    assert.equal(result.status, expected, `${options?.method || 'GET'} ${route} status`);
    return result;
  }

  async function getBooks() {
    return (await expectStatus('/api/family/books', {}, 200)).json;
  }

  async function scan() {
    const result = await expectStatus('/api/family/scan', { method: 'POST', data: {} }, 200);
    for (const key of ['added', 'found', 'missing', 'skipped', 'version']) {
      assert.ok(Number.isSafeInteger(result.json[key]) && result.json[key] >= 0, `${key} is a nonnegative integer`);
    }
    return result.json;
  }

  function downloadRoute(id) {
    return `/api/family/download?id=${encodeURIComponent(id)}`;
  }

  t.after(async () => {
    await stop();
    // This test may create links to siblings, but only its own temporary root is removed.
    const root = path.resolve(temporaryRoot);
    const target = path.resolve(runDir);
    assert.equal(path.dirname(target), root, 'cleanup remains within .test-data');
    assert.ok(path.basename(target).startsWith('files-'), 'cleanup targets this run');
    await rm(target, { recursive: true, force: true });
  });

  await start();

  await t.test('requires login for scan and downloads', async () => {
    const state = await expectStatus('/api/family/session', { session: null }, 200);
    assert.equal(state.json.fileLibraryEnabled, true);
    await expectStatus('/api/family/scan', { method: 'POST', data: {}, session: null }, 401);
    await expectStatus(downloadRoute(fixtures[0].id), { session: null }, 401);
    const setupToken = (await readFile(path.join(dataDir, 'setup-token.txt'), 'utf8')).trim();
    const setup = await expectStatus('/api/family/setup', {
      method: 'POST', session: null,
      data: { username: 'files_family', password: 'Test-ebook-password-986!', setupToken },
    }, 200);
    const setCookie = setup.headers.get('set-cookie');
    assert.ok(setCookie, 'account setup returns a session cookie');
    cookie = setCookie.split(';')[0];
    await expectStatus('/api/family/scan', { method: 'POST', data: {}, origin: 'http://untrusted.example' }, 403);
    await expectStatus('/api/family/scan', { method: 'POST', data: {}, origin: null }, 403);
  });

  await t.test('recursively indexes supported formats with stable IDs and preserves manual entries', async () => {
    const initial = await getBooks();
    await expectStatus('/api/family/books', {
      method: 'PUT', data: { version: initial.version, books: [manualBook] },
    }, 200);
    const result = await scan();
    assert.equal(result.added, fixtures.length);
    assert.equal(result.found, fixtures.length);
    assert.equal(result.missing, 0);
    assert.ok(result.skipped >= 2, 'unsupported files are skipped');
    const library = await getBooks();
    assert.equal(library.books.length, fixtures.length + 1);
    assert.equal(library.version, result.version);
    assert.deepEqual(library.books.find(book => book.id === manualBook.id), manualBook);
    for (const fixture of fixtures) {
      const book = library.books.find(item => item.id === fixture.id);
      assert.ok(book, `stable identifier exists for ${fixture.relative}`);
      assert.ok(book.file, 'indexed book has a file attachment');
      assert.equal(book.file.name, path.posix.basename(fixture.relative));
      assert.equal(String(book.file.format).replace(/^\./, '').toLowerCase(), path.extname(fixture.relative).slice(1).toLowerCase());
      assert.equal(book.file.size, fixture.bytes.length);
      assert.equal(book.file.available, true);
      assert.ok(!JSON.stringify(book.file).includes(booksDir), 'attachment does not disclose absolute NAS directory');
    }
    assert.ok(!library.books.some(book => book.id === fileId('program.exe')));
    assert.ok(!library.books.some(book => book.id === fileId('README.bin')));
  });

  await t.test('downloads exact bytes and uses safe attachment filenames', async () => {
    for (const fixture of fixtures) {
      const download = await expectStatus(downloadRoute(fixture.id), {}, 200);
      assert.deepEqual(download.bytes, fixture.bytes, `download matches ${fixture.relative}`);
      const disposition = download.headers.get('content-disposition') || '';
      assert.match(disposition, /^attachment(?:;|$)/i);
      assert.doesNotMatch(disposition, /[\r\n]/);
      if (/[^\x20-\x7e]/.test(path.posix.basename(fixture.relative))) {
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        assert.ok(encoded, 'Unicode filenames have an RFC 5987 encoded parameter');
        assert.equal(decodeURIComponent(encoded[1]), path.posix.basename(fixture.relative));
      }
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const id of ['unknown-book', manualBook.id, '../../outside/private.epub', fileId('program.exe')]) {
      await expectStatus(downloadRoute(id), {}, 404);
    }
    await expectStatus('/api/family/download', {}, 404);
  });

  await t.test('metadata edits survive rescans without duplicate books or lost attachments', async () => {
    const library = await getBooks();
    const edited = library.books.map(({ file, ...book }) => book.id === fixtures[0].id ? {
      ...book, title: '全家一起读的小王子', author: '我们编辑的作者', status: '读完',
      location: '阅读收藏', borrower: '家人甲', notes: '这个笔记在扫描后必须保留。',
    } : book);
    await expectStatus('/api/family/books', {
      method: 'PUT', data: { version: library.version, books: edited },
    }, 200);
    const afterEdit = await getBooks();
    assert.equal(afterEdit.books.find(book => book.id === fixtures[0].id).file.available, true);
    const repeated = await scan();
    assert.equal(repeated.added, 0);
    assert.equal(repeated.found, fixtures.length);
    const refreshed = await getBooks();
    assert.equal(refreshed.books.length, fixtures.length + 1);
    assert.equal(new Set(refreshed.books.map(book => book.id)).size, refreshed.books.length);
    const updated = refreshed.books.find(book => book.id === fixtures[0].id);
    const expected = edited.find(book => book.id === fixtures[0].id);
    for (const key of ['title', 'author', 'status', 'location', 'borrower', 'notes', 'created']) {
      assert.equal(updated[key], expected[key], `${key} survives scanning`);
    }
    assert.deepEqual(refreshed.books.find(book => book.id === manualBook.id), manualBook);
  });

  await t.test('retains file associations and downloads after server restart', async () => {
    await stop();
    await start();
    const library = await getBooks();
    assert.equal(library.books.length, fixtures.length + 1);
    assert.equal(library.books.find(book => book.id === fixtures[0].id).title, '全家一起读的小王子');
    const download = await expectStatus(downloadRoute(fixtures[1].id), {}, 200);
    assert.deepEqual(download.bytes, fixtures[1].bytes);
  });

  await t.test('keeps missing file records and user notes but refuses downloads', async () => {
    await unlink(path.join(booksDir, ...fixtures[0].relative.split('/')));
    const result = await scan();
    assert.equal(result.added, 0);
    assert.equal(result.found, fixtures.length - 1);
    assert.equal(result.missing, 1);
    const library = await getBooks();
    const missing = library.books.find(book => book.id === fixtures[0].id);
    assert.ok(missing, 'missing files keep their book record');
    assert.equal(missing.file.available, false);
    assert.equal(missing.notes, '这个笔记在扫描后必须保留。');
    await expectStatus(downloadRoute(fixtures[0].id), {}, 404);
  });

  await t.test('rejects files replaced with symlinks outside the ebook directory', async subtest => {
    const fixture = fixtures[1];
    const location = path.join(booksDir, ...fixture.relative.split('/'));
    await unlink(location);
    let linked = false;
    try {
      await symlink(outsideFile, location, 'file');
      linked = true;
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN'].includes(error.code)) {
        subtest.skip(`File symlink creation is unavailable on this OS (${error.code}).`);
        return;
      }
      throw error;
    } finally {
      if (!linked) await writeFile(location, fixture.bytes);
    }
    try {
      const download = await expectStatus(downloadRoute(fixture.id), {}, 404);
      assert.ok(!download.bytes.equals(outsideBytes), 'outside bytes are never returned');
      await scan();
      const library = await getBooks();
      assert.equal(library.books.find(book => book.id === fixture.id).file.available, false);
    } finally {
      await unlink(location);
      await writeFile(location, fixture.bytes);
    }
  });

  await t.test('ignores linked directories outside the ebook tree', async subtest => {
    const linkedDir = path.join(booksDir, 'external-dir');
    try {
      await symlink(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN'].includes(error.code)) {
        subtest.skip(`Directory symlink creation is unavailable on this OS (${error.code}).`);
        return;
      }
      throw error;
    }
    const result = await scan();
    assert.equal(result.added, 0);
    const library = await getBooks();
    assert.equal(library.books.length, fixtures.length + 1);
    assert.ok(!library.books.some(book => book.id === fileId('external-dir/private.epub')));
    await expectStatus(downloadRoute(fileId('external-dir/private.epub')), {}, 404);
  });
});

test('unified files: format capabilities, safe streaming and bounded text decoding', async t => {
  await mkdir(temporaryRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(temporaryRoot, 'resources-'));
  const booksDir = path.join(runDir, 'books');
  const outsideDir = path.join(runDir, 'outside');
  await mkdir(booksDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE library (id INTEGER PRIMARY KEY, books TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO library VALUES (1, '[]', 0);
    CREATE TABLE ebook_files (id TEXT PRIMARY KEY, relative_path TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1);`);
  const files = createFileLibrary(db, booksDir);
  const entries = new Map();
  async function fixture(relative, bytes) {
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const filename = path.join(booksDir, ...relative.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    entries.set(relative, bytes);
    return fileId(relative);
  }
  for (const extension of supportedExtensions) await fixture(`分类/示例${extension}`, `fixture-${extension}-中文`);
  await fixture('编码/UTF8.txt', '第一行\n中文与 emoji 🌱');
  await fixture('编码/GB18030.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  await fixture('编码/UTF16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文文本', 'utf16le')]));
  const textLimit = 2 * 1024 * 1024;
  await fixture('编码/large.txt', Buffer.concat([Buffer.alloc(textLimit - 1, 65), Buffer.from('中尾部')]));
  await fixture('empty.txt', Buffer.alloc(0));
  await fixture('linked-parent/escape.txt', 'allowed original contents');
  await fixture('目录/active.html', '<script>document.body.textContent="unsafe"</script>');
  await fixture('目录/active.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  await writeFile(path.join(booksDir, '.hidden.pdf'), 'hidden');
  await writeFile(path.join(booksDir, 'program.exe'), 'executable');
  await writeFile(path.join(outsideDir, 'escape.txt'), 'PRIVATE OUTSIDE CONTENT');
  await files.scan();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const authorize = () => req.headers['x-test-session'] === 'family';
    try {
      if (url.pathname === '/content') return await files.preview(req, res, id, authorize);
      if (url.pathname === '/download') return await files.download(req, res, id, authorize);
      if (url.pathname === '/text') {
        const result = await files.text(id, authorize, url.searchParams.get('encoding') || 'auto');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(action, relative, { method = 'GET', headers = {}, authenticated = true, encoding } = {}) {
    const id = relative.startsWith('file-') ? relative : fileId(relative);
    const query = new URLSearchParams({ id });
    if (encoding) query.set('encoding', encoding);
    const response = await fetch(`${base}/${action}?${query}`, {
      method, headers: { ...(authenticated ? { 'X-Test-Session': 'family' } : {}), ...headers },
    });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    assert.equal(path.dirname(path.resolve(runDir)), path.resolve(temporaryRoot));
    assert.ok(path.basename(runDir).startsWith('resources-'));
    await rm(runDir, { recursive: true, force: true });
  });

  await t.test('indexes every permitted extension and attaches authoritative capabilities', async () => {
    const stored = db.prepare('SELECT data FROM catalog_items').all().map(row=>JSON.parse(row.data));
    assert.equal(stored.length, entries.size);
    for (const extension of supportedExtensions) {
      const id = fileId(`分类/示例${extension}`);
      const original = stored.find(book => book.id === id);
      assert.equal(original.resourceType, fileType(extension === '.pdf' ? 'file.pdf' : `file${extension}`).resourceType);
      const attached = files.attach([{ ...original, file: { name: 'forged', folder: outsideDir, preview: 'image' } }])[0];
      assert.equal(attached.file.name, `示例${extension}`);
      assert.equal(attached.file.folder, '分类');
      assert.equal(attached.file.preview, fileType(`file${extension}`).preview);
      assert.ok(Number.isInteger(attached.file.mtime));
      assert.equal(attached.file.size, entries.get(`分类/示例${extension}`).length);
    }
    assert.equal(files.attach([{ id: 'manual', title: 'paper' }])[0].resourceType, undefined);
    const pdf = stored.find(book => book.id === fileId('分类/示例.pdf'));
    assert.equal(files.attach([{ ...pdf, resourceType: '期刊论文' }])[0].resourceType, '期刊论文');
    const repeated = await files.scan();
    assert.equal(repeated.added, 0);
    assert.equal(repeated.version, db.prepare('SELECT version FROM library WHERE id=1').get().version);
  });

  await t.test('protects GET, HEAD and text requests before returning bytes', async () => {
    for (const action of ['content', 'download', 'text']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(action, '编码/UTF8.txt', { method, authenticated: false });
        assert.equal(response.status, 401);
        assert.ok(!response.bytes.includes(Buffer.from('第一行')));
      }
    }
    await assert.rejects(files.text(fileId('编码/UTF8.txt'), () => false), { status: 401 });
  });

  await t.test('streams content types safely and always preserves attachment downloads', async () => {
    for (const [relative, mime] of [
      ['分类/示例.pdf', 'application/pdf'], ['分类/示例.epub', 'application/epub+zip'],
      ['分类/示例.png', 'image/png'], ['分类/示例.mp3', 'audio/mpeg'], ['分类/示例.mp4', 'video/mp4'],
      ['目录/active.html', 'text/plain; charset=utf-8'], ['目录/active.svg', 'text/plain; charset=utf-8'],
    ]) {
      const content = await request('content', relative);
      assert.equal(content.status, 200);
      assert.equal(content.headers.get('content-type'), mime);
      assert.match(content.headers.get('content-disposition'), /^inline;/);
      assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(content.bytes, entries.get(relative));
      const download = await request('download', relative);
      assert.match(download.headers.get('content-disposition'), /^attachment;/);
      assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    }
    for (const relative of ['分类/示例.docx', '分类/示例.heic', '分类/示例.tiff', '分类/示例.caj']) {
      assert.equal((await request('content', relative)).status, 415);
      assert.equal((await request('download', relative)).status, 200);
    }
  });

  await t.test('honors bounded, open and suffix ranges with correct lengths', async () => {
    const relative = '分类/示例.pdf';
    const bytes = entries.get(relative);
    for (const [range, start, end] of [
      ['bytes=0-3', 0, 3], ['bytes=4-', 4, bytes.length - 1],
      ['bytes=-4', bytes.length - 4, bytes.length - 1],
      ['bytes=1-99999', 1, bytes.length - 1], ['bytes=-99999', 0, bytes.length - 1],
    ]) {
      for (const action of ['content', 'download']) {
        const response = await request(action, relative, { headers: { Range: range } });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
        assert.equal(Number(response.headers.get('content-length')), end - start + 1);
        assert.deepEqual(response.bytes, bytes.subarray(start, end + 1));
      }
    }
    for (const range of [`bytes=${bytes.length}-`, 'bytes=4-3', 'bytes=-0']) {
      const response = await request('content', relative, { headers: { Range: range } });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
      assert.equal(response.bytes.length, 0);
    }
    for (const range of ['bytes=0-1,3-4', 'items=1-2', 'bytes=not-a-range', 'bytes=9999999999999999999999-']) {
      const response = await request('content', relative, { headers: { Range: range } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.bytes, bytes);
    }
    const stale = await request('content', relative, { headers: { Range: 'bytes=0-1', 'If-Range': '"old-version"' } });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.bytes, bytes);
    const head = await request('content', relative, { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal(head.bytes.length, 0);
    assert.equal((await request('content', 'empty.txt')).bytes.length, 0);
    const emptyRange = await request('content', 'empty.txt', { headers: { Range: 'bytes=0-' } });
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.headers.get('content-range'), 'bytes */0');
  });

  await t.test('decodes UTF8, GB18030, UTF16 and truncates without breaking UTF8 characters', async () => {
    const utf8 = await files.text(fileId('编码/UTF8.txt'));
    assert.equal(utf8.text, '第一行\n中文与 emoji 🌱');
    assert.equal(utf8.encoding, 'utf-8');
    assert.equal(utf8.truncated, false);
    const gb = await files.text(fileId('编码/GB18030.txt'));
    assert.deepEqual(gb, { text: '中文', encoding: 'gb18030', truncated: false });
    assert.deepEqual(await files.text(fileId('编码/UTF16.txt')), { text: '中文文本', encoding: 'utf-16le', truncated: false });
    const large = await files.text(fileId('编码/large.txt'));
    assert.equal(large.encoding, 'utf-8');
    assert.equal(large.truncated, true);
    assert.equal(large.text.length, textLimit - 1);
    assert.ok(!large.text.includes('\ufffd'));
    assert.deepEqual(await files.text(fileId('empty.txt')), { text: '', encoding: 'utf-8', truncated: false });
    await assert.rejects(files.text(fileId('编码/GB18030.txt'), () => true, 'utf-8'), { status: 422 });
    await assert.rejects(files.text(fileId('编码/UTF8.txt'), () => true, 'utf-7'), { status: 400 });
    await assert.rejects(files.text(fileId('分类/示例.pdf')), { status: 415 });
    assert.equal((await files.text(fileId('目录/active.html'))).text, entries.get('目录/active.html').toString());
  });

  await t.test('uses the current opened file size and refuses missing files', async () => {
    const relative = '分类/示例.pdf';
    const updated = Buffer.from('%PDF changed after scan; current bytes only.');
    await writeFile(path.join(booksDir, ...relative.split('/')), updated);
    const response = await request('content', relative, { headers: { Range: 'bytes=-5' } });
    assert.equal(response.headers.get('content-range'), `bytes ${updated.length - 5}-${updated.length - 1}/${updated.length}`);
    assert.deepEqual(response.bytes, updated.subarray(-5));
    await unlink(path.join(booksDir, ...relative.split('/')));
    assert.equal((await request('content', relative)).status, 404);
    assert.equal((await request('download', relative)).status, 404);
    await assert.rejects(files.text(fileId('../outside/escape.txt')), { status: 404 });
  });

  await t.test('refuses all readers when an indexed parent becomes an outside symlink', async subtest => {
    const original = path.resolve(booksDir, 'linked-parent');
    const saved = path.resolve(booksDir, 'saved-parent');
    assert.equal(path.dirname(original), path.resolve(booksDir));
    assert.equal(path.dirname(saved), path.resolve(booksDir));
    await rename(original, saved);
    let linked = false;
    try {
      try {
        await symlink(outsideDir, original, process.platform === 'win32' ? 'junction' : 'dir');
        linked = true;
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN'].includes(error.code)) {
          subtest.skip(`Directory symlink is unavailable (${error.code}).`);
          return;
        }
        throw error;
      }
      for (const action of ['content', 'download', 'text']) {
        const response = await request(action, 'linked-parent/escape.txt');
        assert.equal(response.status, 404);
        assert.ok(!response.bytes.includes(Buffer.from('PRIVATE OUTSIDE CONTENT')));
      }
    } finally {
      if (linked) await unlink(original);
      await rename(saved, original);
    }
  });
});
