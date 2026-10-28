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
    if (save) notice.value = result.githubProxy ? '代理前缀已保存，直连失败后点击“是，使用代理刷新”即可使用。' : '代理已停用，刷新使用直连。';
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
        例如填写 https://gh-proxy.com/，直连失败后会询问是否使用代理，点击“是”才会拼接完整源链接重试。留空保存可停用，设置重启后保留，无需修改配置文件。
      </p>
      <p class="field-hint">
        历史卡池支持 API 和原始文件代理。字典直连使用 genshin-db API，确认使用代理后读取同一项目的 GitHub 压缩包，下载可能较慢。两张卡片也支持手动导入，无需服务器访问外网。代理仅用于公开字典和卡池。
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
