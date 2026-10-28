# R24：公共字典与历史卡池的 GitHub 代理回退

## 使用

1. 更新服务端和前端构建，重启应用；不需要增加配置项或运行数据库迁移。
2. 进入管理员页面 `/admin`（子路径部署例如 `/gacha/admin`）。
3. 在「公共数据网络设置」填写 `https://gh-proxy.com/`，点击「保存网络设置」。也支持其他采用「前缀 + 完整 GitHub URL」形式的 HTTPS 服务及带路径的前缀。
4. 使用原来的「刷新字典」「刷新历史卡池」按钮。有新角色时先刷新字典，再刷新卡池。
5. 留空保存即可停用。设置保存在当前数据库中，重启后保留，保存动作不发起外部下载，启动也不会检测外网。

历史卡池需要代理服务同时支持 `api.github.com` 与 `raw.githubusercontent.com`，字典备用来源需要支持 GitHub `archive` 压缩包。部分服务只支持 Release 下载，不能用于全部刷新。[GH-Proxy 官方格式说明](https://gh-proxy.com/docs/github-accelerator)

拼接示例：

```text
https://gh-proxy.com/https://raw.githubusercontent.com/MadeBaruna/paimon-moe/<commit>/src/data/banners.js
```

## 实际数据源与回退顺序

| 数据 | 先尝试 | 失败后 |
| --- | --- | --- |
| 历史卡池最新版本 | GitHub commits API | 配置的前缀 + 同一 API URL |
| 历史卡池内容 | 固定上述 commit 的 GitHub Raw 文件 | 配置的前缀 + 同一 Raw URL |
| 物品字典 | genshin-db 的 Vercel API，四组简中／英文角色、武器数据 | 配置代理后，先直连同一项目的 GitHub 源码包；再尝试前缀 + GitHub archive URL |

原字典 API 不是 GitHub 链接，不能直接交给 GHProxy。因此增加 `theBowja/genshin-db` 仓库源码包作为备用来源，继续从相同上游读取 `id`、`rarity`、`name`，不更换为另一套物品字典，也不执行下载的 JS。未配置代理时保持原有 API 刷新路径。

仓库完整压缩包当前约 51 MiB。程序以流方式扫描 tar.gz，读取完简中和英文的角色、武器子目录后即停止下载，不读取其余语言，不落盘解压。本次公开快照读取约 8.8 MiB 压缩数据，得到 369 个物品，无内置 ID 缺失；实际流量随仓库内容、目录顺序和网络缓冲变化。HTTP／格式失败、直连超时会触发回退，整体失败继续保留旧数据。

每次直连最多 8 秒，两种刷新各自整轮最多 45 秒；浏览器等待最多 60 秒。仍沿用大小、字段、双语完整性、已知 ID 保留、卡池覆盖范围和数据库事务检查。下载上限为 64 MiB 压缩数据、512 MiB 流式展开数据、12 MiB 所选 JSON；这些不是一次性内存分配。

代理只收到固定公开数据源 URL，不转发本地会话、米游社 Token、UID、订单信息或用户提交的任意目标。只接受不含账号密码、查询参数、片段或 IP 地址的 HTTPS 前缀。现有拒绝重定向行为保留；请填写直接返回文件的代理地址。公共代理可能限流、缓存旧内容或不可用，可更换前缀；数据源版本由页面原有状态显示。

## 其他网络方案

如果服务器已有自己维护的稳定 HTTP CONNECT 代理，可以直接让 Node 24 使用它。这样通常能访问原先较小的 Vercel API，而不必启用字典源码包回退。Node 支持 `NODE_USE_ENV_PROXY=1` 配合 `HTTPS_PROXY`、`NO_PROXY`；这是运行时环境设置，和应用仅在首次创建 config.toml 时读取的初始化变量不同。[Node 官方网络配置说明](https://nodejs.org/learn/http/enterprise-network-configuration)

Debian 直接启动示例，前提是该服务器上的 `127.0.0.1:7890` 已有可用代理：

```bash
NODE_USE_ENV_PROXY=1 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1,::1,.mihoyo.com,.hoyoverse.com,.hoyolab.com,.yuanshen.com \
pnpm start
```

Docker 需要将这些变量传入容器，并填写容器能访问到的代理地址；容器中的 `127.0.0.1` 指容器自身。也可自行部署兼容 GHProxy 前缀格式的服务，再填写到管理员页面。以上是可选部署方案，本轮没有安装代理或修改服务器网络。

## 接口与验证

- `GET /api/admin/data-sources`：读取 `{ githubProxy, updatedAt }`。
- `POST /api/admin/data-sources`：提交 `{ githubProxy: "https://gh-proxy.com/" }` 或空字符串，保存后返回规范化结果。
- 继承管理员身份、Origin、CSRF 与站点子路径保护；普通用户不可读取或修改。设置写入现有 `shared_snapshots`，不增加依赖、配置文件或迁移。
- 3 个相关文件共 14 项定向测试通过：设置权限与持久化；直连成功不走代理；HTTP／非法 JSON／超时回退；整轮取消不重试；GitHub API、Raw、字典 archive 路径；不完整压缩包拒绝；读取完成提前取消；原字典及卡池刷新回归。前后端类型、构建和改动范围 lint 通过，保留既有统计图表分包体积提示。
- 另只读核对公开 genshin-db 压缩包解析结果，以及 gh-proxy.com 三类 URL 的 HEAD 响应。没有调用米游社、读取真实凭证或修改部署数据库；没有重跑浏览器、Docker 和真实 PostgreSQL。目标云服务器的可达性仍由实际部署网络决定。
