# 邀请码管理

站长和管理员可以生成邀请码，限制使用次数和有效期。用户成功使用有效邀请码后直接完成注册，不需要审核。邀请码功能需要 Redis、Kvrocks 或 Upstash，SQLite 和 `localstorage` 不支持。

## 开启邀请码注册

在管理后台的用户设置中开启“允许用户注册”和“需要邀请码注册”。如果只开启“需要审核注册”，用户也可以选填邀请码来免审核；不填则提交审核资料。

这些开关保存在后台的 `UserConfig` 中，不属于资源站配置 JSON。关闭“允许用户注册”会停止所有新注册，即使用户持有有效邀请码也不能注册。规则组合见 [注册与审核规则](deployment/CONFIGURATION.md#注册与审核规则)。

在“邀请码管理”中创建邀请码，可填写自定义码，也可以留空随机生成：

| 参数         | 范围                                  | 默认值              |
| ------------ | ------------------------------------- | ------------------- |
| 自定义邀请码 | 4–32 位英文字母、数字、短横线或下划线 | 留空生成 8 位随机码 |
| 最大使用次数 | 1–1000 次                             | 10 次               |
| 有效期       | 1 小时至 365 天                       | 7 天                |

自定义码会去除首尾空白并转为大写，例如 `MIAO-2026`、`VIP_FRIENDS`。随机码使用 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`，避开 `0`、`O`、`1`、`I` 等容易混淆的字符。创建和注册都不区分大小写。

已禁用、用完或过期的邀请码仍占用原名称，并保留使用记录。管理员可以禁用、重新启用或删除邀请码；重新启用不会恢复已消耗次数，也不会延长有效期。删除会移除邀请码本身和它的使用记录，不会删除已注册的账号。

## 管理接口

下面的 `/api/admin/invites` 接口需要有效的站长或管理员会话，使用登录后的 `user_auth` Cookie。示例中的 Cookie 是占位符，不是独立的 API Token。

### 创建

```http
POST /api/admin/invites
Content-Type: application/json
Cookie: user_auth=<登录后的会话值>

{
  "code": "MIAO-2026",
  "maxUses": 10,
  "expiresIn": 604800
}
```

`code` 可省略或留空；`expiresIn` 的单位为秒。成功响应：

```json
{
  "ok": true,
  "code": "MIAO-2026",
  "message": "邀请码生成成功"
}
```

参数错误返回 `400`，重名返回 `409`。创建会原子检查重名并写入；并发创建同一个自定义码时，只有一个请求成功，已有的使用历史不会被覆盖。

### 查看列表

```http
GET /api/admin/invites
Cookie: user_auth=<登录后的会话值>
```

响应包含 `ok`、`codes` 和 `total`。`codes` 包含所有状态的记录，并按创建时间从新到旧排列。每条记录包括：

| 字段                                      | 含义                                               |
| ----------------------------------------- | -------------------------------------------------- |
| `code`                                    | 邀请码                                             |
| `createdBy`、`createdByUid`               | 创建者的当前名称和 UID；旧记录可能没有 UID         |
| `createdAt`、`expiresAt`                  | ISO 格式的创建时间与到期时间                       |
| `maxUses`、`currentUses`、`remainingUses` | 总次数、已用次数与剩余次数                         |
| `status`                                  | `active`、`used_up`、`expired` 或 `disabled`       |
| `expired`、`disabled`                     | 是否过期、是否禁用                                 |
| `users`、`userUids`                       | 使用者名称及可解析到的 UID；旧名称记录不一定有 UID |

### 禁用或启用

```http
PATCH /api/admin/invites?code=MIAO-2026
Content-Type: application/json
Cookie: user_auth=<登录后的会话值>

{
  "disabled": true
}
```

把 `disabled` 改为 `false` 可重新启用。不存在的邀请码返回 `404`。

### 删除

```http
DELETE /api/admin/invites?code=MIAO-2026
Cookie: user_auth=<登录后的会话值>
```

成功返回 `{"ok":true,"message":"邀请码已删除"}`，不存在时返回 `404`。修改和删除时使用列表返回的大写码。

## 注册与验证

普通注册请求带上 `inviteCode`：

```http
POST /api/register
Content-Type: application/json

{
  "username": "newuser",
  "password": "replace-with-your-own-password",
  "confirmPassword": "replace-with-your-own-password",
  "inviteCode": "MIAO-2026"
}
```

示例密码需要自行替换。`RequireInviteCode=true` 时邀请码必填；审核注册中可选填。有效邀请码允许邮箱选填、不要求来源，并跳过审核。OIDC 完成注册时也使用相同的邀请码校验规则。

服务端在创建账号前原子占用一次名额。无效、禁用、过期、用尽或无法验证的邀请码都会使注册失败。如果账号创建或资料保存失败，系统会尝试清理本次账号数据；只有确认清理完成后，才归还占用次数。

还可以单独检查邀请码：

```http
POST /api/invites/validate
Content-Type: application/json
Cookie: user_auth=<登录后的会话值>

{
  "code": "MIAO-2026"
}
```

当前该接口受站点认证拦截，需要有效登录会话。注册页不依赖这个接口，`/api/register` 会重新验证并占用次数。验证成功只代表查询当时可用，不会预留名额。

成功响应：

```json
{
  "valid": true,
  "remainingUses": 7
}
```

无效时返回 `400`，响应含 `valid: false` 和 `error`；未登录时会先返回 `401`。

## 存储结构

邀请码使用 Redis Hash、List、Set 和 Lua 操作。新记录通过 UID 关联创建者和使用者，账号改名后仍可追踪；历史记录继续保留原名称。

| 键                      | 类型 | 内容                                                                         |
| ----------------------- | ---- | ---------------------------------------------------------------------------- |
| `invite:CODE`           | Hash | 邀请码、创建者名称与 UID、创建时间、有效期、使用次数、禁用状态，以及占用凭据 |
| `invite:CODE:users`     | List | 使用者引用；新记录为 `uid:UID`，历史记录可能是用户名                         |
| `invites:active`        | Set  | 活跃邀请码索引；最终是否可用仍由有效期与使用次数等条件决定                   |
| `admin:uid:UID:invites` | Set  | 创建者的邀请码索引                                                           |

旧的 `admin:USERNAME:invites` 索引仍有兼容读取逻辑。不要手动只改次数或删除某一个键，这会使记录、索引与占用凭据不一致。过期不会立刻删除历史记录；需要清理时从管理后台删除。

[返回文档中心](README.md)
