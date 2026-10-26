# R07：UIGF 导入导出后端

日期：2026-10-27（Asia/Shanghai）。本轮提供 API、解析与持久化；上传、预览、选择 UID 和下载页面由 R08 接入。

## 格式与版本

接受明确的 `v4.0`、`v4.1`、`v4.2`，仅导入 `hk4e`。没有原神块时预览成功，返回 `NO_GENSHIN_DATA` 和空档案数组；空原神档案可以保存和导出。旧工具内部 JSON、v3、未知未来版本不自动转换或猜测。

三版完整标准 Schema 固化于 `packages/uigf/src/schemas/`，来自 [UIGF 标准仓库](https://github.com/UIGF-org/UIGF-org.github.io/tree/0bba3809236602d4ada66a84a17de4e0ab89d170/docs/zh/standards)，MIT 许可保存在 `packages/uigf/SCHEMA_LICENSE`。Ajv 使用 draft 2020-12，不进行类型转换或删除输入字段。导入只验证 `info` 与 `hk4e`，其他游戏块即便内容格式错误也不会阻止原神导入；响应明确列出实际出现的 `hkrpg`、`nap`、`hk4e_ugc`。导出重新通过对应版本的完整 Schema。

三版原神必填字段相同，但 **v4.2 的记录 ID 最多 19 位**。v4.0/v4.1 中更长的十进制字符串不会截断、转成 Number 或重新编号；请求导出 v4.2 时若不符合其限制，返回 `EXPORT_INCOMPATIBLE_VERSION`，可选择 v4.0/v4.1。默认导出 v4.0。

额外的应用校验：合法本地日期时间、整数时区 -12 至 +14、原始池与保底组一致、UID 为正十进制数且文件内不重复；数字 UID 必须处于 JS 安全整数范围，记录 ID 必须是字符串。ID 去重比较忽略前导零，保存与导出保留首次写入的原字符串。`301/400` 共享 `301` 保底分组，原始池不改变。

每次请求上限为 **16 MiB JSON 请求体、32 个原神档案、合计 100,000 条记录**。UID 最长 20 位，记录 ID 在旧版中最长 128 位，物品 ID 最长 64 位；物品名称最多 512 字符，其他可选记录字段最多 64 字符。这是单次导入限制，不是账号或累计历史数量限制。

## API 流程

所有接口只允许已登录的普通用户；使用 R04 的 Cookie、Origin 和 CSRF 规则。请求响应使用 `Cache-Control: no-store`，用户身份始终取自服务端会话，客户端不能传入 owner ID。写入请求均为 `application/json`。

| 请求 | 内容与结果 |
| --- | --- |
| `POST /api/uigf/preview` | `{ "document": <解析后的 UIGF 对象> }`；只读预览，不创建档案或批次 |
| `POST /api/uigf/import` | `{ "document": <同一对象>, "previewToken": "...", "profileIndexes": [0, 2] }`；只合并选中的原神档案 |
| `GET /api/profiles` | 当前用户的原神档案列表：ID、UID、地区、时区、语言、历史状态、数据版本、记录数、时间范围和元数据不完整数量 |
| `GET /api/uigf/export/:profileId` | 完整档案下载，默认 v4.0；可附加 `?version=v4.1` 或 `?version=v4.2` |

`profileIndexes` 对应预览中的 `index`，必须非空、不重复且属于当前文件。没有原神数据时不应显示执行导入按钮。导出忽略查询页筛选条件；接口不接受记录筛选参数。不存在的或属于其他用户的档案统一返回 404。

预览响应包含 `version`、`fileHash`、`previewToken`、`expiresAt`（毫秒时间戳）、`profiles`、`skippedBlocks` 和 `warnings`。文件指纹是服务端对收到的对象执行 `JSON.stringify` 后的 SHA-256，不是原始文件字节摘要。预览凭据通过独立用途密钥签名，绑定当前用户、文件指纹、档案 ID 和数据版本，**15 分钟有效**；不包含原始记录或上游授权凭证。应在内存保留原对象，在确认时重新提交，不能沿用其他文件的凭据。

每个档案的报告包含：

- `index / uid / timezone / lang` 和 `targetProfileId / dataVersion`；首次导入预览后两者为 null，成功后返回实际值。
- `total / inserted / duplicates / enriched`：文件行数、预计新增的唯一记录数、兼容的重复行数、已有记录中补全元数据的数量。`enriched` 是重复记录中的子集，不与其他数量相加作为总行数；冲突行另计。
- `conflicts / conflictDetails / blockers`：关键字段冲突次数、最多 20 个冲突的记录 ID 与字段名，以及档案级阻断原因。
- `metadataWarnings`：可选元数据差异被保留原值或语言冲突阻止补全的行数；`metadataIncomplete / metadataConflicts` 是本次文件输入按本地字典解析的行数，包含重复行，不代表合并后全档案总数。
- `firstTime / lastTime`：本次文件中该档案记录的本地时间范围；空档案为 null。档案列表接口返回保存后的完整范围。

导入成功返回 `batchId`、选中档案的最终报告与跳过块列表；重复导入新增为 0。真正新增或补全时 `dataVersion` 才递增；纯重复导入不改版本。导入批次只保存指纹和结果报告，不保存原始文件。

## 合并和冲突规则

按当前用户 + 原神 + UID 查找档案。不存在时创建地区为 `unknown` 的离线档案；唯一匹配时合并，即使已有档案绑定了具体地区。多个地区存在相同 UID 时返回 `AMBIGUOUS_PROFILE`，避免误选。已有档案时区与文件不同时返回 `TIMEZONE_CONFLICT`，本轮不自动改时区或重写历史。

相同记录 ID 的物品 ID、原始池、保底组、本地时间、UTC 时间或双方均提供的 `count` 不一致，记为关键冲突。任何选中档案存在关键冲突或档案级阻断，**整个所选批次不写入**，返回 409 与报告；未选中的冲突档案不妨碍其他选择。不会静默覆盖旧记录。

可选 `name / item_type / rank_type / count` 原值单独保存在 `metadata_json`；缺失的名称、类别、星级用 R06 字典补充内部查询字段，字典缺失或星级／类别冲突保持未知。标准允许的未知 `rank_type` 原文仍保留；不把未知星级猜成三星。重复记录仅补充旧记录缺少的可选字段，双方不同的已有可选值保留首次值并报告警告。不能将不同语言的名称与类别混成同一语言元数据。

导出仅投影标准字段，重新生成 `info`，输出原始可选元数据，不把临时字典推断写成原始数据。混合语言或无法确定名称语言时省略可选 `lang`，避免给整份档案错误标注语言。原文件的自定义字段、授权字段、其他游戏内容不持久化到记录，也不会进入导出。

SQLite 使用连接内串行事务和 `BEGIN IMMEDIATE`；PostgreSQL 使用事务内按 owner 的 advisory lock（命名空间 `72407001`，第二参数 `hashtext(ownerId)`）。确认时重新计算计划并校验预览版本，发生变化返回 `PREVIEW_STALE`。所有所选档案、记录和完成批次在同一事务中提交；失败一起回滚。未来 R14 刷新应遵守相同锁和版本约定。

导入不会持久化筛选后的序号或保底缓存。R09/R10 应基于合并后的完整历史调用领域逻辑，补入更早记录后重算，再筛选和分页。离线文件不会自动证明第一抽完整，`historyStatus` 默认仍为 `unknown`。

## 错误与客户端处理

| HTTP / code | 处理建议 |
| --- | --- |
| 400 `UNSUPPORTED_FORMAT / UNSUPPORTED_UIGF_VERSION` | 提示使用支持版本的 UIGF，旧格式不迁移 |
| 400 `INVALID_UIGF / INVALID_RECORD / INVALID_IDENTIFIER / INVALID_UID / INVALID_TIMEZONE / DUPLICATE_OR_INVALID_PROFILE` | 按 JSON 路径或档案／记录索引定位；索引从 0 开始 |
| 400 `IMPORT_LIMIT_EXCEEDED`；413 `INVALID_REQUEST` | 减少单次档案／记录或请求大小 |
| 400 `INVALID_SELECTION / INVALID_PREVIEW_TOKEN` | 重新选择或重新预览；不能换账号、改文件后复用凭据 |
| 409 `PREVIEW_EXPIRED / PREVIEW_STALE` | 重新预览并让用户确认最新结果 |
| 409 `IMPORT_CONFLICT` | 展示 `error.details` 内的报告，本次没有写入 |
| 400 `EXPORT_INCOMPATIBLE_VERSION` | 所选版本无法表达现有数据；提示切换版本，不截断 ID |
| 404 `PROFILE_NOT_FOUND` | 刷新档案列表，不泄露其他用户是否持有该 ID |

认证、CSRF、Origin 和其他请求结构错误沿用 [auth-api.md](auth-api.md)。错误响应不包含原始文件、密码、连接串或 SQL 参数。

## 本轮验证

使用合成数据完成 11 项定向测试：三版格式、缺省与未知元数据、空档案／无原神、跳过游戏块、字段投影、ID 精度和 v4.2 长度限制；SQLite 与独立 PostgreSQL 18.4 执行相同的选择、去重、补全、用户隔离、事务冲突、并发／过期预览、历史回补、导出再导入用例；真实认证 API 测试验证 Cookie／CSRF、预览签名、下载与跨用户限制。

受影响包类型检查、零警告 lint、服务端及依赖构建通过。独立 PostgreSQL 仅监听本机，测试后停止；没有重跑旧全量测试或浏览器验证，没有导入或修改用户提供的真实 JSON。R08 负责页面端到端验证。
