# R16 部署、备份恢复与升级

日期：2026-10-27。配置字段与原生初始化规则见 [deployment.md](deployment.md)，验收结果与限制见 [v1-acceptance.md](v1-acceptance.md)。

Debian 服务器从零安装与 systemd 常驻运行请先看 [Debian 部署指南](debian-deployment.md)。按用户最新安排，下面提供操作说明，目标服务器上的验证由用户自行执行。

## Docker Compose：默认 SQLite

需要 Docker Linux 容器和 Compose v2。在仓库根目录执行：

```sh
docker compose up -d --build
docker compose ps
docker compose cp app:/app/data/config.toml ./config.local.toml
```

默认访问 `http://127.0.0.1:3000`，从本机 config.local.toml 读取 `[admin].password`，直接访问 `/admin` 登录并创建普通账号。普通账号使用 `12345678` 登录，初始密码提示不强制修改。日志与 HTTP 不会输出管理员密码，config.local.toml 已被 Git 忽略。

默认只绑定宿主机 127.0.0.1。容器以 node 用户（UID 1000）运行，命名卷 app-data 挂载到 `/app/data`，保存配置、SQLite、原凭证主密钥和部署标记；重建容器保留该卷。每个部署只运行一个应用实例，扫码、限速与刷新 worker 不支持跨实例接力。

复制 `.env.example` 为 `.env` 后可调整 APP_PORT、PUBLIC_URL、BIND_ADDRESS 和 USER_TIMEZONE。**公开访问地址必须与 PUBLIC_URL 的协议／主机／端口一致**：例如 `APP_PORT=3100` 时，同时设置 `PUBLIC_URL=http://127.0.0.1:3100`。局域网直接访问需自行选择 BIND_ADDRESS=0.0.0.0 和真实访问地址。修改后执行 `docker compose up -d app` 重新创建。

Compose 环境覆盖相应 TOML 字段，Node 本身不加载 .env。普通模式只需 `pnpm install --frozen-lockfile && pnpm build`，再设置所需 GRV_DATA_DIR／PUBLIC_URL／HOST 等启动环境，运行 `pnpm start`；Node.js 必须为 24.x，pnpm 固定 11.25.0。它作为前台服务运行，由操作系统服务管理器管理时应转发 SIGTERM 并给出停止宽限。详见 [原生运行与环境变量](deployment.md)。

## Compose：PostgreSQL 替代配置

复制 `deploy/postgres.env.example` 为 `.env.postgres`，填写随机 URL 安全密码（字母、数字、短横线、下划线），空值会拒绝解析，再运行：

```sh
docker compose --env-file .env.postgres -f compose.postgres.yaml up -d --build
docker compose --env-file .env.postgres -f compose.postgres.yaml ps
docker compose --env-file .env.postgres -f compose.postgres.yaml cp app:/app/data/config.toml ./config.local.toml
```

这是独立替代配置，不与默认 SQLite 配置叠加。需要和原部署并存时选择独立项目名（如 `-p grv-postgres`）和不同 APP_PORT／PUBLIC_URL，命名卷与网络随项目名区分。已有 SQLite 卷不能靠更换 Compose 文件自动搬迁到 PostgreSQL。

数据库固定 PostgreSQL 18.4，不发布宿主机 5432；数据库健康后才启动应用。数据库数据在 postgres-data 卷，配置／主密钥／标记仍在 app-data。18 系列按官方布局挂载 `/var/lib/postgresql`；主版本更新需要独立升级或逻辑备份恢复，不能仅换主版本标签后复用原数据目录。[官方镜像说明](https://github.com/docker-library/docs/blob/master/postgres/README.md)

## 镜像、HTTPS 与健康检查

Dockerfile 使用固定的 Node.js 24.22.1 Bookworm／pnpm 11.25.0，构建前后端后单独安装生产依赖。运行镜像保留原生模块、迁移、字典、UIGF Schema 和许可；不包含宿主机 node_modules、真实 JSON、运行配置、密钥或测试目录。构建上下文使用源码白名单，R16 已检查实际导出的上下文文件清单。[Node 官方镜像](https://hub.docker.com/_/node)

Linux amd64 镜像已实际构建并验收，约 276 MB；其他架构需独立验证。构建需能访问官方基础镜像及 npm，网络错误请检查自己的 Docker／代理设置，项目不自动更改系统代理或镜像源。固定版本便于复现，后续安全更新需审阅并升级。

对外部署可用宿主机 HTTPS 反向代理，参考 `deploy/Caddyfile.example`，将 PUBLIC_URL 设为同一 HTTPS origin，应用端口继续绑定 127.0.0.1。HTTPS 配置会使用 Secure Cookie；从错误的 HTTP 地址访问会导致登录／Origin 校验失败。应用部署在站点根路径，不提供 `/gacha/` 子路径构建。浏览器复制 Token 通常要求 HTTPS 或 localhost，不支持时可主动查看后手动复制。

`/api/health` 检查进程存活，`/api/ready` 查询实际数据库；Docker 健康检查使用 ready，不检测米游社。`docker compose logs --tail=100 app` 可查看错误码，配置和密钥不要随反馈公开。正常停止给应用 45 秒宽限，先停止 worker 再关闭数据库；中断任务可重试，已写记录保留。

## SQLite 冷备

先建立 backups 父目录，本次目标 `./backups/20261027` 应不存在。停止应用后复制整个数据目录，再启动：

```sh
docker compose stop app
docker compose cp app:/app/data ./backups/20261027
docker compose start app
```

备份目录中应含 config.toml、credential-key、installation.json、gacha.sqlite；存在的 WAL／SHM 一并保留。backups 已被 Git 忽略，应另外存放到受访问控制的安全位置。不能在服务仍写入时只复制 SQLite 主文件。

原生运行同样先停止 Node，再复制整个 GRV_DATA_DIR 与配置引用的外部文件。Windows 可用 `Copy-Item -LiteralPath .\data -Destination .\backups\20261027 -Recurse`，Unix 可用 `cp -a data backups/20261027`；先建立父目录并确认目标不存在。UIGF 只备份抽卡记录，不含用户、配置、加密授权，不能替代整站备份。

## PostgreSQL 一致性备份

保留原 `.env.postgres` 或外部数据库凭证配置，停止应用后同时备份 app-data 与逻辑转储：

```sh
docker compose --env-file .env.postgres -f compose.postgres.yaml stop app
docker compose --env-file .env.postgres -f compose.postgres.yaml cp app:/app/data ./backups/20261027
docker compose --env-file .env.postgres -f compose.postgres.yaml exec -T postgres pg_dump -U gacha -d gacha -Fc -f /tmp/gacha.dump
docker compose --env-file .env.postgres -f compose.postgres.yaml cp postgres:/tmp/gacha.dump ./backups/gacha-20261027.dump
docker compose --env-file .env.postgres -f compose.postgres.yaml start app
```

先写容器内文件再复制，避免部分 PowerShell 文本重定向损坏二进制 dump。数据库保持运行，pg_dump 取得一致性快照，应用暂停使配置／密钥与转储来自同一备份窗口。外部 PostgreSQL 使用兼容版本的 pg_dump，由部署环境提供认证。

## 恢复到独立部署

保留原部署与备份，使用新项目名、空卷验证，避免覆盖正在使用的数据。同时运行时，为恢复实例设置不同 APP_PORT／PUBLIC_URL。不要删除原卷或重生成密钥来“修复”部署身份不匹配。

SQLite 创建未启动的容器、复制备份内容、修复所有者后启动：

```sh
docker compose -p grv-restored create app
docker compose -p grv-restored cp ./backups/20261027/. app:/app/data/
docker compose -p grv-restored run --rm --no-deps --user root --entrypoint sh app -c 'chown -R node:node /app/data'
docker compose -p grv-restored up -d app
```

PostgreSQL 在上述 create／cp／权限命令中同样添加 `--env-file .env.postgres -f compose.postgres.yaml`，先恢复 app-data，但不要启动 app。接着运行：

```sh
docker compose -p grv-restored --env-file .env.postgres -f compose.postgres.yaml up -d postgres
docker compose -p grv-restored --env-file .env.postgres -f compose.postgres.yaml exec -T postgres pg_isready -U gacha -d gacha
docker compose -p grv-restored --env-file .env.postgres -f compose.postgres.yaml cp ./backups/gacha-20261027.dump postgres:/tmp/gacha.dump
docker compose -p grv-restored --env-file .env.postgres -f compose.postgres.yaml exec -T postgres pg_restore -U gacha -d gacha --no-owner --exit-on-error /tmp/gacha.dump
docker compose -p grv-restored --env-file .env.postgres -f compose.postgres.yaml up -d app
```

pg_isready 成功后再恢复，目标必须是新建空库。不能先启动空应用再导入旧数据库。启动时会检查数据库、配置、原主密钥与标记来自同一部署；原生恢复也遵守这一规则。

恢复后核对 ready、管理员密码、普通登录、记录数量、导出和本人 Token 解密。两种容器部署均已实际恢复到独立项目并通过这些检查。root 权限只用于恢复文件所有者，日常应用继续以 node 运行。

## 升级与回退

记录当前提交／镜像，先停机并按上文备份；更新源码到选定提交后执行 `docker compose up -d --build`（PostgreSQL 使用相应参数）。服务自动应用未执行迁移，R16 已验证从 R03 数据库结构升级后保留账号、记录与凭证。

数据库结构迁移不等于旧项目 JSON 历史迁移；后者明确不做。切换数据库类型也不自动搬运数据。修改管理员密码时停机，复制并编辑原配置的 `[admin].password` 再复制回去，保持其余部署 ID／路径／密钥不变，并修复文件所有者；启动后旧管理员会话失效。

迁移后不保证旧代码能读取新结构。回退需在独立目录／卷恢复升级前的整组备份，使用匹配的旧提交／镜像验证后再切换。不要改写已提交迁移，也不要假定改回数据库连接就完成回退。生产运维不使用 `down -v` 删除持久卷。
