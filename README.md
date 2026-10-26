# GachaRecordsViewer

原神抽卡记录管理与分析 Web App，[GenshinGachaRecords](https://github.com/Flyky/GenshinGachaRecords) 的重写版本。

当前处于第一版规划阶段，尚未开始应用代码实现。

## 第一版计划

支持本地多账号、管理员创建 / 重置账号、UIGF v4.x 原神导入导出、完整记录查询和既有统计分析，以及米游社授权与手动刷新。数据库默认 SQLite，可配置 PostgreSQL。米游社实时能力仍需真实账号验证。

技术方案为 Node.js 24 LTS + TypeScript + Fastify 5，前端采用 Vue 3 + Vite + Naive UI + ECharts，Drizzle 分别适配两种数据库。

- [逐轮实施计划与进度](docs/implementation-plan.md)：R00 规划，R01–R16 逐步实现、验证、每轮 commit。
- [前期文档入口](docs/README.md)
- [需求规格与验收标准](docs/requirements.md)
- [UIGF 与米游社调研](docs/research-uigf-miyoushe.md)
- [技术架构](docs/architecture.md)
- [米游社授权手册草案](docs/miyoushe-authorization-guide.md)

真实抽卡记录、部署配置、数据库和账号凭证不提交到仓库。旧格式 JSON 的导入与历史迁移均不实现，直接参考用户提供的 UIGF v4.1 文件。

祈愿链接导入已确认安排在下一版：用户在本地游戏打开祈愿记录页，提取包含临时 AuthKey 的链接，再提交到本应用获取记录。首版暂不包含该入口、千星奇域、星铁正式功能、签到和角色战绩页面。
