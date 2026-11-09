const $ = (selector) => document.querySelector(selector);
const id = new URL(location.href).searchParams.get('id');
// Bind this reading tab to its URL member, even if another tab changes the picker.
const memberId = new URL(location.href).searchParams.get('member') ?? 'family';
let memberName = '家庭共享';
const contentURL = '/api/family/content?id=' + encodeURIComponent(id || '');
const downloadURL = '/api/family/download?id=' + encodeURIComponent(id || '');
const viewer = $('#viewer');
const toolbar = $('#toolbar');
const disposers = [];
let savedProgress = null;
let pendingProgress = null;
let lastSavedKey = '';
let lastSaveAt = 0;
let saveTimer = null;
let saving = false;
let leaving = false;
let theme = 'day';
let fontSize = 18;
let themeChanged = () => {};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, label) {
  const node = element('button', '', text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', action);
  return node;
}
function group(...nodes) {
  const node = element('div', 'control-group');
  node.append(...nodes);
  toolbar.append(node);
  return node;
}
function options(values, label, action) {
  const select = element('select');
  select.setAttribute('aria-label', label);
  for (const [value, text] of values) {
    const option = element('option', '', text);
    option.value = value;
    select.append(option);
  }
  select.addEventListener('change', action);
  return select;
}
function clamp(value, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function sizeLabel(value) {
  if (!Number.isFinite(value)) return '';
  return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(value / 1024)) + ' KB';
}
function note(text) { $('#readerNote').textContent = text; $('#readerNote').hidden = !text; }
function loading(text) { $('#loadingText').textContent = text; $('#loading').hidden = false; }
function ready(className) {
  viewer.className = 'viewer ' + className;
  viewer.hidden = false;
  toolbar.hidden = !toolbar.childElementCount;
  $('#loading').hidden = true;
}
function showError(message, title = '暂时无法预览', retry = true) {
  $('#loading').hidden = true;
  $('#errorTitle').textContent = title;
  $('#errorMessage').textContent = message;
  $('#errorPanel').hidden = false;
  $('#retryButton').hidden = !retry;
  viewer.hidden = true;
  toolbar.hidden = true;
}
function goToLogin() {
  if (leaving) return;
  leaving = true;
  location.replace('/library.html?next=' + encodeURIComponent('/reader.html?id=' + encodeURIComponent(id || '') + '&member=' + encodeURIComponent(memberId)));
}
async function responseOrError(response) {
  if (response.status === 401) { goToLogin(); throw new Error('登录已过期，请重新登录。'); }
  if (!response.ok) {
    let message = '资料读取失败，请稍后重试或下载原文件。';
    try { message = (await response.json()).error || message; } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response;
}
async function api(path, body) {
  const response = await fetch('/api/family/' + path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return (await responseOrError(response)).json();
}
function progressKey(value) { return JSON.stringify([value.kind, value.location, value.progress]); }
function remember(kind, locationValue, value, label, save = true) {
  $('#positionLabel').textContent = label;
  const locationText = String(locationValue);
  if (!save || locationText.length > 2048 || !Number.isFinite(value)) return;
  const next = { id, memberId, kind, location: locationText, progress: clamp(value) };
  if (progressKey(next) === lastSavedKey && !saving) {
    pendingProgress = null; clearTimeout(saveTimer); saveTimer = null;
    return;
  }
  pendingProgress = next;
  if (!saveTimer && !saving) saveTimer = setTimeout(saveProgress, Math.max(1800, 10000 - (Date.now() - lastSaveAt)));
}
async function saveProgress() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!pendingProgress || saving || leaving) return;
  const value = pendingProgress;
  pendingProgress = null;
  saving = true;
  lastSaveAt = Date.now();
  try {
    await responseOrError(await fetch('/api/family/progress', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
    }));
    lastSavedKey = progressKey(value);
    $('#saveStatus').textContent = '已保存 · ' + memberName;
    $('#saveStatus').classList.remove('save-error');
  } catch (error) {
    if (!pendingProgress) pendingProgress = value;
    $('#saveStatus').textContent = '进度暂未保存；阅读可继续';
    $('#saveStatus').classList.add('save-error');
  } finally {
    saving = false;
    if (pendingProgress && !leaving) saveTimer = setTimeout(saveProgress, document.visibilityState === 'hidden' ? 1500 : 15000);
  }
}
function flushProgress() {
  if (!pendingProgress || leaving || saving) return;
  clearTimeout(saveTimer); saveTimer = null;
  void saveProgress();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushProgress(); });
window.addEventListener('pagehide', () => { flushProgress(); for (const dispose of disposers) { try { dispose(); } catch {} } });
// A BFCache restore revives the JavaScript state after reader resources were closed.
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
$('#retryButton').addEventListener('click', () => location.reload());
$('#closeOutline').addEventListener('click', () => $('#outlineDialog').close());
try {
  const previous = sessionStorage.getItem('family-knowledge-return');
  if (previous && previous.length <= 4096) {
    const target = new URL(previous, location.origin);
    if (target.origin === location.origin && ['/', '/library.html'].includes(target.pathname) && !target.username && !target.password) {
      target.searchParams.delete('next');
      for (const link of document.querySelectorAll('a[href="/library.html"]')) link.href = target.pathname + target.search + target.hash;
    }
  }
} catch {}

function appearance(onChange = () => {}) {
  themeChanged = onChange;
  const smaller = button('A−', () => { fontSize = clamp(fontSize - 2, 14, 30); apply(); }, '减小字号');
  const larger = button('A＋', () => { fontSize = clamp(fontSize + 2, 14, 30); apply(); }, '增大字号');
  const toggle = button('夜间', () => { theme = theme === 'night' ? 'day' : 'night'; apply(); }, '切换夜间阅读');
  function apply() {
    document.body.dataset.theme = theme;
    document.documentElement.style.setProperty('--page-size', fontSize + 'px');
    smaller.disabled = fontSize <= 14; larger.disabled = fontSize >= 30;
    toggle.textContent = theme === 'night' ? '日间' : '夜间';
    toggle.setAttribute('aria-pressed', String(theme === 'night'));
    try { localStorage.setItem('family-reader-appearance', JSON.stringify({ theme, fontSize })); } catch {}
    onChange();
  }
  group(smaller, larger, toggle);
  apply();
}
function pageControls(previous, next, jump, max = 1, unit = '页') {
  const prev = button('←', previous, '上一' + unit);
  const following = button('→', next, '下一' + unit);
  const input = element('input');
  input.type = 'number'; input.min = '1'; input.max = String(max); input.value = '1';
  input.inputMode = 'numeric'; input.setAttribute('aria-label', '跳转到第几' + unit);
  const total = element('span', '', '/ ' + max + ' ' + unit);
  input.addEventListener('change', () => { const value = Number(input.value); if (Number.isInteger(value)) jump(clamp(value, 1, Number(input.max))); });
  group(prev, input, total, following);
  return { input, set(current, count = max) { input.max = String(count); input.value = String(current); total.textContent = '/ ' + count + ' ' + unit; prev.disabled = current <= 1; following.disabled = current >= count; } };
}
function outline(entries, navigate) {
  const list = element('ul', 'outline-list');
  let count = 0;
  function append(items, parent, depth) {
    if (depth > 8) return;
    for (const item of items || []) {
      if (++count > 800) break;
      const li = element('li');
      const action = button(String(item.title || item.label || '未命名章节').slice(0, 300), () => {
        $('#outlineDialog').close();
        Promise.resolve().then(() => navigate(item)).catch(() => note('这个目录位置暂时无法打开，可使用翻页继续阅读。'));
      });
      li.append(action); parent.append(li);
      const children = item.items || item.subitems;
      if (children?.length) { const ul = element('ul', 'outline-list'); li.append(ul); append(children, ul, depth + 1); }
    }
  }
  append(entries, list, 0);
  $('#outlineList').replaceChildren(list);
  if (count) group(button('目录', () => $('#outlineDialog').showModal()));
  toolbar.hidden = !toolbar.childElementCount;
}

async function openPDF() {
  loading('正在打开 PDF…');
  const pdfjs = await import('/vendor/pdfjs/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/worker.mjs';
  const task = pdfjs.getDocument({
    url: contentURL, withCredentials: true, isEvalSupported: false,
    disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536,
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/'
  });
  disposers.push(() => task.destroy());
  let passwordCancelled = false;
  task.onPassword = (update, reason) => {
    const dialog = $('#passwordDialog');
    $('#passwordHint').textContent = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重新输入。' : '输入文件密码后，在当前浏览器中解锁。';
    $('#filePassword').value = '';
    $('#passwordForm').onsubmit = (event) => { event.preventDefault(); const value = $('#filePassword').value; $('#filePassword').value = ''; dialog.close(); update(value); };
    const cancel = () => { passwordCancelled = true; dialog.close(); task.destroy(); showError('需要 PDF 文件本身的密码才能预览。也可以下载后在其他阅读器中打开。', 'PDF 尚未解锁', false); };
    $('#cancelPassword').onclick = cancel;
    dialog.oncancel = (event) => { event.preventDefault(); cancel(); };
    if (!dialog.open) dialog.showModal();
    $('#filePassword').focus();
  };
  let pdf;
  try { pdf = await task.promise; } catch (error) { if (passwordCancelled) return; if (error.status === 401) goToLogin(); throw new Error('PDF 无法打开，可能已损坏、需要密码或浏览器不兼容。可以下载原文件后阅读。'); }
  // Older versions saved just a page number; new positions add the offset within it.
  const restored = savedProgress?.kind === 'pdf' && /^(\d+)(?::([01](?:\.\d+)?))?$/.exec(String(savedProgress.location));
  let current = clamp(Number(restored?.[1]) || 1, 1, pdf.numPages);
  let zoom = 'fit', epoch = 0, running = 0, frame = 0, resizeTimer;
  let stopped = false, initializing = true, wanted = new Set();
  const resident = new Map();
  const firstPage = await pdf.getPage(1);
  const firstSize = firstPage.getViewport({ scale: 1 });
  const surface = element('div', 'pdf-surface'); viewer.append(surface);
  // Keep inexpensive page placeholders, but never retain the whole document's canvases.
  const pages = Array.from({ length: pdf.numPages }, (_, index) => {
    const node = element('div', 'pdf-sheet');
    node.dataset.page = String(index + 1);
    const placeholder = element('div', 'pdf-placeholder', '第 ' + (index + 1) + ' 页');
    placeholder.setAttribute('aria-hidden', 'true');
    node.append(placeholder); surface.append(node);
    return { number: index + 1, node, placeholder, baseWidth: firstSize.width, baseHeight: firstSize.height, measured: index === 0, top: 0, width: 0, height: 0, failed: false };
  });
  const controls = pageControls(() => jump(current - 1), () => jump(current + 1), jump, pdf.numPages);
  const zoomSelect = options([['fit', '适合宽度'], ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%']], 'PDF 缩放', () => {
    const anchor = position(); zoom = zoomSelect.value; relayout(anchor, true);
  });
  group(zoomSelect, element('span', 'toolbar-note', '向下滚动，连续阅读'));
  ready('pdf-viewer');
  viewer.tabIndex = 0;
  viewer.setAttribute('aria-label', 'PDF 连续阅读区域，可上下滚动或使用页码跳转');
  document.body.classList.add('pdf-reading');

  function pageAt(top) {
    let low = 0, high = pages.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (pages[middle].top <= top) low = middle; else high = middle - 1;
    }
    return pages[low];
  }
  function position() {
    const page = pageAt(viewer.scrollTop + 1);
    return { number: page.number, offset: clamp((viewer.scrollTop - page.top) / Math.max(1, page.height)), x: (viewer.scrollLeft + viewer.clientWidth / 2) / Math.max(1, surface.clientWidth) };
  }
  function fitViewer() {
    const availableHeight = (window.visualViewport?.height || innerHeight) - viewer.getBoundingClientRect().top - $('.reader-footer').offsetHeight - 14;
    viewer.style.height = Math.max(180, availableHeight) + 'px';
  }
  function relayout(anchor, invalidate = false) {
    if (stopped) return;
    if (invalidate) { epoch++; for (const entry of [...resident.values()]) release(entry); }
    fitViewer();
    const availableWidth = Math.max(80, viewer.clientWidth - 24);
    let top = 8, width = availableWidth;
    for (const page of pages) {
      const scale = zoom === 'fit' ? availableWidth / page.baseWidth : Number(zoom);
      page.top = top; page.width = page.baseWidth * scale; page.height = page.baseHeight * scale;
      page.node.style.top = top + 'px'; page.node.style.width = page.width + 'px'; page.node.style.height = page.height + 'px';
      top += page.height + 18; width = Math.max(width, page.width);
      if (invalidate) page.failed = false;
    }
    surface.style.width = width + 24 + 'px'; surface.style.height = top - 10 + 'px';
    const target = pages[clamp(anchor.number, 1, pages.length) - 1];
    viewer.scrollTop = target.top + clamp(anchor.offset) * target.height;
    viewer.scrollLeft = clamp(anchor.x ?? .5) * surface.clientWidth - viewer.clientWidth / 2;
    update();
  }
  function jump(number) {
    const page = pages[clamp(Math.round(number), 1, pages.length) - 1];
    viewer.scrollTop = page.top;
    update();
  }
  function release(entry) {
    if (resident.get(entry.page.number) === entry) resident.delete(entry.page.number);
    entry.released = true;
    entry.task?.cancel();
    if (entry.canvas) { entry.canvas.remove(); entry.canvas.width = 0; entry.canvas.height = 0; }
    entry.page.placeholder.hidden = false;
    entry.page.node.removeAttribute('aria-busy');
    if (entry.done) entry.proxy?.cleanup();
  }
  function update() {
    if (stopped) return;
    const anchor = position();
    const atEnd = viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 2;
    current = atEnd ? pages.length : anchor.number;
    if (document.activeElement !== controls.input) controls.set(current);
    const fraction = atEnd ? 1 : (anchor.number - 1 + anchor.offset) / pages.length;
    remember('pdf', anchor.number + ':' + anchor.offset.toFixed(4), fraction, '第 ' + current + ' / ' + pages.length + ' 页 · ' + Math.round(fraction * 100) + '%', !initializing);
    const from = pageAt(Math.max(0, viewer.scrollTop - viewer.clientHeight * .5)).number;
    const until = viewer.scrollTop + viewer.clientHeight * 1.5;
    const middle = viewer.scrollTop + viewer.clientHeight / 2;
    const candidates = [];
    for (let number = from; number <= pages.length && pages[number - 1].top < until; number++) candidates.push(pages[number - 1]);
    // At most six 3-megapixel canvases (~72 MB of pixel buffers), with two render jobs.
    candidates.sort((a, b) => Math.abs(a.top + a.height / 2 - middle) - Math.abs(b.top + b.height / 2 - middle));
    wanted = new Set(candidates.slice(0, 6).map((page) => page.number));
    for (const entry of [...resident.values()]) if (!wanted.has(entry.page.number)) release(entry);
    pump();
  }
  function schedule() { if (!frame && !stopped) frame = requestAnimationFrame(() => { frame = 0; update(); }); }
  function pump() {
    if (stopped) return;
    for (const number of wanted) {
      if (running >= 2) break;
      const page = pages[number - 1];
      if (resident.has(number) || page.failed) continue;
      const entry = { page, epoch, released: false, done: false };
      resident.set(number, entry); running++; void render(entry);
    }
  }
  async function render(entry) {
    const page = entry.page;
    const active = () => !stopped && !entry.released && entry.epoch === epoch;
    page.node.setAttribute('aria-busy', 'true');
    try {
      entry.proxy = await pdf.getPage(page.number);
      if (!active()) return;
      if (!page.measured) {
        const base = entry.proxy.getViewport({ scale: 1 });
        const anchor = position();
        page.measured = true; page.baseWidth = base.width; page.baseHeight = base.height;
        relayout(anchor);
        if (!active()) return;
      }
      const viewport = entry.proxy.getViewport({ scale: page.width / page.baseWidth });
      const density = Math.min(devicePixelRatio || 1, 2, Math.sqrt(3000000 / (viewport.width * viewport.height)), 8192 / Math.max(viewport.width, viewport.height));
      const canvas = element('canvas', 'pdf-page'); entry.canvas = canvas;
      canvas.setAttribute('aria-label', 'PDF 第 ' + page.number + ' 页'); canvas.setAttribute('role', 'img');
      canvas.width = Math.max(1, Math.floor(viewport.width * density)); canvas.height = Math.max(1, Math.floor(viewport.height * density));
      canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
      entry.task = entry.proxy.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [density, 0, 0, density, 0, 0] });
      await entry.task.promise;
      if (!active()) return;
      page.node.append(canvas); page.placeholder.hidden = true;
      page.node.setAttribute('aria-busy', 'false');
    } catch (error) {
      if (!active() || error.name === 'RenderingCancelledException') return;
      if (error.status === 401) { goToLogin(); return; }
      page.failed = true;
      page.placeholder.replaceChildren(element('span', '', '第 ' + page.number + ' 页暂时无法显示'), button('重试这一页', () => {
        release(entry); page.failed = false; page.placeholder.textContent = '第 ' + page.number + ' 页'; schedule();
      }));
      page.placeholder.hidden = false; page.node.setAttribute('aria-busy', 'false');
    } finally {
      entry.done = true; running--;
      if (!active()) { if (entry.canvas) { entry.canvas.width = 0; entry.canvas.height = 0; } entry.proxy?.cleanup(); }
      pump();
    }
  }
  relayout({ number: current, offset: clamp(Number(restored?.[2]) || 0), x: .5 });
  controls.input.addEventListener('blur', () => controls.set(current));
  viewer.addEventListener('scroll', schedule, { passive: true });
  requestAnimationFrame(() => { initializing = false; });
  pdf.getOutline().then((items) => outline(items, async (item) => {
    let dest = item.dest;
    if (typeof dest === 'string') dest = await pdf.getDestination(dest);
    if (!Array.isArray(dest)) throw new Error('No internal destination');
    const index = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
    jump(index + 1);
  })).catch(() => {});
  const onResize = () => {
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => relayout(position(), true), 160);
  };
  const toolbarObserver = new ResizeObserver(onResize); toolbarObserver.observe(toolbar);
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  disposers.push(() => {
    stopped = true; clearTimeout(resizeTimer); cancelAnimationFrame(frame); toolbarObserver.disconnect();
    window.removeEventListener('resize', onResize); window.visualViewport?.removeEventListener('resize', onResize);
    viewer.removeEventListener('scroll', schedule);
    for (const entry of [...resident.values()]) release(entry);
  });
}

async function openText() {
  const pre = element('pre', 'text-page');
  const info = element('p', 'text-meta');
  viewer.append(pre, info);
  let text = '', chunks = [0], current = 1, generation = 0;
  const controls = pageControls(() => display(current - 1), () => display(current + 1), (page) => display(page), 1, '段');
  const encoding = options([['auto', '自动识别编码'], ['utf-8', 'UTF-8'], ['gb18030', 'GB18030 / GBK'], ['utf-16le', 'UTF-16 LE']], '文本编码', () => loadText());
  group(encoding); appearance();
  function display(page, save = true) {
    current = clamp(Math.round(page), 1, chunks.length);
    const start = chunks[current - 1];
    pre.textContent = text.slice(start, chunks[current] ?? text.length) || '（空白文档）';
    controls.set(current, chunks.length);
    info.textContent = '第 ' + current + ' / ' + chunks.length + ' 段 · 纯文本显示';
    window.scrollTo({ top: 0, behavior: 'instant' });
    remember('text', start, current === chunks.length ? 1 : start / Math.max(1, text.length), '第 ' + current + ' / ' + chunks.length + ' 段', save);
  }
  async function loadText() {
    const version = ++generation;
    encoding.disabled = true; loading('正在读取文本…');
    try {
      const data = await api('text?id=' + encodeURIComponent(id) + '&encoding=' + encoding.value);
      if (version !== generation) return;
      text = String(data.text || ''); chunks = [0];
      for (let offset = 6000; offset < text.length;) {
        const lineEnd = text.indexOf('\n', offset);
        let end = lineEnd >= offset && lineEnd < offset + 1500 ? lineEnd + 1 : offset;
        if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end++;
        chunks.push(end); offset = end + 6000;
      }
      const restore = savedProgress?.kind === 'text' ? Number(savedProgress.location) : 0;
      const section = chunks.findIndex((start, index) => start <= restore && (chunks[index + 1] ?? Infinity) > restore);
      note('编码：' + String(data.encoding || encoding.value) + '。HTML、Markdown、代码等以纯文本呈现。' + (data.truncated ? ' 文件较长，这里只预览前 2 MiB；下载可查看完整内容。' : ''));
      ready('text-viewer'); display(Math.max(1, section + 1), false);
    } catch (error) { showError(error.message); }
    finally { if (version === generation) encoding.disabled = false; }
  }
  await loadText();
}

async function openImage(book) {
  const surface = element('div', 'image-surface');
  const image = element('img', 'preview-image');
  image.alt = book.title || book.file.name; image.decoding = 'async';
  surface.append(image); viewer.append(surface);
  const zoom = options([['fit', '适合屏幕'], ['0.5', '50%'], ['1', '原始大小'], ['1.5', '150%'], ['2', '200%']], '图片缩放', applyZoom);
  group(zoom);
  function applyZoom() {
    viewer.classList.toggle('image-fit', zoom.value === 'fit');
    image.style.width = zoom.value === 'fit' ? '' : Math.max(1, image.naturalWidth * Number(zoom.value)) + 'px';
    image.style.height = '';
  }
  image.onload = () => { ready('image-viewer image-fit'); applyZoom(); remember('image', 'viewed', 1, image.naturalWidth + ' × ' + image.naturalHeight + ' 像素'); };
  image.onerror = async () => { try { await responseOrError(await fetch(contentURL, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' })); } catch (error) { if (leaving) return; } showError('浏览器无法显示这张图片。可能是格式不支持或文件已损坏，请下载后打开。'); };
  image.src = contentURL;
}
function clockLabel(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const value = Math.floor(seconds); return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}
async function openMedia(book, kind) {
  const media = element(kind); media.controls = true; media.preload = 'metadata';
  if (kind === 'video') media.setAttribute('playsinline', '');
  if (kind === 'audio') { const art = element('div', 'media-art', '♫'); art.setAttribute('aria-hidden', 'true'); viewer.append(art); }
  media.setAttribute('aria-label', book.title || book.file.name);
  viewer.append(media, element('p', 'media-hint', '点击播放即可开始。播放位置由全家共用；浏览器不支持的编码可下载后打开。'));
  const speed = options([['0.75', '0.75 倍速'], ['1', '正常速度'], ['1.25', '1.25 倍速'], ['1.5', '1.5 倍速'], ['2', '2 倍速']], '播放速度', () => { media.playbackRate = Number(speed.value); });
  speed.value = '1'; group(speed);
  let restored = false;
  function rememberMedia(save = true) {
    if (!restored || !Number.isFinite(media.duration) || media.duration <= 0) return;
    remember(kind, Math.round(media.currentTime * 10) / 10, media.currentTime / media.duration, clockLabel(media.currentTime) + ' / ' + clockLabel(media.duration), save);
  }
  media.addEventListener('loadedmetadata', () => {
    if (!restored && savedProgress?.kind === kind && Number.isFinite(media.duration)) {
      const position = Number(savedProgress.location);
      if (Number.isFinite(position) && position > 0 && position < media.duration - 1) media.currentTime = position;
    }
    restored = true; rememberMedia(false);
  });
  media.addEventListener('timeupdate', () => { if (!media.paused) rememberMedia(); });
  media.addEventListener('seeked', () => rememberMedia());
  media.addEventListener('pause', () => rememberMedia());
  media.addEventListener('ended', () => rememberMedia());
  media.addEventListener('error', async () => {
    try { await responseOrError(await fetch(contentURL, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' })); } catch { if (leaving) return; }
    showError('当前浏览器无法播放这份' + (kind === 'audio' ? '音频' : '视频') + '。文件扩展名相同也可能使用不同编码；可以下载后用本地播放器打开。', '播放未能开始');
  });
  media.src = contentURL;
  ready('media-viewer');
  disposers.push(() => { media.pause(); media.removeAttribute('src'); media.load(); });
}

const EPUB_LIMIT = 64 * 1024 * 1024;
const EPUB_EXPANDED_LIMIT = 96 * 1024 * 1024;
const EPUB_DOCUMENT_LIMIT = 4 * 1024 * 1024;
const EPUB_ASSET_LIMIT = 16 * 1024 * 1024;
const EPUB_ORIGIN = 'https://epub.invalid';
const EPUB_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
async function loadScript(path, exported) {
  if (window[exported]) return;
  await new Promise((resolve, reject) => {
    const script = element('script'); script.src = path;
    script.onload = () => window[exported] ? resolve() : reject(new Error('阅读组件未能加载，请重新加载页面。'));
    script.onerror = () => reject(new Error('阅读组件未能加载，请重新加载页面。'));
    document.head.append(script);
  });
}
async function limitedDownload() {
  const controller = new AbortController(); disposers.push(() => controller.abort());
  const response = await responseOrError(await fetch(contentURL, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }));
  const advertised = Number(response.headers.get('Content-Length'));
  if (advertised > EPUB_LIMIT) { controller.abort(); throw new Error('EPUB 超过 64 MiB，建议下载后用本地阅读器打开。'); }
  if (!response.body?.getReader) { controller.abort(); throw new Error('这个浏览器不支持安全分段读取 EPUB，请下载后打开。'); }
  const reader = response.body.getReader(); let total = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > EPUB_LIMIT) { await reader.cancel(); controller.abort(); throw new Error('EPUB 超过 64 MiB，请下载后打开。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
function readZipEntry(entry, limit, budget) {
  return new Promise((resolve, reject) => {
    let size = 0, ended = false; const chunks = [];
    const stream = entry.internalStream('uint8array');
    stream.on('data', (chunk) => {
      if (ended) return;
      size += chunk.byteLength; budget.used += chunk.byteLength;
      if (size > limit || budget.used > EPUB_EXPANDED_LIMIT) {
        ended = true; stream.pause(); chunks.length = 0;
        reject(new Error('EPUB 解压后的内容过大，请下载后用本地阅读器打开。'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error) => { if (!ended) { ended = true; reject(error); } });
    stream.on('end', () => {
      if (ended) return;
      ended = true; const output = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      resolve(output);
    });
    stream.resume();
  });
}
function epubPath(href, from, knownPaths) {
  if (typeof href !== 'string' || !href || href.length > 2048 || /[\u0000-\u0020\\]/.test(href) || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  try {
    const url = new URL(href, EPUB_ORIGIN + '/' + from);
    if (url.origin !== EPUB_ORIGIN || url.search) return null;
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!path || path.includes('\\') || !knownPaths.has(path)) return null;
    return { path, hash: url.hash };
  } catch { return null; }
}
function xmlDocument(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('这份 EPUB 含有不支持的 XML 声明，请下载后打开。');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('EPUB 的目录或描述文件格式不正确，请下载后打开。');
  return doc;
}
function cleanChapter(text, path, paths) {
  const clean = window.DOMPurify.sanitize(text, {
    WHOLE_DOCUMENT: true,
    ALLOWED_TAGS: ['html', 'head', 'body', 'title', 'article', 'section', 'nav', 'aside', 'main', 'header', 'footer', 'div', 'p', 'br', 'hr', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'blockquote', 'q', 'cite', 'pre', 'code', 'ol', 'ul', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'a', 'img', 'figure', 'figcaption', 'ruby', 'rt', 'rp'],
    ALLOWED_ATTR: ['id', 'class', 'href', 'src', 'alt', 'title', 'lang', 'xml:lang', 'dir', 'colspan', 'rowspan', 'scope', 'start', 'reversed', 'epub:type', 'role'],
    ALLOWED_URI_REGEXP: /^(?:#|\/?(?!\/)[^:\u0000-\u0020\\]*)$/,
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ['style', 'link', 'meta', 'base', 'script', 'svg', 'math', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'audio', 'video', 'source'],
    FORBID_ATTR: ['style', 'srcset', 'target', 'ping', 'download', 'xml:base']
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  doc.documentElement.setAttribute('xmlns:epub', 'http://www.idpf.org/2007/ops');
  for (const link of doc.querySelectorAll('[href]')) if (!epubPath(link.getAttribute('href'), path, paths)) link.removeAttribute('href');
  for (const image of doc.querySelectorAll('[src]')) {
    const resolved = epubPath(image.getAttribute('src'), path, paths);
    if (!resolved || !/\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(resolved.path)) image.removeAttribute('src');
  }
  const policy = doc.createElement('meta'); policy.setAttribute('http-equiv', 'Content-Security-Policy'); policy.setAttribute('content', EPUB_CSP);
  doc.head.prepend(policy);
  return new XMLSerializer().serializeToString(doc);
}
function validateZipDirectory(bytes) {
  const invalid = () => new Error('EPUB 的压缩目录无效或过大，请下载后用本地阅读器打开。');
  if (bytes.byteLength < 22 || bytes.byteLength > EPUB_LIMIT) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // Inspect only the ZIP directory; decompression remains JSZip's responsibility.
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) { end = offset; break; }
  }
  if (end < 0) throw invalid();
  const countOnDisk = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || countOnDisk !== count || count === 0 || count > 2000 || directorySize === 0xffffffff || directoryStart === 0xffffffff || directorySize > 4 * 1024 * 1024 || directoryStart + directorySize !== end) throw invalid();
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) throw invalid();
  let offset = directoryStart, actualCount = 0;
  while (offset < end) {
    if (++actualCount > 2000 || offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || view.getUint16(offset + 34, true) !== 0 || view.getUint32(offset + 20, true) === 0xffffffff || view.getUint32(offset + 24, true) === 0xffffffff || view.getUint32(offset + 42, true) >= directoryStart) throw invalid();
    for (let extra = offset + 46 + nameLength, extraEnd = extra + extraLength; extra < extraEnd;) {
      if (extra + 4 > extraEnd || view.getUint16(extra, true) === 0x0001) throw invalid();
      extra += 4 + view.getUint16(extra + 2, true);
      if (extra > extraEnd) throw invalid();
    }
    offset = next;
  }
  if (actualCount !== count || offset !== end) throw invalid();
}
async function sanitizeArchive(bytes) {
  validateZipDirectory(bytes);
  const zip = await window.JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: false });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > 2000) throw new Error('这份 EPUB 的文件数量过多，请下载后打开。');
  const paths = new Set(); const allowed = [];
  for (const entry of entries) {
    const path = entry.name;
    if (path.length > 600 || /(^\/|\\|[\u0000-\u001f])/.test(path) || path.split('/').some((part) => part === '..') || (entry.unsafeOriginalName && entry.unsafeOriginalName !== path)) throw new Error('EPUB 中含有无效的文件路径，请下载后打开。');
    if (path === 'mimetype' || /\.(?:xml|opf|ncx|xhtml|html|htm|css|png|jpe?g|gif|webp|avif|bmp|woff2?|ttf|otf)$/i.test(path)) { paths.add(path); allowed.push(entry); }
  }
  if (!paths.has('META-INF/container.xml')) throw new Error('这不是有效的 EPUB 文件，缺少书籍描述。');
  const safe = new window.JSZip(); const budget = { used: 0 }; let packagePath = '';
  for (const entry of allowed) {
    const path = entry.name;
    if (path === 'mimetype') { safe.file(path, 'application/epub+zip', { compression: 'STORE' }); continue; }
    if (/\.css$/i.test(path)) { safe.file(path, ''); continue; }
    const isMarkup = /\.(?:xml|opf|ncx|xhtml|html|htm)$/i.test(path);
    const limit = isMarkup ? EPUB_DOCUMENT_LIMIT : EPUB_ASSET_LIMIT;
    const data = await readZipEntry(entry, limit, budget);
    if (!isMarkup) { safe.file(path, data); continue; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('EPUB 章节的编码不受支持，请下载后打开。'); }
    if (/\.(?:xhtml|html|htm)$/i.test(path)) { safe.file(path, cleanChapter(text, path, paths)); continue; }
    const doc = xmlDocument(text);
    if (doc.documentElement.localName.toLowerCase() === 'html') { safe.file(path, cleanChapter(text, path, paths)); continue; }
    for (const node of doc.querySelectorAll('*')) {
      for (const attr of Array.from(node.attributes)) if (/^on/i.test(attr.name) || ['xml:base', 'style'].includes(attr.name)) node.removeAttribute(attr.name);
      if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'base'].includes(node.localName.toLowerCase())) { node.remove(); continue; }
      if (node.localName === 'item') {
        const type = node.getAttribute('media-type') || '';
        const target = epubPath(node.getAttribute('href'), path, paths);
        if ((/^(?:application\/xhtml\+xml|text\/html)$/.test(type) && !/\.(?:xhtml|html|htm|xml)$/i.test(target?.path || '')) || /(?:javascript|svg|audio|video)/i.test(type)) { node.remove(); continue; }
      }
      if (node.hasAttribute('href') && !epubPath(node.getAttribute('href'), path, paths)) { node.remove(); continue; }
      if (node.hasAttribute('src') && !epubPath(node.getAttribute('src'), path, paths)) node.removeAttribute('src');
      if (node.localName === 'rootfile') {
        const fullPath = node.getAttribute('full-path');
        if (!fullPath || !paths.has(fullPath) || !/\.opf$/i.test(fullPath)) throw new Error('EPUB 书籍描述路径无效。');
        if (!packagePath) packagePath = fullPath;
      }
    }
    safe.file(path, new XMLSerializer().serializeToString(doc));
  }
  if (!packagePath) throw new Error('未找到 EPUB 的书籍描述。');
  const result = await safe.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  if (result.byteLength > EPUB_LIMIT) throw new Error('整理后的 EPUB 内容过大，请下载后打开。');
  return { bytes: result, paths, packagePath };
}
function within(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function openEPUB(book) {
  if (Number(book.file.size) > EPUB_LIMIT) { showError('这份 EPUB 超过 64 MiB，手机浏览器读取可能占用过多内存。请下载后在本地阅读器中打开。', '请下载这份 EPUB', false); return; }
  loading('正在准备 EPUB 阅读组件…');
  await loadScript('/vendor/jszip.min.js', 'JSZip');
  await loadScript('/vendor/purify.min.js', 'DOMPurify');
  await loadScript('/vendor/epub.min.js', 'ePub');
  if (!window.DOMPurify.isSupported) throw new Error('这个浏览器不支持安全预览 EPUB，请下载后打开。');
  loading('正在读取并整理 EPUB…');
  const clean = await sanitizeArchive(await limitedDownload());
  const epub = window.ePub({ replacements: 'blobUrl', requestMethod: () => Promise.reject(new Error('书内外部资源已禁用。')) });
  epub.ready.catch(() => {}); disposers.push(() => epub.destroy());
  await within(epub.open(clean.bytes, 'binary'), 30000, 'EPUB 打开超时，请重新加载或下载后打开。');
  const stage = element('div', 'epub-stage'); viewer.append(stage);
  let rendition;
  const previous = button('← 上一页', () => turn(-1));
  const following = button('下一页 →', () => turn(1));
  group(previous, following);
  appearance(() => {
    if (!rendition) return;
    rendition.themes.fontSize(fontSize + 'px');
    rendition.themes.override('color', theme === 'night' ? '#dde5db' : '#263f36', true);
    rendition.themes.override('background', theme === 'night' ? '#1f2924' : '#fffefa', true);
  });
  note('EPUB 使用统一阅读排版，原书的复杂样式可能简化。书内脚本、外部链接和远程资源已停用。');
  ready('epub-viewer');
  function fitStage() {
    const top = viewer.getBoundingClientRect().top + window.scrollY;
    viewer.style.height = Math.max(320, window.innerHeight - top - $('.reader-footer').offsetHeight - 16) + 'px';
  }
  fitStage();
  rendition = epub.renderTo(stage, { width: '100%', height: stage.clientHeight, flow: 'paginated', spread: 'none', layout: 'reflowable', allowScriptedContent: false, allowPopups: false });
  rendition.themes.default({ body: { 'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif', 'line-height': '1.9', 'overflow-wrap': 'anywhere' }, p: { 'margin-bottom': '1em' }, img: { 'max-width': '100%', 'height': 'auto' }, table: { 'max-width': '100%', 'border-collapse': 'collapse' }, 'td, th': { border: '1px solid #96a38d', padding: '4px' }, pre: { 'white-space': 'pre-wrap' } });
  themeChanged();
  let busy = false, initial = true;
  function sectionTarget(href, from = clean.packagePath) {
    const target = epubPath(href, from, clean.paths);
    if (!target) return null;
    const section = epub.spine.spineItems.find((item) => epubPath(item.href, clean.packagePath, clean.paths)?.path === target.path);
    return section ? section.href + target.hash : null;
  }
  async function display(target) {
    if (busy) return;
    busy = true;
    try { await within(rendition.display(target), 20000, '这一章暂时无法打开。'); }
    catch { note('这一章暂时无法打开。可以通过目录选择其他章节，或下载原文件。'); }
    finally { busy = false; }
  }
  async function turn(direction) {
    if (busy) return;
    busy = true;
    try { await within(direction < 0 ? rendition.prev() : rendition.next(), 20000, '翻页超时。'); }
    catch { note('翻页暂时失败，可通过目录选择章节，或下载原文件。'); }
    finally { busy = false; }
  }
  rendition.on('rendered', (section, view) => {
    const doc = view.document || view.contents?.document;
    if (!doc || doc.documentElement.dataset.familyReaderBound) return;
    doc.documentElement.dataset.familyReaderBound = 'true';
    if (view.iframe) view.iframe.title = 'EPUB 章节';
    const source = epubPath(section.href, clean.packagePath, clean.paths)?.path || clean.packagePath;
    doc.addEventListener('click', (event) => {
      const link = event.target.closest?.('a');
      if (!link) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const target = sectionTarget(link.getAttribute('href'), source);
      if (target) display(target);
    }, true);
    doc.addEventListener('keydown', (event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); turn(event.key === 'ArrowRight' ? 1 : -1); } });
  });
  rendition.on('relocated', (locationValue) => {
    const start = locationValue.start;
    if (!start) return;
    const chapter = Number(start.index) || 0;
    const total = Math.max(1, epub.spine.spineItems.length);
    const page = Math.max(1, Number(start.displayed?.page) || 1);
    const pages = Math.max(1, Number(start.displayed?.total) || 1);
    const fraction = locationValue.atEnd ? 1 : clamp((chapter + (page - 1) / pages) / total);
    previous.disabled = !!locationValue.atStart; following.disabled = !!locationValue.atEnd;
    remember('epub', start.cfi, fraction, '第 ' + (chapter + 1) + ' / ' + total + ' 章 · 约 ' + Math.round(fraction * 100) + '%', !initial);
  });
  const restore = savedProgress?.kind === 'epub' && typeof savedProgress.location === 'string' && savedProgress.location.startsWith('epubcfi(') && savedProgress.location.length <= 2048 ? savedProgress.location : undefined;
  try { await within(rendition.display(restore), 20000, 'EPUB 章节打开超时。'); }
  catch {
    if (restore) { note('上次的章节位置已变化，已尝试从开头打开。'); await within(rendition.display(), 20000, 'EPUB 打开失败，请下载后阅读。'); }
    else throw new Error('EPUB 章节无法显示，请下载原文件后阅读。');
  }
  initial = false;
  const fallbackOutline = () => epub.spine.spineItems.map((item, index) => ({ label: '第 ' + (index + 1) + ' 章', href: item.href }));
  epub.loaded.navigation.then((navigation) => {
    function valid(items) { return (items || []).filter((item) => sectionTarget(item.href)).map((item) => ({ ...item, subitems: valid(item.subitems) })); }
    const items = valid(navigation.toc);
    outline(items.length ? items : fallbackOutline(), (item) => display(sectionTarget(item.href)));
  }).catch(() => outline(fallbackOutline(), (item) => display(sectionTarget(item.href))));
  let resizeTimer;
  const resize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { fitStage(); rendition.resize(stage.clientWidth, stage.clientHeight); }, 200); };
  window.addEventListener('resize', resize);
  disposers.push(() => { clearTimeout(resizeTimer); window.removeEventListener('resize', resize); rendition.destroy(); });
}

async function boot() {
  if (!id || id.length > 200) { showError('请从资料库选择要打开的资料。', '没有选择资料', false); return; }
  try {
    const preferences = JSON.parse(localStorage.getItem('family-reader-appearance') || '{}');
    theme = preferences.theme === 'night' ? 'night' : 'day';
    fontSize = Number.isFinite(preferences.fontSize) ? clamp(preferences.fontSize, 14, 30) : 18;
  } catch {}
  document.body.dataset.theme = theme;
  document.documentElement.style.setProperty('--page-size', fontSize + 'px');
  if (!memberId || memberId.length > 100 || /[\x00-\x1f]/.test(memberId)) { showError('阅读成员无效，请返回资料库重新选择。', '请选择阅读成员', false); return; }
  const data = await api('document?id=' + encodeURIComponent(id) + '&member=' + encodeURIComponent(memberId));
  memberName = data.member?.name || (memberId === 'family' ? '家庭共享' : '当前成员');
  $('#readerMember').textContent = '阅读成员 · ' + memberName;
  $('#readerMember').title = '此阅读页的进度保存到「' + memberName + '」';
  $('#positionLabel').textContent = '正在读取' + memberName + '的阅读进度';
  const book = data.book;
  if (!book) throw new Error('这份资料已不在资料库中。');
  savedProgress = data.progress || null;
  if (savedProgress) lastSavedKey = progressKey(savedProgress);
  $('#documentTitle').textContent = book.title || book.file?.name || '未命名资料';
  document.title = (book.title || '阅读资料') + ' · 家庭知库';
  const file = book.file;
  $('#documentMeta').textContent = file ? [file.format, sizeLabel(file.size), file.name].filter(Boolean).join(' · ') : '资料库记录';
  if (!file?.available) { showError(file ? '原文件已移动或暂时不可读取。请检查 NAS 书籍目录，再扫描资料库。' : '这条资料尚未关联原文件，当前无法预览或下载。', '暂时找不到原文件', false); return; }
  for (const link of [$('#download'), $('#fallbackDownload')]) { link.href = downloadURL; link.download = file.name || ''; link.hidden = false; }
  await responseOrError(await fetch(contentURL, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' }));
  try { await api('reading-open', { id, memberId }); }
  catch (error) { if (leaving) return; $('#saveStatus').textContent = '最近阅读暂未记录；可以继续阅读'; $('#saveStatus').classList.add('save-error'); }
  if (file.preview === 'pdf') await openPDF();
  else if (file.preview === 'epub') await openEPUB(book);
  else if (file.preview === 'text') await openText();
  else if (file.preview === 'image') await openImage(book);
  else if (file.preview === 'audio' || file.preview === 'video') await openMedia(book, file.preview);
  else showError('这种格式目前没有网页预览，可以下载原文件，在对应的应用中打开。', '下载后打开这份资料', false);
}
boot().catch((error) => { if (!leaving) showError(error.message || '资料打开失败，请重新加载或下载原文件。'); });
