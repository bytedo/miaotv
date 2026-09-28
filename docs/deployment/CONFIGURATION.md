# 配置说明

先用 [.env.example](../../.env.example) 配好站长账号和存储连接，再进入 `/admin` 设置视频源与站点功能。服务端存储会保留后台配置；修改环境变量不会覆盖所有已经保存的值。

`localstorage` 模式只保存当前浏览器的数据，不支持多用户注册和持久化后台管理。需要后台管理时，先在 [部署指南](DEPLOYMENT.md) 中选择服务端存储。

## 配置从哪里改

| 配置                               | 修改位置                          | 生效方式                                                                    |
| ---------------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| 站长凭据、存储连接、公开地址       | `.env.local` 或部署平台的环境变量 | 修改后重启服务；Docker 需重新创建容器                                       |
| 站点名称、公告、搜索、用户与媒体源 | 管理后台                          | 保存到数据库，按对应功能刷新                                                |
| 资源站 JSON、配置订阅              | 管理后台的“配置文件”              | 保存或拉取后更新站点配置                                                    |
| 邮件、Webhook、第三方登录          | 管理后台的对应面板                | 保存后测试；第三方登录的限制见 [OIDC 配置](../authentication/OIDC_SETUP.md) |

站长账号来自 `USERNAME`，密码来自 `PASSWORD`。`PASSWORD` 同时用于会话签名，修改后已有登录会话需要重新登录。不要把密钥放进 `NEXT_PUBLIC_` 变量；这类变量可以进入浏览器代码。

## 资源站配置

项目没有附带影视源。站长可以在“视频源配置”中逐个添加，也可以在“配置文件”中保存 JSON：

```json
{
  "cache_time": 7200,
  "api_site": {
    "example_source": {
      "api": "https://example.com/api.php/provide/vod",
      "name": "示例资源站",
      "detail": "https://example.com"
    }
  },
  "custom_category": [
    {
      "name": "华语电影",
      "type": "movie",
      "query": "华语"
    },
    {
      "name": "美剧",
      "type": "tv",
      "query": "美剧"
    }
  ]
}
```

`example.com` 是格式示例，需要换成你有权使用的资源接口。

| 字段                      | 含义                                       |
| ------------------------- | ------------------------------------------ |
| `cache_time`              | 接口缓存时间，单位为秒；默认 7200          |
| `api_site` 的键           | 视频源标识，建议使用小写字母、数字和下划线 |
| `api_site.*.api`          | 兼容苹果 CMS V10 格式的 VOD JSON API 地址  |
| `api_site.*.name`         | 页面显示的视频源名称                       |
| `api_site.*.detail`       | 可选的详情页根地址，用于解析剧集详情       |
| `custom_category.*.name`  | 分类显示名称                               |
| `custom_category.*.type`  | `movie` 或 `tv`                            |
| `custom_category.*.query` | 豆瓣搜索关键词，可以是类型、地区或具体片名 |

配置订阅支持远程 JSON 和 Base58 编码的 JSON。`UserConfig`、`SiteConfig` 等后台设置不属于这份资源站 JSON，不要把它们直接粘贴进“配置文件”编辑器。

## 环境变量

### 账号与存储

| 变量                       | 用途                     | 默认值或填写方式                                             |
| -------------------------- | ------------------------ | ------------------------------------------------------------ |
| `USERNAME`                 | 服务端存储模式的站长账号 | 自行设置，示例为 `admin`                                     |
| `PASSWORD`                 | 站长密码和会话签名密钥   | 无默认值，填写独立的长密码                                   |
| `NEXT_PUBLIC_STORAGE_TYPE` | 存储后端                 | `localstorage`；可选 `redis`、`kvrocks`、`upstash`、`sqlite` |
| `REDIS_URL`                | Redis 连接地址           | 仅 `redis` 模式需要，例如 `redis://redis:6379`               |
| `KVROCKS_URL`              | Kvrocks 连接地址         | 仅 `kvrocks` 模式需要，例如 `redis://kvrocks:6666`           |
| `UPSTASH_URL`              | Upstash REST 地址        | 仅 `upstash` 模式需要                                        |
| `UPSTASH_TOKEN`            | Upstash REST 令牌        | 仅 `upstash` 模式需要                                        |
| `SQLITE_DB_PATH`           | SQLite 文件位置          | 默认是进程工作目录下的 `data/lunatv.db`                      |

只填写所选后端需要的连接参数。Redis 兼容服务还需支持项目使用的 Hash、Set 和 Lua 操作；换服务前应检查兼容性。Upstash 使用 HTTP REST，部署在限制 TCP 连接的平台时可以考虑它。SQLite 需要持久化磁盘和支持 `node:sqlite` 的 Node.js，不支持邀请码。

### 站点与媒体

以下大部分变量用于初始化后台配置。已有站点优先在后台修改相应设置。

| 变量                                  | 用途                                                   | 默认值                             |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| `SITE_BASE`                           | 站点公开地址，供 OIDC 回调和邮件链接使用；末尾不加 `/` | 空，例如 `https://tv.example.com`  |
| `NEXT_PUBLIC_BASE_URL`                | 邮件链接的备用地址，优先级低于 `SITE_BASE`             | 空；不替代 OIDC 所需的 `SITE_BASE` |
| `NEXT_PUBLIC_SITE_NAME`               | 站点名称                                               | `MiaoTV`                           |
| `ANNOUNCEMENT`                        | 站点公告                                               | 内置公告                           |
| `NEXT_PUBLIC_SUB_URL`                 | 初始配置订阅地址                                       | 空                                 |
| `NEXT_PUBLIC_SEARCH_MAX_PAGE`         | 搜索最大页数，后台可设为 1–50                          | `5`                                |
| `NEXT_PUBLIC_FLUID_SEARCH`            | 流式搜索                                               | `true`；设为 `false` 关闭          |
| `NEXT_PUBLIC_DISABLE_YELLOW_FILTER`   | 关闭成人内容过滤                                       | `false`                            |
| `NEXT_PUBLIC_DOUBAN_PROXY_TYPE`       | 豆瓣数据代理类型                                       | `direct`                           |
| `NEXT_PUBLIC_DOUBAN_PROXY`            | 自定义豆瓣数据代理前缀                                 | 空                                 |
| `NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE` | 豆瓣图片代理类型                                       | `server`                           |
| `NEXT_PUBLIC_DOUBAN_IMAGE_PROXY`      | 自定义豆瓣图片代理前缀                                 | 空                                 |
| `TMDB_API_KEY`                        | TMDB API Key                                           | 空；演员搜索仍需在后台开启         |
| `DISABLE_HERO_TRAILER`                | 关闭首页预告片                                         | `false`；`VERCEL=1` 时自动关闭     |
| `VIDEO_CACHE_DIR`                     | 首页预告片的视频缓存目录                               | `/tmp/video-cache`                 |

Docker 持久化预告片缓存时，需要同时设置 `VIDEO_CACHE_DIR=/app/video-cache` 并挂载该目录；只挂载目录不会改变程序的缓存路径。无持久化磁盘或需要节省带宽时，设置 `DISABLE_HERO_TRAILER=true`。

豆瓣数据代理可选 `direct`、`cors-proxy-zwei`、`cmliussss-cdn-tencent`、`cmliussss-cdn-ali`、`custom`。图片代理可选 `direct`、`server`、`img3`、`cmliussss-cdn-tencent`、`cmliussss-cdn-ali`、`custom`。选择 `custom` 时，再填写对应的完整变量名 `NEXT_PUBLIC_DOUBAN_PROXY` 或 `NEXT_PUBLIC_DOUBAN_IMAGE_PROXY`。第三方代理的可用性由提供方维护。

### 代理与信任网络

| 变量                  | 用途                                                                | 默认值                                             |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| `TRUSTED_NETWORK_IPS` | 允许免登录读取的 IP 或 CIDR，以逗号分隔；非空时覆盖后台信任网络设置 | 空                                                 |
| `TRUST_PROXY_HEADERS` | 是否信任转发的客户端 IP                                             | `false`；仅在入口代理清除并重写转发头时设为 `true` |

信任网络不授予站长权限。地址识别与可访问范围见 [信任网络](../authentication/TRUSTED_NETWORK.md)。私网媒体源按授权来源的 origin 放行，`DISABLE_SSRF_PROTECTION` 不提供全局绕过，详见 [代理配置](../advanced/PROXY_CONFIG.md)。

## 注册与审核规则

全新的服务端存储实例默认允许注册，不要求审核或邀请码。只打算自己使用时，登录后台后关闭“允许用户注册”。这三个开关保存在 `UserConfig` 中：

| 开关                | 作用                             | 默认值  |
| ------------------- | -------------------------------- | ------- |
| `AllowRegister`     | 是否允许创建新账号               | `true`  |
| `RequireApproval`   | 无有效邀请码的新账号是否需要审核 | `false` |
| `RequireInviteCode` | 是否必须填写邀请码               | `false` |

“允许用户注册”是总开关，普通注册和 OIDC 新账号注册都要遵守。OIDC 还要求相应 Provider 允许注册。

| 允许注册 | 需要审核 | 必须邀请码 | 注册结果                                                 |
| -------- | -------- | ---------- | -------------------------------------------------------- |
| 关闭     | 任意     | 任意       | 拒绝新注册，有邀请码也不能注册                           |
| 开启     | 任意     | 开启       | 邀请码必填；有效邀请码注册免审核，邮箱选填，不要求来源   |
| 开启     | 开启     | 关闭       | 邀请码选填；不用邀请码时，邮箱和来源必填，注册后等待审核 |
| 开启     | 关闭     | 关闭       | 开放注册，邮箱选填，页面不显示邀请码或来源               |

邀请码只有在服务端成功校验并占用次数后才会免审核。不存在、禁用、过期、用尽或无法验证的邀请码会使注册失败。账号创建或资料保存失败时，系统会尝试清理本次创建的数据，并在清理成功后归还占用次数。

关闭注册或审核不会自动处理已有待审核账号。管理员仍需在待审核列表中批准或拒绝；仅待审核的新注册会触发待审核邮件和 Webhook。

注册页在首次打开、重新回到页面、请求失败时更新规则，也会每 15 秒同步。服务端按请求时的设置验证，即使页面尚未刷新，也不能绕过已关闭的注册或审核要求。邀请码的创建和接口说明见 [邀请码管理](../INVITE_CODE_SYSTEM.md)。

## 后台常用设置

| 面板           | 可配置内容                                                                  |
| -------------- | --------------------------------------------------------------------------- |
| 站点配置       | 名称、公告、豆瓣代理、搜索页数、缓存、内容过滤、TMDB 演员搜索、网页直播开关 |
| 用户配置       | 注册与审核、用户组、账号封禁、管理员权限、非活跃用户清理                    |
| 视频源配置     | 添加、检测、排序、批量导入导出视频源                                        |
| 直播源配置     | 添加 M3U/M3U8 地址、刷新频道、排序                                          |
| 分类配置       | 豆瓣搜索分类及显示顺序                                                      |
| 网盘搜索       | PanSou 地址、请求超时和功能开关                                             |
| TVBox 安全配置 | IP 白名单、Token 与个人密钥                                                 |
| 缓存管理       | 查看和清理网盘、豆瓣、弹幕等缓存                                            |
| 数据迁移       | 后台备份导入导出和旧存储键整理；由站长操作                                  |

网页直播的 `SiteConfig.EnableWebLive` 默认开启，已保存的关闭状态会保留。Emby 和 WebSR 的站点开关默认关闭，设置方法见下方的 [Emby 和 WebSR 开关](#emby-和-websr-开关)。

### 邮件与 Webhook

站长可以设置 SMTP 主机、端口、加密方式、账号、密码和发件人，用于注册待审核、审核结果和密码重置。密码重置邮件需要有效的 `SITE_BASE` 或 `NEXT_PUBLIC_BASE_URL`，邮件链接使用该地址。

Webhook 普通地址收到 JSON POST。配置签名密钥后，请求头 `X-Webhook-Signature` 是请求体的 HMAC-SHA256 十六进制签名。地址含 `{username}`、`{email}`、`{source}`、`{reason}` 或 `{message}` 时改用 GET，变量会进行 URL 编码；GET 模板不发送请求体签名，URL 中的用户信息也可能进入接收方的访问日志。

先保存配置，再发送测试邮件或通知；测试使用已保存的配置。SMTP 密码和 Webhook 签名密钥以 `******` 显示，保留占位符会沿用原值，清空则删除。启用 SMTP 并填写用户名时，也需要保留或填写密码。

## Emby 和 WebSR 开关

这两个开关目前没有独立的后台控件。使用服务端存储时，站长可以登录自己的实例，在 `/admin` 页面的浏览器开发者工具控制台执行下面的代码。示例同时开启 Emby 和 WebSR；不需要的那一项改为 `false`，也可以用同样的方法关闭它。

代码先读取当前配置，再只修改两个布尔字段并保存。执行期间不要在其他后台页面同时保存配置，因为该接口提交的是整份配置。无需复制 Cookie、手写完整配置或直接修改数据库。

```javascript
(async () => {
  const readResponse = await fetch('/api/admin/config', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!readResponse.ok) {
    throw new Error(`读取配置失败：HTTP ${readResponse.status}`);
  }

  const { Role, Config } = await readResponse.json();
  if (Role !== 'owner' || !Config?.SiteConfig) {
    throw new Error('请使用站长账号，并确认已配置服务端存储。');
  }

  Config.SiteConfig.EnableEmby = true;
  Config.SiteConfig.EnableWebSR = true;

  const saveResponse = await fetch('/api/admin/config', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Config),
  });
  if (!saveResponse.ok) {
    throw new Error(`保存配置失败：HTTP ${saveResponse.status}`);
  }
  console.info('开关已保存，请刷新页面。');
})().catch((error) => console.error(error.message));
```

GET 响应中的 `Config` 才是 POST 接收的配置对象。原有的 SMTP 密码和 Webhook 签名密钥以 `******` 返回，保存接口会沿用数据库中的原值；代码不会打印配置内容。执行成功后刷新页面，再按 [Emby 指南](../integration/EMBY_GUIDE.md#添加个人源)添加媒体库。WebSR 还需要浏览器支持 WebGPU。

[返回文档中心](../README.md)
