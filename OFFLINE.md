# 家庭知库 · 离线镜像安装

离线包用于 **Linux amd64 / x86_64** NAS，包含应用、Node.js 和阅读器依赖，可直接 `docker load`。安装时不需要 NAS 访问 Docker Hub 或 GHCR。包内不含家庭账号、数据库、初始化密钥或原始资料。

每次主发布流程成功后，[对应版本的 Release](https://github.com/Swear1207/family-library/releases) 都会包含：

- `family-library-版本号-linux-amd64.tar.gz`：完整 Docker 镜像。
- 同名 `.tar.gz.sha256`：镜像包校验文件。
- `family-library-版本号-deploy.zip`：Compose、配置示例和操作说明，首次部署时需要。

请选择同一个 Release 的附件，并确认对应的 `Publish library image` Actions 已完成。Release 名称包含版本，标签还包含源码提交的前 7 位，便于区分同一版本的不同发布。

## 已有项目离线更新

将镜像包和校验文件放入 NAS 的项目目录。以下以 2.1.0 为例；安装其他版本时修改第一行的版本号：

```bash
VERSION=2.1.0
cd /vol1/1000/compose/family-library && \
sha256sum -c "family-library-${VERSION}-linux-amd64.tar.gz.sha256" && \
docker load -i "family-library-${VERSION}-linux-amd64.tar.gz" && \
docker compose --env-file .env up -d --pull never --no-build --force-recreate
docker compose --env-file .env ps
```

`sha256sum` 应显示 `OK`。前一步成功才执行下一步。Docker 可以直接读取压缩镜像包，无需提前解压。`--pull never --no-build` 让本次启动只使用导入的本地镜像，`--force-recreate` 会替换仍在运行的旧容器并保留挂载的数据卷。只导入镜像不会自动更新正在运行的程序。

包内有两个标签：`ghcr.io/swear1207/family-library:latest` 和 `ghcr.io/swear1207/family-library:sha-完整源码提交`。原 `.env` 使用 `LIBRARY_IMAGE=ghcr.io/swear1207/family-library:latest` 时可以直接启动。如果原配置固定了旧 `sha-...` 标签，请更新为本次 Release 中的完整镜像地址；该地址也写在本次部署 ZIP 的 `.env.example` 中。

保留原项目目录、`.env`、数据卷和资料挂载。出现 `healthy` 后打开原网址并刷新页面，已有账号无需重新初始化。首次部署时先按部署 ZIP 的 README 配置 `.env`，然后执行上述导入与启动命令。

## 包的来源与验证

主发布流程直接使用本次构建输出的固定镜像摘要和源码提交，只导出其中的 `linux/amd64`。上传前会完成这些检查：

- 校验镜像架构和源码 revision 标签。
- 检查 gzip 完整性和 SHA256。
- 重新 `docker load`，确认两个标签一致，并逐项比较平台、镜像配置和文件系统层。
- 以只读、非 root 容器启动，验证健康检查和本地阅读器资源。

镜像摘要、源码提交和归档校验值记录在对应 Actions 的摘要中。离线导出过程不会重新构建应用或推送 GHCR 标签，包内的 `latest` 是方便 NAS 配置使用的本地标签。

如需为已有 Release 补包，可在 Actions 手动运行 `Export offline image for NAS`，填写该 Release 的版本号、完整源码 SHA 和已发布镜像的 `sha256:...` 摘要。工作流会先核对 Release 与镜像的来源，失败时不会上传。修改打包配置本身不会自动导出旧镜像；需要重新执行完整发布时，可手动运行 `Publish library image`。
