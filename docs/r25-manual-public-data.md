# R25：管理员手动导入字典／卡池与代理确认

本轮取代 R24 的自动代理回退：点击刷新先直连，失败后显示「直连失败，是否使用代理？」；只有点击「是，使用代理刷新」才发起代理请求。「否」关闭提示，原数据保留。没有保存代理前缀时会提示先设置。确认后的请求直接使用代理，不重复直连，也不长期记住本次同意；下次点击普通刷新仍先直连。

## 页面操作

物品字典、历史卡池卡片各有一个默认收起的「手动导入数据」。展开后可选择「粘贴数据」或「上传文件」，两种方式共享当前输入，切换不丢失内容。

- 文本框默认一行，可以拖动右下角调整高度；不自动展开全文。
- 页面直接展示可点击、带下划线的完整资源 URL。使用能访问资源的电脑获取内容，然后导入；服务器不需要访问外网。
- 文件选择后点击「导入并保存」才提交，成功后立即生效且重启保留；输入可用「清空输入」移除。错误时保留原数据及输入，便于修正重试。
- 导入和在线刷新共用同一把更新锁；进行期间不能互相覆盖。没有增加配置文件、启动检查、数据库迁移或依赖。

## 字典资源

需要四份完整 JSON 数组。四个输入区标明类型与语言，无需自行合并成一个文件；全部填写或选择文件后一次保存。

| 对应输入 | 资源 |
| --- | --- |
| 角色 · 简体中文 | [genshin-db 角色简中](https://genshin-db-api.vercel.app/api/v5/characters?query=names&matchCategories=true&verboseCategories=true&resultLanguage=ChineseSimplified) |
| 角色 · 英文 | [genshin-db 角色英文](https://genshin-db-api.vercel.app/api/v5/characters?query=names&matchCategories=true&verboseCategories=true&resultLanguage=English) |
| 武器 · 简体中文 | [genshin-db 武器简中](https://genshin-db-api.vercel.app/api/v5/weapons?query=names&matchCategories=true&verboseCategories=true&resultLanguage=ChineseSimplified) |
| 武器 · 英文 | [genshin-db 武器英文](https://genshin-db-api.vercel.app/api/v5/weapons?query=names&matchCategories=true&verboseCategories=true&resultLanguage=English) |

浏览器打开链接后复制完整 JSON，或保存为 UTF-8 JSON 文件，在对应位置上传。每份不超过 8 MiB。简中／英文不要放错位置；原始数组内的 `id`、`rarity`、`name` 是必需字段，其余字段不参与字典构建。

沿用在线字典转换及双语完整性检查：至少 100 项，拒绝重复 ID／冲突类型或星级、缺失名称和已存在 ID 丢失。四份一起在事务中写入，失败不会只更新一半。手动版的来源标记为 `genshin-db-manual`，版本继续按转换后的内容计算。

## 历史卡池资源

- [最新上游 banners.js](https://raw.githubusercontent.com/MadeBaruna/paimon-moe/main/src/data/banners.js)：复制或下载完整文件，直接粘贴或上传即可；上游本身不是 JSON。
- [应用仓库卡池 JSON 快照](https://raw.githubusercontent.com/Flyky/GachaRecordsViewer/main/packages/gacha-core/src/catalog/character-banners.json)：可直接保存为 JSON 后上传。该文件随本项目仓库更新，可能落后于上游，不代表实时最新卡池。

支持以下内容，单份最多 1 MiB：

1. 原始 `export const banners = ...` JS。沿用 Acorn 解析字面量，不运行 JS。
2. `{ "characters": [...] }` JSON，或上游 `characters` 数组本身；项目使用 `start`、`end`、`featured`（英文角色名）及可选时区布尔字段。
3. 本应用快照 JSON，使用 `entries` 中的 `start`、`end`、`startGlobal`、`endGlobal`、`itemIds`。

不需要填写或伪造 GitHub commit。手动导入生成 `manual-<内容SHA256>` 版本，并记录导入时间。保持原有时间范围与条目校验，覆盖范围不得缩小；角色 ID 必须在当前字典中且为五星角色，无法识别时先更新字典。旧的 GitHub commit 版本缓存仍可加载，手动数据也能在重启后恢复。

## 接口

沿用管理员、Origin、CSRF 与子路径保护：

| 请求 | 请求体 | 作用 |
| --- | --- | --- |
| `POST /api/admin/dictionary/refresh` | `{}` 或 `{ "useProxy": false }` | 仅直连原 API |
| `POST /api/admin/banners/refresh` | `{}` 或 `{ "useProxy": false }` | 仅直连 GitHub |
| 上述任一 refresh | `{ "useProxy": true }` | 显式请求已保存代理；未设置返回 `DATA_PROXY_REQUIRED` |
| `POST /api/admin/dictionary/import` | `{ "sources": ["角色简中JSON全文", "角色英文JSON全文", "武器简中JSON全文", "武器英文JSON全文"] }` | 本地解析并导入四份字典 |
| `POST /api/admin/banners/import` | `{ "content": "JS或JSON全文" }` | 本地解析并导入卡池 |

上传文件在浏览器读取为文本，再使用相同的管理员接口提交；不上传到任何第三方。成功返回原有 DictionaryStatus／BannerStatus。导入失败错误为 `DICTIONARY_IMPORT_INVALID`、`BANNER_IMPORT_INVALID` 或可操作的 `BANNER_CHARACTER_UNKNOWN`。

## 定向验证

3 个相关文件共 17 项测试通过，覆盖默认不走已保存代理、显式代理请求、未配置代理提示、四份字典导入与原有 ID 保护、卡池 JSON／JS 导入、未知角色／不完整数据／非字面量 JS 拒绝、权限和 CSRF、重启加载、并发更新锁，以及既有刷新与压缩包读取回归。

前后端类型、构建及改动范围零警告 lint 通过，保留既有统计图表分包体积提示。

本轮不调用真实米游社、不读取个人凭证、不运行扫码、浏览器、Docker 或真实 PostgreSQL 验证。目标服务器只需更新构建并重启，无新增部署配置。
