# Debian 部署指南：Docker 与原生 Node.js

更新：2026-10-27。以下命令面向 Debian 12／13 的 Bash，使用有 sudo 权限的账号。两种方式择一即可；默认 SQLite，不需要独立数据库服务。

本文提供部署步骤，目标服务器上的验证由你自行进行。已有验证仅作为参考，不代表你的服务器、域名和网络已经验收。配置字段详见 [配置参考](deployment.md)，更完整的容器恢复流程见 [运维手册](operations.md)。

## 先确定访问地址与代码版本

- 仅本机访问：使用 `http://127.0.0.1:3000`；远程服务器可通过 SSH 转发 `ssh -L 3000:127.0.0.1:3000 用户@服务器` 后在自己电脑打开这个地址。
- 对外访问：建议域名加 HTTPS，示例为 `https://gacha.example.com`，替换为自己的域名。
- `PUBLIC_URL` 必须和浏览器访问地址的协议、主机、端口一致，否则会出现 Origin 校验或 Cookie 登录问题。应用运行在站点根路径，不提供 `/gacha/` 子路径构建。
- 使用包含本轮部署文件的提交。**本地提交不会自动出现在 GitHub**：如果远端分支还没有 Dockerfile、Compose 和 deploy 目录，先同步所需提交，或将这份源码上传到服务器。不要上传 Windows 的 node_modules、真实记录、配置或密钥作为源码。

## 方案 A：Docker Compose

默认按 A2 启动 SQLite。若选 PostgreSQL，下载源码后直接按 A4 配置和启动，跳过 A2 的 SQLite 启动命令。

### A1. 安装 Docker

已有可用 Docker Engine 和 Compose v2 时跳过。下面使用 Docker 官方 Debian 软件源；已有其他来源的 Docker 时，先按官方文档检查包冲突，不要直接卸载正在使用的服务。[官方 Debian 安装说明](https://docs.docker.com/engine/install/debian/)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
printf '%s\n' \
  'Types: deb' \
  'URIs: https://download.docker.com/linux/debian' \
  "Suites: $VERSION_CODENAME" \
  'Components: stable' \
  "Architectures: $(dpkg --print-architecture)" \
  'Signed-By: /etc/apt/keyrings/docker.asc' \
  | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

后续 Docker 命令统一带 sudo，无需把用户加入 docker 组。Docker 方案不需要在宿主机安装 Node.js 或 pnpm。

### A2. 下载源码并配置 SQLite

```bash
sudo apt-get install -y git nano openssl
git clone https://github.com/Flyky/GachaRecordsViewer.git
cd GachaRecordsViewer
cp .env.example .env
nano .env
```

本机或 SSH 转发访问保持默认值：

```dotenv
BIND_ADDRESS=127.0.0.1
APP_PORT=3000
PUBLIC_URL=http://127.0.0.1:3000
USER_TIMEZONE=Asia/Shanghai
```

HTTPS 域名部署改为 `PUBLIC_URL=https://你的域名`，端口保持只绑定 127.0.0.1，之后配置反向代理。局域网直接访问可将 BIND_ADDRESS 改为 0.0.0.0，PUBLIC_URL 改成服务器实际 IP 与端口；这种 HTTP 访问下 Token 自动复制可能不可用，可主动查看后手动复制。

启动应用：

```bash
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=100 app
```

首次构建需下载官方 Node 镜像和 npm 包。运行镜像使用 Node.js 24.22.1 和 pnpm 11.25.0，应用为非 root 用户。配置、数据库和凭证主密钥保存在命名卷，不随重建容器消失。

### A3. 首次管理员登录

```bash
sudo docker compose cp app:/app/data/config.toml ./config.local.toml
sudo chmod 600 ./config.local.toml
sudo less ./config.local.toml
```

在 `[admin]` 中读取 password。浏览器直接访问 `/admin`，管理员用户名为 `admin`，普通页面没有管理入口。创建普通账号后，用初始密码 `12345678` 在 `/login` 登录；初始密码提醒可以暂时忽略。

不要把 config.local.toml、credential-key、数据库或 Token 发到公开位置。普通数据导入在 `/data`，米游社账号、扫码及刷新在 `/accounts`，获取手册在 `/help/miyoushe`。

### A4. 改用 PostgreSQL（可选）

应在第一次初始化前选择。不要在已有 SQLite 部署上换文件并期待自动搬迁数据。

```bash
cp deploy/postgres.env.example .env.postgres
chmod 600 .env.postgres
openssl rand -hex 24
nano .env.postgres
```

把生成的随机密码填入 POSTGRES_PASSWORD，并按访问方式填写 PUBLIC_URL。使用这个例子时密码为十六进制字符，可直接放入连接 URL。然后执行：

```bash
sudo docker compose --env-file .env.postgres -f compose.postgres.yaml up -d --build
sudo docker compose --env-file .env.postgres -f compose.postgres.yaml ps
sudo docker compose --env-file .env.postgres -f compose.postgres.yaml cp app:/app/data/config.toml ./config.local.toml
```

PostgreSQL 18.4 保存在单独命名卷，不发布宿主机 5432 端口，应用等数据库健康后启动。后续 start／stop／logs／备份等命令都要保留相同 `--env-file`、`-f` 和可选项目名 `-p`。

### A5. 常用操作与备份

```bash
# 停止／启动；不会删除数据卷
sudo docker compose stop app
sudo docker compose start app

# 查看日志
sudo docker compose logs -f --tail=100 app
```

SQLite 停机复制整个数据目录，目标备份目录应不存在：

```bash
mkdir -p backups
chmod 700 backups
BACKUP_DIR="./backups/$(date +%Y%m%d-%H%M%S)"
sudo docker compose stop app
sudo docker compose cp app:/app/data "$BACKUP_DIR"
sudo docker compose start app
```

PostgreSQL 还必须备份数据库。停止 app，复制 app-data，再在 postgres 容器中用 `pg_dump -Fc -f /tmp/gacha.dump` 写出转储并通过 compose cp 取回。对应完整命令和恢复到独立空卷的步骤见 [运维手册](operations.md)。

不要使用 `down -v` 清除生产持久卷。只导出 UIGF 不是整站备份：用户、配置和加密授权不在 UIGF 中。

## 方案 B：原生 Node.js + systemd

示例固定使用 `/opt/gacha-viewer` 放源码，`/var/lib/gacha-viewer` 放运行数据，`/var/cache/gacha-viewer` 放构建账号的缓存，服务用户为 gacha。路径或用户改名时，同步修改后面的 systemd 文件。

若选 PostgreSQL，在 B3 启动服务之前完成 B4，再回来启动服务。

### B1. 安装 Node.js 24 和 pnpm

已有合适的 Node.js 24 与 pnpm 11.25.0 时可以复用，但要相应调整服务的 Node 路径。以下将官方运行时安装到独立的 `/opt/gacha-node`，不依赖交互式 nvm。[Node.js 官方下载目录](https://nodejs.org/dist/v24.22.1/)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git nano openssl xz-utils build-essential python3

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo '此示例仅提供 x64 / arm64 下载方式'; exit 1 ;;
esac
NODE_VERSION=v24.22.1
DOWNLOAD_DIR="$(mktemp -d)"
cd "$DOWNLOAD_DIR"
curl -fSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
curl -fSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
sha256sum --check --ignore-missing SHASUMS256.txt
```

**确认校验成功后**，继续安装：

```bash
sudo tar -xJf "node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -C /opt
sudo ln -sfnT "/opt/node-$NODE_VERSION-linux-$NODE_ARCH" /opt/gacha-node
export PATH="/opt/gacha-node/bin:$PATH"
sudo env "PATH=$PATH" /opt/gacha-node/bin/npm install --global pnpm@11.25.0
node --version
pnpm --version
```

应分别看到 v24.x 和 11.25.0。build-essential／python3 供 SQLite、Argon2 等原生依赖在缺少预编译包时构建；不要从 Windows 复制 node_modules。已有本机验收是 amd64，arm64 仍需你在目标机器自验。

### B2. 创建专用用户与构建源码

以下按首次创建示例执行；已有同名用户或目录时先确认其用途。

```bash
sudo useradd --system --user-group --home-dir /var/cache/gacha-viewer --no-create-home --shell /usr/sbin/nologin gacha
sudo install -d -o gacha -g gacha -m 0755 /opt/gacha-viewer
sudo install -d -o gacha -g gacha -m 0700 /var/lib/gacha-viewer /var/cache/gacha-viewer
sudo -H -u gacha git clone https://github.com/Flyky/GachaRecordsViewer.git /opt/gacha-viewer
sudo -H -u gacha env "PATH=/opt/gacha-node/bin:$PATH" sh -c 'cd /opt/gacha-viewer && pnpm install --frozen-lockfile && pnpm build'
```

运行数据目录第一次启动前应为空。用户 home／npm／pnpm 缓存与运行数据分开，避免缓存文件被识别为不完整旧部署。不要先在数据目录中手工新建缺少部署 ID 或密钥的配置。

### B3. 配置环境与 systemd

```bash
sudo install -o root -g root -m 0600 /opt/gacha-viewer/deploy/native.env.example /etc/gacha-viewer.env
sudo nano /etc/gacha-viewer.env
```

默认 SQLite 可使用：

```dotenv
NODE_ENV=production
GRV_DATA_DIR=/var/lib/gacha-viewer
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=http://127.0.0.1:3000
USER_TIMEZONE=Asia/Shanghai
DATABASE_DRIVER=sqlite
```

域名部署只需将 PUBLIC_URL 改为实际 HTTPS 地址，并配置下一节的反向代理。环境文件由 systemd 读取；应用不会自行加载仓库中的 .env。

```bash
sudo install -o root -g root -m 0644 /opt/gacha-viewer/deploy/gacha-viewer.service /etc/systemd/system/gacha-viewer.service
sudo systemctl daemon-reload
sudo systemctl enable --now gacha-viewer
sudo systemctl status gacha-viewer --no-pager
sudo journalctl -u gacha-viewer -n 100 --no-pager
```

首次启动自动生成 `/var/lib/gacha-viewer/config.toml`、credential-key、installation.json 和 SQLite 数据库。读取管理员密码：

```bash
sudo less /var/lib/gacha-viewer/config.toml
```

管理员及普通用户登录方式与 A3 相同。修改环境文件后用 `sudo systemctl restart gacha-viewer`；修改 .service 后先 daemon-reload 再重启。

修改管理员密码时先停止服务，用 `sudo nano /var/lib/gacha-viewer/config.toml` 只修改 `[admin].password`，保持部署 ID、密钥和其他配置不变，然后重新启动。Docker 方式先停止 app，复制原配置到本机、编辑后复制回 `app:/app/data/config.toml`，恢复文件所有者为 `node:node` 后启动；完整维护规则见 [运维手册](operations.md)。

### B4. 原生 PostgreSQL（可选）

在应用首次启动前配置。Debian 软件源提供的 PostgreSQL 主版本随发行版不同；本项目已实测的是 18.4，其他版本请自行确认，或选用前面的固定版本容器。

```bash
sudo apt-get install -y postgresql postgresql-client
sudo systemctl enable --now postgresql
sudo -u postgres createuser --pwprompt gacha_app
sudo -u postgres createdb --owner=gacha_app gacha_records
```

createuser 会交互询问数据库密码。然后编辑 `/etc/gacha-viewer.env`：

```dotenv
DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://gacha_app:URL编码后的密码@127.0.0.1:5432/gacha_records
```

用实际密码替换占位文本；特殊字符必须按 URL 规则编码，随机十六进制密码则可直接使用。保留 GRV_DATA_DIR，那里仍需存放配置、主密钥与标记。数据库角色需拥有该专用数据库并可创建 public 中的表与 drizzle 迁移 Schema；服务自动建表，但不会创建数据库或角色。

如果应用已经初始化为 SQLite，请保留原部署，另建数据目录与数据库；简单改连接字符串不会搬迁数据。

### B5. 原生备份与恢复

SQLite 冷备示例：

```bash
BACKUP_DIR="/var/backups/gacha-viewer/$(date +%Y%m%d-%H%M%S)"
sudo install -d -m 0700 "$BACKUP_DIR"
sudo systemctl stop gacha-viewer
sudo cp -a /var/lib/gacha-viewer "$BACKUP_DIR/data"
sudo cp -a /etc/gacha-viewer.env "$BACKUP_DIR/gacha-viewer.env"
sudo systemctl start gacha-viewer
```

PostgreSQL 同样停应用、复制配置与数据目录，并在重启前增加逻辑备份（交互输入数据库密码）：

```bash
sudo pg_dump -h 127.0.0.1 -U gacha_app -W -d gacha_records -Fc -f "$BACKUP_DIR/gacha.dump"
```

恢复时先停止应用，将备份数据复制到一个**新的空目录**，例如 `/var/lib/gacha-viewer-restored`，将其所有者设为 gacha，并在环境文件中调整 GRV_DATA_DIR。保持原配置、密钥、部署标记和数据库来自同一组备份。

PostgreSQL 先创建新的空库再恢复，随后调整 DATABASE_URL；不要先启动空应用建立新部署：

```bash
sudo -u postgres createdb --owner=gacha_app gacha_records_restored
sudo pg_restore -h 127.0.0.1 -U gacha_app -W -d gacha_records_restored --no-owner --exit-on-error "$BACKUP_DIR/gacha.dump"
```

恢复后再启动应用并自行核对。配置中的数据库／密钥若使用了绝对路径，也要对应调整；不要重新生成密钥或安装 ID 来绕过不匹配错误。

## 两种方式共用：HTTPS、升级与自行验证

### HTTPS 反向代理

仓库提供 `deploy/Caddyfile.example`，可用于宿主机 Caddy：

```caddyfile
gacha.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

替换域名，确保 DNS 指向服务器并允许访问 80／443。若使用 Debian 软件源的 Caddy，可按以下步骤手动安装并将配置写入 `/etc/caddy/Caddyfile`；已有 Caddy 配置时应合并站点，而不是覆盖其他站点：

```bash
sudo apt-get install -y caddy
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

应用的 PUBLIC_URL 必须为同一 HTTPS 地址，修改后重新创建 Docker 应用容器或重启原生服务。你也可使用现有 Nginx 等代理，保持所有路径转发至应用。以上只是提供操作说明，本轮没有在目标服务器安装代理或申请证书。

### 更新与回退

1. 记录当前提交／镜像并完成整组备份。
2. Docker 更新到所需源码提交后 `sudo docker compose up -d --build`，PostgreSQL 加上对应参数。
3. 原生运行先停止服务，以 gacha 用户更新选定源码提交，再按 B2 的 pnpm install／build 命令构建，最后启动服务。
4. 启动自动执行数据库结构迁移。结构升级后不能假设旧代码仍兼容；回退需要恢复升级前的整组备份与匹配版本。

数据库结构迁移不等于旧项目 JSON 迁移，后者明确不做。UIGF 用于记录交换，不包含账号和授权。生产数据卷、配置及主密钥应另行安全保管。

### 你可以按此顺序自行验证

```bash
curl -f http://127.0.0.1:3000/api/health
curl -f http://127.0.0.1:3000/api/ready
```

接着在浏览器检查：管理员创建普通用户 → 初始密码登录 → 导入 UIGF → 查询／统计／导出 → 米游社授权与刷新 → 重启后账号、记录和授权仍在。ready 只检查数据库，不代表米游社可访问；Token 默认不显示明文，只有本人主动查看才读取。

常见问题：

| 现象 | 检查 |
| --- | --- |
| 登录后无会话／Origin 错误 | PUBLIC_URL 是否与浏览器实际地址完全匹配，HTTPS 是否仍从 HTTP 地址访问 |
| 原生服务找不到 node／pnpm | B1 的 /opt/gacha-node 链接与服务 ExecStart／PATH 是否一致 |
| 首启报 CONFIG_MISSING | 数据目录是否混入构建缓存或其他文件，是否误用了丢失配置的旧部署目录 |
| KEY_MISMATCH／标记不匹配 | 数据库、配置、主密钥、标记是否来自同一部署；不要删除后强行重建 |
| 原生模块加载失败 | 是否使用 Node 24、是否误复制其他平台 node_modules；重新在 Debian 安装并构建 |
| 数据库不通 | 驱动选择、URL 编码、PostgreSQL 服务／权限／连接规则是否正确 |
| Docker Hub／npm 下载失败 | 服务器能否访问官方源，Docker 与当前 shell 的代理是否配置正确 |
| 米游社要求验证／授权过期 | 在官方 App 正常处理，再更新授权；已有历史保留 |
