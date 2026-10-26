<script setup lang="ts">
import { NConfigProvider, zhCN, dateZhCN, type GlobalThemeOverrides } from 'naive-ui';
import { RouterView } from 'vue-router';
const theme: GlobalThemeOverrides = { common: {
  primaryColor: '#326963', primaryColorHover: '#3e7b74', primaryColorPressed: '#244f4b',
  borderRadius: '8px', fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", sans-serif',
} };
</script>

<template>
  <NConfigProvider
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme-overrides="theme"
  >
    <RouterView />
  </NConfigProvider>
</template>
