<script setup lang="ts">
import { RouterLink } from 'vue-router';
import MiyousheGuide from '../components/MiyousheGuide.vue';
</script>
<template>
  <section class="page-heading">
    <p class="eyebrow">
      AUTHORIZATION GUIDE
    </p><h1>米游社授权获取手册</h1><p class="muted">
      扫码、外部凭证与常见问题，按当前应用实际能力使用。
    </p><RouterLink
      class="text-link"
      to="/accounts"
    >
      ← 返回米游社账号
    </RouterLink>
  </section>
  <MiyousheGuide />
</template>
