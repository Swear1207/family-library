import { constants, fstat as statFd, read as readFd } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

const fstat = promisify(statFd), read = promisify(readFd);
const MiB = 1024 * 1024;
const HARD_LIMITS = Object.freeze({ maxPdfBytes: 512 * MiB, maxEpubBytes: 64 * MiB,
  maxPdfReadBytes: 64 * MiB, maxPdfPages: 3, maxOpfBytes: 2 * MiB, maxContainerBytes: 64 * 1024 });
const DC = 'http://purl.org/dc/elements/1.1/';
const OPF = 'http://www.idpf.org/2007/opf';
const CONTAINER = 'urn:oasis:names:tc:opendocument:xmlns:container';
let pdfModule;

function limit(options, name) {
  const value = options[name];
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, HARD_LIMITS[name]) : HARD_LIMITS[name];
}
function text(value, max) {
  if (Array.isArray(value)) value = [...new Set(value.filter(v => typeof v === 'string'))].join('; ');
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function publicationYear(value) {
  if (Array.isArray(value)) value = value.find(v => publicationYear(v));
  if (typeof value !== 'string') return '';
  return /^([12]\d{3})(?:$|-(?:0[1-9]|1[0-2])(?:$|-(?:0[1-9]|[12]\d|3[01])(?:$|[T\s])))/.exec(value.trim())?.[1] || '';
}
function doiCandidates(value, marked = false) {
  if (typeof value !== 'string') return [];
  const prefix = marked ? /(?:\bdoi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s<>"\u0000-\u001f]+)/ig : /^(?:(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/))?(10\.\d{4,9}\/[^\s<>"\u0000-\u001f]+)$/i;
  const matches = marked ? [...value.matchAll(prefix)].map(match => match[1]) : [prefix.exec(value.trim())?.[1]].filter(Boolean);
  const candidates = new Set(matches.map(candidate => {
    candidate = candidate.replace(/[.,;:]+$/, '');
    while (candidate.endsWith(')') && (candidate.match(/\)/g) || []).length > (candidate.match(/\(/g) || []).length) candidate = candidate.slice(0, -1);
    return candidate.length <= 200 ? candidate : '';
  }).filter(Boolean));
  return [...candidates];
}
function doi(value, marked = false) {
  const candidates = doiCandidates(value, marked);
  return candidates.length === 1 ? candidates[0] : '';
}
function fields(values) {
  const result = {};
  for (const [key, max] of Object.entries({ title: 300, author: 200, source: 160, abstract: 8000 })) {
    const value = text(values[key], max);
    if (value) result[key] = value;
  }
  const year = publicationYear(values.year), identifier = doi(values.doi);
  if (year) result.year = year;
  if (identifier) result.doi = identifier;
  return result;
}
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function openLocal(filePath, rootDir) {
  const resolved = path.resolve(filePath), actual = await realpath(resolved);
  // A caller with a verified handle should use the fd API to close all path races.
  if (!samePath(actual, resolved)) throw new Error('Symbolic-link paths are unsupported');
  if (rootDir) {
    const relative = path.relative(await realpath(rootDir), actual);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Outside library');
  }
  const before = await lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Not a regular file');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev || !samePath(await realpath(resolved), actual)) throw new Error('File changed');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readRange(fd, begin, end, size) {
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin || end > size) throw new Error('Invalid file range');
  const data = new Uint8Array(end - begin);
  let done = 0;
  while (done < data.length) {
    const { bytesRead } = await read(fd, data, done, Math.min(MiB, data.length - done), begin + done);
    if (!bytesRead) throw new Error('File truncated during extraction');
    done += bytesRead;
  }
  return data;
}

async function pdfMetadata(fd, size, options) {
  const { getDocument, PDFDataRangeTransport } = await (pdfModule ||= import('pdfjs-dist/legacy/build/pdf.mjs'));
  const readLimit = limit(options, 'maxPdfReadBytes');
  let used = Math.min(size, 65536);
  if (used > readLimit) throw new Error('PDF read budget exceeded');
  const initialData = await readRange(fd, 0, used, size);
  let fail;
  const failure = new Promise((_, reject) => { fail = reject; });
  failure.catch(() => {});
  class FileRangeTransport extends PDFDataRangeTransport {
    pending = new Set();
    aborted = false;
    requestDataRange(begin, end) {
      if (this.aborted) return;
      const length = end - begin;
      if (!Number.isSafeInteger(length) || length < 0 || length > 16 * MiB || used + length > readLimit) { fail(new Error('PDF read budget exceeded')); return; }
      used += length;
      const pending = readRange(fd, begin, end, size).then(data => {
        if (!this.aborted) this.onDataRange(begin, data);
      }).catch(fail).finally(() => this.pending.delete(pending));
      this.pending.add(pending);
    }
    abort() { this.aborted = true; }
  }
  class NoExternalResources {
    async fetch() { throw new Error('External PDF resources are disabled'); }
  }
  const transport = new FileRangeTransport(size, initialData, true);
  const task = getDocument({ range: transport, length: size, rangeChunkSize: 65536,
    disableAutoFetch: true, disableStream: true, disableRange: false,
    enableXfa: false, useWorkerFetch: false, useSystemFonts: false, useWasm: false,
    disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    BinaryDataFactory: NoExternalResources, maxImageSize: 0, verbosity: 0 });
  const guarded = operation => Promise.race([operation, failure]);
  try {
    const document = await guarded(task.promise);
    const { info = {}, metadata } = await guarded(document.getMetadata());
    const xmp = key => metadata?.get(key);
    const custom = info.Custom || {};
    const result = fields({
      title: xmp('dc:title') || info.Title,
      author: xmp('dc:creator') || info.Author,
      source: xmp('prism:publicationname') || xmp('dc:publisher') || custom.Journal || custom.Publisher,
      year: xmp('prism:publicationdate') || xmp('pdfx:publicationyear') || custom.PublicationYear || custom.PublicationDate,
      doi: xmp('prism:doi') || xmp('pdfx:doi') || custom.DOI || custom.doi,
      abstract: xmp('dc:description') || custom.Abstract,
    });
    // CreationDate / ModDate / xmp:CreateDate are file dates, never publication years.
    if (!result.doi) {
      const candidates = new Set();
      for (let number = 1; number <= Math.min(document.numPages, limit(options, 'maxPdfPages')); number++) {
        let page, reader;
        try {
          page = await guarded(document.getPage(number));
          reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
          let content = '';
          while (content.length < 128 * 1024) {
            const chunk = await guarded(reader.read());
            if (chunk.done) break;
            for (const item of chunk.value.items) {
              if (typeof item.str === 'string') content += (item.str + (item.hasEOL ? '\n' : ' ')).slice(0, 128 * 1024 - content.length);
              if (content.length >= 128 * 1024) break;
            }
          }
          if (content.length >= 128 * 1024) content = content.replace(/\S+$/, '');
          for (const identifier of doiCandidates(content, true)) candidates.add(identifier);
        } catch { /* A page with unavailable fonts must not discard embedded metadata. */ }
        finally { try { await reader?.cancel(); } catch {} page?.cleanup(); }
      }
      if (candidates.size === 1) result.doi = [...candidates][0];
    }
    return result;
  } finally {
    transport.abort();
    try { await task.destroy(); } finally { await Promise.allSettled(transport.pending); }
  }
}

function validateZipDirectory(bytes) {
  const invalid = () => new Error('Unsupported or malformed EPUB ZIP directory');
  if (bytes.length < 22) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw invalid();
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), directorySize = view.getUint32(end + 12, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count ||
    !count || count > 2000 || directorySize > 4 * MiB || start === 0xffffffff || start + directorySize !== end ||
    end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) throw invalid();
  let at = start, actualCount = 0;
  while (at < end) {
    if (++actualCount > 2000 || at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw invalid();
    const names = view.getUint16(at + 28, true), extras = view.getUint16(at + 30, true), comments = view.getUint16(at + 32, true);
    const next = at + 46 + names + extras + comments, local = view.getUint32(at + 42, true);
    if (next > end || view.getUint16(at + 34, true) || view.getUint16(at + 8, true) & 1 ||
      ![0, 8].includes(view.getUint16(at + 10, true)) || view.getUint32(at + 20, true) === 0xffffffff ||
      view.getUint32(at + 24, true) === 0xffffffff || local + 30 > start || view.getUint32(local, true) !== 0x04034b50) throw invalid();
    const localName = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    if (local + 30 + localName + localExtra + view.getUint32(at + 20, true) > start) throw invalid();
    for (let extra = at + 46 + names, extraEnd = extra + extras; extra < extraEnd;) {
      if (extra + 4 > extraEnd || view.getUint16(extra, true) === 0x0001) throw invalid();
      extra += 4 + view.getUint16(extra + 2, true);
      if (extra > extraEnd) throw invalid();
    }
    at = next;
  }
  if (actualCount !== count || at !== end) throw invalid();
}
function zipPath(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 600 &&
    !/(^\/|\\|[\u0000-\u001f\u007f])/.test(name) && !/^[a-z][a-z0-9+.-]*:/i.test(name) &&
    !name.split('/').some(part => part === '..' || part === '.');
}
function readEntry(entry, maximum) {
  if (!entry || entry.dir) throw new Error('Missing EPUB metadata');
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0, done = false;
    const stream = entry.internalStream('uint8array');
    stream.on('data', chunk => {
      if (done) return;
      length += chunk.length;
      if (length > maximum) { done = true; stream.pause(); chunks.length = 0; reject(new Error('EPUB metadata exceeds limit')); return; }
      chunks.push(chunk);
    });
    stream.on('error', error => { if (!done) { done = true; reject(error); } });
    stream.on('end', () => {
      if (done) return;
      done = true;
      const result = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      resolve(result);
    });
    stream.resume();
  });
}
function xml(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('XML declarations are forbidden');
  let broken = false;
  const doc = new DOMParser({ errorHandler: { warning() { broken = true; }, error() { broken = true; }, fatalError() { broken = true; } } }).parseFromString(source, 'application/xml');
  if (broken || !doc.documentElement) throw new Error('Invalid XML');
  return doc;
}
function plainDescription(value) {
  if (typeof value !== 'string' || !value.includes('<')) return value;
  // Escaped HTML in dc:description is text only; omit executable element contents.
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) return '';
  const doc = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } }).parseFromString('<div>' + value + '</div>', 'text/html');
  for (const name of ['script', 'style', 'iframe', 'object']) {
    const nodes = Array.from(doc.getElementsByTagName(name));
    for (const node of nodes) node.parentNode?.removeChild(node);
  }
  return doc.documentElement?.textContent || '';
}
async function epubMetadata(fd, size, options) {
  const bytes = await readRange(fd, 0, size, size);
  validateZipDirectory(bytes);
  const zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: false });
  for (const entry of Object.values(zip.files)) {
    if (!zipPath(entry.name) || entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw new Error('Unsafe EPUB path');
  }
  const container = xml(await readEntry(zip.file('META-INF/container.xml'), limit(options, 'maxContainerBytes')));
  if (container.documentElement.namespaceURI !== CONTAINER || container.documentElement.localName !== 'container') throw new Error('Invalid EPUB container');
  const rootfile = Array.from(container.getElementsByTagNameNS(CONTAINER, 'rootfile')).find(node => node.getAttribute('media-type') === 'application/oebps-package+xml');
  const name = rootfile?.getAttribute('full-path');
  if (!zipPath(name) || !/\.opf$/i.test(name)) throw new Error('Invalid OPF path');
  const document = xml(await readEntry(zip.file(name), limit(options, 'maxOpfBytes')));
  if (document.documentElement.namespaceURI !== OPF || document.documentElement.localName !== 'package') throw new Error('Invalid OPF package');
  const metadata = Array.from(document.documentElement.childNodes).find(node => node.namespaceURI === OPF && node.localName === 'metadata');
  if (!metadata) return {};
  const children = Array.from(metadata.childNodes).filter(node => node.nodeType === 1);
  const values = name => children.filter(node => node.namespaceURI === DC && node.localName === name);
  const meta = children.filter(node => node.namespaceURI === OPF && node.localName === 'meta');
  const creators = values('creator').filter(node => {
    const refiner = meta.find(m => m.getAttribute('refines') === '#' + node.getAttribute('id') && m.getAttribute('property') === 'role');
    const role = node.getAttributeNS(OPF, 'role') || refiner?.textContent?.trim();
    return !role || role === 'aut';
  });
  const date = values('date').find(node => {
    const event = node.getAttributeNS(OPF, 'event');
    return (!event || event === 'publication') && publicationYear(node.textContent);
  });
  const identifiers = [...new Set(values('identifier').map(node => doi(node.textContent)).filter(Boolean))];
  return fields({ title: values('title')[0]?.textContent, author: creators.map(node => node.textContent),
    year: date?.textContent, source: values('publisher')[0]?.textContent,
    doi: identifiers.length === 1 ? identifiers[0] : '', abstract: plainDescription(values('description')[0]?.textContent) });
}

/**
 * Extract embedded metadata offline. Missing/invalid/oversized files return {}.
 * Preferred worker API: extractMetadata(null, { fd, size, format: 'pdf'|'epub' }).
 * Numeric fds belong to the caller and are never closed here. Keep the handle
 * open until the worker exits. File reads use explicit offsets, preserving its
 * position. Run in a worker with a timeout: document parsers can be CPU-heavy.
 * Path mode opens its own read-only handle and closes it, optionally under rootDir.
 * Limits can only be lowered. No publication year/author/classification guessing.
 */
export async function extractMetadata(filePath, options = {}) {
  let owned;
  try {
    if (filePath && typeof filePath === 'object') { options = { ...filePath, ...options }; filePath = null; }
    const format = String(options.format || (typeof filePath === 'string' ? path.extname(filePath) : '')).replace(/^\./, '').toLowerCase();
    if (!['pdf', 'epub'].includes(format)) return {};
    let fd = options.fd;
    if (!Number.isSafeInteger(fd) || fd < 0) {
      if (options.fd !== undefined || typeof filePath !== 'string') return {};
      owned = await openLocal(filePath, options.rootDir); fd = owned.fd;
    }
    const before = await fstat(fd), maximum = limit(options, format === 'pdf' ? 'maxPdfBytes' : 'maxEpubBytes');
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > maximum ||
      options.size !== undefined && options.size !== before.size) return {};
    const result = await (format === 'pdf' ? pdfMetadata(fd, before.size, options) : epubMetadata(fd, before.size, options));
    const after = await fstat(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) return {};
    return result;
  } catch { return {}; }
  finally { await owned?.close().catch(() => {}); }
}
