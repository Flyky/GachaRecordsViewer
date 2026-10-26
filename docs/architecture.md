# 技术栈、架构与仓库建议

日期：2026-10-26

状态：技术方案与实施参考；R02 独立 provider 探针已完成，正式业务模块按计划推进。仓库为 `Flyky/GachaRecordsViewer`。

## 1. 推荐技术栈

| 层 | 选择 | 适合本项目的原因 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS | 满足 Node 服务端偏好；采用受支持的 LTS 分支 |
| 语言 | TypeScript | 共享接口类型；减少 UIGF 字符串 ID / 类型转换错误 |
| HTTP 服务端 | Fastify 5 | 路由、校验、日志和认证边界清楚，适合小型 API 服务 |
| 前端 | Vue 3 + Vite + Vue Router | 表格、筛选、图表状态较多；沿用 Vue 使用经验，独立 SPA 足够 |
| 组件库 | Naive UI | 提供表单、数据表、分页、日期范围、对话框等；主题便于统一星级颜色 |
| 图表 | Apache ECharts | 直接覆盖原有折线图和日历热力图 |
| 数据层 | Drizzle ORM + Repository 接口 | 显式分别适配 SQLite / PostgreSQL，业务逻辑共享 |
| SQLite 驱动 | better-sqlite3 | 小规模单实例部署；构建镜像时处理原生模块 |
| PostgreSQL 驱动 | pg（node-postgres） | 常规连接池与事务，部署时选择 |
| 格式校验 | Ajv 8，独立 Ajv2020 实例 | UIGF 使用 draft 2020-12，固定版本 Schema |
| 密码 | Argon2id | 普通用户密码保存为哈希；与可解密 Token 分开处理 |
| 会话 | 数据库保存不透明 Session，Cookie 携带随机会话 ID | 方便退出、改密与重置时撤销；无需 Redis |
| 测试 | Vitest、Fastify inject、Playwright | 覆盖核心逻辑、权限接口及主要浏览器流程 |
| 部署 | 单个 Node 服务 + 构建后的静态前端；可选 Docker Compose | SQLite 模式一个应用容器，PostgreSQL 模式加一个数据库服务 |
| 配置 | TOML + 环境变量 | 可编辑持久化配置，敏感数据库连接可由环境提供 |

前端使用自托管构建资源，不继续依赖旧版运行时 CDN 脚本。暂不引入 SSR、微服务、Redis、消息队列或专门的搜索服务；用户规模和功能不需要这些组件。

Node 版本依据：[官方发布状态](https://nodejs.org/en/about/previous-releases)。Fastify 主版本依据：[官方 LTS 说明](https://fastify.dev/docs/latest/Reference/LTS/)。双数据库能力依据：[Drizzle SQLite](https://orm.drizzle.team/docs/sqlite/get-started-sqlite)、[Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)。其余组件的具体版本在实施时锁定稳定版与 lockfile，避免直接使用预发布版本。

前端组件依据：[Vue 介绍](https://vuejs.org/guide/introduction.html)、[Vite 入门](https://vite.dev/guide/)、[Naive UI 项目](https://github.com/tusen-ai/naive-ui)、[Apache ECharts](https://echarts.apache.org/en/index.html)。

## 2. 部署与模块边界

```text
浏览器：Vue 应用
    │ 同源 HTTPS，Session Cookie
    ▼
Fastify 服务
    ├─ 本地认证 / 管理员认证
    ├─ UIGF 导入导出
    ├─ 查询与统计
    ├─ 米游社授权与刷新任务
    │    └─ 可替换的 MiHoYo provider → 指定上游接口
    └─ Repository
         ├─ SQLite
         └─ PostgreSQL（部署时二选一）
```

推荐目录结构：

```text
apps/web/                 前端
apps/server/              Fastify 与任务执行
packages/contracts/      API 类型、错误码、共享枚举
packages/gacha-core/     归组、排序、次数和统计纯逻辑
packages/uigf/           已知版本适配与固定 Schema
packages/providers/      米游社与各游戏上游适配
packages/db/             Repository、两种 Schema 与迁移
docs/                    本轮文档、后续部署与用户手册
```

不从前端直接带长期 Token 请求上游。前端只调用本服务；服务端在授权范围内代理必要能力。

## 3. 账号隔离与数据模型

| 实体 | 关键内容 |
| --- | --- |
| User | 本地账号 ID、规范化用户名、密码哈希、初始密码状态、会话版本 |
| Session | 会话 ID 的哈希、主体类型与 ID、有效期、认证版本 |
| CommunityAccount | 所有者 ID、国服 / 国际服 provider、社区账号 ID、mid、昵称、能力状态 |
| Credential | 所有者及社区账号、凭证类型 / 版本、加密内容、密钥版本、验证状态 |
| GameProfile | 所有者、游戏、UID、区域、时区、可选社区账号关联、历史完整性标记 |
| GachaRecord | 档案 ID、真实记录 ID、物品 ID、原始卡池、保底分组、时间、可选元数据与来源 |
| ImportBatch | 所有者、文件摘要、选定档案、插入 / 重复 / 冲突 / 跳过数量与状态 |
| SyncJob | 所有者、档案、进度、分卡池游标、结果、失败类型；不含明文 Token |
| ItemMetadata | 游戏、物品 ID、类型、星级、名称字典与来源版本 |

关键约束建议：

- 用户名规范化后唯一；普通账号不能使用保留管理员名称。
- 游戏档案在所有者范围内以游戏 + UID + 区域（可为已确认占位值）识别。UIGF 不直接提供 region 时暂存为未确认，绑定后根据角色响应补齐并合并，避免重复建档。
- 相同 UID 允许由不同本地用户分别保存；不能以全局 UID 唯一为由暴露别人的档案。
- 唯一记录键为档案 ID + 上游记录 ID；所有档案读写先限制 owner。
- 社区账号身份在同一本地用户范围内唯一，不跨用户共享凭证。
- 不能只校验前端所选 UID。Repository 接口必须接收并约束当前 owner，任务查询和 Token reveal 同样适用。
- 普通用户通过 UIGF 创建离线档案不代表完成米游社归属验证；绑定凭证时以官方角色列表检查，而不是相信用户提交的任意 UID。

Token 默认用 AES-256-GCM 加密，主密钥存入持久化密钥文件或部署 Secret，带版本号。必须可解密以满足用户主动查看需求，因此不能像密码那样只存单向哈希。密文数据库与主密钥分开保存；服务器部署者掌握服务与密钥，不能宣称其无法读取凭证。

## 4. SQLite / PostgreSQL 的实现方式

“使用 ORM”不意味着一套 DDL 自动兼容两种数据库。建议：

1. 分别定义 `sqlite-core` 与 `pg-core` Schema，维护各自迁移目录。
2. 同一 Repository 对外返回同一领域对象；事务、批量插入、冲突处理分别实现。
3. 长 ID 一律 text；日期分组与保底计算尽量在共享 TypeScript 逻辑中完成，避免沿用 MySQL 的 `DATE_FORMAT` 等方言函数。
4. 预先定义字符串匹配的语义，参数化查询并转义子串搜索中的 SQL 通配符，确保数据库间结果一致。
5. SQLite 启用外键、WAL 与合理 busy timeout，写操作控制事务长度；本地磁盘持久化，单实例使用。
6. PostgreSQL 采用小连接池。索引覆盖 owner / profile、时间、卡池组与记录 ID 等实际查询。
7. 两种数据库使用同一验收数据集验证权限、排序、去重和统计。

配置切换仅选择本次运行连接的数据库。不会自动把 SQLite 中的用户、会话、Token 和档案复制到 PostgreSQL。未来若需要搬迁，另做受控迁移命令并校验行数与凭证；UIGF 只能迁移抽卡数据，不能当整站备份。

## 5. 关键计算规则

- 先按档案和保底分组将完整已存记录升序排序，再计算累计抽数和五星间隔，最后应用查询条件与分页。
- 时间相同时按十进制 ID 数值顺序排序，不用 JS Number；数据库可用 ID 长度 + 字典序等无损方案。
- 游戏时间归属由档案时区确定。保存原始无时区时间及偏移，并标准化为 UTC 时间用于统一比较。
- 月度 / 每日统计提取游戏当地日期，不能取部署服务器的日期。
- 三种数据完整性分别记录：上游可查询范围、已保存范围、已确认 / 未知缺口。没有办法仅凭时间间隔大就自动断定中间缺记录。
- 当前规模可在档案记录变化时重新计算、按数据版本缓存统计；不依赖永久写死的旧累计序号。
- 元数据未知时保留记录、明确未知，并使受影响的保底统计失去确定标记；不能默认为非五星。

## 6. 管理员初始化与配置建议

示例只表示配置结构，不是已经存在的可运行配置：

```toml
[server]
host = "0.0.0.0"
port = 3000
public_url = "https://your-app.example"
user_timezone = "Asia/Shanghai"

[database]
driver = "sqlite" # sqlite 或 postgres
sqlite_path = "./data/gacha.sqlite"
# PostgreSQL 模式建议从 DATABASE_URL 环境变量读取连接信息

[admin]
username = "admin"
password = "<首次启动自动生成并持久化>"

[security]
credential_key_file = "./data/credential-key"

[miyoushe]
enabled = true
region_scope = "cn"
```

初始化规则：

- 创建数据目录；如果无配置，从默认模板原子写入配置并生成足够随机的管理员密码。
- 正常重启读取已有密码与主密钥；已有数据库但关键配置 / 密钥丢失时明确报错，不静默生成导致管理员身份或 Token 解密状态改变。
- 配置密码按用户要求可人工编辑；服务启动后只在认证所需内存中使用，不回传前端，也不输出到常规请求日志。
- 文件权限限运行账号；`data/`、本地配置、数据库、密钥、真实 UIGF 和 Token 不入 Git。
- 修改管理员密码后重启生效，依据配置认证版本使旧管理员会话无效；应用数据库或文件中持久化版本，避免重启误接受旧会话。
- 普通用户密码保存在数据库哈希中，不与管理员配置明文机制混淆。

生产环境由反向代理或入口提供 HTTPS；Cookie 设置 HttpOnly / Secure / SameSite，变更接口校验 Origin / CSRF，登录限速。Token 查看接口要求本人会话及近期密码确认，返回 `no-store`，只按需返回选中的字段；默认页面接口不返回密文解密结果。

管理员管理页只提供两项业务操作。隐藏导航是入口要求，真正的权限边界由服务端管理员认证实现。

## 7. 页面与 API 建议

| 页面 | 路径建议 | 职责 |
| --- | --- | --- |
| 本地登录 | `/login` | 登录与初始密码提醒 |
| 查询记录 | `/records` | 账号 / UID 选择、组合筛选、明细、分页 |
| 统计分析 | `/analysis` | 保留三组原分析 |
| 数据管理 | `/data` | UIGF 导入预览、执行、导出；授权刷新结果 |
| 米游社账号 | `/accounts` | 扫码 / Token 导入、选择 UID、凭证详情、解绑 |
| 个人设置 | `/settings` | 修改本地密码 |
| 获取手册 | `/help/miyoushe` | 本轮独立手册的页面内容 |
| 管理员 | `/admin` | 独立认证、注册普通账号、重置密码；其他页面无链接 |

API 模块建议：

- `/api/auth/*`：登录、退出、当前会话、修改密码。
- `/api/admin/*`：管理员登录、退出、用户列表、创建账号、重置密码。
- `/api/profiles/*`：当前用户的离线 / 已绑定游戏档案。
- `/api/records`、`/api/analysis/*`：查询与统计。
- `/api/uigf/*`：预览、导入和导出。
- `/api/community/*`：授权会话、账号详情、凭证验证、reveal 和解绑。
- `/api/sync-jobs/*`：创建刷新任务、读取进度、重试；凭证永远不放在任务 URL 中。

扫码 ticket 绑定当前本地用户与一次性授权会话，不接受跨用户取回扫码结果。用户已确认下一版实现祈愿链接导入：仅提取允许参数并请求固定上游白名单，不由服务端任意抓取用户给出的 URL；纯网页不负责自动读取玩家本地日志或缓存。

后台任务采用进程内执行器和数据库任务状态；服务重启后将进行中的任务标记可重试。未来签到若加入，可复用任务框架，但本轮不创建任何计划任务。

## 8. 仓库方案

**用户已选择新建仓库：[Flyky/GachaRecordsViewer](https://github.com/Flyky/GachaRecordsViewer)。** 本地目录仍为 `gacha-viewer`，无需为名称一致而迁移目录。以下比较保留为决策依据。

| 比较项 | 新建仓库 | 原仓库新建分支 |
| --- | --- | --- |
| 代码关系 | 新架构、数据库和协议边界更清晰 | 与旧版结构差异很大，历史对比噪声较多 |
| 维护 | 新版独立 README、部署与发布 | 旧版与新版说明需要长期区分 |
| 保留历史 | 旧仓库继续保留，README 可互相链接 | 同一仓库查看旧分支方便 |
| 适用情形 | 本次整体重写、使用者少、无需保留现有协作流程 | 希望保留原仓库 Issues、Stars、集成与单一入口时 |

若用户更看重原仓库入口，也可建立 `rewrite` 分支，稳定后切换默认分支并保留旧版标签。不要在重写之前先删除旧代码历史。

当前目录以新仓库已有 `main` 初始化历史为基础，后续逐轮 commit。旧仓库不归档、不改默认分支；当前实现进度以逐轮实施计划的执行记录为准。

## 9. 实施阶段与交付顺序

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| A：风险验证 | 小型米游社 App 扫码 → SToken → 原神拉取验证 | 真实账号及目标网络端到端成功，明确服务器范围；失败则保留手动导入方案 |
| B：基础账号与数据 | 本地登录、管理员两项操作、双数据库、UIGF 导入导出 | 账号隔离、初始密码提醒、重复导入及往返校验通过 |
| C：查询与分析 | 完整旧查询与三组统计，次数规则和星级颜色 | 同一记录集对账、筛选和分页不改变历史次数 |
| D：在线刷新 | 授权 UI、手动 Token、能力检查、任务进度、凭证查看 | 失效 / 风控 / 部分完成 / 重新授权可处理，历史保留 |
| E：部署验收 | SQLite 默认、PostgreSQL 可选、配置与备份手册 | 干净环境部署、重启保留管理员密码与 Token、双库验收一致 |
| 后续提案 | 新分析、角色战绩、签到、星铁 | 分别确定范围后开发，不自动纳入首期 |

阶段 A 先做授权可行性验证，同时不阻塞离线核心开发。未来如果实时接口变化，离线导入、查询、统计和导出仍应完整可用。

上表为阶段概览，实际按[第一版逐轮实施计划](implementation-plan.md)执行。R01 建立骨架，R02 先验证授权风险，再逐步实现；每轮有明确的范围、验收与 commit 边界。
