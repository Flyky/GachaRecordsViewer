<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { NButton } from 'naive-ui';
import type { BannerStatus } from '@gacha/contracts';
import { adminSession, errorMessage, getBanners, refreshBanners } from '../auth.js';
const status = shallowRef<BannerStatus | null>(null), busy = ref(false), error = ref(''), notice = ref('');
let active = true;
onUnmounted(() => { active = false; });
async function load(refresh = false) {
  if (busy.value) return; const session = adminSession.value; busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await (refresh ? refreshBanners() : getBanners());
    if (!active || !session || session.csrfToken !== adminSession.value?.csrfToken) return;
    status.value = result; if (refresh) notice.value = '历史卡池已更新，欧非分析刷新后立即使用，无需重启或重新导入记录。';
  } catch (cause) { if (active && session?.csrfToken === adminSession.value?.csrfToken) error.value = errorMessage(cause); }
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
      {{ status.storage === 'database' ? '已保存的在线数据' : '随应用内置数据' }} · {{ status.count }} 个时间段<br>
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
    </p><p
      v-if="notice"
      class="feedback success"
      role="status"
    >
      {{ notice }}
    </p>
  </section>
</template>
