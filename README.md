# MiaoTV

[English](README_EN.md) · [文档](docs/README.md) · [参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG)

<div align="center"><img src="public/logo.png" alt="MiaoTV" width="120"></div>

MiaoTV 是一个可以自己部署的影视聚合与播放站，基于 MoonTV 和 LunaTV 开发。接入视频源、直播源或 Emby 媒体库后，可以在浏览器里搜索、播放、收藏，并接着上次的进度观看。

项目不托管影视内容。点播源由部署者配置，短剧、弹幕等功能会调用第三方接口。请使用有权访问的内容。

## 能做什么

- 搜索多个视频源，浏览豆瓣、Bangumi 和短剧内容。
- 播放点播与直播，切换线路和集数，加载弹幕，设置片头片尾跳过。
- 保存收藏、观看记录和想看列表；配置服务端存储后，可在多个设备间同步。
- 管理用户、邀请码和注册审核，配置邮件通知、密码找回与 OIDC 登录。
- 接入 Emby、TVBox 和兼容客户端，按需开启视频下载与 WebSR 画质增强。

Emby 和 WebSR 默认关闭，需要通过[站点配置](docs/deployment/CONFIGURATION.md#emby-和-websr-开关)启用。WebSR 需要浏览器支持 WebGPU。第三方接口、媒体源和客户端兼容性会影响功能可用性，具体设置见[文档目录](docs/README.md)。

## 用 Docker 跑起来

需要 Docker 和 Docker Compose。[compose.yaml](compose.yaml) 会从源码构建 MiaoTV，并启动一个持久化的 Redis 实例；当前构建目标是 `linux/amd64`。

```sh
git clone https://github.com/bytedo/miaotv.git
cd miaotv
cp .env.example .env.local
```

Windows PowerShell 可以用 `Copy-Item .env.example .env.local` 复制配置。打开 `.env.local`，设置站长用户名 `USERNAME` 和密码 `PASSWORD`。密码没有默认值，请填写自己的长随机密码，再启动服务：

```sh
docker compose up -d --build
```

访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)，登录后在管理后台添加视频源。新数据库默认允许注册，对外开放前请检查注册、审核和邀请码设置。Compose 默认只监听本机，Redis 不对外开放端口；远程访问需要调整应用的端口绑定，或通过反向代理配置域名和 HTTPS。

Redis 数据保存在 `redis-data` 数据卷中。升级前备份数据库；删除数据卷会同时删除账号、配置和观看记录。已有数据库、镜像发布和其他平台的使用方式见[部署指南](docs/deployment/DEPLOYMENT.md)。公开仓库的 GHCR 镜像需要先由维护者运行发布流程，首次部署请按上面的方法从源码构建。

## 本地开发

使用 [.nvmrc](.nvmrc) 指定的 Node.js 22.23.2 和 pnpm 10.14.0。克隆仓库并准备 `.env.local` 后运行：

```sh
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm dev:local
```

`pnpm dev:local` 监听 `127.0.0.1:3000`，并从项目环境文件读取站长用户名，避免 Windows 的系统 `USERNAME` 覆盖它。换端口用 `pnpm dev:local --port 3001`。局域网调试可用 `pnpm dev`，它监听 `0.0.0.0`，并遵循进程环境变量的优先级。

[.env.example](.env.example) 默认使用浏览器本地存储，适合先查看页面和播放流程。注册、后台管理和跨设备同步需要 Redis、Kvrocks、Upstash 或 SQLite；SQLite 不支持邀请码。Compose 已配置 Redis，本地开发请按[配置说明](docs/deployment/CONFIGURATION.md)选择后端。

提交代码改动前运行：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

测试使用 Node.js 内置测试运行器。Redis/Lua 测试的额外依赖、目录说明和提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 使用和维护

| 要做的事                       | 文档                                                      |
| ------------------------------ | --------------------------------------------------------- |
| 部署、更新和备份               | [部署指南](docs/deployment/DEPLOYMENT.md)                 |
| 配置存储、注册、邮件和功能开关 | [配置说明](docs/deployment/CONFIGURATION.md)              |
| 接入 Emby、TVBox 或移动客户端  | [文档目录](docs/README.md#客户端与媒体库)                 |
| 配置第三方登录                 | [OIDC 登录及兼容限制](docs/authentication/OIDC_SETUP.md)  |
| 排查图片、视频和第三方接口连接 | [代理配置](docs/advanced/PROXY_CONFIG.md)                 |
| 了解认证与数据处理             | [安全与隐私](docs/security/SECURITY.md)                   |
| 报告问题或提交修改             | [贡献指南](CONTRIBUTING.md) · [安全漏洞报告](SECURITY.md) |

从旧版本升级时，保留数据库原生备份和旧镜像。后台的 `.dat` 导出不能代替整库备份。

## 来源与许可

MiaoTV 继承了 [LunaTV](https://github.com/SzeMeng76/LunaTV) 和 [MoonTV](https://github.com/MoonTechLab/LunaTV) 的工作，沿用 [CC BY-NC-SA 4.0](LICENSE)：保留署名、限非商业使用，修改后以相同许可分发。这个许可包含非商业限制，不属于 OSI 定义的开源许可证。

© 2025–2026 LunaTV Enhanced Edition & Contributors。来源、第三方组件和字体说明见 [NOTICE.md](NOTICE.md)。公开版本的变化记录在 [CHANGELOG](CHANGELOG) 中。
