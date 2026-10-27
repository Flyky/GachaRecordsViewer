# R12 米游社凭证与账号后端

日期：2026-10-27。后端代码与两种数据库的模拟上游契约已完成。R13 后续真实扫码已验证 SToken 派生、LToken 身份校验、重新授权、加密保存和重启后 validate／reveal；独立 LToken-only／Cookie Token-only 的真实手动导入仍未实测。详见 [R13 验证记录](miyoushe-qr-api.md)。

本轮提供 API，页面在 R15 接入，扫码会话见 [R13 接口](miyoushe-qr-api.md)，记录刷新在 R14 实现。目前直接授权只适配国服原神，UIGF 离线导入范围保持原状。

## 认证与接口

所有接口要求普通用户会话。管理员会话不能读取普通用户凭证，owner 始终从会话取得；其他用户的账号 ID 返回 404。所有响应为 `Cache-Control: no-store`，写请求沿用配置 Origin、JSON 和 `X-CSRF-Token` 校验，参见 [认证 API](auth-api.md)。

下表 `:id` 是本应用社区账号 ID，`accountId` 字段是米游社身份 ID，`profileId` 是本应用游戏档案 ID。

| 方法与路径 | 请求体 | 结果 |
| --- | --- | --- |
| `GET /api/community/accounts` | 无 | `{ accounts }`，仅当前用户 |
| `GET /api/community/accounts/:id` | 无 | `{ account }` |
| `POST /api/community/accounts` | `{ "input": "Cookie 或 JSON 文本" }` | 201，验证成功后创建，返回 `{ account }` |
| `POST /api/community/accounts/:id/credentials` | 同上 | 验证成功后整组替换，返回 `{ account }` |
| `POST /api/community/accounts/:id/validate` | `{}` 或 `{ "profileId": "本人的绑定档案 ID" }` | 重新校验并更新能力，返回 `{ account }` |
| `POST /api/community/accounts/:id/reveal` | `{ "type": "stoken" }`，亦可 `ltoken` / `cookieToken` | `{ accountId, mid, type, value }`，仅显式查看时返回明文，供后续页面查看／复制 |
| `POST /api/community/accounts/:id/export-credentials` | `{}` | `{ credentials }`，R17 新增，仅本人主动复制时返回可重新导入的 JSON 字段，不含设备／主密钥／AuthKey |
| `POST /api/community/accounts/:id/unlink` | `{}` | 204，删除凭证与社区绑定，保留抽卡历史 |

默认账号响应只包含本地 ID、provider、米游社 accountId、能力、凭证存在状态和固定遮挡值，以及绑定档案的 ID／UID／region／timezone。不会包含 Token、mid、密文、AuthKey 或上游个人资料。缺失凭证的 `maskedValue` 为 null；已有但失效的凭证仍可由本人查看。

导入、替换和校验共同限速：15 分钟内每个本地用户最多 10 次、每个请求 IP 最多 20 次，超限返回 429 和 Retry-After。同进程中每用户只允许一个凭证变更／校验／查看／解绑操作，冲突返回 `409 COMMUNITY_BUSY`；列表读取不受此锁限制。

## 手动输入与能力

`input` 接受 `key=value; key=value` Cookie 文本（可带 `Cookie:` 前缀），或一个 JSON 对象的文本形式。示例仅作字段说明：`stuid=12345;mid=example-mid;stoken=example-stoken`，占位值不能用于真实调用。

| 标准字段 | 接受的别名 |
| --- | --- |
| accountId | `accountId`、`account_id`、`account_id_v2`、`stuid`、`stuid_v2`、`ltuid`、`ltuid_v2` |
| mid | `mid` |
| stoken | `stoken`、`stoken_v2` |
| ltoken | `ltoken`、`ltoken_v2` |
| cookieToken | `cookieToken`、`cookie_token`、`cookie_token_v2` |

身份 ID 必须是 1–20 位正十进制整数，以字符串处理；JSON 数字仅接受安全整数。多个身份别名须一致；不同值的 Token 别名和重复 Cookie 键会被拒绝。空字段视为缺失，忽略 login_ticket 等未知字段，不保留原始输入。凭证值限制为可打印 ASCII，不接受空白、分号或控制字符。输入最多 24,000 字符，单项最多 8,192 字符，mid 最多 256 字符，请求体最多 32 KiB。

- **SToken + mid**：先换取 Cookie Token 并检查上游返回身份，再尝试获取／验证 LToken，最后读取绑定角色。新 Token 只有经过相应校验才保存。可选 LToken 获取失败时可保留已验证的 SToken／Cookie Token，LToken 标为 missing；验证挑战、身份不一致或取消会停止整个操作。
- **只有 LToken**：调用身份校验，保存验证得到的身份 mid。可以完成身份确认，但角色和祈愿能力均为 missing，不调用仅接受 Cookie Token 的角色接口。
- **只有 Cookie Token**：读取角色列表完成校验，可以绑定档案；没有 SToken 时祈愿能力仍为 missing。
- 同时提交的凭证必须通过对应校验；使用 SToken 时派生新凭证替代用户附带的值，不保存未经验证的附带值。替换要求米游社身份与原账号一致，不把一个账号原地改成另一个账号。

`capabilities` 分别返回 identity、roles、wish、三类 tokens 和 lastValidation；状态含 missing、unverified、verified、invalid、verification_required、error、authkey_verified，并附 checkedAt 和必要的固定 code。已验证只表示相应调用在该时间成功；后续可过期。

普通导入／校验只将 wish 标记为 `unverified / authkey_not_checked`。只有显式提交本人的绑定 `profileId`，服务端才针对这个档案生成一次 AuthKey 并立即丢弃，成功标记 `authkey_verified` 和 `history_not_checked`。不读取抽卡记录，不代表所有 UID、所有池或完整刷新已验证，也不产生刷新任务。

## 绑定、替换、解绑和加密

从 Cookie Token 取得的角色列表是当前绑定依据，限国服官服／渠道服原神。每次成功校验至多接受 32 个原神角色，上游原始角色列表上限 64。服务按 owner、游戏、UID 和 region 寻找档案：只有一个匹配的离线 unknown-region 档案时补齐 region、绑定并保留原 ID 和记录；没有时创建空档案。存在多个候选、已经绑定其他社区账号或时区不符合国服 +8 时返回冲突，不自动合并历史。

成功读取新角色列表后，已移除的角色会解除绑定并取消相关未完成任务，保留历史。仅用 LToken 校验没有权威角色列表，因此不改变既有绑定。解绑删除整组凭证，解除所有相关档案绑定，取消该 owner 下相关 queued／running／retrying 任务；其他用户的数据和任务不受影响。

上游验证在数据库事务之外进行。只有验证成功才将账号元数据、角色绑定和加密凭证一起提交；冲突全部回滚。替换失败保留旧凭证与旧能力；重新校验旧凭证明确失效时保留密文并更新失效状态，网络错误仅更新最后校验结果，挑战单独标记且不自动重试。

数据库事务与 owner 锁保护两库写入，凭证 UUID 用作更新版本：在途结果不得覆盖另一次替换或恢复已解绑的账号，返回 `CREDENTIALS_CHANGED` 或 `COMMUNITY_NOT_FOUND`。

Token 和设备上下文整组使用 AES-256-GCM 加密，随机 12 字节 IV、16 字节认证标签；AAD 绑定版本、owner、社区账号和凭证 UUID，移动密文到其他行会解密失败。由 R03 持久化的 32 字节 `data/credential-key` 派生专用子密钥；密文和密钥版本保存在 credentials 表。社区 accountId、mid 和能力属于数据库身份元数据，Token 明文仅用于请求与本人 reveal，不写日志或配置。

重启后在相同数据库和密钥下可复用已保存凭证与设备上下文。备份必须同时保留数据库、配置及原凭证主密钥；修改或遗失主密钥不能恢复旧 Token，参见 [部署备份说明](deployment.md)。本轮不提供密钥轮换工具。

## 错误与验证边界

固定错误包括 `INVALID_CREDENTIAL_INPUT`、`STOKEN_MID_REQUIRED`、`COMMUNITY_EXISTS`、`COMMUNITY_IDENTITY_MISMATCH`、`PROFILE_BINDING_CONFLICT`、`PROFILE_BOUND_ELSEWHERE`、`PROFILE_TIMEZONE_CONFLICT`、`PROFILE_NOT_BOUND`、`CREDENTIAL_NOT_AVAILABLE`、`CREDENTIAL_DECRYPT_FAILED`。上游错误转换为 `MIYOUSHE_*`：网络／协议／上游故障 502、超时 504、验证挑战 409、失效或身份不符等 422。不会用上游失效的 401 让本地用户退出，也不返回原始上游错误或个人信息。

本轮 73 项定向测试通过：provider 62 项、加密 1 项、SQLite／真实 PostgreSQL 各 5 组集成契约。覆盖别名、LToken 签名与身份、重启解密、篡改与行绑定、所有者与 CSRF、日志脱敏、失败替换、挑战停止、角色移除、解绑保留记录和版本／并发冲突。受影响类型、零警告 lint、后端与依赖构建通过；没有重跑浏览器、前端构建或无关全量测试。真实样例未读取，真实米游社账号未调用。

按用户本轮要求：将来需要真实扫码时，先完成独立工作，再在最后询问用户，得到回复后才创建二维码和开始轮询。允许将确认后的 Token 在本地加密保存供后续测试复用，失效时再请求授权；不要求用户每次重扫。本轮没有创建二维码或保存真实 Token。R02 命令行探针仍维持其原有不保存凭证的行为。

后续补充：R13 经用户确认后已进行真实扫码，加密授权保留于独立本地验证部署，结果与剩余边界见上方链接；不修改 R12 当时未调用真实账号的历史记录。

## 协议依据

本轮核对固定版本 [TeyvatGuide takumiReq.ts](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/src/request/takumiReq.ts)、[passportReq.ts](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/src/request/passportReq.ts) 和 [getRequestHeader.ts](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/src/utils/network/getRequestHeader.ts)。`verifyLtoken` 请求发送 JSON，但该参考实现的 DS 输入是参数形式的 body；provider 保留这一差异并单独验证签名。它属于社区实现依据，新增接口可用性仍需真实环境确认。沿用 [第三方许可说明](../THIRD_PARTY_NOTICES.md)。加密实现依据 [Node.js Crypto 文档](https://nodejs.org/docs/latest-v24.x/api/crypto.html#class-cipheriv)。
