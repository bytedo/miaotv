# 第三方登录配置

MiaoTV 的 OIDC 面板可以保存多个登录提供商。一般流程是：在身份服务中创建应用，把 Client ID、Client Secret 和端点填入后台，再用测试账号完成一次登录和注册。

下面记录当前代码的接入方式与已知限制。添加一个 Provider 或看到登录按钮，并不代表整个认证流程已经配置完成。

| 提供商                         | 当前接入方式                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Google、Microsoft 等 OIDC 服务 | 授权码换取 Token，再请求 UserInfo；端点可通过后台“自动发现”填入                             |
| GitHub                         | 已有 OAuth scope、JSON Token 响应和私有邮箱读取适配                                         |
| Facebook                       | 已有 scope 和 UserInfo 字段适配；端点版本需按应用后台填写                                   |
| 微信                           | 已有 `appid`、`secret`、`snsapi_login` 和 `openid` 字段适配，Token 请求方式仍需核对，见下文 |
| Apple                          | 当前有回调和 Token 处理缺口，不适合直接用于正式实例                                         |
| LinuxDo                        | 当前 Token 处理与旧文档描述不一致，见下文限制                                               |

## 准备回调地址

先在部署环境设置固定的站点地址，末尾不加 `/`：

```dotenv
SITE_BASE=https://tv.example.com
```

在身份服务的应用配置中登记：

```text
https://tv.example.com/api/auth/oidc/callback
```

协议、域名、端口和路径必须与实际使用的一致。`localhost` 和 `127.0.0.1` 是不同的地址；提供商允许本地回调时，可以使用 `http://localhost:3000/api/auth/oidc/callback`。正式实例使用 HTTPS。

应用优先用 `SITE_BASE` 生成回调地址；未设置时，会读取转发的主机和协议信息，再退回请求地址。经过反向代理部署时，固定 `SITE_BASE`，并让代理重写这些头，避免回调指向容器内部地址或错误域名。`NEXT_PUBLIC_BASE_URL` 只用于邮件地址的备用配置，不替代这里的 `SITE_BASE`。

第三方登录依赖服务端账号存储，`localstorage` 模式不支持这套注册流程。Client Secret 只填在管理后台或受控配置中，不要放进前端环境变量、截图或公开 Issue。

## 在管理后台添加 Provider

1. 用站长账号访问 `/admin`，打开“OIDC 登录配置”。
2. 使用“多 Provider 模式”，添加一个 Provider。
3. 填写唯一的 Provider ID、Client ID、Client Secret 和端点。
4. 启用这个 Provider，按需要设置“允许注册”，然后保存配置。
5. 用新的浏览器会话测试登录，保留站长的原会话，便于修改配置。

GitHub、Facebook、微信、Apple 的 Provider ID 分别使用小写的 `github`、`facebook`、`wechat`、`apple`。这些 ID 会选择对应的 OAuth 参数，不能只把它们当作按钮名称。Google 和 Microsoft 可使用 `google`、`microsoft`。

| 字段                      | 填写说明                                                        |
| ------------------------- | --------------------------------------------------------------- |
| Provider ID               | 本站内的唯一标识，已有账号绑定后不要随意修改                    |
| 名称、按钮文字            | 后台和登录页使用的显示文本                                      |
| 启用                      | 是否显示并接受该提供商的登录                                    |
| 允许注册                  | 是否允许该提供商创建新账号，还需站点总注册开关开启              |
| Issuer URL                | 提供方的身份服务地址；没有 OIDC discovery 的 OAuth 服务可以留空 |
| Authorization Endpoint    | 浏览器跳转到的授权地址                                          |
| Token Endpoint            | 服务端交换授权码的地址                                          |
| UserInfo Endpoint         | 服务端读取用户身份的地址                                        |
| Client ID / Client Secret | 在提供商后台创建的应用凭据                                      |
| 最低信任等级              | 检查新注册会话的 `trust_level`，默认 `0`；不代替账号封禁        |

使用自动发现时，输入 Issuer URL，点击“自动发现”，确认端点已经填入，再保存。只保存 Issuer 而把端点留空，登录仍会提示配置不完整。该功能读取 `{issuer}/.well-known/openid-configuration`，Issuer 末尾不要加 `/`。

新绑定会同时记录 Provider 和身份服务。修改 Provider ID、Issuer 或作为身份来源的端点，可能使已有账号无法匹配原绑定。旧数据只有一个 Provider 时可兼容读取；多个 Provider 下无法判断旧绑定属于哪一家时，应用会拒绝自动关联，需由管理员处理。

## Google

在 [Google Cloud Console](https://console.cloud.google.com/) 创建 Web 应用的 OAuth 客户端，配置授权同意屏幕和回调地址，再取得 Client ID 与 Client Secret。应用处于测试状态时，按 Google 后台要求加入测试用户。

```text
Provider ID: google
Issuer URL: https://accounts.google.com
Authorization Endpoint: https://accounts.google.com/o/oauth2/v2/auth
Token Endpoint: https://oauth2.googleapis.com/token
UserInfo Endpoint: https://openidconnect.googleapis.com/v1/userinfo
```

可以手动填写这些端点，也可以通过 Issuer 自动发现。应用请求 `openid profile email` 范围。

参考 [Google OpenID Connect 文档](https://developers.google.com/identity/openid-connect/openid-connect)。

## Microsoft Entra ID

在 [Microsoft Entra 管理中心](https://entra.microsoft.com/) 注册应用，选择要允许的账号类型，添加 Web 回调地址，并创建客户端密码。Client Secret 填“值”，不要填密钥的 ID。

单租户应用使用自己的租户 ID：

```text
Provider ID: microsoft
Issuer URL: https://login.microsoftonline.com/{tenant-id}/v2.0
```

在后台点击自动发现并保存端点。需要同时接受组织和个人账号时，应在 Entra 应用中选择对应的账号类型，再使用与该类型匹配的 authority，例如 `https://login.microsoftonline.com/common/v2.0`。不要为了让登录通过而扩大原本需要限制的租户范围。

此流程使用授权码，不需要按旧文档开启隐式授权。参考 [应用注册](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) 和 [UserInfo 端点](https://learn.microsoft.com/en-us/entra/identity-platform/userinfo)。

## GitHub

在 GitHub 的 **Settings → Developer settings → OAuth Apps** 创建 OAuth App，填写首页与回调地址，生成 Client Secret。

```text
Provider ID: github
Issuer URL: 留空
Authorization Endpoint: https://github.com/login/oauth/authorize
Token Endpoint: https://github.com/login/oauth/access_token
UserInfo Endpoint: https://api.github.com/user
```

GitHub OAuth 不提供这里使用的 OIDC 自动发现，需要手动填写三个端点。应用请求 `read:user user:email`，使用 GitHub 的用户 `id` 关联账号。当 `/user` 未返回邮箱时，会尝试从 `/user/emails` 获取已验证的主邮箱或其他已验证邮箱。

参考 [创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)。

## Facebook

在 [Meta for Developers](https://developers.facebook.com/) 创建应用、配置 Facebook Login 和有效的 OAuth 回调地址。应用的测试用户、上线条件和权限审核以该后台要求为准。

Provider ID 使用 `facebook`，Client ID 和 Client Secret 分别填写 App ID 与 App Secret。手动填写下面的端点，把 `{version}` 替换成该应用正在使用的 Graph API 版本，并在三个地址中保持一致：

```text
Authorization Endpoint: https://www.facebook.com/{version}/dialog/oauth
Token Endpoint: https://graph.facebook.com/{version}/oauth/access_token
UserInfo Endpoint: https://graph.facebook.com/{version}/me
```

应用请求 `public_profile email`，并在 UserInfo 请求中指定 `id`、`name`、`email` 和头像字段。用户未授权邮箱时，需要按本站注册规则补充资料。

参考 [Facebook Login](https://developers.facebook.com/docs/facebook-login/) 和 [Graph API 版本记录](https://developers.facebook.com/docs/graph-api/changelog)。

## 微信、Apple 与 LinuxDo 的限制

这些提供商在后台有配置入口，但当前实现仍有需要处理的兼容问题。不要照搬旧文档中的“已支持”表格直接上线。

### 微信

网站应用的端点为：

```text
Provider ID: wechat
Authorization Endpoint: https://open.weixin.qq.com/connect/qrconnect
Token Endpoint: https://api.weixin.qq.com/sns/oauth2/access_token
UserInfo Endpoint: https://api.weixin.qq.com/sns/userinfo
```

微信应用后台的“授权回调域”填写域名，不含协议和路径。MiaoTV 已区分 `appid` / `secret` 参数和 `snsapi_login` 范围，但当前回调用表单 POST 交换 Token；接入前需核对微信端点要求的请求方法并完成适配。开发者资质、审核和费用以 [微信网站应用文档](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login) 为准。

### Apple

当前回调会要求所有 Provider 都填写 UserInfo Endpoint，而 Apple 没有这个端点。Apple 分支还只是解码 `id_token`，没有使用 JWKS 验证签名，也没有完整验证 Token 的受众和有效期；后台保存 `jwksUri` 不会补上这些检查。

因此，Apple 需要先修复回调条件、补齐 Token 验证并完成真实登录测试，再用于正式实例。不要通过填写一个无关的 UserInfo URL 绕过配置检查。生成 Apple Client Secret 时应在受控环境使用自己的私钥，不要把 `.p8` 私钥上传到第三方在线生成器。

参考 [Sign in with Apple](https://developer.apple.com/sign-in-with-apple/)。

### LinuxDo

LinuxDo Connect 的常用端点为：

```text
Provider ID: linuxdo
Authorization Endpoint: https://connect.linux.do/oauth2/authorize
Token Endpoint: https://connect.linux.do/oauth2/token
UserInfo Endpoint: https://connect.linux.do/api/user
```

当前 MiaoTV 回调把 Client ID 和 Client Secret 放在表单中，没有实现旧文档所述的 HTTP Basic 认证；同时，`linuxdo` 分支仍要求响应包含 `id_token`。若提供方返回的是不含 `id_token` 的 OAuth Token，流程会报“token 无效”。接入前需按 [LinuxDo Connect](https://connect.linux.do/) 的实际协议补齐适配。

后台的最低信任等级只在完成新注册时检查，不会重新拦截已绑定账号的每次登录。停用现有账号应使用本站的封禁功能。

## 注册、审核与账号

第三方账号首次登录后，需要在本站选择用户名并补充注册规则要求的资料。站点的 `AllowRegister` 和 Provider 的“允许注册”都开启时，才能创建账号；有效邀请码可免审核，没有邀请码时遵守站点的审核规则。完整组合见 [注册与审核规则](../deployment/CONFIGURATION.md#注册与审核规则)。

新账号角色是普通用户，并继承配置的默认用户组。第三方登录不会绕过待审核或封禁状态。关闭新注册也不会阻止已批准、已绑定的账号继续登录。

OIDC 注册时会生成随机本地密码，用户没有可直接使用的初始密码。需要密码登录时，可以通过已配置的密码重置流程或管理员设置密码。不同提供商即使返回相同邮箱，也不会因此自动合并账号。

## 登录失败时检查什么

| 提示或现象                        | 检查方向                                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| `redirect_uri_mismatch`           | 核对 `SITE_BASE`、提供商回调地址、实际访问协议与域名                   |
| 状态验证失败                      | 从本站登录页重新发起；不要复用旧回调地址。状态 Cookie 有效期为 10 分钟 |
| OIDC 配置不完整                   | 确认 Provider 已启用，三个端点和客户端凭据已保存；Apple 有上文所述限制 |
| 获取 Token 失败、`invalid_client` | 核对 Client ID、Secret、密钥是否过期，以及提供方要求的 Token 认证方式  |
| 用户信息获取失败                  | 检查 UserInfo 地址、授权范围、服务端网络和提供方返回值                 |
| 该 OIDC 账号未注册                | 检查站点总注册开关和该 Provider 的注册开关                             |
| 旧 OIDC 绑定无法确定登录服务      | 用已有的账号密码登录并联系管理员处理绑定，避免重新注册占用同一账号     |

先查看服务端日志，再查看浏览器的跳转与请求状态。提交 [Issue](https://github.com/bytedo/miaotv/issues) 时附上版本、Provider ID、错误提示和脱敏后的配置，不要附 Client Secret、授权码、Token 或会话 Cookie。密钥泄露时，先在提供商后台撤销并换新，再更新本站配置。

[返回文档中心](../README.md)
