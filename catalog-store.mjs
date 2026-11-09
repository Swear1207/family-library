import { cleanBook, normalizeBook } from './catalog.mjs';
import { fileType } from './file-types.mjs';

const failure = (status, message) => Object.assign(new Error(message), {status});
const lower = value => String(value || '').toLocaleLowerCase();
const METADATA_FIELDS = ['title','author','year','source','doi','abstract'];

// Records and file indexes stay in SQLite; ordinary requests only decode one page.
export function createCatalogStore(db) {
  db.function('unicode_fold',{deterministic:true},value=>lower(value));
  db.exec(`CREATE TABLE IF NOT EXISTS catalog_items (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL,
    category TEXT NOT NULL, status TEXT NOT NULL, resource_type TEXT NOT NULL,
    year TEXT NOT NULL, doi TEXT NOT NULL, favorite INTEGER NOT NULL, borrower TEXT NOT NULL,
    created REAL NOT NULL, search_text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS catalog_created ON catalog_items(created DESC,id);
    CREATE INDEX IF NOT EXISTS catalog_title ON catalog_items(title COLLATE NOCASE,id);
    CREATE INDEX IF NOT EXISTS catalog_type ON catalog_items(resource_type);
    CREATE INDEX IF NOT EXISTS catalog_category ON catalog_items(category);
    CREATE INDEX IF NOT EXISTS catalog_year ON catalog_items(year);
    CREATE TABLE IF NOT EXISTS catalog_tags (book_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(book_id,tag));
    CREATE INDEX IF NOT EXISTS catalog_tag_value ON catalog_tags(tag,book_id);
    CREATE TABLE IF NOT EXISTS metadata_locks (id TEXT PRIMARY KEY, fields TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata_jobs (id TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', updated INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS metadata_status ON metadata_jobs(status,id);`);
  const columns = new Set(db.prepare('PRAGMA table_info(ebook_files)').all().map(c=>c.name));
  if (!columns.has('format')) db.exec("ALTER TABLE ebook_files ADD COLUMN format TEXT NOT NULL DEFAULT ''");
  if (!columns.has('scan_id')) db.exec("ALTER TABLE ebook_files ADD COLUMN scan_id TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS files_format ON ebook_files(format); CREATE INDEX IF NOT EXISTS files_available ON ebook_files(available);');
  const getRow = db.prepare('SELECT data FROM catalog_items WHERE id=?');
  const upsert = db.prepare(`INSERT INTO catalog_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    data=excluded.data,title=excluded.title,author=excluded.author,category=excluded.category,status=excluded.status,
    resource_type=excluded.resource_type,year=excluded.year,doi=excluded.doi,favorite=excluded.favorite,
    borrower=excluded.borrower,created=excluded.created,search_text=excluded.search_text`);
  const deleteTags = db.prepare('DELETE FROM catalog_tags WHERE book_id=?');
  const insertTag = db.prepare('INSERT OR IGNORE INTO catalog_tags VALUES (?,?)');
  function put(book, {manual=false}={}) {
    const previous = manual ? get(book.id) : null;
    const b = normalizeBook(book);
    if(!book.resourceType){const file=db.prepare('SELECT relative_path FROM ebook_files WHERE id=?').get(book.id);if(file)b.resourceType=fileType(file.relative_path)?.resourceType||'其他';}
    const text = lower([b.title,b.author,b.source,b.doi,b.abstract,b.category,b.location,b.notes,b.borrower,...b.tags].join('\n'));
    upsert.run(b.id,JSON.stringify(book),b.title,b.author,b.category,b.status,b.resourceType,b.year,b.doi,b.favorite?1:0,b.borrower,b.created,text);
    deleteTags.run(b.id); for (const tag of b.tags) insertTag.run(b.id,tag);
    if (manual) {
      const locks = new Set(JSON.parse(db.prepare('SELECT fields FROM metadata_locks WHERE id=?').get(b.id)?.fields || '[]'));
      for (const field of METADATA_FIELDS) if ((previous?.[field]||'') !== (book[field]||'')) locks.add(field);
      db.prepare('INSERT INTO metadata_locks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET fields=excluded.fields').run(b.id,JSON.stringify([...locks]));
    }
  }
  function get(id) { const row=getRow.get(id);return row?JSON.parse(row.data):null; }
  const old = db.prepare('SELECT books FROM library WHERE id=1').get();
  if (old && old.books !== '[]') {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const book of JSON.parse(old.books)) put(book);
      const updateFormat=db.prepare('UPDATE ebook_files SET format=? WHERE id=?');
      for (const file of db.prepare('SELECT id,relative_path FROM ebook_files').all()) updateFormat.run(file.relative_path.split('.').pop().toUpperCase(),file.id);
      db.prepare("UPDATE library SET books='[]' WHERE id=1").run(); db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK');throw error;}
  }
  const version = () => db.prepare('SELECT version FROM library WHERE id=1').get()?.version || 0;
  const bump = () => db.prepare('UPDATE library SET version=version+1 WHERE id=1 RETURNING version').get().version;
  const all = () => db.prepare('SELECT data FROM catalog_items ORDER BY created DESC,id').all().map(r=>JSON.parse(r.data));
  const remove = id => {db.prepare('DELETE FROM catalog_items WHERE id=?').run(id);db.prepare('DELETE FROM metadata_locks WHERE id=?').run(id);};
  function replace(books) {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS restore_ids(id TEXT PRIMARY KEY); DELETE FROM restore_ids;');
    const remember=db.prepare('INSERT INTO restore_ids VALUES (?)');
    for (const book of books) {put(cleanBook({...get(book.id),...book}),{manual:true});remember.run(book.id);}
    db.exec('DELETE FROM catalog_items WHERE id NOT IN (SELECT id FROM restore_ids); DELETE FROM metadata_locks WHERE id NOT IN (SELECT id FROM catalog_items); DELETE FROM reading_progress WHERE id NOT IN (SELECT id FROM catalog_items); DELETE FROM restore_ids;');
  }
  function enrich(id, metadata, filenameTitle) {
    const current=get(id);if(!current)return false;
    const locks=new Set(JSON.parse(db.prepare('SELECT fields FROM metadata_locks WHERE id=?').get(id)?.fields||'[]'));
    let changed=false;
    for (const field of METADATA_FIELDS) {
      const value=metadata[field];
      if(typeof value!=='string'||!value.trim()||locks.has(field))continue;
      if(field==='title' ? current.title!==filenameTitle : !!current[field])continue;
      const limits={title:300,author:200,year:4,source:160,doi:200,abstract:8000};
      if(value.length>limits[field]||field==='year'&&!/^[12]\d{3}$/.test(value))continue;
      if(current[field]!==value.trim()){current[field]=value.trim();changed=true;}
    }
    if(changed)put(current);return changed;
  }
  let facetVersion=-1, cachedSummary;
  function summary() {
    const v=version();
    if(cachedSummary && facetVersion===v)return cachedSummary;
    const stats=db.prepare(`SELECT count(*) total,coalesce(sum(status='在读'),0) reading,coalesce(sum(status='读完'),0) done,coalesce(sum(favorite),0) favorites FROM catalog_items`).get();
    stats.files=db.prepare('SELECT count(*) n FROM catalog_items c JOIN ebook_files f ON f.id=c.id WHERE f.available=1').get().n;
    const facet=(column,table='catalog_items',where="value<>''",limit=1000)=>db.prepare(`SELECT ${column} value,count(*) count FROM ${table} GROUP BY ${column} HAVING ${where} ORDER BY count DESC,value LIMIT ${limit}`).all();
    cachedSummary={stats,facets:{types:facet('resource_type'),formats:facet('f.format','catalog_items c JOIN ebook_files f ON f.id=c.id'),categories:facet('category'),tags:facet('tag','catalog_tags'),years:facet('year').sort((a,b)=>b.value.localeCompare(a.value))}};
    facetVersion=v;return cachedSummary;
  }
  function search(params) {
    const from=params.get('yearFrom'),to=params.get('yearTo');
    if([from,to].some(x=>x&&!/^[12]\d{3}$/.test(x))||from&&to&&from>to)throw failure(400,'请填写有效的起止年份，例如 2020 至 2025');
    const clauses=[],values=[];
    const add=(sql,value)=>{clauses.push(sql);if(value!==undefined)values.push(value);};
    for(const [key,col] of [['type','c.resource_type'],['format','f.format'],['category','c.category']])if(params.get(key))add(`${col}=?`,key==='format'?params.get(key).toUpperCase():params.get(key));
    if(params.get('tag'))add('EXISTS(SELECT 1 FROM catalog_tags t WHERE t.book_id=c.id AND t.tag=?)',params.get('tag'));
    if(from)add('c.year>=? AND c.year<>\'\'',from);if(to)add('c.year<=? AND c.year<>\'\'',to);
    const status=params.get('status');if(status==='lent')add("c.borrower<>''");else if(status)add('c.status=?',status);
    if(params.get('favorite')==='1')add('c.favorite=1');
    if(params.get('availability')==='available')add('f.available=1');
    if(params.get('availability')==='missing')add('f.available=0');
    const field=params.get('field'),target=['title','author','doi'].includes(field)?`unicode_fold(c.${field})`:"(c.search_text||char(10)||unicode_fold(coalesce(f.relative_path,'')))";
    for(const term of lower(params.get('q')).trim().slice(0,1000).split(/\s+/).filter(Boolean))add(`instr(${target},?)>0`,term);
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    const base=' FROM catalog_items c LEFT JOIN ebook_files f ON f.id=c.id';
    const total=db.prepare('SELECT count(*) n'+base+where).get(...values).n;
    const number=(name,fallback,max)=>{const n=Number(params.get(name));return Number.isSafeInteger(n)&&n>0?Math.min(n,max):fallback;};
    const pageSize=number('pageSize',25,100),page=Math.min(number('page',1,Number.MAX_SAFE_INTEGER),Math.max(1,Math.ceil(total/pageSize)));
    const sort=params.get('sort'),order=sort==='title'?'c.title COLLATE NOCASE,c.id':sort==='year'?'c.year DESC,c.created DESC,c.id':'c.created DESC,c.id';
    const items=db.prepare('SELECT c.data'+base+where+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...values,pageSize,(page-1)*pageSize).map(row=>JSON.parse(row.data));
    return {items,total,page,pageSize,version:version(),...summary()};
  }
  return {get,put,all,replace,remove,enrich,search,version,bump};
}
