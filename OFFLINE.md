# 家庭知库 2.0 · 离线镜像安装

此包用于 **Linux amd64 / x86_64** NAS。它是已经发布的家庭知库 2.0 镜像的离线副本，可以直接 `docker load`，不需要 NAS 访问 Docker Hub 或 GHCR。

在 [v2.0.0-ccc2ee0 Release](https://github.com/Swear1207/family-library/releases/tag/v2.0.0-ccc2ee0) 下载：

- `family-library-2.0.0-linux-amd64.tar.gz`：包含应用、Node.js 和阅读器依赖的完整 Docker 镜像。
- `family-library-2.0.0-linux-amd64.tar.gz.sha256`：镜像包校验文件。
- 首次部署还需 `family-library-2.0.0-deploy.zip`，里面是 Compose、配置示例和操作说明。

该镜像包不含家庭账号、数据库、初始化密钥或原始资料。已部署家庭图书馆的用户继续使用原项目目录、配置和数据卷。

## 已有项目离线更新

把镜像包及 `.sha256` 文件放入 NAS 的项目目录，例如 `/vol1/1000/compose/family-library`，执行：

```bash
cd /vol1/1000/compose/family-library
sha256sum -c family-library-2.0.0-linux-amd64.tar.gz.sha256
docker load -i family-library-2.0.0-linux-amd64.tar.gz
docker compose --env-file .env up -d --pull never --no-build
docker compose --env-file .env ps
```

`sha256sum` 应显示 `OK`。Docker 可以直接读取压缩镜像包，无需提前解压。`--pull never --no-build` 让本次启动只使用导入的本地镜像。原 Compose 需要使用下列任一镜像地址，包内已包含这两个标签：

```text
ghcr.io/swear1207/family-library:latest
ghcr.io/swear1207/family-library:sha-ccc2ee08490db71a74a1aa5259af7c71757eadca
```

如果 `.env` 使用 `LIBRARY_IMAGE`，保留上述 `latest` 地址，或填写完整 `sha-...` 地址固定本次版本。出现 `healthy` 后，打开原网址并刷新页面。已有账号无需重新初始化，数据库和资料仍在原挂载目录中。

首次部署时先按部署 ZIP 的 README 配置 `.env` 中的访问地址和资料目录，然后执行同样的导入与启动命令。书籍目录仍只读挂载。

## 包的来源与验证

- 源代码提交：`ccc2ee08490db71a74a1aa5259af7c71757eadca`。
- 已发布镜像的固定多架构摘要：`sha256:96c97513e02e0dbab40e54826d1d58588c0bc4bc94a49e085f24b62711331dcc`。
- 导出工作流只提取其中的 `linux/amd64`，校验架构和源码标签，再用 `docker save` 制作归档。
- 上传前会重新 `docker load`，核对两个标签指向同一镜像，并以只读、非 root 容器启动，验证健康检查和本地阅读器资源。

工作流只往原 Release 添加离线归档及校验文件，不重新构建应用，也不推送或修改 GHCR 上的 `latest` 标签。离线包中的 `latest` 是方便现有 NAS 配置使用的本地标签。

离线归档工作流为 `.github/workflows/offline-image.yml`，也可在 Actions 页面手动运行。只修改离线说明或发布流程时不会触发应用镜像重建；需要重新执行主发布流程时，可在 Actions 页面手动运行 `Publish library image`。
