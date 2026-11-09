import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, unlink, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibraryServer } from './server.mjs';

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
  await writeFile(path.join(booksDir, 'cover.jpg'), 'unsupported cover image');
  await writeFile(path.join(booksDir, 'README.md'), 'unsupported markdown');
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
    assert.ok(!library.books.some(book => book.id === fileId('cover.jpg')));
    assert.ok(!library.books.some(book => book.id === fileId('README.md')));
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
    for (const id of ['unknown-book', manualBook.id, '../../outside/private.epub', fileId('cover.jpg')]) {
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
