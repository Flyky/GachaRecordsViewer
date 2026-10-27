<template>
  <div class="miyoushe-guide">
    <section class="surface account-form">
      <h2>先选择一种方式</h2><ul><li>只管理和备份历史：导入 UIGF 即可，无需米游社授权。</li><li>在线刷新国服原神：优先在“米游社账号”页使用官方 App 扫码，授权加密保存在你信任的本应用服务器。</li><li>扫码暂不可用：手动导入本人从外部工具取得的 SToken Cookie。只有普通网页 Cookie 或 LToken 时，不能保证能刷新。</li></ul><p class="feedback">
        本应用的登录密码只用于本地账号。扫码不需要在这里填写米游社密码；Token 相当于登录凭证，请勿发送到群聊、公开反馈或 GitHub Issue。
      </p>
    </section>
    <section class="surface account-form">
      <h2>1. 使用官方米游社 App 扫码</h2><ol><li>在“米游社账号”点击“扫码添加账号”，再点击“生成二维码”。</li><li>手机打开官方米游社 App，确认当前登录的是要授权的账号，扫描网页二维码并在手机上确认。</li><li>等待页面显示“授权已保存”。二维码约 3 分钟有效；过期后重新生成。离开页面会尝试取消旧会话。</li><li>选择页面列出的原神 UID，核对服务器后点击“开始刷新记录”。国服官服已实测，其他服务器以任务结果为准。</li><li>查看逐池结果；新记录会并入已有历史。查询与数据管理页面可以查看和导出。</li></ol><p class="field-hint">
        重新授权已有账号时使用详情中的“重新扫码授权”，并使用同一个米游社账号。身份不符或验证失败不会替换旧凭证。
      </p>
    </section>
    <section class="surface account-form">
      <h2>2. 从外部工具取得 SToken Cookie</h2><ol>
        <li>
          可从 <a
            class="text-link"
            href="https://github.com/BTMuli/TeyvatGuide"
            target="_blank"
            rel="noopener noreferrer"
          >TeyvatGuide 项目主页 ↗</a> 查看官方发布渠道，使用其提供的账号登录方式完成本人授权。外部工具流程未在本项目中逐步实测，菜单可能随版本调整。
        </li><li>在工具账号区域找到“复制 Cookie”或凭证导出功能。遇到额外验证时按官方流程处理。</li><li>回到本应用“手动导入凭证”，粘贴并点击“验证并保存凭证”。请检查内容包含同一账号的账号 ID、SToken 和 mid。</li><li>查看返回的身份和 UID。只有取得并校验 SToken 后才可尝试在线刷新；有原神角色列表也不等于拥有 SToken。</li>
      </ol><pre>stuid=本人账号ID; mid=对应mid; stoken=本人SToken;</pre><p class="field-hint">
        上方为字段示意，不能直接使用占位值。也接受 JSON 文本和 stuid_v2／stoken_v2／ltoken_v2 等字段。不要混用不同账号的字段，也不要把 LToken 改名为 SToken。
      </p>
    </section>
    <section class="surface account-form">
      <h2>3. 读取本人网页登录 Cookie</h2><p>仅供已有网页登录态的导入和诊断，不保证取得 SToken。</p><ol>
        <li>
          在本人浏览器打开 <a
            class="text-link"
            href="https://www.miyoushe.com/"
            target="_blank"
            rel="noopener noreferrer"
          >米游社官网 ↗</a> 并通过官方页面登录。
        </li><li>打开开发者工具，在“应用 / Application → Cookie”中查看米游社域名；或在“网络 / Network → 官方业务请求 → 请求标头”查看实际发送的 Cookie。</li><li>只复制属于这个米游社账号的必要字段。不要导出整个浏览器、其他站点 Cookie 或完整网络日志。</li><li>将内容手动导入本应用并检查能力。只有 ltuid 与 ltoken 可以校验身份，但不能刷新祈愿；需要改用 App 扫码或补充 SToken。</li>
      </ol><p class="field-hint">
        本应用无法跨站读取米游社 Cookie。HttpOnly 字段也不能通过网页脚本读取，不提供“一段控制台脚本必定取得全部 Token”的承诺。
      </p>
    </section>
    <section class="surface account-form">
      <h2>4. 查看、复制、更换与解绑</h2><ul><li>Token 默认遮挡，点击对应“查看”才显示；60 秒后、窗口失焦或离开页面会隐藏，不写入浏览器本地存储。</li><li>“复制”只复制该项 Token 值。浏览器通常要求 HTTPS 或 localhost；不支持时可主动查看后手动复制。</li><li>“更新凭证”会先校验再替换整组凭证；操作结果不确定时先更新账号列表，不要连续提交。</li><li>“解除绑定”会删除本应用保存的凭证并取消相关未完成刷新任务，保留已有抽卡历史。本地解绑不等于撤销上游登录，撤销请使用官方账号设备／会话管理。</li></ul><p class="field-hint">
        管理员页面不提供查看普通用户 Token 的功能；共享部署的运行者仍掌握服务器、数据库和密钥，请仅向可信部署保存凭证。
      </p>
    </section>
    <section class="surface account-form">
      <h2>5. 刷新与历史范围</h2><ul><li>默认五类卡池、增量刷新；首次自动遍历上游当前可提供的记录。完整重扫用于重新核对当前窗口。</li><li>任务在后台运行，可以离开页面。部分失败可“重试未完成卡池”，服务中断后也可以重试。</li><li>上游查询窗口之外的历史不能凭授权恢复，可通过 UIGF v4.0／v4.1／v4.2 合并补齐。本地更早历史不会被在线刷新删除。</li><li>刚抽的记录可能尚未更新，请等待上游同步后再刷新。</li><li>千星奇域不在首版范围，星铁、签到、角色和副本信息也未在此版本开放。</li></ul>
    </section>
    <section class="surface account-form">
      <h2>6. 常见问题</h2><dl><dt>要求设备或人机验证</dt><dd>先在官方 App 中处理，再重新授权；本应用不会绕过验证。也可改用外部工具导出的凭证或 UIGF。</dd><dt>没有目标 UID</dt><dd>检查米游社绑定关系与服务器。不要手工伪造账号归属；仅有 LToken 时不会取得角色列表。</dd><dt>授权失效或临时授权过期</dt><dd>刷新任务会有限重试临时授权；仍失败时更新凭证或重新扫码。已保存的历史保留。</dd><dt>网页显示网络错误，操作是否成功？</dt><dd>操作可能仍在服务端完成。先点击更新账号／任务列表，核对状态后再决定是否重试。</dd><dt>只想导入历史，不保存长期授权</dt><dd>直接使用 UIGF 导入导出。旧版内部 JSON 导入与历史迁移不提供。</dd></dl>
    </section>
    <section class="surface account-form">
      <h2>下一版：祈愿链接导入</h2><p>将支持在本地游戏打开祈愿历史后，从日志或缓存取得含临时 AuthKey 的祈愿链接，再交给本应用读取记录。首版尚未提供入口；网页无法代你读取游戏电脑的本地日志。链接会过期，也不会因此得到 SToken 或签到权限。</p>
    </section>
  </div>
</template>
