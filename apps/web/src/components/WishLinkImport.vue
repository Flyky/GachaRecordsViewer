<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { NButton, NInput, NSelect } from 'naive-ui';
import { WISH_LINK_REGIONS, type WishLinkJob, type WishLinkRegion } from '@gacha/contracts';
import { appUrl } from '../base.js';
import { operationLabel, operationMessage, useOperation } from '../operations.js';
import { poolLabel } from '../records.js';
import { refreshProfiles, selectProfile } from '../profiles.js';
import { userSession } from '../auth.js';
const url = ref(''), region = ref<WishLinkRegion>('cn_gf01');
let active = true;
onUnmounted(() => { active = false; url.value = ''; });
const { job, busy, loading, error, running, load, start, cancel } = useOperation<WishLinkJob>('/api/wish-link', async (finished) => {
  const owner = userSession.value?.user.id; await refreshProfiles();
  if (active && owner === userSession.value?.user.id && finished.profileId) selectProfile(finished.profileId);
});
const totals = computed(() => job.value?.pools.reduce((sum, pool) => ({ inserted: sum.inserted + pool.inserted, duplicates: sum.duplicates + pool.duplicates, enriched: sum.enriched + pool.enriched }), { inserted: 0, duplicates: 0, enriched: 0 }));
async function submit() { if (await start({ url: url.value.trim(), region: region.value })) url.value = ''; }
</script>
<template>
  <section class="surface account-form wish-link-import">
    <h2>祈愿链接导入</h2><p class="muted">
      粘贴本地游戏祈愿记录页的完整链接，读取官方当前可见记录并合并到对应 UID。无需绑定米游社账号，重复记录自动去重。
    </p>
    <details class="wish-link-guide">
      <summary>如何获取祈愿链接（Windows 游戏客户端）</summary><ol>
        <li>在运行游戏的电脑打开原神 → 祈愿 → 历史记录，等待列表加载，并保留游戏运行。</li>
        <li>
          <a
            :href="appUrl('/tools/get-wish-link.ps1')"
            download="get-wish-link.ps1"
          >下载本地提取脚本</a>，可先用记事本查看源码。只读取日志／缓存和写入剪贴板，不上传文件、不修改游戏或系统代理。
        </li>
        <li>在下载文件所在目录打开 PowerShell，执行：<pre>powershell -NoProfile -ExecutionPolicy Bypass -File .\get-wish-link.ps1</pre></li>
        <li>自动定位失败时，指定 Data 目录（替换为实际路径）：<pre>powershell -NoProfile -ExecutionPolicy Bypass -File .\get-wish-link.ps1 -GameDataPath 'D:\游戏目录\YuanShen_Data'</pre>国际服目录一般为 GenshinImpact_Data。</li>
        <li>将复制到剪贴板的完整链接粘贴到下方，选择对应服务器后导入。脚本在游戏电脑运行，不在 Debian 服务端运行。</li>
      </ol><p class="field-hint">
        也可使用已有导出工具的“复制祈愿链接”功能。手机或无法读取缓存时，可继续使用 UIGF 导入或米游社授权刷新；网页不能直接读取你电脑上的游戏缓存。
      </p>
    </details>
    <form
      class="stack-form"
      @submit.prevent="submit"
    >
      <label>游戏服务器</label><NSelect
        :value="region"
        :options="WISH_LINK_REGIONS.map((entry) => ({ label: entry.label, value: entry.value }))"
        :disabled="busy || running"
        aria-label="祈愿链接对应的服务器"
        @update:value="region = $event"
      />
      <p class="field-hint">
        请选择游戏实际服务器，用于确定记录时区。已有档案的服务器或时区不同时会停止合并。
      </p>
      <label for="wish-link-input">完整祈愿记录链接</label><NInput
        v-model:value="url"
        type="textarea"
        :maxlength="32768"
        :autosize="{ minRows: 3, maxRows: 6 }"
        :disabled="busy || running"
        placeholder="https://...auth_appid=webview_gacha&amp;authkey=..."
        :input-props="{ id: 'wish-link-input', autocomplete: 'off', spellcheck: false }"
      />
      <p class="field-hint">
        链接包含临时访问凭证，请勿公开。任务结束、取消或服务停止后会释放凭证，不保存到数据库或浏览器存储；过期后需要重新获取。
      </p>
      <div class="button-row">
        <NButton
          type="primary"
          attr-type="submit"
          :loading="busy"
          :disabled="busy || loading || running || !url.trim()"
        >
          导入并合并记录
        </NButton><NButton
          :disabled="busy || loading"
          @click="load"
        >
          刷新任务状态
        </NButton><NButton
          v-if="running"
          :disabled="busy"
          @click="cancel"
        >
          取消导入
        </NButton>
      </div>
    </form>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <div
      v-if="job"
      class="sync-result"
      aria-live="polite"
    >
      <h3>{{ operationLabel(job.status) }}{{ job.uid ? ` · UID ${job.uid}` : '' }}</h3>
      <p
        v-if="totals"
        class="sync-totals"
      >
        新增 {{ totals.inserted }} 条 · 重复 {{ totals.duplicates }} 条 · 补全 {{ totals.enriched }} 条
      </p><p
        v-if="job.code"
        class="feedback"
      >
        {{ operationMessage(job.code) }}
      </p>
      <div class="sync-pool-results">
        <article
          v-for="pool in job.pools"
          :key="pool.pool"
          class="sync-pool-result"
        >
          <div class="list-heading">
            <strong>{{ poolLabel(pool.pool) }}</strong><span>{{ operationLabel(pool.status) }}</span>
          </div><p>已读取 {{ pool.fetched }} 条 · 新增 {{ pool.inserted }} 条 · 重复 {{ pool.duplicates }} 条</p><p
            v-if="pool.code"
            class="field-hint"
          >
            {{ operationMessage(pool.code) }}
          </p>
        </article>
      </div>
      <p class="field-hint">
        已写入的记录保留。部分失败可重新粘贴有效链接导入；未返回的早期历史不会删除，也不会标记为完整历史。
      </p>
    </div>
    <p class="data-footnote">
      服务重启后不保留任务状态，已入库记录不受影响。可重新提供有效链接继续合并。
    </p>
  </section>
</template>
