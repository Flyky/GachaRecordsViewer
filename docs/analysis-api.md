# R10：分析计算与接口

日期：2026-10-27（Asia/Shanghai）。本轮实现原有三组分析的数据计算和 API，页面由 R11 接入。没有增加欧非、UP 判断、消费折算或其他分析提案。

## 共用约定

三个接口均为 `GET /api/profiles/:profileId/analysis/...`，需要普通用户 Cookie 会话，返回 `Cache-Control: no-store`。用户身份始终取自会话，不能通过参数指定 owner；未知档案与他人档案统一返回 404 `PROFILE_NOT_FOUND`，未登录返回 401。

每次读取当前 owner 的完整档案快照，先按 R06/R09 的时区与元数据规则解析，再统计。接口只接受各自列出的参数，查询页的时间、名称、星级等筛选不会隐式影响统计；传入额外参数或不合法选项返回 400 `INVALID_REQUEST`。

共同响应字段：

| 字段 | 含义 |
| --- | --- |
| `profileId / uid / timezone` | 当前档案、UID 和游戏时区 |
| `dataVersion` | 与该响应的记录处于同一事务快照中的档案数据版本 |
| `historyCount` | 全档案已保存的记录条数，不随物品类型、日历年份或池改变 |
| `metadataIssues.incompleteRecords` | 本条元数据缺失／冲突，或同一物品 ID 跨记录存在类型／星级矛盾的记录数 |
| `metadataIssues.conflictRecords` | 本条元数据冲突，或同 ID 跨记录矛盾的记录数，是上项的子集 |
| `metadataIssues.unknownRankRecords` | 本条星级未知，或同 ID 跨记录有相互矛盾星级的记录数 |

所有数量按记录条数计算，原始可选字段 `count` 不扩展为额外抽数。可选名称缺失可以用本地字典补全，明确无效星级和与字典冲突的字段保持不确定；不猜测新的物品 ID。显示名沿用 R09 的简体中文解析规则，原始字段仍保留用于导出。

SQLite 通过既有串行事务读取，PostgreSQL 沿用 owner advisory lock；快照携带 `dataVersion`，单个响应中的版本与记录一致。未来页面同时请求三个接口时，如果收到不同版本，应刷新对应分析，不能把它们当成同一版本的数据拼接。没有建立永久统计缓存；历史回补后直接重算。Schema 无变更。

## 物品分组

`GET /api/profiles/:profileId/analysis/items`

| 参数 | 值 |
| --- | --- |
| `itemType` | `character / weapon`，默认 `character` |
| `order` | 数量 `asc / desc`，默认 `desc` |

返回 `itemType / order / groups / selectedTypeCount / otherTypeCount / unclassified` 和共同字段。

- 角色 `groups` 固定为五星、四星两栏，武器固定为五星、四星、三星三栏，即使某栏为空也保留。每栏包含 `rank / total / items`。
- 物品条目为 `itemId / name / quantity`。按规范化十进制物品 ID 聚合，名称不同或语言不同不会拆成不同物品；数量相同按无损物品 ID 正序打破平局。显示名优先选已有简体中文，其次英文，然后按名称稳定排序，不依赖数据库读取顺序。
- 只缺名称但类型和星级明确的物品可以进入正确栏目，name 为 null 时页面应以 ID 展示。类型或星级未知、同 ID 跨记录矛盾、明确元数据冲突、三星角色等不支持的组合，进入 `unclassified.items`，附带 `reasons`。
- 同一 ID 中可以确定类型和星级的记录正常归类，无法确定的记录单独列入 `unclassified`，不借用同 ID 其他记录猜测缺失字段。一个 ID 可以同时有已分类数量和未分类数量；同 ID 的已知星级或类型相互矛盾时，整组不进入星级栏目。
- `unclassified` 作用于整个档案，角色／武器切换时均可提示；不是仅当前类型的不明物品。`selectedTypeCount + otherTypeCount + unclassified.total = historyCount`，每条记录只计入其中一项。
- `reasons` 包括 `unknown-type / unknown-rank / conflicting-metadata / unsupported-combination`。星级跨记录矛盾时，月度五星统计也不会把其中一条当成确定五星。

## 年月统计

`GET /api/profiles/:profileId/analysis/monthly`，不接受筛选参数。

返回 `months / totals / fiveStarCountsIncomplete` 和共同字段。每个 `months` 条目包含按游戏时区归属的 `month`（`YYYY-MM`），以及以下五个数值字段：

| 字段 | 原版系列 |
| --- | --- |
| `total` | 全部支持的原神祈愿记录，包含新手和集录 |
| `fiveStars` | 星级可以确定为五星的记录，包含所有原神卡池 |
| `standard` | 常驻池 `200` |
| `characterEvent` | 角色活动 `301/400` 合计 |
| `weaponEvent` | 武器活动 `302` |

从最早记录月份到最近记录月份按年月正序返回，中间缺少抽卡的月份补五项 0。新手／集录不挤入其他卡池系列；总抽数不会因为星级未知而减少。`totals` 是这五条系列的各自合计，不是将五条系列相加的总和。

`fiveStarCountsIncomplete` 在存在无法确定星级的记录时为 true，此时五星数只代表已知部分。仅缺名称或类型问题不自动降低已知星级的计数；原始星级或同 ID 的星级相互矛盾时不计入确定五星。没有记录时 `months=[]`、totals 全 0。

## Daily 日历

`GET /api/profiles/:profileId/analysis/daily`

| 参数 | 值 |
| --- | --- |
| `year` | 1–9999 的年份，不含前导零；默认按 Asia/Shanghai 当前日期取年份 |
| `pool` | `100 / 200 / 301 / 302 / 500`；不传或空字符串表示所有池；`301` 包含原始 `301/400` |

默认年份按用户日期的首期默认时区 Asia/Shanghai 取值，与游戏档案的时区分开。例如上海已进入新年，而美服档案本地记录仍在上一年，默认仍选择上海当前年；具体某条抽卡记录的年月日始终按游戏档案时区归属。本轮没有增加个人时区设置或任意时区参数。

返回 `year / pool / calendarTimeZone / availableYears / days / total / maxDailyCount / hasRecords` 和共同字段：

- `calendarTimeZone` 固定为 `Asia/Shanghai`，`pool` 在全部池时为 null。
- `availableYears` 包含全部记录年份、当前年份以及显式请求的年份，去重后降序排列，不因卡池筛选丢失其他年份。
- `days` 包含当年全部日期，按日期正序排列，每项为 `date / count`；闰年 366 天，其他年份 365 天，无抽卡日为 0。
- `total`、`maxDailyCount` 和 `hasRecords` 仅针对所选年份与卡池。未知元数据仍按一条抽卡记录计入，不影响每日总数。
- 没有匹配记录时仍返回完整全 0 日历，total 和 maxDailyCount 为 0，hasRecords 为 false。页面应保留日期 hover，并处理颜色最大值为 0 的情况。

## 实现与验证

纯计算位于 `packages/gacha-core/src/statistics.ts`。服务端共用 `analyzeProfile` 适配器，记录查询和分析使用相同的原始元数据、字典、时间和卡池规则。数据库增加复用的版本化 snapshot 读取方法，UIGF 导出继续只投影标准字段，不会带出数据版本或内部档案 ID。

20 项定向测试通过：4 组纯计算测试，SQLite／真实 PostgreSQL 各 3 组新分析 API 契约，以及共享读取改动影响的 6 组查询 API 和 4 组 UIGF 仓储回归。覆盖 ID／语言合并、数量排序、未知名称／星级、跨记录矛盾、固定星级栏目、月度补零、五系列对账、新手／集录、跨年、闰日和世纪闰年、空档案、上海当前年与游戏日界、授权隔离、禁止注入查询页参数、历史回补和导出字段隔离。

受影响包类型检查、零警告 lint、后端及依赖构建通过。独立 PostgreSQL 验证后停止；没有读取真实 JSON，没有重跑无关全量、前端构建或浏览器验证。统计页面与图表在 R11 实现。
