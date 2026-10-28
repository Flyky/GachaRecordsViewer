<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { NButton } from 'naive-ui';
import { BANNER_SOURCE_URL, BANNER_JSON_URL, type BannerStatus } from '@gacha/contracts';
import { ApiError, adminSession, errorMessage, getBanners, refreshBanners, importBanners } from '../auth.js';
import AdminManualImport from './AdminManualImport.vue';
import AdminProxyPrompt from './AdminProxyPrompt.vue';
const status = shallowRef<BannerStatus | null>(null), busy = ref(false), error = ref(''), notice = ref('');
const proxyPrompt = ref(false), resources = [{ label: '最新上游卡池数据（banners.js，可直接粘贴或上传）', url: BANNER_SOURCE_URL }];
let active = true;
onUnmounted(() => { active = false; });
async function load(refresh = false, useProxy = false, content?: string) {
  if (busy.value) return; const session = adminSession.value; busy.value = true; error.value = ''; notice.value = '';
  proxyPrompt.value = false;
  try {
    const result = await (content !== undefined ? importBanners(content) : refresh ? refreshBanners(useProxy) : getBanners());
    if (!active || !session || session.csrfToken !== adminSession.value?.csrfToken) return;
    status.value = result; if (refresh || content !== undefined) notice.value = '历史卡池已保存，欧非分析刷新后立即使用，无需重启或重新导入记录。';
  } catch (cause) { if (active && session?.csrfToken === adminSession.value?.csrfToken) {
    error.value = errorMessage(cause);
    proxyPrompt.value = refresh && !useProxy && content === undefined && cause instanceof ApiError && cause.code === 'BANNER_REFRESH_FAILED';
  } }
  finally { if (active) busy.value = false; }
}
onMounted(() => { void load(); });
</script>
<template>
  <section class="surface dictionary-settings">
    <div class="list-heading">
      <h2>历史卡池数据</h2><NButton
        :loading="busy"
        :disabled="busy"
        @click="load(true)"
      >
        刷新历史卡池
      </NButton>
    </div>
    <p class="field-hint">
      更新角色 UP 名单和时间范围，供欧非分析判断是否歪。数据重启后保留；失败继续使用旧版。新角色无法识别时，请先刷新物品字典。
    </p>
    <p
      v-if="status"
      class="field-hint dictionary-info"
    >
      {{ status.storage === 'database' ? '已保存的卡池数据' : '随应用内置数据' }} · {{ status.count }} 个时间段<br>
      {{ status.source }} · {{ status.version.slice(0, 12) }}<br>
      覆盖：{{ status.firstStart }} 至 {{ status.lastEnd }}<br>
      获取时间：{{ status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '未知' }}
    </p>
    <p
      v-if="status?.cacheWarning"
      class="feedback"
    >
      保存的数据暂不可用，当前使用内置历史卡池，可尝试刷新。
    </p>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <AdminProxyPrompt
      v-if="proxyPrompt"
      :disabled="busy"
      @confirm="load(true, true)"
      @cancel="proxyPrompt = false"
    />
    <AdminManualImport
      :resources="resources"
      :disabled="busy"
      :max-bytes="1024 * 1024"
      accept=".json,.js,.txt,application/json,text/javascript,text/plain"
      @submit="load(false, false, $event[0])"
    >
      <p class="field-hint">
        在能联网的电脑打开下方资源，复制完整内容或下载后上传。支持 banners.js、含 characters 的 JSON、卡池数组及应用快照 JSON。请先更新物品字典。
      </p>
      <p class="field-hint">
        也可以下载<a
          :href="BANNER_JSON_URL"
          target="_blank"
          rel="noopener noreferrer"
          style="text-decoration: underline"
        >仓库内置卡池快照（JSON）</a>；该快照随仓库更新，可能落后于最新上游。
      </p>
    </AdminManualImport>
    <p
      v-if="notice"
      class="feedback success"
      role="status"
    >
      {{ notice }}
    </p>
  </section>
</template>
