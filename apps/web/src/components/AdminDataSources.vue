<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { adminSession, errorMessage, getDataSources, saveDataSources } from '../auth.js';

const proxy = ref(''), busy = ref(false), loaded = ref(false), error = ref(''), notice = ref('');
let active = true;
onUnmounted(() => { active = false; });
async function load(save = false) {
  if (busy.value) return; const session = adminSession.value; busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = save ? await saveDataSources(proxy.value) : await getDataSources();
    if (!active || !session || session.csrfToken !== adminSession.value?.csrfToken) return;
    proxy.value = result.githubProxy; loaded.value = true;
    if (save) notice.value = result.githubProxy ? '代理前缀已保存，下次刷新立即生效；直连失败后自动尝试代理。' : '代理已停用，刷新使用直连。';
  } catch (cause) { if (active && session?.csrfToken === adminSession.value?.csrfToken) error.value = errorMessage(cause); }
  finally { if (active) busy.value = false; }
}
onMounted(() => { void load(); });
</script>
<template>
  <section class="surface dictionary-settings">
    <h2>公共数据网络设置</h2>
    <form @submit.prevent="load(loaded)">
      <label
        class="proxy-label"
        for="github-proxy"
      >GitHub 代理前缀（可选）</label>
      <NInput
        v-model:value="proxy"
        placeholder="https://gh-proxy.com/"
        :disabled="busy || !loaded"
        :maxlength="2048"
        :input-props="{ id: 'github-proxy', spellcheck: false, autocomplete: 'off' }"
      />
      <p class="field-hint">
        例如填写 https://gh-proxy.com/，GitHub 直连失败后会自动拼接完整源链接重试。留空保存可停用，设置重启后保留，无需修改配置文件。
      </p>
      <p class="field-hint">
        历史卡池支持 API 和原始文件代理。字典优先使用 genshin-db API；配置代理后，API 失败时改读同一项目的 GitHub 压缩包，再按直连、代理顺序尝试，下载可能较慢。仅用于公开字典和卡池，不传递米游社凭证。
      </p>
      <NButton
        attr-type="submit"
        :loading="busy"
        :disabled="busy"
      >
        {{ loaded ? '保存网络设置' : '重新读取网络设置' }}
      </NButton>
    </form>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="feedback success"
      role="status"
    >
      {{ notice }}
    </p>
  </section>
</template>
<style scoped>
.proxy-label { display: block; margin: 16px 0 8px; font-size: 13px; }
</style>
