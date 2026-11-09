'use strict';

const $ = selector => document.querySelector(selector);
const LEGACY_KEY = 'yiwushu-books-v1';
const RETURN_KEY = 'family-knowledge-return';
const MEMBER_KEY = 'family-knowledge-member';
const TYPES = ['电子书', '期刊论文', '学位论文', '会议论文', '报告', '标准规范', '专利', '资料文档', '数据集', '图片', '音频', '视频', '其他'];
const DEFAULT_QUERY = { q: '', field: 'all', type: '', format: '', category: '', tag: '', yearFrom: '', yearTo: '', status: '', availability: '', favorite: '', directory: '', recursive: '1', sort: 'new', page: 1, pageSize: 25, view: 'list' };
const FILTER_KEYS = ['directory', 'recursive', 'type', 'format', 'category', 'tag', 'yearFrom', 'yearTo', 'status', 'availability', 'favorite'];
const EDIT_FIELDS = ['title', 'author', 'resourceType', 'category', 'year', 'source', 'doi', 'abstract', 'status', 'location', 'borrower', 'notes'];
const state = { query: readQuery(), authenticated: false, setup: false, fileLibrary: false, version: 0, items: [], total: 0, pageSize: 25, facets: {}, stats: {}, request: 0, controller: null, mutating: 0, scanning: false, detail: null, detailRequest: 0, edit: null, editSnapshot: '', saving: false, conflict: null, members: [], memberId: storedMember(), memberEditing: null, recentRequest: 0, recentController: null, recentSignature: '', directoryRequest: 0, directoryController: null, directoryPage: 1, directoryPages: 1, directoryQuery: '', directoryVersion: -1 };
let toastTimer;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function text(value) { return typeof value === 'string' ? value : ''; }
function storedMember() { try { return localStorage.getItem(MEMBER_KEY) || 'family'; } catch { return 'family'; } }
function currentMember() { return state.members.find(member => member.id === state.memberId) || { id: state.memberId, name: state.memberId === 'family' ? '家庭共享' : '当前成员' }; }
function documentPath(id) { return 'document?id=' + encodeURIComponent(id) + '&member=' + encodeURIComponent(state.memberId); }
function hasFilter(key) { return key === 'recursive' ? state.query.recursive === '0' : !!state.query[key]; }
function count(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—'; }
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4500);
}
function closeMenu() { $('#accountMenu').open = false; }
function showDialog(dialog) { if (!dialog.open) dialog.showModal(); }
function fileSize(bytes) {
  if (!Number.isFinite(Number(bytes))) return '';
  const n = Number(bytes);
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
async function api(path, method = 'GET', data, signal) {
  const response = await fetch('/api/family/' + path, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    const error = new Error(result.error || '请求未完成，请稍后重试（' + response.status + '）');
    error.status = response.status;
    throw error;
  }
  return result;
}
async function handleError(error) {
  if (error.name === 'AbortError') return;
  if (error.status === 401) {
    hideLibrary();
    await boot();
    $('#loginError').textContent = '登录已过期，请重新输入家庭账号和密码。';
  } else toast(error.message || '连接失败，请稍后重试。');
}
function readQuery() {
  const params = new URLSearchParams(location.search);
  const query = { ...DEFAULT_QUERY };
  for (const key of Object.keys(query)) {
    if (!params.has(key)) continue;
    query[key] = params.get(key);
  }
  query.q = String(query.q).slice(0, 500);
  query.field = ['all', 'title', 'author', 'doi'].includes(query.field) ? query.field : 'all';
  query.sort = ['new', 'title', 'year'].includes(query.sort) ? query.sort : 'new';
  query.view = query.view === 'compact' ? 'compact' : 'list';
  query.favorite = query.favorite === '1' ? '1' : '';
  query.recursive = query.recursive === '0' ? '0' : '1';
  query.directory = String(query.directory).slice(0, 4096);
  if (/^[\/\\]|[\x00-\x1f]/.test(query.directory) || query.directory.split('/').some(part => part === '.' || part === '..')) query.directory = '';
  query.availability = ['available', 'missing'].includes(query.availability) ? query.availability : '';
  query.status = ['未读', '在读', '读完', 'lent'].includes(query.status) ? query.status : '';
  query.type = TYPES.includes(query.type) ? query.type : '';
  query.page = Math.max(1, Math.min(100000, parseInt(query.page, 10) || 1));
  query.pageSize = 25;
  for (const key of ['yearFrom', 'yearTo']) query[key] = /^\d{4}$/.test(query[key]) ? query[key] : '';
  for (const key of ['format', 'category', 'tag']) query[key] = String(query[key]).slice(0, 80);
  return query;
}
function writeUrl() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.query)) {
    if (key === 'pageSize' || value === '' || value === DEFAULT_QUERY[key]) continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  const url = location.pathname + (suffix ? '?' + suffix : '');
  if (url !== location.pathname + location.search) history.pushState(null, '', url);
}
function safeReaderNext() {
  const next = new URLSearchParams(location.search).get('next');
  if (!next) return null;
  try {
    const url = new URL(next, location.origin);
    const id = url.searchParams.get('id');
    if (url.origin !== location.origin || url.pathname !== '/reader.html' || !id || id.length > 100 || url.username || url.password) return null;
    const member = url.searchParams.get('member') ?? 'family';
    if (!member || member.length > 100 || /[\x00-\x1f]/.test(member)) return null;
    return '/reader.html?id=' + encodeURIComponent(id) + '&member=' + encodeURIComponent(member);
  } catch { return null; }
}
function syncControls() {
  const query = state.query;
  $('#searchInput').value = query.q;
  $('#searchField').value = query.field;
  $('#sort').value = query.sort;
  $('#yearFrom').value = query.yearFrom;
  $('#yearTo').value = query.yearTo;
  $('#statusFilter').value = query.status;
  $('#availabilityFilter').value = query.availability;
  $('#favoriteFilter').checked = query.favorite === '1';
  $('#recursiveFilter').checked = query.recursive === '1';
  renderDirectoryBreadcrumbs();
  $('#favoritesShortcut').setAttribute('aria-pressed', String(query.favorite === '1'));
  $('#results').classList.toggle('compact', query.view === 'compact');
  for (const [id, view] of [['listView', 'list'], ['compactView', 'compact']]) {
    $(id === 'listView' ? '#listView' : '#compactView').classList.toggle('active', query.view === view);
    $('#' + id).setAttribute('aria-pressed', String(query.view === view));
  }
  renderFacets();
  renderActiveFilters();
}
function updateQuery(changes, { keepPage = false, scroll = false } = {}) {
  const directoryChanged = changes.directory !== undefined && changes.directory !== state.query.directory;
  state.query = { ...state.query, ...changes };
  if (directoryChanged) { state.directoryPage = 1; state.directoryQuery = ''; $('#directoryQuery').value = ''; state.directoryVersion = -1; }
  if (!keepPage) state.query.page = 1;
  writeUrl();
  syncControls();
  if (state.authenticated) loadResources().then(() => {
    if (scroll) $('#resultsHeading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function resetQuery(keepSearch = false) {
  const previous = state.query;
  state.query = { ...DEFAULT_QUERY, view: previous.view, q: keepSearch ? previous.q : '', field: keepSearch ? previous.field : 'all' };
  state.directoryPage = 1; state.directoryQuery = ''; state.directoryVersion = -1; $('#directoryQuery').value = '';
  $('#yearError').hidden = true;
  updateQuery({});
}
function facetItems(name) {
  return (Array.isArray(state.facets[name]) ? state.facets[name] : []).map(item => {
    if (typeof item === 'string' || typeof item === 'number') return { value: String(item), count: null };
    return { value: String(item.value ?? ''), count: Number.isFinite(Number(item.count)) ? Number(item.count) : null };
  }).filter(item => item.value !== '');
}
function fillSelect(selector, facetName, label, selected) {
  const select = $(selector);
  const items = facetItems(facetName);
  select.replaceChildren();
  const all = node('option', '', label); all.value = ''; select.append(all);
  if (selected && !items.some(item => item.value === selected)) items.unshift({ value: selected, count: null });
  for (const item of items) {
    const option = node('option', '', item.value + (item.count === null ? '' : ' (' + count(item.count) + ')'));
    option.value = item.value; select.append(option);
  }
  select.value = selected;
}
function renderFacets() {
  const selected = state.query.type;
  const entries = facetItems('types');
  if (selected && !entries.some(item => item.value === selected)) entries.unshift({ value: selected, count: 0 });
  const all = { value: '', count: Number.isFinite(state.stats.total) ? state.stats.total : null };
  $('#typeFacets').replaceChildren();
  for (const item of [all, ...entries]) {
    const button = node('button', 'facet-button' + (selected === item.value ? ' active' : ''));
    button.type = 'button'; button.setAttribute('aria-pressed', String(selected === item.value));
    button.append(node('span', '', item.value || '全部资料'), node('span', '', item.count === null ? '' : count(item.count)));
    button.addEventListener('click', () => updateQuery({ type: item.value }));
    $('#typeFacets').append(button);
  }
  fillSelect('#categoryFilter', 'categories', '全部分类', state.query.category);
  fillSelect('#formatFilter', 'formats', '全部格式', state.query.format);
  fillSelect('#tagFilter', 'tags', '全部标签', state.query.tag);
  $('#categorySuggestions').replaceChildren();
  for (const item of facetItems('categories')) { const option = node('option'); option.value = item.value; $('#categorySuggestions').append(option); }
}
function renderActiveFilters() {
  const labels = { q: '关键词', directory: '目录', recursive: '范围', type: '类型', format: '格式', category: '分类', tag: '标签', yearFrom: '起始年份', yearTo: '结束年份', status: '家庭状态', availability: '文件', favorite: '收藏' };
  const values = { lent: '已借出', available: '可用', missing: '缺失', '1': '已收藏' };
  const active = ['q', ...FILTER_KEYS].filter(hasFilter);
  $('#activeFilters').replaceChildren();
  for (const key of active) {
    const label = labels[key] + '：' + (key === 'recursive' ? '仅当前目录' : ['status', 'availability', 'favorite'].includes(key) ? (values[state.query[key]] || state.query[key]) : state.query[key]);
    const button = node('button', 'filter-chip');
    button.type = 'button'; button.setAttribute('aria-label', '移除筛选 ' + label);
    button.append(node('span', '', label), node('span', '', '×'));
    button.addEventListener('click', () => updateQuery({ [key]: key === 'recursive' ? '1' : '' }));
    $('#activeFilters').append(button);
  }
  if (active.length) {
    const clear = node('button', 'text-button', '清空全部'); clear.type = 'button'; clear.addEventListener('click', () => resetQuery()); $('#activeFilters').append(clear);
  }
  const filterCount = FILTER_KEYS.filter(hasFilter).length;
  $('#activeFilterCount').hidden = !filterCount;
  $('#activeFilterCount').textContent = String(filterCount);
}
function renderStats() {
  for (const [id, key] of [['total', 'total'], ['filesCount', 'files'], ['reading', 'reading'], ['done', 'done'], ['favoritesCount', 'favorites']]) {
    $('#' + id).textContent = Number.isFinite(state.stats[key]) ? count(state.stats[key]) : '—';
  }
}
function previewLabel(book) {
  const preview = book.file?.preview;
  if (preview === 'audio' || preview === 'video') return '播放';
  if (preview === 'image') return '预览';
  if (['pdf', 'epub', 'text'].includes(preview)) return '阅读';
  return null;
}
function readerLink(book, className) {
  const link = node('a', className, previewLabel(book) + ' ↗');
  link.href = '/reader.html?id=' + encodeURIComponent(book.id) + '&member=' + encodeURIComponent(state.memberId);
  link.setAttribute('aria-label', previewLabel(book) + '《' + book.title + '》');
  link.addEventListener('click', () => { try { sessionStorage.setItem(RETURN_KEY, location.pathname + location.search); } catch {} });
  return link;
}
function downloadLink(book, className) {
  const link = node('a', className, '下载 ↓');
  link.href = '/api/family/download?id=' + encodeURIComponent(book.id);
  link.download = text(book.file?.name) || book.title;
  link.setAttribute('aria-label', '下载《' + book.title + '》');
  return link;
}
function statusBadge(book) {
  const status = book.borrower ? '借给 ' + book.borrower : (book.status || '未读');
  const className = book.borrower ? 'borrowed' : book.status === '在读' ? 'reading' : book.status === '读完' ? 'done' : '';
  return node('span', 'reading-badge ' + className, status);
}
function tagButton(value, closeDetail = false) {
  const button = node('button', 'tag', value);
  button.type = 'button'; button.title = '筛选标签：' + value;
  button.addEventListener('click', () => { if (closeDetail) $('#detailDialog').close(); updateQuery({ tag: value }); });
  return button;
}

async function loadMembers() {
  const result = await api('members');
  state.members = Array.isArray(result.members) ? result.members : [];
  if (!state.members.some(member => member.id === state.memberId)) state.memberId = result.defaultMemberId || 'family';
  try { localStorage.setItem(MEMBER_KEY, state.memberId); } catch {}
  renderMembers();
}
function renderMembers() {
  $('#memberSelect').replaceChildren(); $('#memberList').replaceChildren();
  for (const member of state.members) {
    const option = node('option', '', member.name); option.value = member.id; $('#memberSelect').append(option);
    const row = node('div', 'member-row');
    const choose = node('button', 'member-choice'); choose.type = 'button'; choose.setAttribute('aria-pressed', String(member.id === state.memberId));
    choose.append(node('span', 'member-avatar', Array.from(member.name)[0] || '家'), node('span', 'member-choice-name', member.name), node('span', 'member-choice-state', member.id === state.memberId ? '当前' : '选择'));
    choose.addEventListener('click', () => { $('#memberDialog').close(); void switchMember(member.id); });
    const rename = node('button', 'text-button', '改名'); rename.type = 'button'; rename.setAttribute('aria-label', '为' + member.name + '改名');
    rename.addEventListener('click', () => {
      state.memberEditing = member.id; $('#memberName').value = member.name; $('#memberFormTitle').textContent = '修改成员名称'; $('#saveMember').textContent = '保存名称'; $('#cancelMemberRename').hidden = false; $('#memberError').textContent = ''; $('#memberName').focus();
    });
    row.append(choose, rename); $('#memberList').append(row);
  }
  $('#memberSelect').value = state.memberId; $('#memberSelect').disabled = !state.members.length;
  $('#recentMember').textContent = currentMember().name;
}
function resetMemberForm() {
  state.memberEditing = null; $('#memberForm').reset(); $('#memberFormTitle').textContent = '新增成员'; $('#saveMember').textContent = '新增成员'; $('#cancelMemberRename').hidden = true; $('#memberError').textContent = '';
}
async function switchMember(memberId) {
  if (!state.members.some(member => member.id === memberId)) return;
  state.memberId = memberId; state.detailRequest++; state.recentSignature = '';
  try { localStorage.setItem(MEMBER_KEY, memberId); } catch {}
  renderMembers(); renderRows();
  releaseCovers($('#recentList')); $('#recentList').replaceChildren();
  await loadRecent();
  if ($('#detailDialog').open && state.detail?.book) await openDetail(state.detail.book.id);
}
function readingLabel(progress) {
  if (!progress || !Number.isFinite(Number(progress.progress))) return '已打开，尚未记录进度';
  const percentage = Math.round(Math.max(0, Math.min(1, Number(progress.progress))) * 100);
  if (progress.kind === 'image') return '已查看图片';
  return (['audio', 'video'].includes(progress.kind) ? '播放至 ' : '已读 ') + percentage + '%';
}
async function loadRecent() {
  if (!state.authenticated) return;
  state.recentController?.abort(); const controller = new AbortController(); state.recentController = controller;
  const request = ++state.recentRequest, memberId = state.memberId;
  $('#recentSection').hidden = false; $('#recentMember').textContent = currentMember().name;
  if (!$('#recentList').childElementCount) $('#recentMessage').textContent = '正在读取最近阅读…';
  try {
    const result = await api('recent?member=' + encodeURIComponent(memberId) + '&limit=8', 'GET', undefined, controller.signal);
    if (request !== state.recentRequest || memberId !== state.memberId || !state.authenticated) return;
    const items = Array.isArray(result.items) ? result.items : [];
    const signature = JSON.stringify([memberId, items]);
    $('#recentMessage').textContent = items.length ? '' : currentMember().name + '还没有阅读记录。打开一份资料，就会出现在这里。';
    $('#recentSummary').hidden = !items.length;
    $('#recentSummary').textContent = '最近 ' + items.length + ' 份 · 共打开过 ' + count(result.total) + ' 份资料';
    if (signature === state.recentSignature) return;
    state.recentSignature = signature;
    releaseCovers($('#recentList')); $('#recentList').replaceChildren();
    for (const book of items) {
      const card = node('article', 'recent-card'); card.append(coverTile(book));
      const content = node('div', 'recent-card-content');
      const title = node('button', 'recent-title', book.title || '未命名资料'); title.type = 'button'; title.addEventListener('click', () => openDetail(book.id));
      content.append(title, node('p', 'recent-progress-label', readingLabel(book.progress)));
      if (book.progress && Number.isFinite(Number(book.progress.progress))) {
        const bar = node('progress', 'reading-progress'); bar.max = 1; bar.value = Math.max(0, Math.min(1, Number(book.progress.progress))); bar.setAttribute('aria-label', readingLabel(book.progress)); content.append(bar);
      }
      const foot = node('div', 'recent-card-foot');
      const stamp = Number(book.lastOpened || book.progress?.updated);
      foot.append(node('span', 'recent-date', Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' 打开' : '最近打开'));
      if (book.file?.available && previewLabel(book)) { const link = readerLink(book, 'recent-read'); link.textContent = book.progress ? '继续阅读 →' : (previewLabel(book) + ' →'); if (['audio', 'video'].includes(book.file.preview)) link.textContent = '继续播放 →'; foot.append(link); }
      else foot.append(node('span', 'recent-unavailable', book.file && !book.file.available ? '原文件缺失' : '下载后打开'));
      content.append(foot); card.append(content); $('#recentList').append(card);
    }
  } catch (error) {
    if (error.name === 'AbortError' || request !== state.recentRequest) return;
    $('#recentMessage').textContent = '最近阅读暂时无法加载，可点击刷新重试。';
    if (error.status === 401) await handleError(error);
  }
}
function renderDirectoryBreadcrumbs() {
  const nav = $('#directoryBreadcrumbs'); nav.replaceChildren();
  const segments = state.query.directory ? state.query.directory.split('/') : [];
  const entries = [{ path: '', name: '资料根目录' }, ...segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join('/') }))];
  entries.forEach((entry, index) => {
    if (index) nav.append(node('span', 'directory-separator', '›'));
    const button = node('button', '', entry.name); button.type = 'button'; button.title = entry.path || '全部资料目录';
    if (index === entries.length - 1) button.setAttribute('aria-current', 'location');
    button.addEventListener('click', () => updateQuery({ directory: entry.path })); nav.append(button);
  });
}
async function loadDirectories({ quiet = false } = {}) {
  if (!state.authenticated || !state.fileLibrary) return;
  state.directoryController?.abort(); const controller = new AbortController(); state.directoryController = controller;
  const request = ++state.directoryRequest, version = state.version;
  const params = new URLSearchParams({ path: state.query.directory, page: String(state.directoryPage), pageSize: '50', q: state.directoryQuery });
  if (!quiet) $('#directoryMessage').textContent = '正在读取目录…';
  try {
    const result = await api('directories?' + params, 'GET', undefined, controller.signal);
    if (request !== state.directoryRequest || !state.authenticated) return;
    state.directoryVersion = version; state.directoryPages = Math.max(1, Number(result.pages) || 1);
    if (state.directoryPage > state.directoryPages) { state.directoryPage = state.directoryPages; void loadDirectories(); return; }
    $('#directoryList').replaceChildren();
    const items = Array.isArray(result.items) ? result.items : [];
    for (const item of items) {
      const button = node('button', 'directory-button'); button.type = 'button'; button.title = item.path;
      button.append(node('span', 'folder-icon', '▱'), node('span', 'directory-name', item.name), node('span', 'directory-count', count(item.count)));
      button.setAttribute('aria-label', '打开目录 ' + item.name + '，' + count(item.count) + ' 份资料');
      button.addEventListener('click', () => updateQuery({ directory: item.path })); $('#directoryList').append(button);
    }
    $('#directoryMessage').textContent = items.length ? '' : state.directoryQuery ? '没有匹配的子目录' : '当前目录没有子目录';
    $('#directoryPagination').hidden = state.directoryPages <= 1;
    $('#directoryPageLabel').textContent = state.directoryPage + ' / ' + state.directoryPages;
    $('#previousDirectoryPage').disabled = state.directoryPage <= 1; $('#nextDirectoryPage').disabled = state.directoryPage >= state.directoryPages;
  } catch (error) {
    if (error.name === 'AbortError' || request !== state.directoryRequest) return;
    $('#directoryMessage').textContent = '目录暂时无法读取，请重新检索或刷新。';
    if (error.status === 401) await handleError(error);
  }
}

// Covers are requested only near the viewport. Each visible tile retries a pending
// thumbnail with a bounded backoff; changing pages revokes blobs and aborts requests.
const coverEntries = new Map(), coverQueue = [];
const MAX_COVER_ATTEMPTS = 30;
let coverRunning = 0;
const coverObserver = new IntersectionObserver(entries => {
  for (const observed of entries) {
    const entry = coverEntries.get(observed.target); if (!entry) continue;
    entry.visible = observed.isIntersecting;
    if (entry.visible) queueCover(entry);
    else { clearTimeout(entry.timer); entry.timer = null; entry.controller?.abort(); }
  }
}, { rootMargin: '100px' });
function coverTile(book) {
  const kind = book.file?.preview;
  const tile = node('div', 'cover-frame cover-kind-' + (['pdf', 'epub', 'image', 'audio', 'video'].includes(kind) ? kind : 'document'));
  tile.setAttribute('aria-hidden', 'true');
  tile.append(node('span', 'cover-glyph', kind === 'audio' ? '♫' : kind === 'video' ? '▷' : kind === 'image' ? '▧' : '▤'), node('span', 'cover-format', text(book.file?.format).toUpperCase() || 'DOC'));
  if (book.file?.available && ['pdf', 'epub', 'image'].includes(kind)) {
    const entry = { node: tile, id: book.id, attempts: 0, visible: false, queued: false, loading: false, done: false, timer: null, controller: null, url: null };
    coverEntries.set(tile, entry); coverObserver.observe(tile);
  }
  return tile;
}
function releaseCovers(container) {
  for (const [element, entry] of coverEntries) if (!container || container.contains(element)) {
    coverObserver.unobserve(element); clearTimeout(entry.timer); entry.controller?.abort(); if (entry.url) URL.revokeObjectURL(entry.url); coverEntries.delete(element);
  }
}
function queueCover(entry) {
  if (!coverEntries.has(entry.node) || !entry.visible || entry.done || entry.loading || entry.queued || entry.timer || entry.attempts >= MAX_COVER_ATTEMPTS) return;
  entry.queued = true; coverQueue.push(entry); pumpCovers();
}
function pumpCovers() {
  while (state.authenticated && coverRunning < 3 && coverQueue.length) {
    const entry = coverQueue.shift(); entry.queued = false;
    if (!coverEntries.has(entry.node) || !entry.node.isConnected || !entry.visible || entry.done || entry.loading) continue;
    entry.loading = true; entry.attempts++; coverRunning++; void fetchCover(entry);
  }
}
async function fetchCover(entry) {
  const controller = new AbortController(); entry.controller = controller;
  let retry = false;
  try {
    const response = await fetch('/api/family/cover?id=' + encodeURIComponent(entry.id), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!coverEntries.has(entry.node)) return;
    if (response.status === 202) { retry = true; return; }
    if (response.status === 401) { const error = new Error('登录已过期'); error.status = 401; if (state.authenticated) await handleError(error); return; }
    if (response.status !== 200 || !/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i.test(response.headers.get('content-type') || '')) { entry.done = true; return; }
    const blob = await response.blob();
    if (!coverEntries.has(entry.node) || controller.signal.aborted) return;
    entry.done = true; if (blob.size > 3 * 1024 * 1024) return;
    const img = node('img', 'cover-image'); img.alt = ''; img.decoding = 'async';
    entry.url = URL.createObjectURL(blob); img.src = entry.url;
    img.onload = () => { if (coverEntries.has(entry.node)) entry.node.classList.add('has-cover'); };
    img.onerror = () => { img.remove(); if (entry.url) URL.revokeObjectURL(entry.url); entry.url = null; };
    entry.node.append(img);
  } catch (error) { if (error.name !== 'AbortError') retry = true; }
  finally {
    entry.loading = false; entry.controller = null; coverRunning--;
    if (retry && entry.visible && entry.attempts < MAX_COVER_ATTEMPTS && coverEntries.has(entry.node)) entry.timer = setTimeout(() => { entry.timer = null; queueCover(entry); }, Math.min(10000, 3000 + entry.attempts * 500));
    else if (controller.signal.aborted && entry.visible && coverEntries.has(entry.node)) queueCover(entry);
    pumpCovers();
  }
}
function renderRows() {
  releaseCovers($('#results'));
  $('#results').replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const book of state.items) {
    const row = node('article', 'resource-row');
    const kind = TYPES.includes(book.resourceType) ? book.resourceType : '其他';
    const tile = coverTile(book);
    const content = node('div', 'resource-content');
    const kicker = node('div', 'resource-kicker');
    kicker.append(node('span', 'resource-type', kind));
    if (book.file) {
      kicker.append(node('span', book.file.available ? '' : 'record-state', book.file.available ? fileSize(book.file.size) : '原文件缺失'));
    } else kicker.append(node('span', '', '目录记录'));
    const title = node('button', 'resource-title', book.title || '未命名资料'); title.type = 'button';
    title.addEventListener('click', () => openDetail(book.id));
    content.append(kicker, title);
    const metadata = [book.author, book.year, book.source || book.category].map(text).filter(Boolean);
    if (metadata.length) {
      const line = node('p', 'resource-meta');
      metadata.forEach((value, index) => { if (index) line.append(node('span', 'meta-separator', '·')); line.append(node('span', '', value)); });
      content.append(line);
    }
    if (book.abstract) content.append(node('p', 'resource-abstract', book.abstract));
    const bottom = node('div', 'resource-bottom');
    bottom.append(statusBadge(book));
    if (Array.isArray(book.tags) && book.tags.length) {
      const tags = node('div', 'resource-tags');
      for (const tag of book.tags.slice(0, 4)) tags.append(tagButton(tag));
      if (book.tags.length > 4) tags.append(node('span', 'tag', '+' + (book.tags.length - 4)));
      bottom.append(tags);
    }
    content.append(bottom);
    const actions = node('div', 'resource-actions');
    const favorite = node('button', 'favorite-button', book.favorite ? '★' : '☆');
    favorite.type = 'button'; favorite.setAttribute('aria-label', (book.favorite ? '取消收藏' : '收藏') + '《' + book.title + '》'); favorite.setAttribute('aria-pressed', String(!!book.favorite));
    favorite.addEventListener('click', () => toggleFavorite(book.id, favorite));
    actions.append(favorite);
    if (book.file?.available) {
      if (previewLabel(book)) actions.append(readerLink(book, 'row-link read-link'));
      actions.append(downloadLink(book, 'row-link'));
    }
    row.append(tile, content, actions);
    fragment.append(row);
  }
  $('#results').append(fragment);
  $('#resultCount').textContent = count(state.total);
  const anyFilter = ['q', ...FILTER_KEYS].some(hasFilter);
  $('#empty').hidden = state.items.length > 0;
  $('#emptyTitle').textContent = anyFilter ? '没有找到匹配的资料' : '还没有收录资料';
  $('#emptyDescription').textContent = anyFilter ? '换个关键词，或减少筛选条件，再找找看。' : '扫描 NAS 上的资料目录，或手动添加第一条记录。';
  $('#emptyAction').textContent = anyFilter ? '清空筛选' : '新增资料';
  $('#emptyAction').onclick = () => anyFilter ? resetQuery() : openEditor();
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $('#pagination').hidden = !state.total;
  $('#previousPage').disabled = state.query.page <= 1;
  $('#nextPage').disabled = state.query.page >= pages;
  $('#pagePosition').textContent = state.query.page + ' / ' + pages;
  const from = state.total ? (state.query.page - 1) * state.pageSize + 1 : 0;
  const to = Math.min(state.query.page * state.pageSize, state.total);
  $('#pageSummary').textContent = '显示 ' + count(from) + '–' + count(to) + ' 条，共 ' + count(state.total) + ' 条';
  $('#clearDemo').hidden = !state.items.some(book => book.demo);
}
async function loadResources({ quiet = false } = {}) {
  if (!state.authenticated) return;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const request = ++state.request;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.query)) if (key !== 'view' && value !== '') params.set(key, String(value));
  $('#loadError').hidden = true;
  if (!quiet) {
    $('#loading').hidden = false;
    $('#empty').hidden = true;
    $('#results').setAttribute('aria-busy', 'true');
  }
  try {
    const result = await api('resources?' + params, 'GET', undefined, controller.signal);
    if (request !== state.request || !state.authenticated) return;
    const unchanged = quiet && result.version === state.version && JSON.stringify(result.items) === JSON.stringify(state.items);
    state.items = Array.isArray(result.items) ? result.items : [];
    state.total = Math.max(0, Number(result.total) || 0);
    state.version = result.version;
    state.pageSize = Number(result.pageSize) || 25;
    state.stats = result.stats || {};
    state.facets = result.facets || {};
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.query.page > pages) { updateQuery({ page: pages }, { keepPage: true }); return; }
    renderStats(); renderFacets(); if (!unchanged) renderRows();
    if (state.directoryVersion !== state.version) void loadDirectories({ quiet: true });
    $('#syncStatus').textContent = '已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    if (error.name === 'AbortError' || request !== state.request) return;
    if (error.status === 401) await handleError(error);
    else {
      $('#loadError').hidden = false;
      $('#loadErrorMessage').textContent = error.message || '无法连接 NAS，请检查网络后重试。';
      $('#syncStatus').textContent = '连接中断';
    }
  } finally {
    if (request === state.request) {
      $('#loading').hidden = true;
      $('#results').setAttribute('aria-busy', 'false');
    }
  }
}
function hideLibrary() {
  state.authenticated = false; state.request++; state.detailRequest++;
  state.recentRequest++; state.directoryRequest++; state.recentController?.abort(); state.directoryController?.abort(); releaseCovers();
  state.controller?.abort(); state.items = [];
  $('#results').replaceChildren();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#appShell').hidden = true; $('#loginScreen').hidden = false;
  $('#loginForm').reset(); $('#passwordForm').reset(); closeMenu();
}
async function boot() {
  try {
    const session = await api('session');
    state.authenticated = !!session.authenticated;
    state.setup = !session.configured;
    state.fileLibrary = !!session.fileLibraryEnabled;
    $('#loginForm').hidden = false;
    $('#setupTokenLabel').hidden = !state.setup;
    $('#confirmLabel').hidden = !state.setup;
    const form = $('#loginForm');
    form.elements.setupToken.required = state.setup;
    form.elements.confirmPassword.required = state.setup;
    form.elements.password.minLength = state.setup ? 12 : 1;
    form.elements.password.autocomplete = state.setup ? 'new-password' : 'current-password';
    $('#loginTitle').textContent = state.setup ? '开启家庭知库' : '欢迎回来';
    $('#loginSubmit').textContent = state.setup ? '创建家庭账号 →' : '登录家庭知库 →';
    $('#loginHint').textContent = state.setup ? '首次使用：读取 NAS 的 /data/setup-token.txt 初始化密钥，再设置全家共用的账号及至少 12 位密码。' : '登录全家共用的账号，继续探索已收藏的资料。';
    $('#scanBooks').hidden = !state.fileLibrary;
    $('#accountName').textContent = (session.username || '家庭') + ' · 共享账号';
    if (state.authenticated) {
      const next = safeReaderNext();
      if (next) { location.replace(next); return; }
      $('#loginScreen').hidden = true; $('#appShell').hidden = false;
      try { $('#migrate').hidden = !localStorage.getItem(LEGACY_KEY); } catch { $('#migrate').hidden = true; }
      syncControls();
      await loadMembers();
      await Promise.all([loadResources(), loadRecent()]);
    } else { $('#appShell').hidden = true; $('#loginScreen').hidden = false; }
  } catch (error) {
    $('#loginHint').textContent = '暂时无法连接家庭资料库，请检查 NAS 与网络后刷新。';
    $('#loginError').textContent = error.message;
  }
}
function appendMetadata(list, name, value, placeholder = '未填写') {
  list.append(node('dt', '', name), node('dd', '', text(value) || placeholder));
}
function renderDetail() {
  const book = state.detail?.book;
  if (!book) return;
  $('#detailTitle').textContent = book.title || '未命名资料';
  $('#detailType').textContent = (book.resourceType || '其他') + (book.year ? ' / ' + book.year : '') + ' · 资料详情';
  releaseCovers($('#detailCover')); $('#detailCover').replaceChildren(coverTile(book));
  $('#detailMemberName').textContent = currentMember().name + '的阅读进度';
  $('#detailProgressLabel').textContent = state.detail.progress ? readingLabel(state.detail.progress) : '还没有记录阅读进度';
  $('#detailProgress').hidden = !state.detail.progress;
  $('#detailProgress').value = Math.max(0, Math.min(1, Number(state.detail.progress?.progress) || 0));
  $('#detailMetadata').replaceChildren();
  for (const [name, value] of [['作者', book.author], ['年份', book.year], ['来源', book.source], ['分类', book.category], ['DOI', book.doi]]) appendMetadata($('#detailMetadata'), name, value);
  const metadataState=book.file?.metadataStatus;
  $('#detailMetadataHint').hidden=!['PDF','EPUB'].includes(book.file?.format);
  $('#detailMetadataHint').textContent=['pending','running'].includes(metadataState)?'正在后台逐步提取作者、年份等信息，可以先阅读。已手动填写的内容会保留。':metadataState==='failed'?'此文件暂未能自动提取信息（可能加密、损坏或过于复杂），可手动补充。':'仅自动填写文件中能识别的文献信息；缺失字段和主题分类可手动补充。';
  $('#detailAbstract').textContent = book.abstract || '暂无摘要或说明，可在编辑资料时补充。';
  $('#detailAbstract').classList.toggle('is-empty', !book.abstract);
  $('#detailNotes').textContent = book.notes || '还没有笔记。读到有启发的地方，记下来与家人分享。';
  $('#detailNotes').classList.toggle('is-empty', !book.notes);
  $('#detailTags').replaceChildren();
  for (const tag of Array.isArray(book.tags) ? book.tags : []) $('#detailTags').append(tagButton(tag, true));
  $('#detailStatus').replaceWith(Object.assign(statusBadge(book), { id: 'detailStatus' }));
  $('#detailHousehold').replaceChildren();
  appendMetadata($('#detailHousehold'), '收纳位置', book.location);
  appendMetadata($('#detailHousehold'), '借阅人', book.borrower, '未借出');
  $('#detailFileActions').replaceChildren();
  if (book.file?.available) {
    if (previewLabel(book)) $('#detailFileActions').append(readerLink(book, 'button primary'));
    $('#detailFileActions').append(downloadLink(book, 'button secondary'));
    if (!previewLabel(book)) $('#detailFileActions').append(node('span', 'no-file-hint', '此格式请下载后打开'));
  } else $('#detailFileActions').append(node('span', 'no-file-hint', book.file ? '原文件已缺失，请检查目录并重新扫描。' : '此条为目录记录，尚无关联文件。'));
  $('#detailFileSection').hidden = !book.file;
  if (book.file) {
    $('#detailFileName').textContent = book.file.name || '';
    $('#detailFileMeta').textContent = [book.file.format, fileSize(book.file.size), book.file.folder].filter(Boolean).join(' · ');
    $('#detailFileState').textContent = book.file.available ? '只读访问 NAS 原文件，删除记录不会删除原文件。' : '文件当前不可用。笔记和资料信息仍然保留。';
  }
  $('#detailFavorite').textContent = book.favorite ? '★ 已收藏' : '☆ 收藏';
  $('#detailFavorite').setAttribute('aria-pressed', String(!!book.favorite));
  $('#detailContent').hidden = false;
}
async function openDetail(id) {
  const request = ++state.detailRequest;
  state.detail = null;
  $('#detailTitle').textContent = '正在读取资料…';
  $('#detailType').textContent = 'RESOURCE DETAILS';
  $('#detailContent').hidden = true; $('#detailError').hidden = true;
  showDialog($('#detailDialog'));
  try {
    const result = await api(documentPath(id));
    if (request !== state.detailRequest || !$('#detailDialog').open) return;
    state.detail = result; renderDetail();
  } catch (error) {
    if (request !== state.detailRequest) return;
    if (error.status === 401) await handleError(error);
    else { $('#detailTitle').textContent = '暂时无法读取资料'; $('#detailError').textContent = error.message; $('#detailError').hidden = false; }
  }
}
async function toggleFavorite(id, button) {
  if (button.disabled) return;
  button.disabled = true; state.mutating++;
  try {
    const current = await api(documentPath(id));
    await api('document', 'PUT', { book: { ...current.book, favorite: !current.book.favorite }, version: current.version, recordVersion:current.recordVersion });
    if (state.detail?.book?.id === id && $('#detailDialog').open) {
      state.detail = await api(documentPath(id)); renderDetail();
    }
    await loadResources({ quiet: true });
    toast(current.book.favorite ? '已取消收藏' : '已加入家庭收藏');
  } catch (error) {
    if (error.status === 409) toast('资料刚被家人更新，请刷新后再操作。');
    else await handleError(error);
  } finally { button.disabled = false; state.mutating--; }
}
function emptyBook() {
  return { id: newId(), title: '', author: '', resourceType: '其他', category: '', year: '', source: '', doi: '', abstract: '', tags: [], favorite: false, status: '未读', location: '', borrower: '', notes: '', color: '#456258', demo: false, created: Date.now() };
}
function formSnapshot() { return JSON.stringify(Array.from(new FormData($('#editForm')).entries())); }
function fillEditor(book) {
  const form = $('#editForm');
  form.reset();
  for (const key of EDIT_FIELDS) form.elements[key].value = book[key] || (key === 'resourceType' ? '其他' : key === 'status' ? '未读' : '');
  form.elements.tags.value = Array.isArray(book.tags) ? book.tags.join('，') : '';
  form.elements.favorite.checked = !!book.favorite;
  $('#editorFileHint').hidden = !book.file;
  $('#editorFileHint').textContent = book.file ? '关联文件：' + book.file.name + '。此处只修改资料信息，原文件保持不变。' : '';
  state.editSnapshot = formSnapshot();
}
async function openEditor(id) {
  closeMenu();
  $('#editorError').textContent = '';
  $('#editorConflict').hidden = true; $('#conflictContent').hidden = true;
  state.conflict = null;
  try {
    const result = id ? await api(documentPath(id)) : { book: emptyBook(), version: state.version, recordVersion:'new' };
    state.edit = { ...result, isNew: !id };
    $('#editorTitle').textContent = id ? '编辑资料与笔记' : '新增资料';
    fillEditor(result.book);
    $('#detailDialog').close();
    showDialog($('#editor'));
    $('#editor').scrollTop = 0;
  } catch (error) { await handleError(error); }
}
function closeEditor() {
  if (state.saving) return;
  if (formSnapshot() !== state.editSnapshot && !confirm('表单中的修改还没有保存，确定离开吗？')) return;
  $('#editor').close();
}
function collectBook() {
  const form = $('#editForm');
  const book = { ...state.edit.book };
  for (const key of EDIT_FIELDS) book[key] = form.elements[key].value.trim();
  book.tags = Array.from(new Set(form.elements.tags.value.split(/[,，;；\n]/).map(tag => tag.trim()).filter(Boolean)));
  book.favorite = form.elements.favorite.checked;
  if (!book.title) throw new Error('请填写资料题名。');
  if (book.year && !/^\d{4}$/.test(book.year)) throw new Error('年份请填写 4 位数字，或留空。');
  if (book.tags.length > 30 || book.tags.some(tag => tag.length > 40)) throw new Error('标签最多 30 个，每个最多 40 字。');
  return book;
}
async function saveEditor() {
  if (state.saving || !state.edit || !$('#editForm').reportValidity()) return;
  $('#editorError').textContent = '';
  let book;
  try { book = collectBook(); } catch (error) { $('#editorError').textContent = error.message; return; }
  state.saving = true; state.mutating++; $('#saveRecord').disabled = true;
  try {
    await api('document', 'PUT', { book, version: state.edit.version,recordVersion:state.edit.recordVersion });
    $('#editor').close(); state.editSnapshot = formSnapshot();
    await loadResources();
    toast('资料与笔记已保存');
  } catch (error) {
    if (error.status === 409) {
      $('#editorConflict').hidden = false; $('#conflictContent').hidden = true; state.conflict = null;
      $('#editorError').textContent = '保存发生冲突，表单内容没有丢失。';
      $('#editorConflict').scrollIntoView({ block: 'nearest' });
    } else if (error.status === 401) await handleError(error);
    else $('#editorError').textContent = error.message;
  } finally { state.saving = false; state.mutating--; $('#saveRecord').disabled = false; }
}
async function reviewConflict() {
  if (!state.edit) return;
  $('#reviewConflict').disabled = true;
  try {
    if (state.edit.isNew) {
      const result = await api('resources?page=1&pageSize=1');
      state.conflict = { book: null, version: result.version,recordVersion:'new' };
      $('#conflictPreview').textContent = '资料库中有新的改动。你的新增资料尚未写入；继续保存会使用最新的资料库版本。';
      $('#useLatest').hidden = true;
    } else {
      state.conflict = await api(documentPath(state.edit.book.id));
      const book = state.conflict.book;
      $('#conflictPreview').textContent = [['题名', book.title], ['作者', book.author], ['类型', book.resourceType], ['年份', book.year], ['来源', book.source], ['分类', book.category], ['DOI', book.doi], ['标签', (book.tags || []).join('，')], ['摘要', book.abstract], ['阅读状态', book.status], ['位置', book.location], ['借阅人', book.borrower], ['笔记', book.notes]].map(pair => pair[0] + '：' + (pair[1] || '未填写')).join('\n\n');
      $('#useLatest').hidden = false;
    }
    $('#conflictContent').hidden = false;
  } catch (error) { $('#editorError').textContent = error.message; }
  finally { $('#reviewConflict').disabled = false; }
}
async function deleteRecord() {
  if (!state.detail?.book || !confirm('删除这条资料记录和笔记？NAS 原文件不会删除，文件仍在目录时，下次扫描会重新加入。')) return;
  $('#deleteRecord').disabled = true; state.mutating++;
  try {
    await api('document?id=' + encodeURIComponent(state.detail.book.id), 'DELETE', { version: state.detail.version,recordVersion:state.detail.recordVersion });
    $('#detailDialog').close();
    await loadResources();
    toast('资料记录已删除，原文件未改动');
  } catch (error) {
    if (error.status === 409) toast('资料刚被家人更新。请重新打开详情，核对后再删除。');
    else await handleError(error);
  } finally { $('#deleteRecord').disabled = false; state.mutating--; }
}
async function exportBackup() {
  closeMenu(); $('#export').disabled = true;
  try {
    const result = await api('books');
    const content = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), books: result.books }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = node('a'); anchor.href = url; anchor.download = '家庭知库-资料备份-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('资料与笔记备份已生成；原始文件需另行备份。');
  } catch (error) { await handleError(error); }
  finally { $('#export').disabled = false; }
}
async function importBackup(file) {
  if (!file) return;
  state.mutating++;
  try {
    if (file.size > 256 * 1024 * 1024) throw new Error('JSON 备份超过 256 MiB，请使用 NAS 数据卷备份恢复。');
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效的 JSON 备份。'); }
    if (data.version !== 1 || !Array.isArray(data.books) || !data.books.every(book => book && typeof book.id === 'string' && typeof book.title === 'string')) throw new Error('备份格式不正确。请选择家庭知库或旧版一屋书导出的 JSON 文件。');
    const current = await api('books');
    if (!confirm('备份包含 ' + data.books.length + ' 条资料，将替换现有资料信息和笔记。建议先导出当前备份。确认导入？')) return;
    await api('books', 'PUT', { books: data.books, version: current.version });
    await loadResources();
    toast('备份已导入，原始文件未改动');
  } catch (error) {
    if (error.status === 409) toast('家人刚更新了资料，导入未执行。请核对后重新导入。');
    else await handleError(error);
  } finally { state.mutating--; $('#importFile').value = ''; }
}
async function migrateLegacy() {
  closeMenu(); state.mutating++;
  try {
    let books;
    try { books = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch { throw new Error('无法读取本机旧书架，可以尝试导入 JSON 备份。'); }
    if (!Array.isArray(books) || !books.every(book => book && typeof book.id === 'string' && typeof book.title === 'string')) throw new Error('本机旧书架格式不正确。');
    const current = await api('books');
    const ids = new Set(current.books.map(book => book.id));
    const added = books.filter(book => !ids.has(book.id));
    if (!added.length) { toast('旧书架中的资料已在家庭知库中。'); return; }
    if (!confirm('把本机旧书架的 ' + added.length + ' 条记录合并到资料库？旧数据会继续保留。')) return;
    await api('books', 'PUT', { books: [...current.books, ...added], version: current.version });
    await loadResources(); toast('本机旧书架已合并');
  } catch (error) { await handleError(error); }
  finally { state.mutating--; }
}
async function scanFiles() {
  if (state.scanning) return;
  state.scanning = true;
  const button = $('#scanBooks'); button.disabled = true; button.textContent = '正在扫描…';
  $('#scanResult').hidden = false; $('#scanResult').textContent = '正在扫描资料目录和子目录，请稍候。已有笔记和人工编辑的信息会保留。';
  try {
    renderScan(await api('scan', 'POST', {background:true}));
    toast('已开始后台收录，可以继续浏览或关闭页面');
  } catch (error) {
    $('#scanResult').textContent = '扫描未完成：' + error.message;
    if (error.status === 401) await handleError(error);
    state.scanning=false;button.disabled=false;button.textContent='↻ 扫描资料';
  }
}
function renderScan(result) {
  state.scanning=!!result.running;
  const button=$('#scanBooks');button.disabled=state.scanning;button.textContent=state.scanning?'正在收录…':'↻ 扫描资料';
  const m=result.metadata||{},processed=(m.done||0)+(m.empty||0)+(m.failed||0);
  if(!result.started&&!m.total)return;
  const parts=[result.started?(result.running?'正在收录':'目录扫描已结束'):'后台文献信息提取'];
  if(result.started)parts.push('发现 '+count(result.found)+' 个文件，新增 '+count(result.added)+' 条');
  if(result.running)parts.push('已检查 '+count(result.visited)+' 个目录条目');
  if(result.missing)parts.push(count(result.missing)+' 个原文件缺失');
  if(m.total)parts.push('文献信息已处理 '+count(processed)+' / '+count(m.total)+'，识别到信息 '+count(m.done||0)+' 份');
  if(result.error)parts.push('扫描中断：'+result.error+'；已收录记录仍可使用');
  else if(m.pending||m.running)parts.push('后台正在逐份补全，可继续浏览或关闭页面');
  else if(m.empty||m.failed)parts.push('部分文件没有可识别信息或暂无法提取，可手动补充');
  $('#scanResult').hidden=false;$('#scanResult').textContent=parts.join('。')+'。';
}
let scanPolling=false;
async function pollScan() {
  if(scanPolling||!state.authenticated||!state.fileLibrary||document.hidden)return;
  scanPolling=true;
  try {
    const result=await api('scan');renderScan(result);
    if(result.version!==state.version&&!state.mutating&&!state.saving&&!document.querySelector('dialog[open]'))await loadResources({quiet:true});
    const detail=state.detail, detailMember=state.memberId;
    if(detail&&$('#detailDialog').open&&['pending','running'].includes(detail.book.file?.metadataStatus)){
      const latest=await api(documentPath(detail.book.id));
      if(state.detail===detail&&detailMember===state.memberId&&$('#detailDialog').open){state.detail=latest;renderDetail();}
    }
  }catch(error){if(error.status===401)await handleError(error);}
  finally{scanPolling=false;}
}
setInterval(pollScan,5000);

$('#memberSelect').addEventListener('change', event => { void switchMember(event.target.value); });
$('#manageMembers').addEventListener('click', () => { resetMemberForm(); renderMembers(); showDialog($('#memberDialog')); });
$('#closeMembers').addEventListener('click', () => $('#memberDialog').close());
$('#cancelMemberRename').addEventListener('click', resetMemberForm);
$('#memberForm').addEventListener('submit', async event => {
  event.preventDefault(); const name = $('#memberName').value.trim(); $('#memberError').textContent = '';
  if (!name || name.length > 40 || /[\x00-\x1f\x7f]/.test(name)) { $('#memberError').textContent = '请填写 1–40 字的成员名称。'; return; }
  const editing = state.memberEditing; $('#saveMember').disabled = true;
  try {
    const result = await api('members', editing ? 'PUT' : 'POST', editing ? { id: editing, name } : { name });
    await loadMembers();
    if (!editing) await switchMember(result.member.id);
    else { state.recentSignature = ''; await loadRecent(); if ($('#detailDialog').open) renderDetail(); }
    resetMemberForm(); toast(editing ? '成员名称已更新' : '已新增成员，接下来的阅读进度会单独保存');
  } catch (error) { $('#memberError').textContent = error.message; if (error.status === 401) await handleError(error); }
  finally { $('#saveMember').disabled = false; }
});
$('#refreshRecent').addEventListener('click', () => { void loadRecent(); });
$('#recursiveFilter').addEventListener('change', event => updateQuery({ recursive: event.target.checked ? '1' : '0' }));
$('#directorySearch').addEventListener('submit', event => { event.preventDefault(); state.directoryQuery = $('#directoryQuery').value.trim(); state.directoryPage = 1; void loadDirectories(); });
$('#directoryQuery').addEventListener('search', () => { if (!$('#directoryQuery').value) { state.directoryQuery = ''; state.directoryPage = 1; void loadDirectories(); } });
$('#previousDirectoryPage').addEventListener('click', () => { state.directoryPage = Math.max(1, state.directoryPage - 1); void loadDirectories(); });
$('#nextDirectoryPage').addEventListener('click', () => { state.directoryPage = Math.min(state.directoryPages, state.directoryPage + 1); void loadDirectories(); });

for (const type of TYPES) { const option = node('option', '', type); option.value = type; $('#editResourceType').append(option); }
$('#searchForm').addEventListener('submit', event => { event.preventDefault(); updateQuery({ q: $('#searchInput').value.trim(), field: $('#searchField').value }); });
$('#searchInput').addEventListener('search', () => { if (!$('#searchInput').value) updateQuery({ q: '' }); });
$('#searchField').addEventListener('change', () => { state.query.field = $('#searchField').value; });
$('#sort').addEventListener('change', () => updateQuery({ sort: $('#sort').value }));
for (const [selector, key] of [['#categoryFilter', 'category'], ['#formatFilter', 'format'], ['#tagFilter', 'tag'], ['#statusFilter', 'status'], ['#availabilityFilter', 'availability']]) $(selector).addEventListener('change', event => updateQuery({ [key]: event.target.value }));
$('#favoriteFilter').addEventListener('change', event => updateQuery({ favorite: event.target.checked ? '1' : '' }));
$('#favoritesShortcut').addEventListener('click', () => updateQuery({ favorite: state.query.favorite ? '' : '1' }));
for (const selector of ['#yearFrom', '#yearTo']) $(selector).addEventListener('change', () => {
  const from = $('#yearFrom').value.trim(), to = $('#yearTo').value.trim();
  const invalid = (from && !/^\d{4}$/.test(from)) || (to && !/^\d{4}$/.test(to)) || (from && to && from > to);
  $('#yearError').hidden = !invalid; $('#yearError').textContent = '请填写有效的四位年份，起始年份不能晚于结束年份。';
  if (!invalid) updateQuery({ yearFrom: from, yearTo: to });
});
$('#resetFilters').addEventListener('click', () => resetQuery(true));
$('#listView').addEventListener('click', () => { state.query.view = 'list'; writeUrl(); syncControls(); });
$('#compactView').addEventListener('click', () => { state.query.view = 'compact'; writeUrl(); syncControls(); });
$('#previousPage').addEventListener('click', () => updateQuery({ page: Math.max(1, state.query.page - 1) }, { keepPage: true, scroll: true }));
$('#nextPage').addEventListener('click', () => updateQuery({ page: state.query.page + 1 }, { keepPage: true, scroll: true }));
$('#retryLoad').addEventListener('click', () => loadResources());
$('#openFilters').addEventListener('click', () => { $('#mobileFilters').append($('#filters')); showDialog($('#filterDialog')); });
$('#closeFilters').addEventListener('click', () => $('#filterDialog').close());
$('#applyFilters').addEventListener('click', () => $('#filterDialog').close());
$('#filterDialog').addEventListener('close', () => $('#desktopFilters').append($('#filters')));
matchMedia('(min-width:801px)').addEventListener('change', event => { if (event.matches && $('#filterDialog').open) $('#filterDialog').close(); });
$('#closeDetail').addEventListener('click', () => { state.detailRequest++; $('#detailDialog').close(); });
$('#detailDialog').addEventListener('close', () => releaseCovers($('#detailCover')));
$('#detailEdit').addEventListener('click', () => { if (state.detail?.book) openEditor(state.detail.book.id); });
$('#detailFavorite').addEventListener('click', () => { if (state.detail?.book) toggleFavorite(state.detail.book.id, $('#detailFavorite')); });
$('#deleteRecord').addEventListener('click', deleteRecord);
$('#add').addEventListener('click', () => openEditor());
$('#closeEditor').addEventListener('click', closeEditor);
$('#cancelEditor').addEventListener('click', closeEditor);
$('#editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
$('#editForm').addEventListener('submit', event => { event.preventDefault(); saveEditor(); });
$('#reviewConflict').addEventListener('click', reviewConflict);
$('#useLatest').addEventListener('click', () => {
  if (!state.conflict?.book || !confirm('用最新资料替换当前表单？当前尚未保存的输入会被替换。')) return;
  state.edit = { ...state.conflict, isNew: false };
  fillEditor(state.conflict.book);
  $('#editorConflict').hidden = true; $('#editorError').textContent = ''; state.conflict = null;
});
$('#overwriteLatest').addEventListener('click', () => {
  if (!state.conflict || !confirm(state.edit.isNew ? '使用最新资料库版本保存这条新增资料？' : '确认用当前表单内容覆盖刚查看的最新资料？')) return;
  state.edit.version = state.conflict.version;
  state.edit.recordVersion = state.conflict.recordVersion;
  if (state.conflict.book) state.edit.book = { ...state.conflict.book, ...state.edit.book };
  state.conflict = null; $('#editorConflict').hidden = true; saveEditor();
});
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; $('#loginError').textContent = '';
  if (state.setup && form.elements.password.value !== form.elements.confirmPassword.value) { $('#loginError').textContent = '两次输入的密码不一致。'; return; }
  $('#loginSubmit').disabled = true;
  try {
    await api(state.setup ? 'setup' : 'login', 'POST', { username: form.elements.username.value.trim(), password: form.elements.password.value, setupToken: state.setup ? form.elements.setupToken.value.trim() : undefined });
    form.reset(); await boot();
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { $('#loginSubmit').disabled = false; }
});
$('#logout').addEventListener('click', async () => { closeMenu(); try { await api('logout', 'POST', {}); hideLibrary(); await boot(); toast('已退出家庭知库'); } catch (error) { await handleError(error); } });
$('#refresh').addEventListener('click', () => { closeMenu(); loadResources(); });
$('#export').addEventListener('click', exportBackup);
$('#import').addEventListener('click', () => { closeMenu(); $('#importFile').click(); });
$('#importFile').addEventListener('change', event => importBackup(event.target.files[0]));
$('#migrate').addEventListener('click', migrateLegacy);
$('#clearDemo').addEventListener('click', async () => {
  closeMenu(); state.mutating++;
  try {
    const current = await api('books');
    const remaining = current.books.filter(book => !book.demo);
    if (!confirm('只移除旧版标记为示例的资料，保留所有自行添加的资料。继续？')) return;
    await api('books', 'PUT', { books: remaining, version: current.version });
    await loadResources(); toast('示例资料已移除');
  } catch (error) { await handleError(error); }
  finally { state.mutating--; }
});
$('#scanBooks').addEventListener('click', scanFiles);
$('#help').addEventListener('click', () => { closeMenu(); showDialog($('#infoDialog')); });
$('#infoClose').addEventListener('click', () => $('#infoDialog').close());
$('#passwordButton').addEventListener('click', () => { closeMenu(); $('#passwordForm').reset(); $('#passwordError').textContent = ''; showDialog($('#passwordDialog')); });
$('#passwordClose').addEventListener('click', () => { $('#passwordForm').reset(); $('#passwordDialog').close(); });
$('#passwordForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type="submit"]'); $('#passwordError').textContent = '';
  if (form.elements.password.value !== form.elements.confirmPassword.value) { $('#passwordError').textContent = '两次输入的新密码不一致。'; return; }
  button.disabled = true;
  try {
    await api('password', 'POST', { currentPassword: form.elements.currentPassword.value, password: form.elements.password.value });
    form.reset(); $('#passwordDialog').close(); toast('密码已更新，其他设备需要重新登录。');
  } catch (error) { $('#passwordError').textContent = error.message; }
  finally { button.disabled = false; }
});
document.addEventListener('click', event => { if ($('#accountMenu').open && !$('#accountMenu').contains(event.target)) closeMenu(); });
window.addEventListener('popstate', () => { state.query = readQuery(); state.directoryPage = 1; state.directoryQuery = ''; state.directoryVersion = -1; $('#directoryQuery').value = ''; syncControls(); if (state.authenticated) loadResources(); });
window.addEventListener('pagehide', () => { releaseCovers(); state.recentController?.abort(); state.directoryController?.abort(); });
window.addEventListener('pageshow', event => { if (event.persisted && state.authenticated) { renderRows(); state.recentSignature = ''; void loadRecent(); if ($('#detailDialog').open) renderDetail(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated) void loadRecent(); });
setInterval(() => {
  if (!state.authenticated || state.mutating || state.saving || document.hidden || document.querySelector('dialog[open]') || $('#accountMenu').open) return;
  loadResources({ quiet: true });
  void loadRecent();
}, 20000);

async function start() {
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const scope = location.origin + '/';
      await Promise.all(registrations.filter(registration => registration.scope === scope).map(registration => registration.unregister()));
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith('yiwushu-shell-') || key.startsWith('family-knowledge-shell-')).map(key => caches.delete(key)));
      }
      if (navigator.serviceWorker.controller) { location.reload(); return; }
    } catch {}
  }
  syncControls();
  await boot();
  await pollScan();
}
start();
