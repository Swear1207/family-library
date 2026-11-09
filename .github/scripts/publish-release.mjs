import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const {GITHUB_REPOSITORY:repository,GITHUB_SHA:sha,GITHUB_TOKEN:token}=process.env;
if(!repository||!sha||!token||!/^[a-f0-9]{40}$/.test(sha))throw Error('Missing release environment');
const {version}=JSON.parse(await fs.readFile('package.json','utf8'));
const image=`ghcr.io/${repository.toLowerCase()}:sha-${sha}`;
const tag=`v${version}-${sha.slice(0,7)}`;
const archiveName=`family-library-${version}-deploy.zip`;
const zip=new JSZip();
zip.file('compose.yaml',await fs.readFile('compose.yaml'));
const env=(await fs.readFile('.env.example','utf8')).replace(/^LIBRARY_IMAGE=.*$/m,`LIBRARY_IMAGE=${image}`);
zip.file('.env.example',env);
zip.file('README.md',await fs.readFile('README.md'));
await fs.mkdir('release-output',{recursive:true});
const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
await fs.writeFile(path.join('release-output',archiveName),bytes);
const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'family-library-release'};
async function api(route,method='GET',body){
  const response=await fetch(`https://api.github.com/repos/${repository}${route}`,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(response.status===404&&method==='GET')return null;
  if(!response.ok)throw Error(`GitHub release API ${method} ${route}: HTTP ${response.status}`);
  return response.status===204?null:response.json();
}
let release=await api(`/releases/tags/${tag}`);
if(!release)release=await api('/releases','POST',{tag_name:tag,target_commitish:sha,name:`家庭知库 ${version}`,draft:false,prerelease:false,body:`家庭资料库：分类检索、标签、文献信息、PDF/EPUB/文本阅读、图片与音视频预览。\n\n镜像：\`${image}\`\n\n附件是 Compose 部署包，包含配置示例与升级说明。镜像由 NAS 从 GHCR 拉取；本 ZIP 不包含镜像本体或家庭资料。已有用户可保留原目录、.env 和数据卷，更新 latest 镜像。\n\n完整支持范围和升级备份说明见仓库 README。`});
for(const asset of release.assets||[])if(asset.name===archiveName)await api(`/releases/assets/${asset.id}`,'DELETE');
const upload=release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(archiveName);
if(new URL(upload).hostname!=='uploads.github.com')throw Error('Unexpected upload host');
const result=await fetch(upload,{method:'POST',headers:{...headers,'Content-Type':'application/zip'},body:bytes});
if(!result.ok)throw Error(`Release archive upload: HTTP ${result.status}`);
const asset=await result.json();
console.log(`Deployment package: ${asset.browser_download_url}`);
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`\n[部署包下载](${asset.browser_download_url}) · [Release](${release.html_url})\n`);
