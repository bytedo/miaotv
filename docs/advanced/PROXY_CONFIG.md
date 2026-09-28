# MiaoTV 代理与来源授权

媒体代理会先检查访问身份和来源，再校验目标地址。部署时需要同时考虑这两层：登录账号不代表可以请求任意内网地址，配置了来源也不会自动开放匿名访问。

## 入口与身份

[src/proxy.ts](../../src/proxy.ts) 处理请求入口的身份检查。登录、注册、找回密码、重置密码、OIDC 注册和 `/download` 是公开页面。TVBox、定时任务等公开 API 还有各自的令牌或管理员权限检查；不要把整个 `/api/proxy/` 配成匿名放行。

| 请求                                                  | 访问规则                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/api/proxy/m3u8`、`segment`、`key`、`logo`、`stream` | 有效账号；配置了受信入口时，可信网络可免登录访问公网媒体。`stream` 必须指定启用的直播源。 |
| `/api/image-proxy`、`/api/video-proxy`                | 与媒体代理相同的账号及目标检查；视频支持 Range 和 HEAD。                                  |
| `/api/proxy/cms`                                      | 目标还必须匹配当前用户可用的 CMS 源 origin、API 路径，以及配置中已有的嵌套 `url` 参数。   |
| `/api/live/channels`、`epg`、`epg-debug`、`precheck`  | 检查启用的直播源；私网来源需要有效账号。冷缓存和缓存命中都执行来源检查。                  |
| `/api/live/merged`                                    | 保留既有公开订阅入口；匿名请求只拉取公网来源，私网来源需要有效账号的来源授权。            |
| `/api/proxy/spider.jar`                               | 保留公开读取。指定未配置的 JAR URL、强制刷新以及修改自定义 JAR 需要管理员。               |

Cookie 中自填的 `role`、`owner` 或 `trustedNetwork` 字段不能授予账号权限。可信网络免登录访问也不会创建一个站长账号；管理员操作和个人数据写入仍需验证账号。

可信网络只在已明确配置可信反向代理入口后读取转发 IP。相关配置见 [可信网络说明](../authentication/TRUSTED_NETWORK.md)。

## 私网来源与 DNS 校验

所有这些代理仅支持 HTTP/HTTPS，拒绝 URL 用户名和密码。DNS 的全部结果都要通过 IP 分类检查，并将验证后的地址固定给实际连接使用，避免验证和连接时分别解析导致 DNS rebinding。

私网许可绑定完整 origin，即协议、主机和端口。例如授权 `http://media.internal.example:8096` 后，另一台主机、另一个端口或 HTTPS 地址仍需单独授权。公网与私网 IP 混合解析也不会自动获得许可。

- 直播媒体的 `moontv-source` 必须对应管理员配置中启用的来源。登录用户才可取得该来源 URL 的私网 origin 许可。HLS、预检和流接口兼容 `decotv-source`；图片接口兼容 `source`。
- CMS 私网许可来自当前用户有权访问的配置源。任意传入一个 URL 或源名称都不能增加许可。
- 直播列表的 TVBox 二跳、列表中的 EPG URL、重定向目标都重新校验。来自列表内容的另一私网 origin 不会被信任。管理员在直播源中明确配置的独立 EPG origin，仅用于已授权用户的节目单请求。
- Emby 默认为关闭。开启后，普通用户只可见自己的来源和管理员明确共享的来源；个人保存一个私网 URL 不会产生私网许可。普通用户的私网访问必须匹配启用且公开的管理员 Emby 来源 origin，管理员可明确测试或配置自己的来源。
- 即使 origin 获准，回环、链路本地、云元数据、组播及保留地址仍拒绝。受控私网许可只涵盖 IPv4 私网、IPv6 ULA 与 CGNAT 地址范围。

每次 HTTP 重定向都会重新校验，默认最多三次。跨 origin 时删除 Authorization、Cookie、代理认证及 Emby 认证头。Emby 元数据和认证请求只允许同 origin 跳转，播放流可跳转至通过验证的公网 CDN。

`DISABLE_SSRF_PROTECTION=true` 不会关闭这些检查。`allowCORS=true` 只影响部分 HLS 链接是否重写，不授予账号权限或私网访问许可。

### 本机 fake-IP DNS

本机网络工具可能把公网图片域名解析为 `198.18.0.0/15` 的 fake-IP，导致安全代理在发起连接前返回 403。可以为运行 MiaoTV 的进程配置一个支持 [DNS JSON API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/) 的 HTTPS 解析器，例如：

```dotenv
PROXY_DNS_OVER_HTTPS=https://cloudflare-dns.com/dns-query
```

该选项默认关闭，仅在域名的系统 DNS 结果包含 fake-IP 时查询所配置的解析器。重新解析的全部地址仍需通过原有 IP 检查，并固定到实际连接；重定向仍重新校验。字面 IP、回环、云元数据和未授权私网地址不会因此获得访问许可。解析失败时返回错误，不会改用未经检查的连接。HTTPS 解析请求保留证书校验，禁止跳转，有超时与响应大小上限，并按 DNS TTL 短时缓存。

媒体代理每次请求使用独立连接，确保实际连接采用本次校验后的地址，避免复用此前私网授权建立的 socket；因此不会复用代理连接池。

此变量只供服务端使用，需要重启进程生效；不改变系统 DNS 或浏览器代理设置，也无需改动用户的图片代理选项。正常 DNS 环境无需配置。

## 清单、响应流与请求头

HLS 的相对链接以重定向后的完整清单 URL 为基准，支持没有 `.m3u8` 后缀的清单地址、仅查询参数的链接和清单变量。子清单、密钥和分片链接继续携带必要的来源及显式 Referer 上下文；签名 URL 不重复解码。

来源配置中的 UA 用于媒体请求，未设置时使用统一的 `DEFAULT_USER_AGENT`；直播列表解析保留其既有 UA，TVBox 格式列表使用专用 UA。Referer 只接受不含换行或 URL 凭据的 HTTP/HTTPS 地址。Range 会传给相应媒体接口，206 和 Content-Range 继续返回。视频与短剧 HEAD 请求不会转成完整 GET 下载。

代理要求上游使用 identity 编码；如果上游仍返回 gzip、deflate 或 Brotli，会先解压并删除失效的压缩长度。图片及重写后的 HLS 返回实际字节长度。媒体透传保持流式响应，分片按下游读取速度控制背压，客户端取消会传到上游。连接响应头和连接空闲有超时限制，持续到达的长视频流没有固定的整段播放时限。

图片拒绝非图片 Content-Type。SVG、透传媒体和 CMS 非 JSON 响应使用 `nosniff` 与受限 CSP，避免上游 HTML 或 SVG 在本站 origin 执行脚本。涉及来源授权的媒体、密钥、CMS 和频道响应使用私有缓存；密钥、logo 及 Emby 客户端的服务端缓存不能绕过来源停用或权限变更。

豆瓣图片使用 `https://movie.douban.com/` 作为 Referer，不发送图片 CDN 自身的 Origin；其他图片继续使用各自来源的请求头策略。来源配置的 User-Agent 仍保留。

| 缓冲内容                   | 大小上限       |
| -------------------------- | -------------- |
| HLS 清单                   | 5 MiB          |
| AES 密钥响应               | 1 MiB          |
| 通用图片 / 直播 logo       | 10 MiB / 5 MiB |
| CMS、直播列表、Emby 元数据 | 各 10 MiB      |
| 流式读取的 EPG XML         | 50 MiB         |

`precheck` 保留 `HTTP 200` 加 `success: false` 的探测失败格式；来源缺失、禁用或身份不符会在探测前拒绝。

## Worker 与可选功能

TVBox 和网页视频源分别配置 Worker。启用后，点播链路按 Worker、原始地址、本地 HLS 代理逐级尝试；直播使用各自的直连偏好和预检设置。Worker 是外部服务，本站的 DNS 固定与 origin 校验只约束本站发出的连接，不能代替 Worker 自己的授权和目标验证。

Emby、WebSR 需要各自的布尔开关。未配置、`false` 或字符串 `"true"` 均不会开启。相关服务端 API 会在执行前拒绝；Emby 管理测试、导入和导出也受开关限制。

启用 Emby 不会开放匿名 TVBox 入口。连接方法见 [Emby 影库](../integration/EMBY_GUIDE.md)，TVBox 的 Token 设置见[访问控制](../integration/TVBOX_SECURITY.md)。

## 验证与当前限制

仓库中的回归测试使用隔离的账号、配置、DNS 和 HTTP 替身，覆盖私网 origin、IPv4/IPv6、重定向和 DNS 绑定、账号权限、缓存撤权、HLS 重写、流背压与取消、Range/HEAD、Emby 来源以及可选 API 的关闭行为。可在本地运行：

```sh
node --test src/lib/__tests__/proxy-security.test.cjs src/lib/__tests__/proxy-dns.test.cjs src/lib/__tests__/optional-features.test.cjs src/lib/__tests__/emby-security.test.cjs src/app/api/__tests__/proxy-matrix.test.cjs
```

没有来源授权的私网点播链接会被拒绝。遇到此类错误时，应检查来源配置和账号权限。EPG 诊断接口只返回有限的诊断数据；真实 Worker、防盗链、浏览器播放、直播服务和 Emby 的兼容性仍需在实际部署环境中验证，隔离测试不能替代这些检查。
