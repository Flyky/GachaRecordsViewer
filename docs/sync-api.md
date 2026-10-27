# R14 原神在线刷新任务后端

日期：2026-10-27。后端、定向测试与真实官服当前窗口拉取／重启／增量验证已完成。页面与刷新按钮见 [R15 使用说明](community-pages.md)，本轮不是签到功能。

## 接口

所有接口要求普通用户会话，写请求沿用 Origin、JSON 和会话 CSRF 校验。owner 来自会话，参数中的 profileId／jobId 都是本应用 ID；不接受调用方指定 UID、Token、AuthKey 或上游地址。其他用户的任务返回 404，任务列表只包含本人。

| 方法与路径 | 请求体／查询 | 返回 |
| --- | --- | --- |
| `POST /api/profiles/:profileId/sync` | `{}`，或 `{ "pools": ["301", "302"], "mode": "full" }` | 202，`{ job }`，已入队不表示拉取已完成 |
| `GET /api/sync/jobs` | 可选 `?profileId=...` | `{ jobs }`，最近 20 个本人任务 |
| `GET /api/sync/jobs/:jobId` | 无 | `{ job }` |
| `POST /api/sync/jobs/:jobId/retry` | `{}` | 202，新任务，retryOf 指向原任务 |
| `POST /api/sync/jobs/:jobId/cancel` | `{}` | `{ job }`，取消活动任务；终态重复取消不改变结果 |

默认卡池为 `100/200/301/302/500`，分别为新手、常驻、角色活动、武器活动、集录。角色活动统一通过 301 请求，接受返回 301／400 并共享保底分组；500 单独统计。不包含千星奇域。可多选 1–5 个不同池，不接受 400 单独作为请求池。

mode 默认 incremental，也可 full。创建及重试共同限速：每本地用户 10 次／15 分钟，每 IP 20 次／15 分钟，超限 429 与 Retry-After。同一档案同时只能有一个 queued／running／retrying 任务，冲突返回 `SYNC_ALREADY_ACTIVE`；全队列活动任务上限 32。当前为单进程部署，单个后台 worker 串行处理任务，不支持多实例竞争同一队列。

## 数据拉取和去重

创建任务前检查本人档案的国服绑定和可解密的 SToken／mid；后台执行时再次检查，从 SToken 换取 Cookie Token，核对社区身份并读取最新角色列表。只有目标 UID／region 仍在该列表中，才按池生成临时 AuthKey 拉取记录。仅有网页 LToken 或 Cookie Token 时返回 `STOKEN_REQUIRED`，不会假装可刷新。

每次请求 20 条，使用 end_id 向更早记录分页，要求字符串记录 ID 严格递减；验证 UID、卡池、物品 ID、时间及元数据，并按国服 +8 时区转换。不将大记录 ID 转成 JavaScript Number。上游分页请求全局串行、开始间隔至少 1 秒；AuthKey 仅保留在执行内存中，不进入任务、日志或导出文件。

本机实测发现上游 item_id 可能为空。只有名称、简体中文语言、物品类型和星级同时精确匹配本地固定字典的唯一条目，才补齐标准物品 ID；不做模糊名称匹配。未知或有歧义的条目返回 ITEM_ID_UNRESOLVED，该页不落库、该池失败，其他池仍可继续；需要更新本地字典后再试。上游提供非空 ID 时仍要求合法正十进制值，不把异常 ID 当成缺省字段忽略。

- **首次 incremental** 没有可信检查点时遍历到上游空页，取得其当前可提供的窗口。
- **后续 incremental** 从最新记录开始，跨过该池上次成功完成任务的最新 ID 后停止。检查点只来自成功完成的池，不能从失败的页或任意已有 UIGF 记录推断。新增内容先合并再停止，重复 ID 不重复插入。
- **full** 忽略检查点，从头遍历至上游空页，用于重新核对可见历史、补元数据或检查较早缺口。它不代表能恢复上游已经不可查询的历史。

每页在同一数据库事务中验证任务仍活动、档案绑定／时区未变且凭证版本一致，再合并记录并保存进度。复用 UIGF 的关键字段冲突和可选元数据补全规则：同 ID 的物品／池／时间等冲突使整页回滚，不覆盖已有历史；先前成功的页面和其他池保留。数据版本只在新增或补全时增加，重复内容不增加版本。不会删除上游本次未返回的本地记录，也不会据上游空页把档案宣称为从开服开始的完整历史。

在线记录 source 为 miyoushe，原始可选字段仍可通过既有 UIGF 导出接口导出。原始名字／类型／星级与本地字典的冲突仍遵循既有提示规则，不凭字典静默改写原始元数据。

## 进度、失败、重试和恢复

job 返回 id、profileId、status、mode、创建／更新时间、完成时间、retryOf、failureCode 和逐池 pools。每池包含 status、成功页数、fetched、inserted、duplicates、enriched、retries、authKeyRenewals、code 和 stopReason；空结束页也算一次成功请求。stopReason 为 upstream_end 或 checkpoint。响应不包含 owner、完整 UID、社区凭证版本、分页游标、Token、AuthKey 或设备信息。

| 任务状态 | 含义 |
| --- | --- |
| queued / running / retrying | 等待执行／正在执行／有限退避 |
| completed | 所有选定池均到达上游空页或可信增量检查点 |
| partial | 有池失败，但已有池完成或已有新记录保存 |
| failed | 本次未取得上述有效结果；failureCode 给出固定原因 |
| cancelled | 本人取消、解绑账号或角色移除；已保存的记录保留 |
| interrupted | 服务关闭或启动时发现遗留活动任务，等待用户重试 |

网络／超时、HTTP 429／5xx 最多重试两次，退避 1 秒、2 秒。历史请求的 AuthKey 失效最多为当前池重新生成一次；仍失效则停止。凭证失效、身份或角色不符、官方验证挑战会停止任务，不换 UID、不绕过验证、不无限重试。一般单池协议／上游错误保留失败状态并继续其他池。

任务最多执行 30 分钟、取得 100,000 条记录，每池最多 5,000 页，触限明确失败并保留此前记录；这些是服务保护限制，不承诺任意大历史单次完成。

retry 只对 partial／failed／cancelled／interrupted 开放，新建任务只选择原任务未完成的池，并从最新页开始重新核对，已保存页面自动去重；不续用过期 AuthKey 或盲信旧游标。原任务保持可查，成功池不被自动重拉。completed 和活动任务不支持 retry，需要时另建刷新。

启动时将遗留活动任务标记为 interrupted／SERVER_RESTARTED，不静默重复联网；正常关闭先中止 worker、记录 SERVER_STOPPED，再关闭数据库。重启后用户可调用 retry。任务信息和已经写入的记录持久化，两种数据库使用相同规则。

解绑账号／移除角色会取消相关活动任务，显式取消也会中止当前请求。即使迟到响应忽略中止，事务检查仍拒绝落库。凭证替换后旧任务返回 CREDENTIALS_CHANGED，需重新创建或重试。退出本地登录不会取消已经由本人创建的后台刷新任务，之后重新登录可查；这与绑定原登录 session 的一次性扫码会话不同。

固定错误包括 PROFILE_NOT_FOUND、PROFILE_NOT_BOUND、STOKEN_REQUIRED、SYNC_NOT_FOUND、SYNC_ALREADY_ACTIVE、SYNC_QUEUE_FULL、SYNC_NOT_RETRYABLE、SYNC_BINDING_CHANGED、CREDENTIALS_CHANGED、RECORD_CONFLICT、ITEM_ID_UNRESOLVED、SYNC_LIMIT_EXCEEDED 和 `MIYOUSHE_*`。未知执行异常仅记录 SYNC_FAILED，不输出原始 SQL／上游响应。任务结果是该次刷新证据；社区账号 capabilities 仍表示独立凭证校验的范围和时间。

## 验证范围

定向检查分两阶段进行：先通过 48 项刷新／provider／UIGF／扫码契约；真实字段差异修复后追加字典唯一反查，并重跑受影响的 provider、领域、刷新及 UIGF 用例。通过的不同用例合计 59 项（重复执行不重复计数）：provider 11 项、领域 10 项、两库刷新各 8 组、两库 UIGF 共 4 组、两库扫码共 18 组。覆盖长 ID、空物品 ID、名称唯一映射与未知／歧义拒绝、角色与池校验、全量／增量去重、标准导出、冲突整页回滚、部分失败与重试、退避及 AuthKey 更新上限、凭证／挑战停止、owner／CSRF、并发档案锁、迟到响应和重启恢复。受影响类型、零警告 lint、后端与依赖构建通过，真实 PostgreSQL 测试后停止；未重跑前端／浏览器或无关全量。

真实验证复用了 R13 独立本机部署中加密保存的授权，只选择已确认的官服 `10***44`。2026-10-27 12:59–13:01（Asia/Shanghai），本机 Windows／Node.js 24.22.1／当前网络／SQLite 下通过正式认证和刷新 API 完成以下验证，全程未扫码：

| 请求池 | 当前窗口获取条数 | full 成功页数（含空结束页） | 重启后 incremental 新增 |
| --- | ---: | ---: | ---: |
| 100 新手 | 0 | 1 | 0 |
| 200 常驻 | 154 | 9 | 0 |
| 301 角色活动 | 1,105 | 57 | 0 |
| 302 武器活动 | 114 | 7 | 0 |
| 500 集录 | 0 | 1 | 0 |
| 合计 | 1,373 | 75 | 0 |

首次 full 任务约 82 秒完成，五池均以 upstream_end 结束；关闭应用／数据库连接后重建，记录数仍为 1,373、原任务仍为 completed。第二次 incremental 约 11 秒，共五页；三个非空池各校验 20 条重复记录并到达 checkpoint，两个空池正常结束，新增和元数据补全均为 0。全部 1,373 条记录的 UIGF v4.0 导出通过标准校验，导出数量与数据库一致。

本次初始严格校验曾拒绝上游空 item_id，未写入不合法数据；核对字段形态后增加精确唯一字典映射并通过补充测试，再重新完成上述拉取。验证部署位于本机忽略目录 `test-results/r13-live/`，保留加密授权和已拉记录供后续测试使用；真实数据、凭证、配置、密钥及验证脚本不提交。

1,373 条仅是上游当前可查询窗口，不是账号全部历史，与原有 UIGF 历史总量不同属正常边界。较早历史可通过 UIGF 合并补齐，本轮没有读取真实参考 JSON 或实现旧 JSON 迁移。新手／集录本次为空，只能证明当前空池请求成功。渠道服、国际服及最终部署网络仍未实测，不扩大官服结果；千星奇域不在首版范围。

分页参数与 1 秒间隔继续依据固定版本 [TeyvatGuide hk4eReq.ts](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/src/request/hk4eReq.ts)。接口是否在其他环境可用以独立实测为准。
