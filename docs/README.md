# GachaRecordsViewer 重写前期文档

日期：2026-10-28（Asia/Shanghai）

状态：R18 三游戏签到、祈愿链接导入及提取手册已实现，Debian 部署文档继续适用。仅做受影响范围检查，真实账号与目标服务器验收仍由用户自行进行。

部署反馈紧急修订：启动采用单份 config.toml，移除部署标记／锁文件和空库绑定检查；环境变量只初始化配置。支持 Nginx 域名子路径，无需按路径重新构建。当前用法以[启动配置](deployment.md)和[Debian 指南](debian-deployment.md)为准；本机仅补充受影响范围检查，目标环境仍由用户验收。

仓库已确定为 [Flyky/GachaRecordsViewer](https://github.com/Flyky/GachaRecordsViewer)。

最新功能：[R18 多游戏签到与祈愿链接导入](r18-updates.md)，此前为 [R17 在线字典、凭证复制与移动端统计](r17-updates.md)。用户已授权本轮实现，验证继续限制在受影响范围。

## 阅读顺序

后续开发从[第一版逐轮实施计划](implementation-plan.md)推进，每轮完成必要验证后 commit。

部署入口：[Debian Docker／原生部署](debian-deployment.md)；备份恢复：[运维手册](operations.md)；配置参考：[部署配置与数据库](deployment.md)。

已有验证记录：[第一版验收参考](v1-acceptance.md)；开发工具：[R02 米游社验证工具](miyoushe-probe.md)。

前端接入：[R04 本地认证与管理员 API](auth-api.md)。

账号使用：[R05 登录、密码与管理页面](account-pages.md)。

领域规则：[R06 排序、次数与本地元数据](gacha-core.md)。

数据接口：[R07 UIGF 预览、事务导入与标准导出](uigf-import-export.md)。

数据使用：[R08 数据管理与多 UID 页面](data-management.md)。

记录查询：[R09 筛选、分页与历史次数](record-query.md)。

分析接口：[R10 物品分组、月度和 Daily 日历](analysis-api.md)。

统计使用：[R11 物品分栏、折线与日历页面](analysis-pages.md)。

米游社接口：[R12 加密凭证、能力校验与绑定](community-api.md)。

扫码授权：[R13 一次性会话、轮询与重新授权](miyoushe-qr-api.md)。

在线刷新：[R14 分池任务、增量合并与重试](sync-api.md)。

米游社使用：[R15 账号、Token、扫码与刷新页面](community-pages.md)。

1. [需求规格与验收标准](requirements.md)：逐项对应用户的 12 条需求，区分确定需求、建议默认值与未来扩展。
2. [UIGF 与米游社调研](research-uigf-miyoushe.md)：规范版本、授权路径、接口依据、已失效方案及待实测项目。
3. [技术栈、架构与仓库建议](architecture.md)：Node 服务端、双数据库、账号隔离、部署配置和开发阶段。
4. [米游社授权获取手册](miyoushe-authorization-guide.md)：可用作后续应用内帮助页的文案，包含内置扫码与外部获取的操作步骤。

## 建议结论

- 技术栈：Node.js 24 LTS、TypeScript、Fastify 5；Vue 3、Vite、Naive UI、ECharts；Drizzle ORM 分别适配 SQLite / PostgreSQL。
- 仓库：用户已新建 `Flyky/GachaRecordsViewer`，保留旧仓库作为历史参考。当前本地已关联新仓库。
- 首期：本地账号登录与管理、原神 UIGF v4.0/v4.1/v4.2 导入导出、原有查询分析、米游社授权管理与原神手动刷新。千星奇域不纳入首期。
- 米游社：国服原神有明确的社区实现依据；优先使用 App 扫码接口获得 SToken，服务端换取原神祈愿 AuthKey。保留手动 Token 导入及帮助页。
- 验证边界：R02 完成官服角色池少量样本，R13／R14／R16 补充授权、官服五池当前窗口刷新和容器参考结果；详见[验收参考](v1-acceptance.md)。渠道服、国际服和最终部署网络不继承这些结果，Debian 目标环境由用户自行验证。
- 数据库：SQLite 默认、PostgreSQL 可选；启动时读取配置，不把切换连接配置描述成自动搬迁已有数据。

## 已确认的范围修订

- [R19：临时 API 模拟](r19-api-mock.md)：15 分钟链接、三种输出选项、复制与销毁及第三方兼容边界。
- [R20：欧非分析](r20-luck-analysis.md)：四类卡池五星均值、角色 UP 成本、小保底不歪率和连续次数。
- [R21：历史卡池刷新与原神充值](r21-banners-topup.md)：管理员在线更新、支付宝／微信二维码、订单确认与恢复。
- [R22：充值兼容修复与功能开关](r22-topup-compatibility.md)：商品金额字符串兼容，管理员开启／关闭充值卡片。
- [R24：公共数据代理回退](r24-public-data-proxy.md)：管理员保存 GHProxy 前缀，字典／历史卡池直连失败后自动回退及其他网络方案。

- 旧 JSON 的历史迁移明确不做，不开发一次性转换器；新版直接以用户提供的 UIGF v4.1 文件为本地参考。
- 该参考文件已通过 UIGF v4.1 Schema 校验，共 1,413 条原神记录。真实文件仅保留本地，不提交到仓库。
- R02 补充的官服 UIGF v4.1 参考也已通过校验，共 11,326 条记录；同样仅保留本地。
- 祈愿链接导入原安排首版之后，现于 R18 实现：本地游戏打开记录页后，从日志／缓存提取含临时 AuthKey 的 URL，页面提供手册与脚本。

## 需要用户决定、但不影响本轮文档完成的事项

| 事项 | 当前建议默认值 |
| --- | --- |
| 服务器范围 | 首期直接授权适配国服官服，其他渠道与 HoYoLAB 单独验证；UIGF 数据不限定国服 |
| 一个本地账号能否管理多个米游社账号 / 游戏 UID | 允许，两层账号独立 |
| 管理员重置密码后的值 | 重置为 `12345678`，恢复初始密码提醒 |
| 首期是否包含星铁 | 先预留模型和适配接口，首期产品只开放原神 |
| UIGF 默认导出版本 | 原神默认 v4.0；导入接受已确认的 v4.0/v4.1/v4.2 |

这些默认值属于方案建议，不能替代用户已经明确给出的要求，也不把“预计不到 8 个账号”实现为硬性数量限制。
