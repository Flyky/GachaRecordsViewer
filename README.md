# GachaRecordsViewer

原神抽卡记录管理与分析 Web App，[GenshinGachaRecords](https://github.com/Flyky/GenshinGachaRecords) 的重写版本。

当前完成到 R02：基础工程与米游社命令行验证工具已可运行；官服原神角色池 10 条样本读取已通过本人扫码实测。正式登录、导入、查询和分析页面按后续轮次实现。

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

此时单个服务在 [http://127.0.0.1:3000](http://127.0.0.1:3000) 提供前端和 API。`GET /api/health` 是进程存活检查，暂不代表数据库或米游社连接正常。缺少前端构建时服务会给出先构建的错误提示。

服务端可读取 `HOST`、`PORT` 环境变量；生产端口默认 3000。开发代理当前固定使用 API 的 3000 端口，开发时请保持该默认值。完整部署配置与持久化将在 R03 加入。

## 工程命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 共享包 watch、API watch、Vite 同时运行，退出时一并停止 |
| `pnpm build` | 按依赖顺序构建共享包、服务端与前端 |
| `pnpm start` | 启动已经构建的服务端并提供 SPA |
| `pnpm typecheck` | 检查服务端、共享类型和 Vue 代码 |
| `pnpm lint` | ESLint 检查，警告也视为失败 |
| `pnpm test` | 检查基础服务与路由，以及米游社协议、状态、身份和脱敏边界 |
| `pnpm probe:miyoushe --region cn_gf01` | 本人扫码后，只读验证官服授权与少量祈愿分页；不保存凭证 |

目录：`apps/server` 为 Fastify，`apps/web` 为 Vue，`packages/contracts` 为共享 API 类型与应用标识，`packages/providers` 为上游适配与 R02 探针。其余业务模块在对应轮次建立。

探针参数、扫码步骤、脱敏输出和已实测边界见 [R02 使用说明](docs/miyoushe-probe.md)。

## 第一版计划

支持本地多账号、管理员创建 / 重置账号、UIGF v4.x 原神导入导出、完整记录查询和既有统计分析，以及米游社授权与手动刷新。数据库默认 SQLite，可配置 PostgreSQL。R02 已验证有限的官服样本链路；其他卡池与最终部署环境仍需分别验证。

技术方案为 Node.js 24 LTS + TypeScript + Fastify 5，前端采用 Vue 3 + Vite + Naive UI + ECharts，Drizzle 分别适配两种数据库。

- [逐轮实施计划与进度](docs/implementation-plan.md)：R00 规划，R01–R16 逐步实现、验证、每轮 commit。
- [前期文档入口](docs/README.md)
- [需求规格与验收标准](docs/requirements.md)
- [UIGF 与米游社调研](docs/research-uigf-miyoushe.md)
- [技术架构](docs/architecture.md)
- [米游社授权手册草案](docs/miyoushe-authorization-guide.md)

真实抽卡记录、部署配置、数据库和账号凭证不提交到仓库。旧格式 JSON 的导入与历史迁移均不实现，直接参考用户提供的 UIGF v4.1 文件。

祈愿链接导入已确认安排在下一版：用户在本地游戏打开祈愿记录页，提取包含临时 AuthKey 的链接，再提交到本应用获取记录。首版暂不包含该入口、千星奇域、星铁正式功能、签到和角色战绩页面。
