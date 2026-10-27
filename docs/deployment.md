# 启动配置与数据库

更新：2026-10-27，紧急部署修订。完整安装见 [Debian 部署指南](debian-deployment.md)，Nginx 示例见 [nginx-subpath.conf.example](../deploy/nginx-subpath.conf.example)。

## 直接 pnpm 启动

完成依赖安装和构建后，在仓库根目录执行：

```bash
pnpm start
```

没有配置文件就生成 `data/config.toml` 并按默认值启动：SQLite、127.0.0.1:3000、站点根路径、Asia/Shanghai。未填写的配置项使用默认值，并将补齐结果写回文件。数据库不可连接时也保留已生成的配置，修改后重试即可。

新部署只有一份配置文件；SQLite 另有数据库文件及可能存在的 WAL／SHM。管理员随机密码和凭证加密密钥一起保存在 config.toml 中，不再生成 installation.json、credential-key 或 .bootstrap.lock。

停止进程后修改配置，再执行 pnpm start，不需要反复 export 环境变量。配置会规范化保存，注释和未知字段不保留。单个部署运行一个应用实例。

## 配置内容

```toml
[server]
host = "127.0.0.1"
port = 3000
public_url = "http://127.0.0.1:3000/"
user_timezone = "Asia/Shanghai"

[database]
driver = "sqlite"
sqlite_path = "./gacha.sqlite"

[admin]
username = "admin"
password = "<首次启动自动生成，也可自行修改，至少8字符>"

[security]
credential_key = "<首次启动自动生成，保留原值>"
```

管理员用户名固定为 admin。密码修改后重启，旧管理员会话失效，普通用户会话不受影响。配置包含密码、数据库连接和加密密钥，应保持仅服务账号可读，避免公开。

`security.credential_key` 用于解密已保存的米游社 Token，不能随意更换。若目标库没有任何加密凭证（即便已经有账号和抽卡记录），密钥不一致时会自动采用当前配置的密钥，保留用户与记录，使旧会话失效。只有目标库已保存加密凭证且密钥不一致时才报 KEY_MISMATCH，此时应使用该数据库原来的配置。

## 修改为 PostgreSQL

先准备可连接的专用数据库与角色。停止应用，把配置的 database 节改成：

```toml
[database]
driver = "postgres"
url = "postgresql://gacha_app:URL编码后的密码@127.0.0.1:5432/gacha_records"
```

保留其余配置并启动，目标为空库时自动建表。数据库角色需要专用库中建表、索引及 drizzle 迁移 Schema 的权限；应用不创建数据库和角色。当前使用 public 应用 Schema，连接池上限 4、连接超时 5 秒。

**先运行过 SQLite 也可以直接这样修改，同一个 data 目录可继续使用。** 不再因旧 installation.json 或空库缺少 app_state 而报 DATABASE_STATE_MISSING。原 SQLite 文件保留，账号和记录不会自动搬运；如需交换记录可通过 UIGF 导入导出。

切回原 SQLite 时恢复 driver 和 sqlite_path，保留该数据库对应的加密密钥即可。结构升级不保证旧版本代码兼容，回退需使用升级前备份。

## 域名与子路径

例如 Nginx 部署在 `https://xxx.com/gacha/`，修改：

```toml
[server]
host = "127.0.0.1"
port = 3000
public_url = "https://xxx.com/gacha/"
user_timezone = "Asia/Shanghai"
```

其余节保持原值。重启后页面为 /gacha/login、/gacha/admin，API 为 /gacha/api/...。多层路径同样支持；路径段使用英文字母、数字、短横线或下划线。末尾斜线会自动补齐，/gacha 会跳转至 /gacha/。

前端资源、Vue 路由、懒加载、API、扫码离开取消请求与 Cookie 都采用同一运行时前缀，不需要按路径重新编译。Nginx 需要保留 /gacha/ 转发，proxy_pass 地址末尾不要加 /；完整配置见 Debian 指南。

public_url 的协议、域名、端口仍需与实际访问地址一致，以供 Cookie 和跨站请求保护使用。HTTPS 子路径 Cookie 使用 __Secure- 前缀、Path=/gacha/，根路径 HTTPS 继续使用 __Host-。没有放松 Origin／CSRF／用户隔离检查。

容器探针仍可访问内部根路径 /api/health、/api/ready；浏览器使用带子路径的 API。ready 检查数据库，不检查米游社。

## Docker 与可选环境变量

Docker 第一次启动可用 Compose 环境变量生成初始配置；后续以挂载卷中的 config.toml 为准。修改 .env 中的 PUBLIC_URL 或数据库变量不会覆盖已生成的配置，应该修改配置文件并重启。

| 变量 | 用途 |
| --- | --- |
| GRV_DATA_DIR | 每次启动选择数据目录，默认仓库根目录的 data |
| GRV_CONFIG | 每次启动选择配置路径，默认数据目录内 config.toml |
| HOST、PORT、PUBLIC_URL、USER_TIMEZONE | 仅用于新配置的初始值 |
| DATABASE_DRIVER、DATABASE_URL | 仅用于新配置的数据库选择与地址 |

pnpm start 不自动加载 .env。直接启动通常无需任何环境变量。

旧版本用 credential_key_file 的配置首次升级时，会读取原密钥，并接收当次环境覆盖以保留旧 Docker 实际配置，再将密钥、连接和监听参数写进一份新格式配置。旧密钥文件、installation.json 与遗留锁文件保留在磁盘，但不再用于后续启动；可以继续保留作为备份，无需手工删除才能升级。

## 备份、恢复与错误

SQLite 停止应用后复制整个数据目录。PostgreSQL 同时保存 config.toml 和 pg_dump 转储。恢复时配置和数据库应来自同一备份，加密密钥须保留；新格式不需要部署标记。旧格式备份应连同外部密钥保留，升级时自动读取。

| 错误 | 处理 |
| --- | --- |
| INVALID_TOML | 修正 TOML 语法 |
| INVALID_CONFIG／INVALID_* | 修正端口、URL、时区等实际无效值 |
| DATABASE_UNAVAILABLE | 检查连接地址、账号、权限和网络 |
| INITIALIZATION_FAILED | 检查数据库迁移权限、已有表结构或文件写入权限 |
| KEY_MISMATCH | 目标库已保存加密凭证，需使用对应原 credential_key；无加密凭证的库会自动重新绑定，无需清库 |
| FILE_READ_FAILED | 检查配置或旧密钥文件读取权限 |

运行中普通用户认证、Token 加密、数据库迁移和基础参数检查保留。没有重复校验部署 UUID、installation.json 或遗留锁文件，也不要求数据目录必须为空。
