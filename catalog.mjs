export const RESOURCE_TYPES = ['电子书','期刊论文','学位论文','会议论文','报告','标准规范','专利','资料文档','数据集','图片','音频','视频','其他'];
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
