import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const {GITHUB_REPOSITORY:repository,GITHUB_SHA:sha,GITHUB_TOKEN:token}=process.env;
if(!repository||!sha||!token||!/^[a-f0-9]{40}$/.test(sha))throw Error('Missing release environment');
const {version}=JSON.parse(await fs.readFile('package.json','utf8'));
if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw Error('Invalid release version');
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
if(release&&release.target_commitish!==sha)throw Error('Existing release targets a different source revision');
if(!release)release=await api('/releases','POST',{tag_name:tag,target_commitish:sha,name:`家庭知库 ${version}`,draft:false,prerelease:false,body:`家庭资料库：分类检索、标签、文献信息、PDF/EPUB/文本阅读、图片与音视频预览。\n\n镜像：\`${image}\`\n\n附件中的 Compose 部署 ZIP 包含配置示例与升级说明，不含镜像本体或家庭资料。发布流程随后会上传 \`family-library-${version}-linux-amd64.tar.gz\` 及 SHA256 校验文件；它是可直接 \`docker load\` 的完整 amd64 离线镜像。请等待本次 Actions 发布完成再下载全部附件。\n\n已有用户保留原目录、.env 和数据卷。离线导入后用 \`docker compose up -d --pull never --no-build\` 启动。操作说明见 [OFFLINE.md](https://github.com/${repository}/blob/${sha}/OFFLINE.md)，完整支持范围和升级备份说明见仓库 README。`});
for(const asset of release.assets||[])if(asset.name===archiveName)await api(`/releases/assets/${asset.id}`,'DELETE');
const upload=release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(archiveName);
if(new URL(upload).hostname!=='uploads.github.com')throw Error('Unexpected upload host');
const result=await fetch(upload,{method:'POST',headers:{...headers,'Content-Type':'application/zip'},body:bytes});
if(!result.ok)throw Error(`Release archive upload: HTTP ${result.status}`);
const asset=await result.json();
console.log(`Deployment package: ${asset.browser_download_url}`);
if(process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,`version=${version}\ntag=${tag}\n`);
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`\n[部署包下载](${asset.browser_download_url}) · [Release](${release.html_url})\n`);
