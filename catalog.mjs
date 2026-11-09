export const RESOURCE_TYPES = ['电子书','期刊论文','学位论文','会议论文','报告','标准规范','专利','资料文档','数据集','图片','音频','视频','其他'];
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
export function serializeCatalog(books) {
  const serialized=JSON.stringify(books);
  if(Buffer.byteLength(serialized)>MAX_CATALOG_BYTES)throw Object.assign(new Error('资料信息总量超过 32 MiB，请精简长笔记或摘要后重试；原文件不计入此限制'),{status:413});
  return serialized;
}
const string = (value, max) => typeof value === 'string' && value.length <= max;
const optional = (book, key, validate) => book[key] === undefined || validate(book[key]);

export function validBook(b) {
  return !!b && string(b.id,100) && b.id.length > 0 && string(b.title,300) && b.title.trim().length > 0 &&
    ['未读','在读','读完'].includes(b.status) && string(b.category,80) && b.category.trim().length > 0 &&
    string(b.author,200) && string(b.location,300) && string(b.borrower,80) && string(b.notes,20000) &&
    Number.isFinite(b.created) && b.created >= 0 &&
    optional(b,'resourceType',v=>RESOURCE_TYPES.includes(v)) &&
    optional(b,'year',v=>typeof v==='string' && /^(?:[12]\d{3})?$/.test(v)) &&
    optional(b,'source',v=>string(v,160)) && optional(b,'doi',v=>string(v,200)) &&
    optional(b,'abstract',v=>string(v,8000)) && optional(b,'favorite',v=>typeof v==='boolean') &&
    optional(b,'tags',v=>Array.isArray(v) && v.length<=30 && v.every(x=>string(x,40)&&x.trim().length>0));
}

export function cleanBook(b) {
  const clean = {id:b.id,title:b.title.trim(),author:b.author,category:b.category.trim(),status:b.status,
    location:b.location,borrower:b.borrower,notes:b.notes,created:b.created,
    color:/^#[a-f0-9]{6}$/i.test(b.color)?b.color:'#456258',demo:b.demo===true};
  for(const key of ['resourceType','year','source','doi','abstract','favorite']) {
    if(b[key]!==undefined)clean[key]=typeof b[key]==='string'?b[key].trim():b[key];
  }
  if(b.tags!==undefined)clean.tags=[...new Set(b.tags.map(t=>t.trim()))];
  return clean;
}

export function normalizeBook(b) {
  return {...b,resourceType:b.resourceType||'其他',year:b.year||'',source:b.source||'',doi:b.doi||'',
    abstract:b.abstract||'',tags:Array.isArray(b.tags)?b.tags:[],favorite:b.favorite===true};
}

const lower = value => String(value||'').toLocaleLowerCase();
const facet = values => {
  const counts=new Map();
  for(const value of values)if(value)counts.set(value,(counts.get(value)||0)+1);
  return [...counts].map(([value,count])=>({value,count})).sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value,'zh-CN'));
};

export function searchCatalog(input, params, version) {
  const all=input.map(normalizeBook);
  const q=lower(params.get('q')).trim().slice(0,1000),field=params.get('field')||'all';
  const terms=q.split(/\s+/).filter(Boolean);
  const type=params.get('type'),format=params.get('format'),category=params.get('category'),tag=params.get('tag');
  const yearFrom=params.get('yearFrom'),yearTo=params.get('yearTo'),status=params.get('status');
  if([yearFrom,yearTo].some(year=>year&&!/^[12]\d{3}$/.test(year))||yearFrom&&yearTo&&yearFrom>yearTo)throw Object.assign(new Error('请填写有效的起止年份，例如 2020 至 2025'),{status:400});
  const favorite=params.get('favorite')==='1',availability=params.get('availability');
  const stats={total:all.length,reading:all.filter(b=>b.status==='在读').length,done:all.filter(b=>b.status==='读完').length,
    favorites:all.filter(b=>b.favorite).length,files:all.filter(b=>b.file?.available).length};
  const facets={types:facet(all.map(b=>b.resourceType)),formats:facet(all.map(b=>b.file?.format)),
    categories:facet(all.map(b=>b.category)),tags:facet(all.flatMap(b=>b.tags)),years:facet(all.map(b=>b.year)).sort((a,b)=>b.value.localeCompare(a.value))};
  const list=all.filter(b=>{
    if(type&&b.resourceType!==type||format&&b.file?.format!==format.toUpperCase()||category&&b.category!==category||tag&&!b.tags.includes(tag))return false;
    if(yearFrom&&(!b.year||b.year<yearFrom)||yearTo&&(!b.year||b.year>yearTo))return false;
    if(status==='lent'?!b.borrower:status&&b.status!==status)return false;
    if(favorite&&!b.favorite||availability==='available'&&!b.file?.available||availability==='missing'&&(!b.file||b.file.available))return false;
    const text=lower(['title','author','doi'].includes(field)?b[field]:[b.title,b.author,b.source,b.doi,b.abstract,b.category,b.location,b.notes,b.borrower,b.file?.name,b.file?.folder,...b.tags].join('\n'));
    return terms.every(term=>text.includes(term));
  });
  const sort=params.get('sort');
  list.sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,'zh-CN'):sort==='year'?(b.year||'').localeCompare(a.year||'')||b.created-a.created:b.created-a.created||a.id.localeCompare(b.id));
  const number=(name,defaultValue,max)=>{const n=Number(params.get(name));return Number.isSafeInteger(n)&&n>=1?Math.min(n,max):defaultValue};
  const pageSize=number('pageSize',25,100),pages=Math.max(1,Math.ceil(list.length/pageSize)),page=Math.min(number('page',1,10000),pages);
  return {items:list.slice((page-1)*pageSize,page*pageSize),total:list.length,page,pageSize,version,stats,facets};
}
