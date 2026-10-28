# 抽卡领域规则与本地元数据（R06）

`packages/gacha-core` 提供独立的 `@gacha/gacha-core` 包，供 UIGF 导入、查询、分析和在线刷新复用。本轮不新增 HTTP 接口、页面或数据库迁移；算法不读取真实用户 JSON。

## 调用顺序

1. 服务层验证当前 owner / profile，只读取该档案的完整已保存历史。
2. 将 UIGF／上游字段转换为领域输入；例如 `rank_type` 转为数字 3／4／5，物品类型转为 `character`／`weapon`，未知字段保持缺省。
3. 调用 `analyzeHistory(records, { timezone, catalog, ... })`，先补全元数据、排序并计算所有记录的次数。
4. 再按时间、卡池、名称、类型、星级筛选，并按需要倒序和分页；不要将筛选后的数组重新传入计算。

```ts
import { analyzeHistory, genshinMetadata } from '@gacha/gacha-core';

const history = analyzeHistory([
  { id: '1900000000000000001', itemId: '11515', gachaType: '302', time: '2026-10-27 12:00:00' },
], { timezone: 8, catalog: genshinMetadata });

const rows = history.records;
// rows[0].metadata.rank === 5：来自本地字典。
// rows[0].groupOrdinal === 1：当前已保存的武器池记录内累计。
// rows[0].pity：count 为 1，但 status 为 partial-history，不能声称第一抽出金。
```

领域包自身不提供鉴权或跨账号数据加载；传入记录必须已在服务层按 owner / profile 限定。补入早期历史或更新字典后重新计算，不持久化无法重算的永久行号。

## 排序、时间与卡池

- 记录 ID 始终保留原字符串。`compareIds` 按去前导零后的长度和数字字符比较，从不转换为 JS Number；非十进制 ID 明确报错。`1` 与 `01` 数值相同，整份历史包含这种重复身份时拒绝计算，交给导入层处理冲突。
- 先按标准化时间升序，再按 ID 数值顺序排序；输入数组和记录不被修改。同秒十连不会因浮点精度丢失而交换位置。
- `gameTime` 严格接受 `YYYY-MM-DD HH:mm:ss`，使用档案整数时区偏移（-12 至 +14），不使用服务器本地时区。非法日期和小时不会自动滚动成另一天。
- 输出 `timeUtc` 与时间戳，同时保留游戏当地 `dateKey`、`monthKey`、`year`，供月／日统计使用。
- 支持原始类型 `100` 新手、`200` 常驻、`301/400` 角色活动、`302` 武器活动、`500` 集录。`301/400` 共用 `301` 组，其余独立；原始 `gachaType` 保留。声明的 UIGF 分组不匹配时拒绝计算，未知卡池不猜归组。
- 基础历史计算不实现千星奇域和星铁卡池规则。R20 在独立欧非分析中增加角色 UP 与大小保底样本推断，见 [R20 统计口径](r20-luck-analysis.md)。

## 已保存次数和五星间隔

每条结果包含 `groupOrdinal`（组内已保存累计序号）及 `pity`：

| 字段 | 含义 |
| --- | --- |
| `count` | 当前抽的五星间隔次数；五星本身计入当前段，下一抽从 1 开始；无法确定是否发生过五星重置时为 `null` |
| `observedSinceFiveStar` | 距离最后一个已知五星后实际保存的记录数，包含当前记录；未知星级时不能把它当真实保底次数 |
| `status: exact` | 当前已保存区间没有已知缺口或未知星级，能够确定该区间的计数；不承诺上游历史绝对完整 |
| `status: partial-history` | 首段起点未确认或存在明确缺口，`count` 仅为已知记录内次数 |
| `status: unknown-rarity` | 有记录可能为五星但星级未知／冲突，`count` 不输出确定值 |
| `reasons` | `unknown-start`、`known-gap`、`unknown-rarity` 的具体原因 |

默认每组第一段从 `unknown-start` 开始。只有有证据确认该组从第一抽开始时，调用方才设置 `boundaries[group].startsAtBeginning = true`。明确缺口通过 `gapBeforeIds` 指定缺口后的第一条记录 ID，并校验它确实属于该组。

长时间没有抽卡不是缺口证据，不根据时间差或记录 ID 不连续自动猜缺口。首段或缺口后的五星记录仍标记不完整；该已知五星之后的下一抽重新开始确定计数。未知星级会影响其后区间，直到下一个已知五星之后才恢复。

筛选展示五星记录时，同一条记录上的 `pity` 就是该五星间隔。这里不计算“距离硬保底还剩多少抽”，也不判断大小保底。

## 字典来源与补全

内置兜底快照来自固定来源 `genshin-db@5.2.14`，共 369 条，仅保留物品 ID、角色／武器类型、3–5 星稀有度和简体中文／英文名称。数据源包只作为开发依赖。R17 起管理员可主动下载在线字典并持久化到数据库，正常启动不联网、不上传 UID 或记录；详情见 [R17 更新](r17-updates.md)。

快照路径为 `src/catalog/genshin-items.json`，带 Schema 版本、游戏、来源版本、URL、许可和获取时间。来源与抽取代码见 [genshin-db](https://github.com/theBowja/genshin-db)，原许可完整保存在包内 `METADATA_LICENSE`，仓库根目录也有归档说明。字典包含活动赠送等非祈愿专属物品，**字典命中不表示该物品属于某一期祈愿或 UP 名单**。

补全遵循以下规则：

- 保留输入中的原始可选字段。展示、筛选和计数使用输出的 `metadata`，不能误用原始 `rank` 绕过冲突处理。
- 当前语言的记录名称优先；需要其他语言时使用字典对应名称，无法取得时保留记录原名，或回退至字典中可用名称，并返回实际 `nameLanguage`。
- 星级和类型缺省时使用字典；记录与字典的星级／类型矛盾时标记 `conflict`，相应有效值置空。星级冲突也会暂停确定的五星间隔计数。
- 未知 ID 原样保留；没有依据的名称、类型和星级保持 `null`，绝不按 ID 范围猜测，也不默认归为三星。
- `missing`、`conflicts`、逐字段 `provenance` 与 `dictionaryVersion` 说明元数据状态。`metadataIncomplete` 汇总档案是否存在不完整或冲突条目。

UIGF 允许原神记录缺省名称、类型和星级，适配依据见 [UIGF 标准](https://uigf.org/zh/standards/uigf.html)。UIGF 的名称翻译服务可作为后续补充来源，但当前未将它用于猜测星级或类型，参见 [UIGF API](https://uigf.org/zh/api.html)。

## 更新边界与检查

日常更新在管理员页面点击“刷新字典”，完整校验后持久化并立即切换活动字典；重启优先加载数据库缓存，失败保留旧版。导入、查询、统计与在线刷新使用同一应用实例的活动字典。

内置兜底快照仍可由维护者按以下流程更新，不在应用启动时追踪最新 npm 包：

1. 审查并更新 `packages/gacha-core/package.json` 中固定的 `genshin-db` 版本和 lockfile。
2. 运行 `pnpm --filter @gacha/gacha-core update:metadata`，从本地已安装的固定版本生成精简快照；先检查输入 ID、星级、类型、名称及重复项，再原子替换 JSON。
3. 审查快照差异、来源与许可。运行该包的定向类型／规则检查并提交。

`createMetadataCatalog` 在暴露新字典前完整校验条目和唯一键，建立只读索引；非法更新不会修改已加载的旧字典。手工替换内置快照需重新构建并重启，管理员在线更新则即时生效；历史查询及统计按活动字典重新解析，数据概览不再依赖入库时缓存的缺失标记。

本轮只运行该包的类型、lint、构建和 9 组领域测试，覆盖长 ID／同秒、时区／闰日／跨年、卡池归组、首次不完整、补入早期历史、显式缺口、未知星级、元数据冲突与本地字典。没有重跑页面、认证或数据库集成测试。
