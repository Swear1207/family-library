# 家庭知库 · 一屋书 2.0

部署在家庭 NAS 上的资料检索、阅读与媒体库。全家共用一个账号，递归扫描挂载目录，统一管理文献、电子书、文本、数据文件、图片、音视频和归档文件。

## 功能

- 按题名、作者、摘要、来源、DOI、标签、笔记和文件名检索；按资料类型、格式、主题分类、年份、阅读状态和文件可用性筛选，分页浏览。
- 编辑论文/报告/标准/专利等资料类型、年份、来源、摘要、DOI、标签、收藏和家庭笔记。PDF 不会仅因扩展名被误判为论文。
- PDF 在线翻页、缩放；EPUB 目录和字号；文本阅读与编码选择；图片预览；浏览器支持的音视频播放。阅读进度保存在 NAS，由共用账号的家人共享。
- 扫描 80 种常见格式，下载原文件；原文件只读挂载，删除资料记录不会删除文件，重新扫描会恢复记录。
- 保留原版共享登录、密码修改、实体书位置与借阅、JSON 备份导入导出。

检索针对已入库的资料信息，本版没有 PDF 正文索引、扫描件 OCR、外部文献自动抓取或 Office 转 PDF 服务。作者、摘要、DOI 等可以手动补全。

## 文件与预览范围

| 文件 | 在线能力 |
| --- | --- |
| PDF | 本机 PDF.js 阅读器，翻页与缩放 |
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

程序保留原账号、会话、图书 ID、分类、笔记及借阅信息。首次升级到数据库 v3 前，自动将一致的 v2 数据库快照保存到数据卷的 `/data/backups/before-v3-*.sqlite`，然后新增阅读进度表。

JSON 导出包含资料记录，不含账号、会话、原文件和阅读进度；完整备份应备份整个数据卷以及原文件目录。不要删除已有数据卷来更新应用。回退到旧应用需要使用匹配的升级前数据库快照。

## 首次部署

从 Releases 下载 `family-library-2.0.0-deploy.zip`。包内只有 Compose、配置示例和说明；镜像位于 GHCR，由 Docker 拉取。也可直接使用本仓库根目录的 `compose.yaml` 和 `.env.example`。

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
- 单库最多 10000 条资料，扫描上限 100000 个目录条目、40 层子目录。资料信息总量限 32 MiB，原文件大小不计入该限制。JSON 导入最多 64 MiB。
- 所有资料、预览、下载与进度接口要求登录，写请求检查来源。文件路径由服务器索引控制，拒绝符号链接、目录穿越和读取挂载目录之外的文件。
- PDF/EPUB 依赖随镜像提供，浏览器无需访问公共 CDN。EPUB 内容在浏览器净化，禁用书内脚本、外部资源与不安全跳转。

## 本地运行与发布

需要 Node.js 24 或更新版本：

```bash
npm ci --omit=optional --ignore-scripts
npm test
APP_ORIGIN=http://localhost:8787 BOOKS_DIR=/path/to/books DATA_DIR=./data npm start
```

GitHub Actions 先执行账号/资料/文件安全测试，再构建只读非 root 容器并做启动检查，然后发布 `linux/amd64` 与 `linux/arm64` 镜像。镜像标签为 `latest` 与 `sha-<完整提交哈希>`。最后创建带提交标识的 GitHub Release，并附上指向该提交镜像的 Compose 部署 ZIP。

发布使用 Actions 的 `GITHUB_TOKEN`，不需上传个人令牌。源码仓库、GHCR 包分别设置可见性；公开包可匿名拉取。NAS 实际的 `.env`、账号数据库、初始化密钥与原始资料不得放进源码仓库或部署包。
