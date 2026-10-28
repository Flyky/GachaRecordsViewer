<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { NButton, NTag } from 'naive-ui';
import type { FeatureSettings } from '@gacha/contracts';
import { adminSession, errorMessage, getAdminFeatures, setGenshinTopup } from '../auth.js';
const settings = shallowRef<FeatureSettings | null>(null), busy = ref(false), error = ref(''), notice = ref('');
let active = true;
onUnmounted(() => { active = false; });
async function load(change = false) {
  if (busy.value) return; const session = adminSession.value; busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = change && settings.value ? await setGenshinTopup(!settings.value.genshinTopup) : await getAdminFeatures();
    if (!active || !session || session.csrfToken !== adminSession.value?.csrfToken) return;
    settings.value = result;
    if (change) notice.value = result.genshinTopup ? '原神充值已开启，用户重新进入或刷新米游社功能页后显示。' : '原神充值已关闭，充值卡片隐藏并阻止新的充值流程。';
  } catch (cause) { if (active && session?.csrfToken === adminSession.value?.csrfToken) error.value = errorMessage(cause); }
  finally { if (active) busy.value = false; }
}
onMounted(() => { void load(); });
</script>
<template>
  <section class="surface dictionary-settings">
    <div class="list-heading">
      <h2>功能开关</h2><NButton
        :loading="busy"
        :disabled="busy"
        @click="load(!!settings)"
      >
        {{ settings ? settings.genshinTopup ? '关闭充值功能' : '开启充值功能' : '读取功能设置' }}
      </NButton>
    </div>
    <p>
      原神充值
      <NTag
        v-if="settings"
        size="small"
        :bordered="false"
        :type="settings.genshinTopup ? 'success' : 'default'"
      >
        {{ settings.genshinTopup ? '已开启' : '已关闭' }}
      </NTag>
    </p>
    <p class="field-hint">
      控制米游社功能页是否显示原神充值卡片。关闭后也会禁止加载商品、核对信息和新下单；不会取消已创建的官方订单。设置重启后保留。
    </p>
    <p
      v-if="settings?.updatedAt"
      class="field-hint"
    >
      最近修改：{{ new Date(settings.updatedAt).toLocaleString() }}
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
