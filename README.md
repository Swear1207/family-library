# 家庭知库 · 一屋书 2.0.1

部署在家庭 NAS 上的资料检索、阅读与媒体库。全家共用一个账号，递归扫描挂载目录，统一管理文献、电子书、文本、数据文件、图片、音视频和归档文件。

## 功能

- 按题名、作者、摘要、来源、DOI、标签、笔记和文件名检索；按资料类型、格式、主题分类、年份、阅读状态和文件可用性筛选，分页浏览。
- 编辑论文/报告/标准/专利等资料类型、年份、来源、摘要、DOI、标签、收藏和家庭笔记。PDF 不会仅因扩展名被误判为论文。
- PDF 连续滚动阅读，滚轮和触摸可自然跨页，同时保留页码跳转、目录与缩放；只渲染附近页面并释放远处画布，阅读进度记录到页内位置。EPUB 目录和字号；文本阅读与编码选择；图片预览；浏览器支持的音视频播放。阅读进度保存在 NAS，由共用账号的家人共享。
- 扫描 80 种常见格式，下载原文件；原文件只读挂载，删除资料记录不会删除文件，重新扫描会恢复记录。
- 后台分批收录大目录，每批 200 个文件写入 SQLite；没有 10000 条资料或 100000 个目录条目的旧限制。扫描时可浏览已收录资料，网页显示进度，关闭网页仍继续。
- 文件收录后，单独的后台队列逐份提取 PDF、EPUB 内嵌题名、作者、明确出版年份、来源、DOI 和摘要。保存过的人工值和主动清空的字段受到保护，重启后未完成任务继续处理。
- 保留原版共享登录、密码修改、实体书位置与借阅、JSON 备份导入导出。

检索针对已入库的资料信息，本版没有 PDF 正文全文索引、扫描件 OCR、外部文献自动抓取或 Office 转 PDF 服务。元数据提取只使用文件实际包含的信息；主题分类需要人工整理，缺失信息不猜测。扫描 PDF 的前 3 页可识别明确标记的 DOI，不把文件创建日期当出版年。

## 文件与预览范围

| 文件 | 在线能力 |
| --- | --- |
| PDF | 本地 PDF.js 阅读器，连续滚动、页码跳转、目录、缩放与页内进度 |
| EPUB | 目录、字号、主题、共享进度；为安全会简化原书排版 |
| TXT、MD、CSV/TSV、JSON、XML、YAML、日志、BIB/RIS、常见代码等 | 纯文本阅读，UTF-8 / GB18030 / UTF-16LE；最长预览约 2 MiB，超出可下载原文 |
| JPG/JPEG、PNG、GIF、WebP、BMP、AVIF | 图片预览；实际支持取决于浏览器 |
| MP3、WAV、OGG、FLAC、M4A、AAC、MP4、WebM、MOV、M4V、MKV、AVI | 浏览器播放器；容器与编码不兼容时提示下载，本版不转码 |
| DOC/DOCX、XLS/XLSX、PPT/PPTX、ODF、RTF、CAJ/NH/KDH、MOBI/AZW、CBZ、DJVU | 编目、资料信息检索与下载 |
| Parquet、HDF5、SQLite、SPSS/Stata/MAT、ZIP/RAR/7Z/TAR/GZ | 编目、资料信息检索与下载 |
| HEIC/TIFF | 编目与下载 |
| HTML、SVG | 源文本阅读，不执行其中的脚本 |

完整格式表见 `file-types.mjs`。EPUB 原包上限 64 MiB，内部条目与解压内容另有内存上限；超限会提示下载。复杂或加密文件可能需要专用客户端。

## 从现有家庭图书馆升级

保留现有 `compose.yaml`、`.env`、项目目录和 `library-data` 数据卷，在原项目目录执行：

```bash
docker compose --env-file .env pull
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

原镜像地址 `ghcr.io/swear1207/family-library:latest` 继续使用。出现 `healthy` 后刷新网页，首次进入新版手动扫描一次即可发现新文件类型。

程序保留原账号、会话、图书 ID、分类、笔记、借阅和阅读进度。首次升级到数据库 v4 前，自动将旧数据库的一致快照保存到 `/data/backups/before-v4-*.sqlite`；随后将整库 JSON 迁移为逐条 SQLite 索引，不需要重新填写资料。

网络拉取较慢时，可从同一 Release 下载完整离线镜像，上传到原 Compose 目录后导入。下面命令适用于 amd64 / x86_64 NAS，每一步成功才继续，完全使用本地镜像：

```bash
docker load -i family-library-2.0.1-linux-amd64.tar.gz && \
docker compose --env-file .env up -d --pull never --no-build --force-recreate
```

仅导入镜像不会替换正在运行的旧容器，必须再执行上面的 Compose 重建命令。文件无需解压，完整说明见 `OFFLINE.md`。

JSON 导出包含资料记录，不含账号、会话、原文件和阅读进度；完整备份应备份整个数据卷以及原文件目录。不要删除已有数据卷来更新应用。回退到旧应用需要使用匹配的升级前数据库快照。

## 首次部署

从 Releases 下载 `family-library-2.0.1-deploy.zip`。包内只有 Compose、配置示例和说明；镜像可从 GHCR 拉取，也可下载同一 Release 的离线镜像后导入。也可直接使用本仓库根目录的 `compose.yaml` 和 `.env.example`。

```bash
mkdir -p family-library
cd family-library
# 将部署包里的文件放在这个目录。
cp .env.example .env
# 编辑 .env：填入 NAS 的 APP_ORIGIN、BOOKS_PATH 和镜像地址。
docker compose --env-file .env config -q
docker compose --env-file .env pull
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

`APP_ORIGIN` 必须与浏览器使用的地址一致，例如 `http://192.168.100.200:8787`，不带子路径。`BOOKS_PATH` 指向存放资料的绝对目录，路径包含空格时保留双引号。子目录会递归扫描。默认每 10 分钟扫描，也可在网页手动扫描。

首次设置账号，在 NAS 读取初始化密钥并填入网页：

```bash
docker compose --env-file .env exec library cat /data/setup-token.txt
```

账号为 3–32 位字母、数字、下划线或连字符；密码至少 12 位。初始化后密钥文件自动删除。现有账号升级后无需再次初始化。

## 数据与服务

- `/books`：资料原文件，Compose 以只读方式挂载。
- `/data/library.sqlite`：家庭账号、会话、资料记录和共享阅读进度。
- `/data/backups/`：升级前数据库快照。
- 默认端口 `8787`，非 root 用户运行，只读容器根文件系统。
- 资料逐条存储，普通列表只读取当前页；不再设置固定资料数量上限，实际容量取决于 NAS 磁盘、内存和检索负载。已用 200001 条索引与 10025 个真实文件验证；这不是对任意硬件扫描速度的承诺。目录深度上限 128 层，不跟随符号链接。
- JSON 备份导入上限 256 MiB；非常大的资料库应备份完整数据卷。备份导入导出会读取整份 JSON，普通检索不会。
- 元数据队列同一时间只处理一份文件，每份默认最多 15 秒，随后让出运行时间。PDF 文件上限 512 MiB、累计读取上限 64 MiB；EPUB 64 MiB、OPF 2 MiB。复杂、加密、纯扫描或缺少内嵌信息的文件可能无法自动补全，可手动编辑；手动重新扫描会重试先前失败的任务。
- 扫描中断时已收录的批次保留；只有完整扫描结束才标记缺失文件，以免局部读取失败把旧资料误标为缺失。
- 所有资料、预览、下载与进度接口要求登录，写请求检查来源。文件路径由服务器索引控制，拒绝符号链接、目录穿越和读取挂载目录之外的文件。
- PDF/EPUB 依赖随镜像提供，浏览器无需访问公共 CDN。EPUB 内容在浏览器净化，禁用书内脚本、外部资源与不安全跳转。

## 本地运行与发布

需要 Node.js 24 或更新版本：

```bash
npm ci --omit=optional --ignore-scripts
npm test
APP_ORIGIN=http://localhost:8787 BOOKS_DIR=/path/to/books DATA_DIR=./data npm start
```

GitHub Actions 先执行账号、文件访问、大库扫描和后台元数据测试，再构建只读非 root 容器并做启动检查，然后发布 `linux/amd64` 与 `linux/arm64` 镜像。镜像标签为 `latest` 与 `sha-<完整提交哈希>`。最后创建带提交标识的 GitHub Release，附上固定该提交镜像的 Compose ZIP，以及经实际导入和容器启动验证的 amd64 离线镜像包、SHA256 校验文件。

发布使用 Actions 的 `GITHUB_TOKEN`，不需上传个人令牌。源码仓库、GHCR 包分别设置可见性；公开包可匿名拉取。NAS 实际的 `.env`、账号数据库、初始化密钥与原始资料不得放进源码仓库或部署包。
