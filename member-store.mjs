import { randomBytes } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const DEFAULT_MEMBER = 'family';

// The login grants household access; member selection only separates reading state.
export function createMemberStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reading_history (
    member_id TEXT NOT NULL REFERENCES members(id), id TEXT NOT NULL, opened INTEGER NOT NULL,
    PRIMARY KEY(member_id,id));
    CREATE INDEX IF NOT EXISTS reading_history_recent ON reading_history(member_id,opened DESC,id);`);
  db.prepare('INSERT OR IGNORE INTO members VALUES (?,?,?,?)').run(DEFAULT_MEMBER,'家庭共享','家庭共享',Date.now());
  if (!db.prepare('PRAGMA table_info(reading_progress)').all().some(c=>c.name==='member_id')) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE reading_progress RENAME TO reading_progress_legacy;
      CREATE TABLE reading_progress (
        member_id TEXT NOT NULL REFERENCES members(id), id TEXT NOT NULL,
        kind TEXT NOT NULL, location TEXT NOT NULL, progress REAL NOT NULL, updated INTEGER NOT NULL,
        PRIMARY KEY(member_id,id));
      INSERT INTO reading_progress SELECT 'family',id,kind,location,progress,updated FROM reading_progress_legacy;
      INSERT OR IGNORE INTO reading_history SELECT 'family',id,updated FROM reading_progress_legacy;
      DROP TABLE reading_progress_legacy;
      COMMIT;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS reading_progress_document ON reading_progress(id);
    CREATE INDEX IF NOT EXISTS reading_history_document ON reading_history(id);`);
  const list = () => ({ members: db.prepare('SELECT id,name FROM members ORDER BY created,id').all(), defaultMemberId: DEFAULT_MEMBER });
  function member(value) {
    const id = value === undefined ? DEFAULT_MEMBER : value;
    if (typeof id !== 'string' || !id || id.length > 100) throw fail(400,'成员信息不正确，请重新选择');
    const result = db.prepare('SELECT id,name FROM members WHERE id=?').get(id);
    if (!result) throw fail(404,'该成员不存在，请重新选择');
    return result;
  }
  function validName(value) {
    if(typeof value!=='string')throw fail(400,'请输入成员名称');
    const name=value.trim().normalize('NFC');
    if(!name || name.length>40 || /[\u0000-\u001f\u007f]/u.test(name))throw fail(400,'成员名称需为 1–40 个字符');
    return name;
  }
  function saveName(name, id) {
    const key=name.toLocaleLowerCase();
    const same=db.prepare('SELECT id FROM members WHERE name_key=?').get(key);
    if(same&&same.id!==id)throw fail(409,'已有同名成员，请换一个名称');
    if(id){member(id);db.prepare('UPDATE members SET name=?,name_key=? WHERE id=?').run(name,key,id);}
    else {
      if(db.prepare('SELECT count(*) n FROM members').get().n>=50)throw fail(400,'最多可创建 50 位家庭成员');
      id='member-'+randomBytes(12).toString('hex');
      db.prepare('INSERT INTO members VALUES (?,?,?,?)').run(id,name,key,Date.now());
    }
    return {id,name};
  }
  const add = name => saveName(validName(name));
  const rename = (id,name) => {if(typeof id!=='string'||!id)throw fail(400,'请选择要修改的成员');member(id);return saveName(validName(name),id);};
  const progress = (memberId,id) => db.prepare('SELECT kind,location,progress,updated FROM reading_progress WHERE member_id=? AND id=?').get(memberId,id)||null;
  const opened = (memberId,id,now=Date.now()) => db.prepare('INSERT INTO reading_history VALUES (?,?,?) ON CONFLICT(member_id,id) DO UPDATE SET opened=excluded.opened').run(memberId,id,now);
  function saveProgress(memberId, data) {
    const updated=Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO reading_progress VALUES (?,?,?,?,?,?) ON CONFLICT(member_id,id) DO UPDATE SET
        kind=excluded.kind,location=excluded.location,progress=excluded.progress,updated=excluded.updated`).run(memberId,data.id,data.kind,data.location,data.progress,updated);
      opened(memberId,data.id,updated);db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    return {ok:true,updated};
  }
  function recent(memberId,limit=8) {
    const count=Number.isSafeInteger(limit)&&limit>0?Math.min(limit,50):8;
    const rows=db.prepare(`SELECT c.data,h.opened,p.kind,p.location,p.progress,p.updated
      FROM reading_history h JOIN catalog_items c ON c.id=h.id
      LEFT JOIN reading_progress p ON p.member_id=h.member_id AND p.id=h.id
      WHERE h.member_id=? ORDER BY h.opened DESC,h.id LIMIT ?`).all(memberId,count);
    const total=db.prepare('SELECT count(*) n FROM reading_history h JOIN catalog_items c ON c.id=h.id WHERE h.member_id=?').get(memberId).n;
    return {total,items:rows.map(row=>({...JSON.parse(row.data),lastOpened:row.opened,progress:row.kind?{kind:row.kind,location:row.location,progress:row.progress,updated:row.updated}:null}))};
  }
  function remove(id) {
    db.prepare('DELETE FROM reading_progress WHERE id=?').run(id);
    db.prepare('DELETE FROM reading_history WHERE id=?').run(id);
  }
  const prune = () => db.exec('DELETE FROM reading_history WHERE id NOT IN (SELECT id FROM catalog_items);');
  return {list,member,add,rename,progress,saveProgress,opened,recent,remove,prune};
}
