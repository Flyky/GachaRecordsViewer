<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { NButton } from 'naive-ui';
const props = defineProps<{ resources: readonly { label: string; url: string }[]; disabled: boolean; maxBytes: number; accept?: string }>();
const emit = defineEmits<{ submit: [sources: string[]] }>();
const mode = ref('paste'), sources = ref(props.resources.map(() => '')), names = ref(props.resources.map(() => ''));
const error = ref(''), reading = ref(0); let active = true;
onUnmounted(() => { active = false; });
async function upload(index: number, event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file) return; error.value = '';
  if (file.size > props.maxBytes) { error.value = `文件超过 ${props.maxBytes / 1024 / 1024} MiB，请检查资源是否正确。`; return; }
  reading.value++;
  try { const content = await file.text(); if (active) { sources.value[index] = content; names.value[index] = file.name; } }
  catch { if (active) error.value = '文件读取失败，请重新选择。'; }
  finally { if (active) reading.value--; }
}
function submit() {
  error.value = '';
  if (sources.value.some((value) => new Blob([value]).size > props.maxBytes)) { error.value = '数据过大，请检查资源是否正确。'; return; }
  emit('submit', [...sources.value]);
}
function clear() { sources.value = props.resources.map(() => ''); names.value = props.resources.map(() => ''); error.value = ''; }
</script>
<template>
  <details class="manual-data">
    <summary>手动导入数据</summary>
    <slot />
    <fieldset :disabled="disabled || reading > 0">
      <legend>导入方式</legend>
      <label><input
        v-model="mode"
        type="radio"
        value="paste"
      >粘贴数据</label>
      <label><input
        v-model="mode"
        type="radio"
        value="upload"
      >上传文件</label>
    </fieldset>
    <form @submit.prevent="submit">
      <div
        v-for="(resource, index) in resources"
        :key="resource.url"
        class="manual-resource"
      >
        <p>{{ resource.label }}</p>
        <a
          :href="resource.url"
          target="_blank"
          rel="noopener noreferrer"
        >{{ resource.url }}</a>
        <label
          v-if="mode === 'paste'"
          class="manual-input"
        >
          <span>粘贴完整内容</span>
          <textarea
            v-model="sources[index]"
            rows="1"
            :disabled="disabled || reading > 0"
            :maxlength="maxBytes"
            spellcheck="false"
            placeholder="在此粘贴完整数据，可拖动右下角调整高度"
          />
        </label>
        <label
          v-else
          class="manual-input"
        >
          <span>选择本地文件</span>
          <input
            type="file"
            :accept="accept ?? '.json,application/json'"
            :disabled="disabled || reading > 0"
            @change="upload(index, $event)"
          >
          <span
            v-if="sources[index]"
            class="field-hint"
          >{{ names[index] || '已保留粘贴的数据' }}</span>
        </label>
      </div>
      <div class="manual-actions">
        <NButton
          attr-type="submit"
          :loading="disabled || reading > 0"
          :disabled="disabled || reading > 0 || sources.some(value => !value.trim())"
        >
          导入并保存
        </NButton>
        <NButton
          :disabled="disabled || reading > 0"
          @click="clear"
        >
          清空输入
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
  </details>
</template>
<style scoped>
.manual-data { margin-top: 20px; border-top: 1px solid #e0e4db; padding-top: 15px; }
summary { cursor: pointer; font-weight: 600; }
fieldset { border: 0; padding: 0; margin: 16px 0; display: flex; gap: 16px; }
legend { font-size: 12px; margin-bottom: 8px; }
fieldset label { display: inline-flex; align-items: center; gap: 6px; }
.manual-resource { margin: 16px 0; min-width: 0; }
.manual-resource p { margin-bottom: 6px; }
a { display: block; overflow-wrap: anywhere; text-decoration: underline; font-size: 12px; color: #52783c; }
a:hover { font-weight: 600; }
.manual-input { display: grid; gap: 7px; margin-top: 10px; font-size: 12px; }
textarea { box-sizing: border-box; width: 100%; min-height: 34px; max-height: 60vh; resize: vertical; border: 1px solid #c7cebe; border-radius: 5px; padding: 7px 9px; font: inherit; background: transparent; }
.manual-actions { display: flex; flex-wrap: wrap; gap: 10px; }
</style>
