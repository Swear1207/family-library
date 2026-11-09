import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { createLibraryServer } from './server.mjs';

const temporaryRoot = fileURLToPath(new URL('./.test-data/', import.meta.url));
const origin = 'http://background.test';
const fileId = name => 'file-' + createHash('sha256').update(name).digest('hex');
function pdfString(value) {
  const bytes = Buffer.from(value, 'utf16le'); bytes.swap16();
  return '<FEFF' + bytes.toString('hex') + '>';
}
function pdf() {
  const text = 'BT /F1 12 Tf 20 700 Td (DOI: 10.1234/background.pdf) Tj ET';
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    `<< /Title ${pdfString('后台提取的论文')} /Author ${pdfString('PDF 作者')} /CreationDate (D:20240102000000Z) >>`];
  const parts = [Buffer.from('%PDF-1.7\n')], offsets = [0]; let offset = parts[0].length;
  for (let index = 1; index < objects.length; index++) {
    offsets.push(offset);
    const part = Buffer.from(`${index} 0 obj\n${objects[index]}\nendobj\n`); parts.push(part); offset += part.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}
async function epub({ title = '后台提取的电子书', author = 'EPUB 作者', publisher = '家庭出版社', suffix = '' } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata>' +
    `<dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:date>2020-05-15</dc:date><dc:publisher>${publisher}</dc:publisher><dc:identifier>10.1234/background.epub</dc:identifier><dc:description>一份准确的文件内摘要。${suffix}</dc:description>` +
    '</metadata><manifest/><spine/></package>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('background scan and metadata: gradual enrichment, edit protection and durable restart', { timeout: 35000 }, async t => {
  await mkdir(temporaryRoot, { recursive: true });
  const temp = await mkdtemp(path.join(temporaryRoot, 'background-'));
  const booksDir = path.join(temp, 'books'), dataDir = path.join(temp, 'data');
  await mkdir(booksDir);
  const pdfName = 'document.pdf', epubName = 'book.epub';
  // The corrupt file precedes valid documents in the durable queue order.
  let damagedName = 'damaged-0.pdf';
  for (let index = 1; fileId(damagedName) > [fileId(pdfName), fileId(epubName)].sort()[0]; index++) damagedName = `damaged-${index}.pdf`;
  await writeFile(path.join(booksDir, pdfName), pdf());
  await writeFile(path.join(booksDir, epubName), await epub());
  await writeFile(path.join(booksDir, damagedName), 'Broken PDF still remains downloadable');
  let app, base, cookie;
  async function start() {
    app = createLibraryServer({ dataDir, booksDir, origin, metadataEnabled: true, metadataDelayMs: 5, metadataTimeoutMs: 5000 });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() { if (app) { const previous = app; app = null; await previous.close(); } }
  async function request(action, { method = 'GET', data, auth = true, headers = {} } = {}) {
    const h = { Origin: origin, ...headers };
    if (auth && cookie) h.Cookie = cookie;
    if (data !== undefined) h['Content-Type'] = 'application/json';
    const response = await fetch(base + '/api/family/' + action, { method, headers: h, body: data === undefined ? undefined : JSON.stringify(data) });
    const raw = await response.text(); let json;
    try { json = JSON.parse(raw); } catch {}
    return { status: response.status, headers: response.headers, raw, json };
  }
  async function waitFor(check, message, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await check(); if (result) return result; await delay(15); }
    assert.fail(message);
  }
  const document = async id => { const response = await request('document?id=' + id); assert.equal(response.status, 200); return response.json; };
  const scanStatus = async () => { const response = await request('scan'); assert.equal(response.status, 200); return response.json; };
  async function scan() {
    const response = await request('scan', { method: 'POST', data: { background: true } });
    assert.equal(response.status, 202);
    assert.equal(response.json.running, true);
    return waitFor(async () => { const status = await scanStatus(); return !status.running && status.finished && status; }, 'background directory scan did not finish');
  }
  async function edit(id, change) {
    const current = await document(id);
    const result = await request('document', { method: 'PUT', data: { book: { ...current.book, ...change }, version: current.version, recordVersion: current.recordVersion } });
    assert.equal(result.status, 200, result.raw);
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(temporaryRoot));
    assert.ok(path.basename(temp).startsWith('background-'));
    await rm(temp, { recursive: true, force: true });
  });
  await start();
  const setupToken = (await readFile(path.join(dataDir, 'setup-token.txt'), 'utf8')).trim();
  const setup = await request('setup', { method: 'POST', data: { username: 'background_family', password: 'Background-test-password-294!', setupToken } });
  assert.equal(setup.status, 200); cookie = setup.headers.get('set-cookie').split(';')[0];

  await t.test('requires authentication for both scan submission and progress', async () => {
    assert.equal((await request('scan', { auth: false })).status, 401);
    assert.equal((await request('scan', { method: 'POST', auth: false, data: { background: true } })).status, 401);
  });

  await t.test('returns 202, exposes gradual progress, and continues after a damaged document', async () => {
    const indexed = await scan();
    assert.equal(indexed.found, 3); assert.equal(indexed.added, 3); assert.equal(indexed.error, null);
    assert.equal(indexed.metadata.total, 3); assert.equal(indexed.metadata.enabled, true);
    assert.ok(indexed.metadata.pending + indexed.metadata.running > 0, 'directory indexing finishes independently of metadata');
    let sawPartial = false;
    const complete = await waitFor(async () => {
      const state = await scanStatus(), counts = state.metadata;
      if (counts.done + counts.empty + counts.failed > 0 && counts.pending + counts.running > 0) sawPartial = true;
      return !counts.pending && !counts.running && state;
    }, 'metadata did not finish');
    assert.equal(sawPartial, true, 'progress exposes completion before the entire queue is finished');
    assert.equal(complete.metadata.done, 2);
    assert.equal(complete.metadata.empty + complete.metadata.failed, 1);
    const paper = (await document(fileId(pdfName))).book;
    assert.equal(paper.title, '后台提取的论文'); assert.equal(paper.author, 'PDF 作者'); assert.equal(paper.doi, '10.1234/background.pdf'); assert.equal(paper.year, '');
    assert.equal(paper.resourceType, '资料文档', 'metadata does not guess that a PDF is a journal article');
    assert.equal(paper.file.metadataStatus, 'done');
    const book = (await document(fileId(epubName))).book;
    assert.equal(book.title, '后台提取的电子书'); assert.equal(book.author, 'EPUB 作者'); assert.equal(book.year, '2020'); assert.equal(book.source, '家庭出版社');
    assert.equal(book.abstract, '一份准确的文件内摘要。');
    const corrupted = (await document(fileId(damagedName))).book;
    assert.equal(corrupted.file.available, true); assert.ok(['empty', 'failed'].includes(corrupted.file.metadataStatus));
    const download = await request('download?id=' + fileId(damagedName));
    assert.equal(download.status, 200); assert.equal(download.raw, 'Broken PDF still remains downloadable');
    const range = await request('content?id=' + paper.id, { headers: { Range: 'bytes=0-7' } });
    assert.equal(range.status, 206); assert.equal(range.raw, '%PDF-1.7');
  });

  await t.test('a new worker preserves manually supplied author and intentionally cleared metadata', async () => {
    const id = fileId(epubName);
    await edit(id, { author: '家人手动确认的作者', source: '' });
    const updatedBefore = app.db.prepare('SELECT updated FROM metadata_jobs WHERE id=?').get(id).updated;
    await writeFile(path.join(booksDir, epubName), await epub({ author: '新文件内的作者不能覆盖手动值', publisher: '新文件内的出版社', suffix: '原文件更新，触发新的提取任务。' }));
    const queued = await scan();
    assert.ok(queued.metadata.pending + queued.metadata.running > 0);
    await waitFor(async () => {
      const state = await scanStatus();
      const row = app.db.prepare('SELECT status,updated FROM metadata_jobs WHERE id=?').get(id);
      return state.metadata.pending === 0 && state.metadata.running === 0 && row.status === 'done' && row.updated > updatedBefore;
    }, 'modified EPUB was not re-extracted');
    const saved = (await document(id)).book;
    assert.equal(saved.author, '家人手动确认的作者');
    assert.equal(saved.source, '', 'manual clearing is a durable instruction to keep the field empty');
    assert.equal(saved.year, '2020');
  });

  await t.test('unfinished jobs survive an in-flight shutdown and resume after restart', async () => {
    const names = Array.from({ length: 5 }, (_, index) => `restart-${index}.epub`);
    for (const [index, name] of names.entries()) await writeFile(path.join(booksDir, name), await epub({ title: `恢复后的书籍 ${index}`, author: `恢复作者 ${index}` }));
    const indexed = await scan(); assert.equal(indexed.found, 8);
    await waitFor(async () => { const state = await scanStatus(); return state.metadata.running === 1 && state.metadata.pending >= 1; }, 'no in-flight job observed before restart');
    const unfinished = app.db.prepare("SELECT id FROM metadata_jobs WHERE status IN ('pending','running')").all().map(row => row.id);
    assert.ok(unfinished.length >= 2);
    await stop(); await start();
    assert.equal((await request('session')).json.authenticated, true, 'restart keeps the family login');
    const stateAfterRestart = await scanStatus();
    assert.ok(stateAfterRestart.metadata.pending > 0);
    await waitFor(async () => { const state = await scanStatus(); return state.metadata.pending === 0 && state.metadata.running === 0 && state; }, 'persistent jobs did not resume after restart');
    for (const [index, name] of names.entries()) {
      const book = (await document(fileId(name))).book;
      assert.equal(book.title, `恢复后的书籍 ${index}`); assert.equal(book.author, `恢复作者 ${index}`); assert.equal(book.file.metadataStatus, 'done');
    }
    assert.equal((await document(fileId(epubName))).book.source, '');
    assert.equal((await document(fileId(epubName))).book.author, '家人手动确认的作者');
    assert.equal((await request('content?id=' + fileId(pdfName), { method: 'HEAD' })).status, 200);
    assert.equal((await request('scan', { auth: false })).status, 401);
  });
});
