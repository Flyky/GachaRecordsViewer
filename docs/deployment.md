# 部署配置与数据库（R03）

配置、初始化、持久化及认证 API 已实现，接口用法见 [auth-api.md](auth-api.md)。完整容器交付、正式备份恢复与升级步骤见 [R16 运维手册](operations.md)，联合验收见 [第一版验收记录](v1-acceptance.md)。本页保留配置字段与原生运行细节。

## 启动与文件

使用 Node.js 24 LTS、pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

默认使用 SQLite，API 和前端在 `http://127.0.0.1:3000`。开发模式使用 `pnpm dev`，前端为 5173，API 仍为 3000。

首次启动在项目根目录的 `data/` 下生成：

| 文件 | 内容 |
| --- | --- |
| `config.toml` | 部署 ID、监听配置、数据库选择、随机管理员密码及密钥路径 |
| `credential-key` | 带版本号的 32 字节随机凭证主密钥，供 R12 凭证加密使用 |
| `gacha.sqlite` | 默认 SQLite 数据库；运行时可能同时出现 `-wal`、`-shm` 文件 |
| `installation.json` | 部署 ID 和密钥摘要，用于识别错误配置、丢失数据库或替换密钥 |

管理员固定用户名为 `admin`。初始管理员密码是 24 随机字节编码得到的 32 字符字符串，**在本机读取 `config.toml` 的 `[admin].password`**；服务日志和 HTTP 接口不会输出它。普通用户的初始密码 `12345678` 属于 R04 账号功能，与此密码不同。

文件以只创建、不覆盖方式写入；正常重启沿用配置、密码和主密钥。初始化期间使用 `.bootstrap.lock` 排斥同一数据目录的并发初始化，完成后释放。意外终止留下锁文件时，确认没有初始化进程后再人工移除锁文件，不要删除整个数据目录。

目录 / 文件创建请求的 Unix 权限分别为 `0700` / `0600`；Windows 权限取决于目录继承的 ACL，部署者应通过操作系统权限限制访问。不要把持久化目录放进前端静态目录。仓库忽略默认运行目录、配置、SQLite、密钥和真实 UIGF 文件；自定义路径也应放在仓库之外。

## TOML 与环境变量

以下展示首次生成的结构；`id`、`password` 为示意，实际保留生成值：

```toml
[installation]
id = "<自动生成的部署 UUID>"

[server]
host = "127.0.0.1"
port = 3000
public_url = "http://127.0.0.1:3000"
user_timezone = "Asia/Shanghai"

[database]
driver = "sqlite"
sqlite_path = "./gacha.sqlite"
# 切换 postgres 时，可增加 url，也可通过 DATABASE_URL 提供

[admin]
username = "admin"
password = "<首次启动自动生成>"

[security]
credential_key_file = "./credential-key"
```

配置不接受未知的节或字段，拼写错误会阻止启动。目前不要添加前期架构提案中的 `[miyoushe]` 节。

| 环境变量 | 作用 |
| --- | --- |
| `GRV_DATA_DIR` | 持久化目录，默认项目根目录下 `./data` |
| `GRV_CONFIG` | 配置文件路径，默认数据目录下 `config.toml` |
| `HOST`、`PORT` | 覆盖监听地址、端口 |
| `PUBLIC_URL` | 覆盖公开 HTTP / HTTPS 地址，不接受带用户名密码的 URL |
| `USER_TIMEZONE` | 覆盖用户默认 IANA 时区，例如 `Asia/Shanghai`；游戏记录使用档案自身时区 |
| `DATABASE_DRIVER` | 显式选择 `sqlite` 或 `postgres` |
| `DATABASE_URL` | PostgreSQL 连接地址，仅在驱动为 `postgres` 时使用 |

环境变量优先于对应 TOML 字段；不会把覆盖值或环境中的数据库密码写回配置。相对 `GRV_DATA_DIR` / `GRV_CONFIG` 以项目根目录解析；TOML 中 `sqlite_path` / `credential_key_file` 以配置文件所在目录解析。项目不自动加载 `.env` 文件，变量由启动环境提供。

不要仅设置 `DATABASE_URL` 并期待自动切换数据库。首次使用环境变量选择 PostgreSQL 后，之后的启动也需保留驱动和连接配置，或在停止服务后将其写进 TOML。开发前端代理固定指向 3000，开发时请保持 API 默认端口。

## SQLite

无需安装独立数据库服务。应用启用外键、WAL 和 5 秒 busy timeout，连接内串行调度写事务，避免异步请求混入另一个请求的事务。部署采用单应用实例和本地磁盘；不把 SQLite 文件放在网络共享盘。

`better-sqlite3` 是原生模块。本轮 Node 24 / Windows x64 使用锁定的 12.11.1 预编译包验证通过；其他平台若没有对应预编译包，需要该平台的编译工具。pnpm 已允许必要的 `better-sqlite3` 与 `esbuild` 安装脚本。

## PostgreSQL

预先创建应用专用数据库和角色；角色需能连接该数据库，并在 `public` 中建表 / 索引、在 `drizzle` 中维护迁移。服务会自动运行迁移，不负责创建数据库或角色。当前固定使用 `public` 应用 Schema，建议一个部署使用一个专用数据库。

首次启动可在 PowerShell 中配置：

```powershell
$env:GRV_DATA_DIR = 'D:\GachaRecordsViewerData'
$env:DATABASE_DRIVER = 'postgres'
$env:DATABASE_URL = 'postgresql://gacha:REPLACE_WITH_PASSWORD@127.0.0.1:5432/gacha'
pnpm start
```

示例中的地址和密码需要替换；特殊字符应按连接 URL 规则编码。远程数据库按部署要求配置 TLS；连接参数由 `pg` 驱动解析。连接池上限为 4，连接超时为 5 秒。迁移和部署身份绑定分别使用 PostgreSQL advisory lock，避免并发初始化重复操作。

修改数据库连接只选择目标数据库，**不会搬迁用户、会话、记录或凭证**。已有部署的标记与数据库状态必须匹配；指向空库或其他部署的库会拒绝启动。要新建独立部署，请用新的空数据目录和新的空数据库。跨数据库搬迁工具不属于 R03。

## 改密、缺失文件与恢复

停止服务，修改 `[admin].password`（8–1024 字符），再启动即可更新管理员密码。启动时根据主密钥与密码的 HMAC 摘要识别变更，更新持久化管理员认证版本，并删除旧管理员会话；普通用户会话保留。R04 认证接口已使用该版本。管理员密码在配置中按需求保存明文，数据库只保存摘要。

已有部署缺失配置、主密钥或数据库时会报错退出，不自动生成替代品。替换主密钥或部署 UUID 也会失败。典型错误：

| 错误码 | 检查内容 |
| --- | --- |
| `BOOTSTRAP_LOCKED` | 是否另有初始化进程或遗留锁文件；也检查目录访问权限 |
| `CONFIG_MISSING` / `KEY_OR_CONFIG_MISSING` / `KEY_MISSING` | 从同一份部署备份恢复配置或主密钥 |
| `DATABASE_STATE_MISSING` | 数据库文件 / 连接是否指错，或是否丢失原数据库 |
| `INSTALLATION_MARKER_MISMATCH` / `INSTALLATION_MISMATCH` / `KEY_MISMATCH` | 配置、标记、数据库与主密钥是否属于同一部署 |
| `INVALID_TOML` / `INVALID_CONFIG` / `UNKNOWN_CONFIG_FIELD` / `INVALID_*` | 按字段定义检查配置和值 |
| `DATABASE_UNAVAILABLE` / `INITIALIZATION_FAILED` | 数据库服务、权限、连接配置或迁移是否可用；排查时不要公开连接凭证 |
| `UNRECOGNIZED_DATABASE` | 目标已有表但没有本应用初始化状态，检查是否选错库或初始化曾中断 |

备份至少包含配置、主密钥、部署标记和数据库，作为一组保管；配置指向外部路径时也要包含对应文件。SQLite 停止服务后备份，不能在服务写入期间只复制主文件而忽略 WAL；PostgreSQL 使用自身一致性备份工具。恢复到新路径时可以调整文件路径和连接地址，但保持部署 ID、密钥与数据库内容一致。UIGF 仅承载抽卡记录，不是整站备份。实际操作见 [备份恢复与升级](operations.md)。

## 检查与开发迁移

`GET /api/health` 返回进程存活状态；`GET /api/ready` 执行真实数据库查询，可用返回 200，否则返回 503。响应不含数据库地址、密码或主密钥。这里不检测米游社状态。

两套 Schema 和迁移位于 `packages/db/src/schema/`、`packages/db/migrations/{sqlite,postgres}/`。结构变更时运行 `pnpm --filter @gacha/db generate` 并审阅两套 SQL；运行服务时自动应用未执行的迁移。已提交的迁移不应改写。

`pnpm test` 总会运行 SQLite 合约和配置测试；没有 `TEST_DATABASE_URL` 时，真实 PostgreSQL 测试明确跳过。要验收 PostgreSQL，设置该变量指向专用测试实例再运行 `pnpm test`。测试角色需要 `CREATE DATABASE` 权限；测试会创建随机 `grv_test_…` 数据库，只移除本次创建的库，不在已有业务库建表。

R03 已用真实 SQLite 和 PostgreSQL 18.4 执行同一套迁移、隔离、约束、事务和持久化测试；PostgreSQL 不是 SQLite 模拟。测试用数据库进程、数据和凭证均不提交。
