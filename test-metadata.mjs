import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import JSZip from 'jszip';
import { extractMetadata } from './metadata-extractor.mjs';

const temporaryRoot = fileURLToPath(new URL('./.test-data/', import.meta.url));
async function fixture(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const dir = await mkdtemp(path.join(temporaryRoot, 'metadata-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return async (name, bytes) => { const filename = path.join(dir, name); await writeFile(filename, bytes); return filename; };
}
function pdfString(value) {
  const bytes = Buffer.from(value, 'utf16le'); bytes.swap16();
  return '<FEFF' + bytes.toString('hex') + '>';
}
function syntheticPdf({ info = {}, xmp = '', pages = [''], padding = 0 } = {}) {
  const objects = [null, '', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const refs = [];
  for (const words of pages) {
    const pageId = objects.length, streamId = pageId + 1;
    const content = 'BT /F1 12 Tf 30 700 Td (' + words.replace(/[\\()]/g, '\\$&') + ') Tj ET';
    refs.push(pageId + ' 0 R');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  const infoId = objects.length;
  objects.push('<< ' + Object.entries(info).map(([name, value]) => '/' + name + ' ' + pdfString(value)).join(' ') + ' >>');
  let metadataRef = '';
  if (xmp) {
    metadataRef = '/Metadata ' + objects.length + ' 0 R';
    objects.push(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>\nstream\n${xmp}\nendstream`);
  }
  if (padding) objects.push(`<< /Length ${padding} >>\nstream\n${'x'.repeat(padding)}\nendstream`);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R ${metadataRef} >>`;
  objects[2] = `<< /Type /Pages /Kids [${refs.join(' ')}] /Count ${refs.length} >>`;
  const parts = [Buffer.from('%PDF-1.7\n')], offsets = [0]; let offset = parts[0].length;
  for (let id = 1; id < objects.length; id++) {
    offsets.push(offset);
    const object = Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`); parts.push(object); offset += object.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const container = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const packageXml = metadata => '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="3.0"><metadata>' + metadata + '</metadata><manifest/><spine/></package>';
async function syntheticEpub(metadata, extra = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip'); zip.file('META-INF/container.xml', container);
  zip.file('OPS/book.opf', packageXml(metadata));
  for (const [name, value] of Object.entries(extra)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('PDF extracts actual Info fields and explicitly labelled DOI, never infers authors or year from page/date', async t => {
  const save = await fixture(t);
  const filename = await save('文献.pdf', syntheticPdf({ info: { Title: '家庭数据研究', Author: '张三; 李四', CreationDate: 'D:20240102000000Z', ModDate: 'D:20250101000000Z' }, pages: ['doi: 10.1234/family.2021.001'] }));
  assert.deepEqual(await extractMetadata(filename), { title: '家庭数据研究', author: '张三; 李四', doi: '10.1234/family.2021.001' });
  const unlabelled = await save('plain.pdf', syntheticPdf({ pages: ['Jane Doe 2024 10.1234/unmarked'] }));
  assert.deepEqual(await extractMetadata(unlabelled), {});
});

test('PDF XMP provides title, creators, publication source/year, DOI and description', async t => {
  const save = await fixture(t);
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">' +
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Embedded XMP Title</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>Alice</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>' +
    '<prism:publicationName>Journal of Test Fixtures</prism:publicationName><prism:publicationDate>2022-04-15</prism:publicationDate><prism:doi>10.1234/test.xmp</prism:doi>' +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">A trustworthy embedded description.</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>';
  const filename = await save('xmp.pdf', syntheticPdf({ xmp, info: { Title: 'Fallback title' } }));
  assert.deepEqual(await extractMetadata(filename), { title: 'Embedded XMP Title', author: 'Alice; Bob', source: 'Journal of Test Fixtures', abstract: 'A trustworthy embedded description.', year: '2022', doi: '10.1234/test.xmp' });
});

test('PDF DOI extraction is limited to the requested first pages and rejects ambiguous page identifiers', async t => {
  const save = await fixture(t);
  const filename = await save('pages.pdf', syntheticPdf({ pages: ['Preface', 'DOI: 10.1234/second', 'End'] }));
  assert.deepEqual(await extractMetadata(filename, { maxPdfPages: 1 }), {});
  assert.equal((await extractMetadata(filename)).doi, '10.1234/second');
  const ambiguous = await save('ambiguous.pdf', syntheticPdf({ pages: ['DOI: 10.1234/one DOI: 10.1234/two'] }));
  assert.deepEqual(await extractMetadata(ambiguous), {});
  const mixed = await save('mixed.pdf', syntheticPdf({ pages: ['DOI: 10.1234/one DOI: 10.1234/two', 'DOI: 10.1234/three'] }));
  assert.deepEqual(await extractMetadata(mixed), {});
});

test('PDF uses bounded fd ranges without reading the whole file or closing/moving caller handle', async t => {
  const save = await fixture(t);
  const filename = await save('large.pdf', syntheticPdf({ info: { Title: 'Large file, small metadata' }, padding: 8 * 1024 * 1024 }));
  const handle = await open(filename, 'r');
  try {
    const { size } = await handle.stat();
    assert.deepEqual(await extractMetadata(null, { fd: handle.fd, size, format: 'PDF', maxPdfPages: 0, maxPdfReadBytes: 256 * 1024 }), { title: 'Large file, small metadata' });
    const bytes = Buffer.alloc(4); await handle.read(bytes, 0, 4, null);
    assert.equal(bytes.toString(), '%PDF');
    assert.deepEqual(await extractMetadata(null, { fd: handle.fd, size: size + 1, format: 'pdf' }), {});
    assert.deepEqual(await extractMetadata(null, { fd: handle.fd, size, format: 'pdf', maxPdfReadBytes: 32 }), {});
  } finally { await handle.close(); }
});

test('EPUB extracts dc metadata, preserves Chinese, ignores editors and modification dates, strips description HTML', async t => {
  const save = await fixture(t);
  const metadata = '<dc:title>家庭阅读集</dc:title><dc:creator opf:role="aut">张三</dc:creator><dc:creator id="author2">李四</dc:creator><meta refines="#author2" property="role">aut</meta>' +
    '<dc:creator opf:role="edt">编者</dc:creator><dc:creator id="editor2">Another Editor</dc:creator><meta refines="#editor2" property="role">edt</meta>' +
    '<dc:date opf:event="modification">2025-01-01</dc:date><dc:date>2021-03-15</dc:date><dc:publisher>家庭出版社</dc:publisher><dc:identifier>isbn:9780000000000</dc:identifier><dc:identifier>https://doi.org/10.1234/epub.1</dc:identifier>' +
    '<dc:description>' + xmlEscape('<p>有据可查的摘要。</p><script>doNotExecute()</script>') + '</dc:description>';
  const filename = await save('book.epub', await syntheticEpub(metadata));
  assert.deepEqual(await extractMetadata(filename), { title: '家庭阅读集', author: '张三; 李四', source: '家庭出版社', abstract: '有据可查的摘要。', year: '2021', doi: '10.1234/epub.1' });
  const sparse = await save('sparse.epub', await syntheticEpub('<dc:title>No invented fields</dc:title><dc:date opf:event="creation">1999-01-01</dc:date><dc:identifier>urn:uuid:111</dc:identifier>'));
  assert.deepEqual(await extractMetadata(sparse), { title: 'No invented fields' });
});

test('EPUB refuses XML entities, unsafe archive paths and malformed ZIP directories', async t => {
  const save = await fixture(t);
  const normal = await syntheticEpub('<dc:title>Valid</dc:title>');
  const invalids = [
    await syntheticEpub('<dc:title>Ignored</dc:title>', { 'OPS/book.opf': '<!DOCTYPE package [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + packageXml('<dc:title>&secret;</dc:title>') }),
    await syntheticEpub('<dc:title>Ignored</dc:title>', { '../outside.xml': '<private/>' }),
    await syntheticEpub('<dc:title>Ignored</dc:title>', { 'META-INF/container.xml': container.replace('OPS/book.opf', 'https://example.invalid/book.opf') }),
    await syntheticEpub('<dc:title>Ignored</dc:title>', { 'OPS/book.opf': packageXml('<dc:title>broken</dc:creator>') }),
  ];
  for (const patch of [b => b.writeUInt16LE(1, b.length - 18), b => b.writeUInt16LE(2001, b.length - 12), b => b.writeUInt32LE(0xffffffff, b.length - 6)]) {
    const bytes = Buffer.from(normal); patch(bytes); invalids.push(bytes);
  }
  for (let index = 0; index < invalids.length; index++) assert.deepEqual(await extractMetadata(await save('invalid-' + index + '.epub', invalids[index])), {});
});

test('EPUB metadata decompression is bounded while large unrelated resources are never inflated', async t => {
  const save = await fixture(t);
  const oversized = await save('bomb.epub', await syntheticEpub('<dc:title>' + 'a'.repeat(2 * 1024 * 1024) + '</dc:title>'));
  assert.deepEqual(await extractMetadata(oversized), {});
  const resource = await save('resource.epub', await syntheticEpub('<dc:title>Only metadata</dc:title>', { 'OPS/unused.txt': 'x'.repeat(4 * 1024 * 1024) }));
  assert.deepEqual(await extractMetadata(resource, { maxOpfBytes: 2048 }), { title: 'Only metadata' });
  assert.deepEqual(await extractMetadata(resource, { maxOpfBytes: 64 }), {});
  assert.deepEqual(await extractMetadata(resource, { maxEpubBytes: 32 }), {});
});

test('metadata output respects catalog field lengths and safe skip behavior', async t => {
  const save = await fixture(t);
  const filename = await save('long.epub', await syntheticEpub('<dc:title>' + '书'.repeat(400) + '</dc:title><dc:creator>' + '名'.repeat(300) + '</dc:creator><dc:publisher>' + '社'.repeat(200) + '</dc:publisher><dc:description>' + '文'.repeat(9000) + '</dc:description>'));
  const result = await extractMetadata(filename);
  assert.equal(result.title.length, 300); assert.equal(result.author.length, 200); assert.equal(result.source.length, 160); assert.equal(result.abstract.length, 8000);
  assert.deepEqual(await extractMetadata(filename, { format: 'docx' }), {});
  assert.deepEqual(await extractMetadata(filename, { rootDir: path.join(path.dirname(filename), 'other') }), {});
  assert.deepEqual(await extractMetadata(await save('invalid.pdf', 'not a PDF')), {});
  assert.deepEqual(await extractMetadata(filename + '.missing'), {});
  assert.deepEqual(await extractMetadata(null, { fd: -1, format: 'pdf' }), {});
});

test('worker can use a parent-owned descriptor without reopening its original path', async t => {
  const save = await fixture(t);
  for (const [format, bytes] of [['epub', await syntheticEpub('<dc:title>Worker descriptor</dc:title>')], ['pdf', syntheticPdf({ info: { Title: 'Worker descriptor' } })]]) {
    const filename = await save('worker.' + format, bytes);
    const handle = await open(filename, 'r');
    try {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); import(workerData.module).then(async ({extractMetadata})=>parentPort.postMessage(await extractMetadata(null,workerData.options)));`, {
        eval: true, workerData: { module: new URL('./metadata-extractor.mjs', import.meta.url).href, options: { fd: handle.fd, size: (await handle.stat()).size, format } },
      });
      t.after(() => worker.terminate());
      assert.deepEqual(await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }), { title: 'Worker descriptor' });
      await new Promise(resolve => worker.once('exit', resolve));
      assert.ok((await handle.stat()).size > 0);
    } finally { await handle.close(); }
  }
});
