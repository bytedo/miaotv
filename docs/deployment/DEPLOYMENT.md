# 部署 MiaoTV

第一次部署可以用仓库里的 [Compose 配置](../../compose.yaml)，它会在本机构建 MiaoTV，并启动 Redis。已有 Redis、Kvrocks 或 Upstash 的实例，可以继续使用原来的存储服务。

## Docker Compose

需要 Docker Engine 或 Docker Desktop，以及 Compose 插件。先获取源码：

```sh
git clone https://github.com/bytedo/miaotv.git
cd miaotv
```

以下命令在仓库根目录执行。

1. 复制环境变量示例：

   ```sh
   cp .env.example .env.local
   ```

   Windows PowerShell 使用 `Copy-Item .env.example .env.local`。

2. 编辑 `.env.local`，填写站长账号 `USERNAME` 和独立的长密码 `PASSWORD`。示例中的密码为空，不能直接用于启动。通过域名访问时，把 `SITE_BASE` 设为完整的 HTTPS 地址，末尾不加 `/`。

3. 构建并启动：

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 miaotv
   ```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)，用刚才设置的账号登录。进入 `/admin` 添加点播源，并检查注册开关；新数据库默认允许注册，对外提供访问前应按需要关闭注册或开启审核。短剧、弹幕等功能会使用第三方接口。

Compose 使用 `linux/amd64` 镜像，将应用端口绑定到 `127.0.0.1:3000`；Redis 不向宿主机开放端口，数据写入命名卷并启用 AOF。公网访问需要在宿主机上配置反向代理和 HTTPS。ARM 设备运行该示例需要 amd64 模拟环境。

Compose 中的 `environment` 会覆盖 `.env.local` 的同名设置，因此这个示例始终连接自带的 Redis。要接入已有数据库，先修改 Compose 中的存储设置和服务依赖，或使用下一节的独立容器方式。

普通停止不会删除数据卷：

```sh
docker compose down
```

`docker compose down -v` 会删除命名卷，其中包括 Redis 数据；保留数据时不要加 `-v`。数据卷能跨容器保留数据，但仍需另做备份。

## 使用已有数据库

先在仓库根目录构建本地镜像：

```sh
docker build --platform linux/amd64 -t miaotv:local .
```

下面以 Kvrocks 为例，替换 `.env.local` 中的示例值：

```dotenv
USERNAME=your_owner_name
PASSWORD=replace_with_a_long_unique_password
NEXT_PUBLIC_SITE_NAME=MiaoTV
NEXT_PUBLIC_STORAGE_TYPE=kvrocks
KVROCKS_URL=redis://:your_database_password@your_kvrocks_host:6666
SITE_BASE=https://tv.example.com
VIDEO_CACHE_DIR=/app/video-cache
```

Redis 使用 `NEXT_PUBLIC_STORAGE_TYPE=redis` 和 `REDIS_URL`；Upstash 使用 `upstash`、`UPSTASH_URL`、`UPSTASH_TOKEN`。URL 中的用户名或密码含有特殊字符时，要按 URL 规则编码。数据库地址必须能从容器内部访问；容器中的 `localhost` 指向容器自己。

macOS / Linux 可运行：

```sh
docker run -d --name miaotv --restart unless-stopped --platform linux/amd64 \
  --env-file .env.local -p 127.0.0.1:3000:3000 \
  -v miaotv-video-cache:/app/video-cache \
  miaotv:local
```

PowerShell 请将上述命令写成一行，或使用 PowerShell 的续行语法。这条命令创建新容器；如果已有同名容器，先按自己的升级流程处理旧容器。视频缓存默认在 `/tmp/video-cache`，示例同时设置了 `VIDEO_CACHE_DIR` 并挂载数据卷，才能将缓存保存在容器外。

Dockerfile 使用固定摘要的 Node.js 22 镜像和 pnpm 10.14.0，构建 Next.js standalone 产物，以非 root 用户运行。`.env.local` 不进入 Git 或 Docker 构建上下文；通过运行时环境传入凭据。

## 存储与升级

未设置存储类型时使用 `localstorage`，播放记录等数据只保留在当前浏览器，不能使用多用户注册和持久化后台管理。需要这些功能时选择 Redis、Kvrocks 或 Upstash。

SQLite 需要显式设置 `NEXT_PUBLIC_STORAGE_TYPE=sqlite`。默认数据库位于进程工作目录的 `data/lunatv.db`，可以用 `SQLITE_DB_PATH` 改路径；Docker 中应持久化挂载 `/app/data`。SQLite 依赖 Node.js 的 `node:sqlite`，不适合没有持久化文件系统的平台，也不支持邀请码功能。

升级前停止旧实例写入，保留旧镜像、运行配置和数据库的一致性原生备份。先用样本数据检查账号、播放记录、收藏和媒体源，再替换正式实例。后台 `.dat` 导出有自己的导出范围，不能代替整库备份。

账号凭据会在成功认证时兼容升级。播放记录、收藏和跳过配置兼容读取旧键与新 Hash；普通启动和请求不会批量迁移旧键。后台“数据迁移”中的旧数据整理由站长确认后执行，会复制缺失字段、保留旧键并返回计数。不要让旧版本继续写旧键，同时假定新旧格式会自动同步。回退前也要在隔离环境演练数据库恢复。

如果从曾向普通账号暴露 TVBox 全局密钥的旧实例迁入，请轮换全局密钥，普通账号改用个人密钥，并更新相关客户端。IP 白名单和可信网络默认不读取转发头；只有受控反向代理会清除并重写这些头时，才设置 `TRUST_PROXY_HEADERS=true`。可信网络只开放有限的匿名读取，不会授予站长权限。

## 从源码开发

按 [.nvmrc](../../.nvmrc) 使用 Node.js 22.23.2，pnpm 版本为 10.14.0。

```sh
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm dev:local
```

启动前按上文准备 `.env.local`。`pnpm dev:local` 只监听 `127.0.0.1`，并从项目环境文件读取站长用户名，避免 Windows 的系统 `USERNAME` 覆盖它。需要局域网调试时可用 `pnpm dev`，它监听所有网卡并遵循进程环境变量的优先级。检查命令见[贡献指南](../../CONTRIBUTING.md#检查改动)。

字体随仓库提供，构建不需要请求 Google Fonts。生产构建输出 standalone，Dockerfile 已处理静态资源复制和启动入口；自行打包 Node.js 服务时，还需把 `public` 和 `.next/static` 放入对应的 standalone 目录，不能只复制 `server.js`。

## 镜像发布与拉取

公开仓库的镜像地址为 `ghcr.io/bytedo/miaotv`。镜像只有在维护者成功执行发布流程后才可拉取；仓库中存在版本号或 `CHANGELOG` 条目并不表示镜像已经发布。

[docker-image.yml](../../.github/workflows/docker-image.yml) 构建 `linux/amd64` 镜像。Pull request 和分支推送运行检查与容器验证。发布需要维护者在 `bytedo/miaotv` 的 `main` 分支手动运行工作流，并选中 `publish_image`；Fork 和其他分支不会按这份策略推送镜像。

检查包含依赖锁文件安装、TypeScript、Lint、回归测试、隔离的 Redis／Upstash Lua 兼容测试和生产依赖审计。容器验证使用独立账号与临时 SQLite 数据，检查启动、认证和重启后的持久化；发布后记录镜像摘要。部署者仍需检查自己的数据库、媒体源和反向代理配置。

发布后可从仓库的 Packages 页面确认可用标签或摘要，再将运行命令中的 `miaotv:local` 换成相应镜像。应用版本中的 `+` 会在 Docker 标签中转成 `-`，例如 `6.6.6+1` 对应 `6.6.6-1`。升级时优先记录并固定摘要；拉取新镜像不会自动替换正在运行的容器。

## 其他平台

`edgeone.json`、`scripts/edgeone-build.mjs`、EdgeOne 工作流和 `render.yaml` 是平台模板，使用前需验证目标平台能运行当前 Next.js 和存储配置。

EdgeOne 模板使用 Node.js 22.23.2，构建命令为 `pnpm edgeone:build`，产物目录为 `.edgeone`。适配器默认拒绝执行；完成目标平台对 Next.js 16、Node.js 依赖、鉴权和存储的验证后，才设置 `MIAOTV_ENABLE_EDGEONE_TEMPLATE=1`。GitHub 工作流还要求仓库变量 `MIAOTV_ENABLE_EDGEONE_TEMPLATE=true`，CLI 由目标平台提供。

Render 模板使用 GHCR 镜像和 Upstash，需要填写站长凭据及数据库配置。等所需镜像成功发布后，将模板中的 `latest` 改为已验证的版本标签或摘要。无持久化磁盘的平台应禁用首页预告片缓存，设置 `DISABLE_HERO_TRAILER=true`；`VERCEL=1` 时应用会自动禁用首页预告片。

配置项见[配置说明](CONFIGURATION.md)，私网媒体源和转发规则见[代理配置](../advanced/PROXY_CONFIG.md)。

[返回文档中心](../README.md)
