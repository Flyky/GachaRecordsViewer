# 本地认证与管理员 API（R04）

R04 已提供后端接口；R05 已接入登录、初始密码提醒、改密和独立管理员页面，见 [account-pages.md](account-pages.md)。无自助注册接口。

## 普通账号

| 方法与路径 | JSON 请求体 | 成功结果 |
| --- | --- | --- |
| `POST /api/auth/login` | `username`、`password` | 200，`{ user, csrfToken }`，设置用户 Cookie |
| `GET /api/auth/me` | 无 | 200，`{ user, csrfToken }` |
| `POST /api/auth/logout` | `{}` | 204，删除当前会话并清除 Cookie |
| `POST /api/auth/password` | `currentPassword`、`newPassword` | 204，撤销该用户全部旧会话并清除 Cookie，需要重新登录 |

`user` 只包含 `id`、`username`、`isInitialPassword`、`createdAt`。初始密码为 `12345678`；使用它可正常登录，`isInitialPassword` 仅供前端非强制提醒。改成其他密码后关闭该状态，主动改回初始密码时恢复。改密必须验证当前密码，不能指定别人的用户 ID。

新密码长度为 8–128 个字符，保留空格、不截断。普通用户名由管理员创建：去首尾空格、统一小写，3–32 位，以字母或数字开头，允许字母、数字、`_`、`.`、`-`；保留 `admin`。不按预计用户数量设置人数上限。

## 管理员

| 方法与路径 | JSON 请求体 | 成功结果 |
| --- | --- | --- |
| `POST /api/admin/login` | `username: "admin"`、`password` | 200，`{ admin: { username: "admin" }, csrfToken }`，设置独立管理 Cookie |
| `GET /api/admin/me` | 无 | 200，同上，恢复当前管理会话信息 |
| `POST /api/admin/logout` | `{}` | 204，删除管理会话并清除 Cookie |
| `GET /api/admin/users` | 无 | 200，`{ users: [...] }`，用于选择重置对象 |
| `POST /api/admin/users` | `username` | 201，`{ user, initialPassword: "12345678" }` |
| `POST /api/admin/users/:id/reset-password` | `{}` | 200，同上，恢复初始密码状态并撤销目标用户全部会话 |

管理员密码来自本机配置 `[admin].password`，长度为 8–1024 字符。修改配置并重启后，旧管理密码及会话失效，普通用户会话保留。管理员身份不占用普通用户表，管理 Cookie 不能用于普通账号接口；普通用户 Cookie 也不能调用管理接口。

管理员账号业务包含创建和重置，账号列表是重置所需辅助。R17 按用户新需求增加物品字典状态与刷新接口，详见 [R17 更新](r17-updates.md)。无删除账号、修改他人资料或查看他人记录接口。

## Cookie、CSRF 与前端接入

会话 ID 为 32 字节随机数，只通过 HttpOnly Cookie 传递；数据库保存它的 SHA-256 摘要。普通会话固定有效期 7 天，管理员 8 小时，不随访问续期。密码使用 Argon2id（19456 KiB、2 轮、并行度 1）及独立随机盐保存。接口不返回密码哈希、会话版本或原始会话 ID。

Cookie 设置 `HttpOnly`、`SameSite=Strict`，不设置 Domain；Path 使用配置 public_url 的路径（根路径为 `/`，子路径如 `/gacha/`）。HTTPS 启用 Secure：根路径 Cookie 名为 `__Host-grv_user`／`__Host-grv_admin`，子路径使用 `__Secure-grv_user`／`__Secure-grv_admin`；HTTP 使用 `grv_user`／`grv_admin`。是否 Secure 由部署配置决定，不信任请求传入的转发头。本文接口路径在子路径部署时统一加前缀，例如 `/gacha/api/auth/login`。

所有 API 写请求都需要 `Content-Type: application/json` 和允许的 `Origin`，包括登录；缺失 Origin 也会拒绝。生产仅允许 `PUBLIC_URL` 的 origin；开发启动额外允许 `http://127.0.0.1:5173` 和 `http://localhost:5173`。没有开放跨域 CORS。

登录成功后保存响应中的 `csrfToken` 到前端内存。后续认证写请求在 `X-CSRF-Token` 中提交它，读请求不需要。刷新页面可通过相应 `/me` 恢复。令牌绑定会话和身份，普通用户和管理员不可混用；同一未失效会话重启后仍有效。响应使用 `Cache-Control: no-store`。

前端调用例（`csrfToken` 来自当前用户登录或 `/api/auth/me`）：

```ts
await fetch('/api/auth/password', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  body: JSON.stringify({ currentPassword, newPassword }),
});
```

浏览器自动发送 Origin。使用命令行客户端时应显式提供部署 origin、保存 Cookie，并从 JSON 读取 CSRF 令牌。不要将真实密码或 Cookie 写进仓库脚本。

未来 API 通过 `app.authenticateUser` / `app.authenticateAdmin` 前置处理器检查会话；当前主体从 `request.principal` 取得。普通业务使用其中的 `user.id` 作为 owner，不能相信请求体中的 owner。初始密码状态不作为拒绝普通业务访问的条件。

## 错误与限速

认证错误采用 `{ "error": { "code": "..." } }`，不回显密码、SQL 参数或 Cookie。

| HTTP | 常见 code | 前端处理 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`、`INVALID_USERNAME` | 检查字段；不接受额外字段或自动类型转换 |
| 401 | `INVALID_CREDENTIALS` | 登录或当前密码错误；改密时此错误不表示现有会话已被撤销 |
| 401 | `UNAUTHENTICATED` | 缺失、过期、已撤销或身份不匹配的会话，重新登录 |
| 403 | `ORIGIN_REJECTED`、`CSRF_REJECTED` | 核对部署公开地址、当前会话与 CSRF 令牌 |
| 404 | `USER_NOT_FOUND` | 重置目标不存在 |
| 409 | `USERNAME_TAKEN`、`SESSION_CHANGED` | 用户名重复，或密码验证期间账号版本已变化 |
| 415 | `JSON_REQUIRED` | 使用 JSON 请求体 |
| 429 | `RATE_LIMITED` | 按 `Retry-After` 秒数等待 |

每 15 分钟固定窗口：每来源 IP 最多 20 次登录／当前密码验证尝试，每登录身份或改密用户最多 10 次。成功尝试也计数，防止绕过计算成本限制。限速保存在进程内、重启清空；不信任客户端 `X-Forwarded-For`。反向代理后的请求当前共用代理 IP 配额，多实例或可信代理配置将在部署需求明确时扩展。

R04 按用户要求采用精简验证：六组真实 SQLite 认证集成用例与改动范围类型／lint 检查；未重复运行 R03 的双数据库全量集成、生产构建或浏览器验证。PostgreSQL 认证端到端将在后续联合验收补齐，当前不标记为已实测。

依赖使用方式依据：[node-argon2](https://github.com/ranisalt/node-argon2)、[Fastify Cookie](https://github.com/fastify/fastify-cookie)。
