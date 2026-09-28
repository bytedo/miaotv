# TVBox 接入

MiaoTV 的 `/api/tvbox` 接口把已配置的视频源和直播源转换成 TVBox 配置。不同 TVBox 分支对配置字段和 Spider JAR 的支持有差异，导入后还需要在实际设备上检查搜索与播放。

## 导入配置

1. 打开本站的 `/tvbox` 页面，选择配置模式和返回格式。
2. 如果管理员启用了 Token 验证，填入管理员提供的 Token。
3. 复制配置地址，在 TVBox 的“设置 → 配置地址”中导入。

标准配置地址示例：

```text
https://tv.example.com/api/tvbox?format=json&token=YOUR_TOKEN
```

未启用 Token 验证时可以省略 `token`。是否启用验证以及用户可访问哪些源，由管理员配置，见 [TVBox 访问控制](./TVBOX_SECURITY.md)。

## 模式与格式

| 模式   | 参数                               | 生成内容                                           |
| ------ | ---------------------------------- | -------------------------------------------------- |
| 标准   | 省略 `mode` 或使用 `mode=standard` | 视频源、直播源、解析接口、IJK 设置、DoH 等配置     |
| 精简   | `mode=safe`                        | 保留视频源、直播源、Spider 和一个默认解析接口      |
| 快速   | `mode=fast`                        | 移除源的 timeout、retry 字段，简化请求头及解析配置 |
| 影视仓 | `mode=yingshicang`                 | 使用影视仓对应的解析接口和播放规则                 |

先用标准模式。客户端无法识别部分配置时尝试精简模式，使用影视仓时可以尝试对应模式。快速模式改变的是生成的配置，无法保证源站响应速度，也不能修复源站证书错误。

默认返回 JSON 文本。需要 Base64 的客户端可以使用：

```text
https://tv.example.com/api/tvbox?format=base64&mode=safe&token=YOUR_TOKEN
```

Base64 只是编码，任何拿到链接或配置的人都可以解码，不能用它隐藏 Token 或视频源地址。

## 配置参数

| 参数                 | 默认行为       | 说明                                                     |
| -------------------- | -------------- | -------------------------------------------------------- |
| `format`             | JSON           | 支持 `json`、`base64`                                    |
| `mode`               | 标准模式       | 支持 `standard`、`safe`、`fast`、`yingshicang`           |
| `token`              | 不带 Token     | 启用验证后需提供有效的全局或用户 Token                   |
| `filter`             | 按显示设置过滤 | `off` 跳过配置生成时的成人源筛选，具体边界见访问控制文档 |
| `forceSpiderRefresh` | 使用 JAR 缓存  | `1` 请求重新获取 JAR                                     |

旧说明中的 `adult`、`proxy`、`strict` 参数不会改变当前 `/api/tvbox` 配置生成逻辑，也没有 `/adult/` 路径前缀的自动重写。

配置接口不缓存生成结果。管理员改动源后，需要在 TVBox 中刷新配置，客户端才会重新读取。

## Spider JAR

部分源需要客户端加载 Spider JAR。后台会尝试候选地址，并缓存下载到的 JAR；成功缓存有效期为 4 小时，失败后的回退结果为 10 分钟。它会计算文件的 MD5，供配置和代理响应核对。

站点可以在 TVBox 配置中指定自定义 JAR。默认情况下，生成的地址会使用本站 `/api/proxy/spider.jar`；IP 访问、源内指定 JAR 或启用 Blob 时，返回的地址可能不同。

标准模式中的这些字段可用于排查：

| 字段               | 含义                 |
| ------------------ | -------------------- |
| `spider`           | 客户端实际读取的地址 |
| `spider_url`       | 后台获取 JAR 的来源  |
| `spider_md5`       | 本次 JAR 内容的 MD5  |
| `spider_cached`    | 是否使用了缓存       |
| `spider_success`   | 是否成功取得远程 JAR |
| `spider_real_size` | 文件字节数           |

精简和快速模式不保留全部诊断字段。若来源显示为 `fallback`，应继续检查远程下载失败的原因；有回退文件不代表其中具备当前视频源需要的解析功能。

已登录的站长或管理员可以使用 `GET /api/tvbox/health?url=ENCODED_JAR_URL` 检查公网 JAR，`url` 需要 URL 编码。接口使用管理员 Cookie 验证，单独的订阅 Token 无法访问；请求及重定向会经过网络目标检查。检查结果只说明本站服务器能否读取文件，TVBox 设备所在网络仍需单独验证。

### Vercel Blob

在 Vercel 部署且设置了 `BLOB_READ_WRITE_TOKEN` 时，项目可以将 JAR 上传到 Blob，并在后续配置中使用 Blob 地址。未配置时仍使用本站代理或远程地址。

[vercel.json](../../vercel.json) 中的定时任务为每天 01:00 UTC，对应新加坡时间 09:00。调度是否执行取决于部署环境；自建部署需要按[部署说明](../deployment/DEPLOYMENT.md)配置。Blob、远程 JAR 和源站的可用性需要在实际部署中检查。

## Worker 代理

管理员可在“TVBox 安全”配置的 Worker 代理区域填入自己的代理地址并启用。该设置独立于网页视频源代理。

生成地址采用以下形式：

```text
https://worker.example.com/p/source-key?url=ENCODED_UPSTREAM_URL
```

每个源使用不同的路径，源地址作为编码后的 `url` 参数传给 Worker。已有地址含嵌套 `url` 时，生成器会尝试提取上游地址，避免重复套代理。

Worker 需要兼容这套路径和参数转发方式，可以参考 [CORSAPI](https://github.com/SzeMeng76/CORSAPI)。使用 Worker 后，请求会经过外部服务；本站的来源校验不能替代 Worker 自己的访问控制。

## 排查

| 现象            | 检查方法                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| 导入失败        | 先用浏览器打开同一地址，看返回的是配置还是登录页、错误信息；再试 JSON 与 Base64 |
| 401             | 检查 Token 是否缺失、被替换或输错                                               |
| 403             | 检查账号状态、IP 白名单和反向代理传入的客户端地址                               |
| 429             | 停止反复刷新，等待下一个限流时间窗口                                            |
| 配置里缺少源    | 检查源是否启用、用户 Token 的源限制和内容显示设置                               |
| Spider 加载失败 | 用标准模式查看诊断字段，确认 TVBox 设备能访问 `spider` 地址                     |
| 视频无法播放    | 验证上游源、客户端解析器和 JAR 是否匹配；导入配置成功不代表每个源都可播放       |

反向代理后的配置若生成了错误域名或协议，可设置 `SITE_BASE` 为客户端可访问的完整站点地址，例如 `https://tv.example.com`，然后重新部署或重启进程。

实现见[配置接口](../../src/app/api/tvbox/route.ts)和 [Spider JAR 管理](../../src/lib/spiderJar.ts)。相关实现参考了 [DecoTV](https://github.com/Decohererk/DecoTV) 和 [KatelyaTV](https://github.com/katelya77/KatelyaTV)；客户端可参考 [TVBoxOSC](https://github.com/o0HalfLife0o/TVBoxOSC)。
