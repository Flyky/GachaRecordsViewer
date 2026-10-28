<script setup lang="ts">
import { NButton } from 'naive-ui';
defineProps<{ disabled: boolean }>();
defineEmits<{ confirm: []; cancel: [] }>();
</script>
<template>
  <div
    class="proxy-prompt"
    role="status"
  >
    <p>直连失败，是否使用代理？</p>
    <p class="field-hint">
      使用「公共数据网络设置」中保存的前缀；尚未设置时请先保存。
    </p>
    <div class="proxy-actions">
      <NButton
        :disabled="disabled"
        @click="$emit('confirm')"
      >
        是，使用代理刷新
      </NButton>
      <NButton
        :disabled="disabled"
        @click="$emit('cancel')"
      >
        否
      </NButton>
    </div>
  </div>
</template>
<style scoped>
.proxy-prompt { margin: 14px 0; padding: 12px; background: #f2f5ed; border-radius: 6px; }
.proxy-actions { display: flex; gap: 10px; flex-wrap: wrap; }
</style>
