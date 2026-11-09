# 一屋书 · 私有 GitHub 镜像发布

家庭共用账号的电子书书架。递归扫描 PDF、EPUB、MOBI、AZW、AZW3、TXT、CBZ 和 DJVU，按文件名生成书架，支持阅读笔记与登录后下载。账号和书架存入 NAS 的 SQLite 数据库；电子书目录只读挂载。

## 发布到私有仓库

在自己的 GitHub 账号下新建一个 **Private** 仓库，例如 `family-library`。把本目录的程序文件及 `.github/workflows/publish.yml` 放在仓库根目录，默认分支使用 `main`。不要上传 NAS 的 `.env`、数据库、初始化密钥或书籍。测试里的账号、密码和电子书字节仅为合成测试数据，不是部署凭据。

推送到 `main` 后，GitHub Actions 会先执行应用测试、构建容器并验证只读文件系统下的启动，再构建 `linux/amd64` 和 `linux/arm64` 镜像并推送到 GHCR。也可以在 Actions 页面手动运行工作流。amd64 启动验证通过不代表已完整验证 arm64 实机。

镜像地址自动取自仓库名：`ghcr.io/用户名/仓库名:latest`，全部小写；另外保留 `sha-提交哈希` 标签。发布使用 Actions 自带的 `GITHUB_TOKEN`，无需额外添加 PAT 或 Docker Hub 密码。新建 GHCR 包默认私有，本工作流不会更改可见性；使用一个全新的包名，并在发布后确认包为 **Private**。不要将已有的公开包当成私有包使用。

GitHub Actions 中的 Node 基础镜像由 GitHub 的构建机下载。NAS 部署只拉取最终的 GHCR 镜像，不执行 Dockerfile 构建。仍需 NAS 能连接 `ghcr.io` 及其镜像下载端点。

## NAS 使用镜像

部署只需 `compose.yaml` 和本地 `.env`。复制 `.env.example` 为 `.env`，填写实际的镜像地址、NAS 访问地址和书籍目录。镜像地址必须在 Actions 成功发布后才可拉取。

私有镜像需要 GitHub personal access token (classic)，至少具有 `read:packages` 权限，且对应账号有权访问这个私有包。令牌在 GitHub 账号设置中自行创建；不写进仓库、Compose 或 `.env`，也不用发到聊天里。NAS 上运行以下命令，在 Password 提示中粘贴令牌（不是 GitHub 账号密码）：

```sh
docker login ghcr.io -u 你的GitHub用户名
docker compose pull
docker compose up -d
docker compose ps
```

本地 `.env` 示例，按实际环境填写：

```dotenv
LIBRARY_IMAGE=ghcr.io/你的github用户名/family-library:latest
APP_ORIGIN=http://NAS的局域网IP:8787
HOST_PORT=8787
BIND_IP=0.0.0.0
BOOKS_PATH="/NAS上的书籍目录"
```

容器健康状态为 `healthy` 后，读取首次初始化密钥：

```sh
docker compose exec library cat /data/setup-token.txt
```

在 APP_ORIGIN 指定的网址上填入初始化密钥，设置全家共享的账号及至少 12 位密码。初始化后密钥文件会删除。书架默认每 10 分钟扫描，也支持手动扫描；下载原始电子书需要登录，不提供内嵌阅读器。图书编辑和笔记在重复扫描后保留；移动或改名会作为新的文件路径导入。

## 持久化与更新

`library-data` 命名卷保留账号、索引及笔记。书籍原文件留在 BOOKS_PATH 指定目录。删除书架记录不会删除原书，下一次扫描会重新加入仍存在的文件。容器使用 UID/GID `1000:1000`，需要书籍目录的遍历和读取权限。

从本地构建版本切换时，继续使用原来的 Compose 项目目录、项目名称和 `library-data` 卷名，不要执行 `docker compose down -v`。仅替换 Compose 配置、补充本地 `.env` 并拉取镜像，不会自动迁移其他项目名的数据卷。已有数据应先备份。

更新源码并等待 Actions 成功后，在同一 NAS 部署目录执行 `docker compose pull`、`docker compose up -d`。网页导出的 JSON 不包含账号密码和原始电子书；需要完整备份时，另行备份命名卷及原始书籍目录。

默认访问方式为家庭局域网 HTTP；外网访问使用 VPN 或配置 HTTPS 反向代理，APP_ORIGIN 与实际访问地址保持一致。

## 本地验证

使用 Node.js 24 或更高版本运行：

```sh
node --test test.mjs test-files.mjs
```

测试只使用临时数据目录；Windows 未获符号链接权限时会跳过文件链接替换测试。Docker 构建和运行验证在 GitHub Actions 实际运行后才成立。提交工作流不代表已成功发布镜像。

参考：[GitHub 发布容器镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 登录和权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)、[Docker 多架构构建](https://docs.docker.com/build/ci/github-actions/multi-platform/)。
