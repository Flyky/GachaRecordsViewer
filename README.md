# GachaRecordsViewer

原神抽卡记录管理与分析 Web App，[GenshinGachaRecords](https://github.com/Flyky/GenshinGachaRecords) 的重写版本。

第一版功能与部署资料已整理。Debian 下的 Docker Compose 和原生 Node.js／systemd 操作见 [Debian 部署指南](docs/debian-deployment.md)；按最新安排，目标环境验证由用户稍后自行进行。

## Debian 部署入口

最新一轮：[R17 更新说明](docs/r17-updates.md)——管理员在线刷新字典、复制可导入的米游社凭证 JSON、统计卡片限高。更新源码后重新构建即可，配置保留，无数据库迁移。

- [Debian：Docker 与原生 Node.js 完整步骤](docs/debian-deployment.md)
- [容器备份、恢复与升级](docs/operations.md)
- [配置字段与初始化规则](docs/deployment.md)

本轮提交默认只保留本地，未自动 push。服务器从 GitHub 克隆前，请确认所选提交已包含 Dockerfile、Compose 和 deploy 目录，或直接上传对应源码。

## 本地运行

需要 Node.js 24 LTS 和 pnpm 11.25.0。先确认 `node --version` 为 `v24.x`；项目不会修改系统全局 Node 安装。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

开发页面：[http://127.0.0.1:5173](http://127.0.0.1:5173)。API 默认监听 `127.0.0.1:3000`，Vite 将 `/api` 转发给 API；共享包在开发时自动编译。

生产构建与启动：

```sh
pnpm build
pnpm start
```

此时单个服务在 [http://127.0.0.1:3000](http://127.0.0.1:3000) 提供前端和 API。`GET /api/health` 是进程存活检查，`GET /api/ready` 检查数据库是否可查询；两者都不检查米游社。

首次启动默认使用 SQLite，在 `data/` 下生成 `config.toml` 和数据库。管理员随机密码与凭证加密密钥都在配置中；缺少字段时自动补齐。停止后直接修改配置再 `pnpm start`，无需环境变量；切换空 PostgreSQL 库不再校验旧部署标记。接口用法见[认证与管理员 API](docs/auth-api.md)，配置与兼容规则见[启动配置](docs/deployment.md)。开发代理固定使用 API 的 3000 端口。

支持 Nginx 子路径：将配置的 `[server].public_url` 设为 `https://xxx.com/gacha/`，Nginx 保留前缀转发，重启即可，不需要按路径重编前端。管理员地址为 `/gacha/admin`。参见 [Nginx 示例](deploy/nginx-subpath.conf.example)。Docker 环境变量仅用于初始化配置，之后以 config.toml 为准。

普通用户从 `/login` 登录，在 `/settings` 修改密码。管理员直接输入 `/admin` 访问；普通页面不提供管理入口。管理员创建账号后，普通用户使用 `12345678` 首次登录，密码提醒可以暂时忽略。页面使用说明见 [R05 账号页面](docs/account-pages.md)。

登录后从「数据管理」或 `/data` 导入 UIGF 文件，预览后勾选 UID 再确认；通过档案选择器切换概览与导出目标。支持 UIGF v4.0/v4.1/v4.2，重复记录自动去重。具体步骤与提示见 [R08 数据管理](docs/data-management.md)。

从「查询记录」或 `/records` 筛选当前 UID 的时间、卡池、物品类型、星级和名称，查看完整历史计算的累计与五星间隔。接口与计数含义见 [R09 记录查询](docs/record-query.md)。

从「统计分析」或 `/analysis` 查看物品分栏、月度折线和全年 Daily 热力图，支持图例切换、缩放、年份／卡池筛选及 0 抽日期提示。页面说明见 [R11 统计分析](docs/analysis-pages.md)，数量与时区规则见 [R10 分析 API](docs/analysis-api.md)。

从“米游社账号”或 `/accounts` 使用 App 扫码、手动导入、重新授权、本人 Token 查看／复制和解绑。选择绑定 UID 后可创建刷新、查看逐池进度、重试失败池和取消；授权获取手册在 `/help/miyoushe`。页面与隐私行为见 [R15 使用说明](docs/community-pages.md)。后续验证优先复用加密授权，需要扫码时仍会最后询问用户后再开始。

[R14 在线刷新 API](docs/sync-api.md) 支持按卡池后台拉取、增量去重、完整重扫、任务进度、失败池重试和取消；重启保留已写记录，中断任务可重试。已有长期历史不会因上游窗口变化被删除。凭证和扫码接口见 [R12](docs/community-api.md)／[R13](docs/miyoushe-qr-api.md)。

## 工程命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 共享包 watch、API watch、Vite 同时运行，退出时一并停止 |
| `pnpm build` | 按依赖顺序构建共享包、服务端与前端 |
| `pnpm start` | 启动已经构建的服务端并提供 SPA |
| `pnpm typecheck` | 检查服务端、共享类型和 Vue 代码 |
| `pnpm lint` | ESLint 检查，警告也视为失败 |
| `pnpm test` | 服务、provider、SQLite 与配置测试；设置 `TEST_DATABASE_URL` 后包含真实 PostgreSQL 集成测试 |
| `pnpm probe:miyoushe --region cn_gf01` | 本人扫码后，只读验证官服授权与少量祈愿分页；不保存凭证 |

目录：`apps/server` 为 Fastify，`apps/web` 为 Vue，`packages/contracts` 为共享 API 类型与应用标识，`packages/providers` 为上游适配与 R02 探针，`packages/db` 为仓储、双数据库 Schema 和迁移。其余业务模块在对应轮次建立。

`packages/gacha-core` 提供无损记录排序、游戏时区、组内计数与本地物品补全；规则、来源和更新步骤见 [R06 领域逻辑](docs/gacha-core.md)。

`packages/uigf` 固化 v4.0/v4.1/v4.2 标准并负责解析与导出；API、冲突规则和限制见 [R07 UIGF 导入导出](docs/uigf-import-export.md)。

探针参数、扫码步骤、脱敏输出和已实测边界见 [R02 使用说明](docs/miyoushe-probe.md)。

## 第一版计划

支持本地多账号、管理员创建 / 重置账号、UIGF v4.x 原神导入导出、完整记录查询和既有统计分析，以及米游社授权与手动刷新。数据库默认 SQLite，可配置 PostgreSQL。官服授权、五池当前窗口刷新及本机容器结果见[验收参考](docs/v1-acceptance.md)；Debian 目标环境由用户自行验证。

技术方案为 Node.js 24 LTS + TypeScript + Fastify 5，前端采用 Vue 3 + Vite + Naive UI + ECharts，Drizzle 分别适配两种数据库。

- [逐轮实施计划与进度](docs/implementation-plan.md)：R00 规划，R01–R16 逐步实现、验证、每轮 commit。
- [前期文档入口](docs/README.md)
- [需求规格与验收标准](docs/requirements.md)
- [UIGF 与米游社调研](docs/research-uigf-miyoushe.md)
- [技术架构](docs/architecture.md)
- [米游社授权获取手册](docs/miyoushe-authorization-guide.md)

真实抽卡记录、部署配置、数据库和账号凭证不提交到仓库。旧格式 JSON 的导入与历史迁移均不实现，直接参考用户提供的 UIGF v4.1 文件。

祈愿链接导入已确认安排在下一版：用户在本地游戏打开祈愿记录页，提取包含临时 AuthKey 的链接，再提交到本应用获取记录。首版暂不包含该入口、千星奇域、星铁正式功能、签到和角色战绩页面。
