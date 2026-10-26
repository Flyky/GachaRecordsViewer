# UIGF 与米游社数据源调研

调查日期：2026-10-26（Asia/Shanghai）

方法：读取 UIGF 原始规范、GitHub 仓库元信息、接口定义和维护中工具源码。未使用真实账号、未提交短信、未扫码授权、未进行实际祈愿拉取。

## 1. 结论及证据等级

| 议题 | 调研结果 | 证据范围 |
| --- | --- | --- |
| UIGF v4.0+ | 可实现；当前明确版本为 v4.0、v4.1、v4.2 | 标准原文与 Schema |
| 多游戏、多 UID | v4 原生支持，可只处理原神块 | 标准原文 |
| 不做千星奇域 | 可独立跳过 `hk4e_ugc`；不必拒绝整个 v4.2 文件 | v4.2 Schema |
| 米游社直接刷新原神记录 | 国服有明确实现依据：SToken → 角色 → AuthKey → 祈愿 API | 活跃项目源码 + 社区 SDK |
| Web App 内获取权限 | 可以优先尝试服务端代理 App 扫码流程；无需本应用持有用户米游社密码 | 活跃项目源码；部署环境需端到端验证 |
| 普通网页登录 Cookie 就能刷新 | 不能保证；网页 Cookie 可能只有 LToken 等凭证 | 网页扫码文档与 App 扫码源码的返回差异 |
| 旧 GameToken 扫码脚本 | 不推荐采用；已有维护者明确失效反馈 | 社区维护者讨论，2025-01 |
| 国际服 / 渠道服 | 必须分别验证，不能由国服官服结论外推 | 域名、身份系统、工具能力边界不同 |
| 历史记录恢复 | 在线只能获取上游当前开放的时间范围；不能恢复全部失效历史 | 当前工具开发方文档 |
| 星铁自动刷新 | 本次不认定已验证；保留独立适配 | Schema 支持不等于授权链路通用 |

“有代码 / 文档”仅表示方案有依据；本项目没有真实运行测试记录。第三方社区接口不是向本项目提供稳定性保证的官方开放平台。

## 2. UIGF 版本与兼容方案

### 2.1 当前标准

当前页面标注 v4.2。对比三个版本的原始文档：

| 版本 | 顶层游戏字段 | 重要变化 |
| --- | --- | --- |
| v4.0 | `hk4e`、`hkrpg`、`nap` | 多账号、多游戏容器；合并星铁格式 |
| v4.1 | 同上 | 星铁增加 `21`、`22` 卡池类型 |
| v4.2 | 再增加 `hk4e_ugc` | 新增千星奇域独立数据块 |

对当前原神需求，三版 `hk4e` 的必需字段相同。建议显式适配已知三版，导出原神默认 v4.0；后续新增版本再复核，未知 v4.x 不默默按旧版解释。

来源：[v4.0 原文](https://github.com/UIGF-org/UIGF-org.github.io/blob/0bba3809236602d4ada66a84a17de4e0ab89d170/docs/zh/standards/uigf-legacy-v4.0.md)、[v4.1 原文](https://github.com/UIGF-org/UIGF-org.github.io/blob/0bba3809236602d4ada66a84a17de4e0ab89d170/docs/zh/standards/uigf-legacy-v4.1.md)、[v4.2 原文](https://github.com/UIGF-org/UIGF-org.github.io/blob/0bba3809236602d4ada66a84a17de4e0ab89d170/docs/zh/standards/uigf.md)。

### 2.2 与实现直接相关的字段

| 层级 | 必填项 | 实现注意 |
| --- | --- | --- |
| 顶层 | `info` | 游戏块按标准可选择性处理 |
| `info` | `export_timestamp`、`export_app`、`export_app_version`、`version` | 导出时间为秒级，不是旧样例的毫秒级时间；版本是 `v4.0` 这样的字符串 |
| `hk4e[]` | `uid`、`timezone`、`list` | UID 标准允许字符串或整数；本项目统一为字符串；时区是整数偏移 |
| `hk4e[].list[]` | `uigf_gacha_type`、`gacha_type`、`item_id`、`time`、`id` | 记录 ID 必须是十进制数字字符串，不能转 JS Number |
| 原神可选元数据 | `name`、`item_type`、`rank_type`、`count`、档案 `lang` | 不能把可选字段错写成 UIGF 的必填项 |

`time` 表示该档案 `timezone` 对应的当地时间。导入时保存原始时区、当地时间和标准化时间；不能直接用服务器本地时区解析无时区字符串。

原神的 `uigf_gacha_type` 包含 `100/200/301/302/500`，原始 `gacha_type` 还包含 `400`。角色活动 `301/400` 的记录按 UIGF `301` 分组计算共享序号与五星间隔，但导出仍保留原始类型。

Schema 使用 JSON Schema draft 2020-12。建议固定版本快照、用独立 Ajv2020 实例校验，不依赖运行时在线下载 Schema，也不将上传文件提供的 `$schema` 当作任意远程抓取地址。[Ajv 的版本支持](https://ajv.js.org/json-schema.html)

### 2.3 物品元数据补全

标准允许只提供物品 ID 而没有名称、类型、星级，这会影响筛选和保底统计，但不应导致合法文件无法保存。

建议建立本地物品字典：按游戏 + `item_id` 定位物品，按语言展示名称，保存来源与更新版本。UIGF 提供名称 / ID 及多语言字典相关能力，可作为补全来源之一；稀有度、类型是否齐全要核对实际字典，缺少时从可追溯游戏元数据补充。未知 ID 保留原值，不伪造名称或星级。[UIGF API 说明](https://uigf.org/zh/api.html)

### 2.4 跳过规则

先识别版本和公共元数据，再校验本项目实际处理的原神块；首期不把其他游戏的业务枚举作为原神导入的前置条件。导出则对本应用产生的完整文件校验。

混合文件中的 `hk4e_ugc`、`hkrpg`、`nap` 不存入抽卡主表，不重新导出为“已备份”；页面明确提示未处理的内容，防止用户误以为本应用保存了整个文件。

### 2.5 用户提供的 UIGF v4.1 参考文件

2026-10-26 只读检查用户新提供的本地 `UIGF_v4.1_<uid>_<timestamp>.json`，使用前述固定提交中 v4.1 原文内的 Schema，通过 PowerShell `Test-Json` 校验。

| 项目 | 本地检查结果 |
| --- | --- |
| 标准版本 | `v4.1`，顶层为 `info` 与 `hk4e` |
| 导出工具 | `genshin-wish-export v0.12.1` |
| 档案 | 一个原神档案，时区 `+8`，语言 `zh-cn` |
| 总记录 | 1,413 条，记录 ID 均为字符串且无重复 |
| 必填字段 | 所有记录均有 `uigf_gacha_type/gacha_type/item_id/time/id` |
| 额外字段 | 含 `name/item_type/rank_type`；没有 `count` 不影响标准校验 |
| 保底分组 | `301` 1,060 条、`302` 94 条、`200` 259 条 |
| 原始角色池 | `301` 832 条、`400` 228 条，均归入 UIGF `301` |
| 星级 | 三星 1,205、四星 185、五星 23 |
| 时间范围 | 2025-09-16 00:45:29 至 2026-10-11 04:12:58 |

本检查验证了参考文件的标准结构，尚不代表本项目导入器已经实现或运行成功。真实文件不提交到仓库，后续自动化测试使用合成或匿名化样例。用户已排除旧内部 JSON 的历史迁移，不再需要补齐旧样例物品 ID 的转换工具。

## 3. 米游社抓取记录的原理

所谓“从米游社刷新”包含两个不同服务：米游社身份服务提供授权，游戏祈愿服务提供记录。

```text
本地应用登录
  → 用户发起米游社绑定
  → 服务端建立官方 App 扫码会话
  → 用户在官方米游社 App 扫码确认
  → 服务端取得并加密保存 SToken、账号 ID、mid
  → 按需取得 LToken / Cookie Token，枚举绑定游戏角色
  → 为选定原神 UID 生成 webview_gacha AuthKey
  → 按卡池、end_id 分页读取祈愿记录
  → 以记录 ID 合并入当前用户的游戏档案
```

现行实现依据包括 TeyvatGuide 的 [扫码请求](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/src/request/passportReq.ts)、[扫码成功返回处理](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/src/components/pageConfig/tco-gameLogin.vue)、[AuthKey 与绑定角色请求](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/src/request/takumiReq.ts)。该仓库调查时最后推送为 2026-10-25，参考提交固定在下文，避免以后主分支变化影响溯源。

### 3.1 凭证不是同一种东西

| 凭证 / 标识 | 作用 | 本项目处理 |
| --- | --- | --- |
| 本地 Session | 登录本 Web App | 与米游社凭证分开，不可互换 |
| 米游社账号 ID / `mid` | 表示社区 / 通行证身份 | 与游戏 UID 分开保存；Token 需与对应身份配对 |
| SToken，含 v2 形式 | 米游社会话凭证；当前国服原神 AuthKey 流程的关键 | 加密保存，按能力验证 |
| LToken | 社区 / 战绩等接口使用的一类凭证 | 实际能力取决于版本和具体接口；不能当作 SToken |
| Cookie Token | 账号相关接口使用的凭证 | 与 account ID / mid 及版本配对；不承诺任意 Token 可互转 |
| GameToken | 游戏登录链路凭证 | 不作为首期推荐长期存储项；旧扫码链路有失效反馈 |
| AuthKey | 特定游戏、角色和用途的临时访问凭证 | 用 `webview_gacha` 用途取得；过期后重新生成，不硬编码有效期 |

界面显示“身份验证通过”并不意味着“祈愿刷新通过”。建议能力状态独立显示：授权身份、绑定角色列表、祈愿刷新、战绩读取。

### 3.2 可以在本 Web App 里获取吗

可以优先实现 **服务端代理 App 扫码**，有现行源码依据：

| 步骤 | 参考端点 | 已核对内容 |
| --- | --- | --- |
| 创建 App 二维码 | `POST https://passport-api.mihoyo.com/account/ma-cn-passport/app/createQRLogin` | TeyvatGuide 请求体为 `{}`，携带 App / 设备 / DS 相关头 |
| 查询确认状态 | 同域 `POST /account/ma-cn-passport/app/queryQRLoginStatus` | 传 `ticket`；确认后读取 `tokens` 和 `user_info` |
| 取得 SToken 身份 | 上一步返回 | 当前源码将返回 token 与 `aid/mid` 组成 SToken Cookie |
| 补充 LToken | `GET /account/auth/api/getLTokenBySToken` | 当前工具仍有此调用；返回形态和验证要求需实测 |
| 补充 Cookie Token | `GET /account/auth/api/getCookieAccountInfoBySToken` | 当前工具仍有此调用；可能遇官方验证 |
| 列出角色 | `https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie` | 使用对应 Cookie 身份 |
| 生成祈愿 AuthKey | `POST https://api-takumi.mihoyo.com/binding/api/genAuthKey` | SToken + mid；`auth_appid=webview_gacha`、`game_biz`、`game_uid`、`region` |
| 拉取记录 | `GET https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog` | AuthKey、卡池、`page/size/end_id` 等参数 |

端点是调查时的参考配置，不是已经实测的可用性承诺。旧资料中存在 `.miyoushe.com` 域名，现行参考源码用 `.mihoyo.com`；不盲目混用 Cookie 域和身份参数。DS 类型、盐值、客户端版本和设备上下文需要匹配当前接口；新 SDK 不内置可保证可用的 DS 盐值。

尤其注意：SDK 的宽泛 TypeSpec 请求模型与维护中应用实际请求体并非处处相同。例如 SDK 为扫码建模的必需设备字段，不能直接覆盖实际源码的请求行为。实现前以真实响应验证适配，而不是生成客户端后就宣称登录已完成。

来源：[新 SDK Passport 定义](https://github.com/UIGF-org/mihoyo-api-sdk/blob/7c3107f95b72e7324af966b2e8989eb8375e5fc7/src/passport.tsp)、[Game Account 定义](https://github.com/UIGF-org/mihoyo-api-sdk/blob/7c3107f95b72e7324af966b2e8989eb8375e5fc7/src/game-account.tsp)、[原神 Gacha 定义](https://github.com/UIGF-org/mihoyo-api-sdk/blob/7c3107f95b72e7324af966b2e8989eb8375e5fc7/src/game-genshin.tsp)。

### 3.3 为什么不能直接嵌入官方登录页读取 Cookie

普通网站受浏览器同源策略限制，不能像桌面应用的 WebView CookieManager 那样读取另一个站点的登录 Cookie；部分 Cookie 还带 HttpOnly。跳转米游社登录或嵌入页面，不会自动把凭证交回本应用。Starward 的 WebView2 实现不能直接搬成网页端。

因此首期建议使用服务端持有扫码会话和官方返回凭证，前端只呈现二维码与状态；不把用户现有浏览器 Cookie 当作可自动读取的资源。[MDN 同源策略](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)、[Starward 登录实现](https://github.com/Scighost/Starward/blob/df8ae07b5ad4c9c6cb70d288488ce8073ce01478/src/Starward/Features/GameRecord/LoginPage.xaml.cs)

### 3.4 明确淘汰的路径

- 不采用“网页 Login Ticket 一定可以换到 SToken”的旧教程；旧 API 合集已经标注相关返回变化。
- 不把旧 `hk4e_cn/combo/panda/qrcode/fetch` GameToken 扫码作为首选。维护者在 2025-01 的答复已指出旧 GameToken 扫码不可用，应改用较新的扫码路径。
- `Womsxd/mihoyo_login` 的调查分支最后推送在 2024-08，仍使用上述旧链路；虽然源码会输出 SToken，但不能据此给用户写“运行就一定成功”的获取步骤。

依据：[维护者关于 SToken 的答复](https://github.com/UIGF-org/mihoyo-api-collect/discussions/80)、[旧 Token 文档](https://github.com/UIGF-org/mihoyo-api-collect/blob/be9e975a797110fffa80bdfa989d812f08274f5a/hoyolab/user/token.md)、[旧扫码脚本](https://github.com/Womsxd/mihoyo_login/blob/11f2092725c3bf22941a82a6f3faf4dbde548b38/qr_login.py)。

## 4. 拉取、时间窗口与失败处理

- 通过每页返回的末条 ID 继续 `end_id` 游标，不按数据库行数跳过输入。
- 新建档案或补齐模式遍历上游可返回范围；普通增量模式按各卡池已保存边界停止。两种模式都按 ID 去重。
- 设置小并发、请求间隔、超时、有限重试与退避；精确速率是本项目配置，不宣称为上游公开配额。
- 失效 AuthKey 可用有效授权重取；授权失效则需要重新扫码或导入，不能无限自动重试。
- 任务可标记“部分完成”，记录已经完成的卡池和失败原因；不把中途失败包装成完整刷新。
- 上游显示可能有延迟，新抽卡未立即出现不自动认定数据丢失。
- 当前工具开发方说明原神可查询近一年记录。产品以“上游当前开放范围”为准，不写死六个月，不承诺恢复超期记录；长期历史靠已有数据库与 UIGF 备份保存。

参见：[现行祈愿功能说明](https://snaphutaorp.org/zh/features/wish-export)、[开发方对接口原理的说明](https://snaphutaorp.org/zh/advanced/Gacha-system-and-export-principal)、[TeyvatGuide 功能说明](https://github.com/BTMuli/TeyvatGuide/blob/72c3f371673e40cf0c2153535ddddafd24462fbc/README.md)。这里的时间窗口是工具开发方资料，未在本轮以真实账号验证。

## 5. 未来扩展是否有依据

| 方向 | 已找到的依据 | 本轮建议 |
| --- | --- | --- |
| 角色与战绩 | 原神 `index`、`character/list`、`character/detail` 等定义和应用实现 | 独立适配器 + 可过期缓存 |
| 深境螺旋、剧诗等 | `spiralAbyss`、`role_combat` 等定义 | 按账号隐私与授权能力显示；不能保证所有历史期次可取 |
| 签到 | 社区 SDK 与现行工具存在签到能力 | 未来用户显式开启，单独任务状态，首期不执行 |
| 星铁抽卡 | UIGF v4.1/v4.2 `hkrpg`，含 `21/22` 新类型 | 数据模型预留；拉取端点、授权及联动池分别验证 |

来源：[原神战绩定义](https://github.com/UIGF-org/mihoyo-api-sdk/blob/7c3107f95b72e7324af966b2e8989eb8375e5fc7/src/game-genshin.tsp)、[国服游戏记录定义](https://github.com/UIGF-org/mihoyo-api-sdk/blob/7c3107f95b72e7324af966b2e8989eb8375e5fc7/src/game-records-cn.tsp)。不采用“请求字段允许 `hkrpg_cn`，所以星铁一定能用同样方式取得 AuthKey”的推论。

## 6. 实现前的最小实测

1. 在目标部署网络创建 App 二维码，正常处理等待、扫描、确认、取消与超时。
2. 用户本人在官方 App 确认，核对 SToken 对应的账号 ID 和 mid；Token 不进入调试日志。
3. 分别验证 LToken / Cookie Token 补充、绑定角色枚举，不用“一次成功”替代全部能力测试。
4. 选国服官服原神 UID，取得 `webview_gacha` AuthKey；依次读取角色、武器、常驻、集录、新手池。
5. 验证 `301/400` 归组规则、同秒记录顺序、记录 ID、时区和重复刷新。
6. 使会话过期或使用无效凭证，确认给出可操作错误且历史数据不变。
7. 测渠道服 / HoYoLAB 时单列结果，不沿用官服测试标签。

本轮未执行上述依赖真实授权的测试。开发顺序建议先做这段最小验证，再投入完整的内置授权界面；不要等应用其他页面全部做完才发现授权路径不兼容。

## 7. 来源快照与维护状态

| 项目 | 本轮固定提交 | 调查时状态 |
| --- | --- | --- |
| UIGF 标准站 | `0bba3809236602d4ada66a84a17de4e0ab89d170` | 未归档；含 v4.2 |
| mihoyo-api-collect | `be9e975a797110fffa80bdfa989d812f08274f5a` | 2026-09-13 归档；README 指向 SDK |
| mihoyo-api-sdk | `7c3107f95b72e7324af966b2e8989eb8375e5fc7` | 未归档；MIT；有 JS/TS 生成客户端 |
| TeyvatGuide | `72c3f371673e40cf0c2153535ddddafd24462fbc` | 未归档；最近推送 2026-10-25 |
| Starward | `df8ae07b5ad4c9c6cb70d288488ce8073ce01478` | 未归档；最近推送 2026-10-11 |
| Womsxd/mihoyo_login | `11f2092725c3bf22941a82a6f3faf4dbde548b38` | 未归档；最后推送 2024-08-20，旧链路不推荐 |

新 SDK README 明确说明：客户端测试采用模拟 HTTP，不访问真实账号。它可以减少接口定义和序列化工作，但不能证明某个端点当前在线可用。建议隔离为本项目内部 provider 接口，评估实际依赖与发布包后决定复用生成客户端还是只参考定义。

旧合集已迁移：[旧仓库 README](https://github.com/UIGF-org/mihoyo-api-collect/blob/be9e975a797110fffa80bdfa989d812f08274f5a/README.md)。新项目与测试边界：[SDK README](https://github.com/UIGF-org/mihoyo-api-sdk/blob/7c3107f95b72e7324af966b2e8989eb8375e5fc7/README.md)。旧文档与新 SDK 的许可证不同；后续实现不整段复制旧文档或未知许可源码，保留实际复用来源的必要说明。
