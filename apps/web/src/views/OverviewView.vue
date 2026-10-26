<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { userSession } from '../auth.js';
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">
      YOUR PERSONAL ARCHIVE
    </p><h1>欢迎回来，{{ userSession?.user.username }}</h1><p class="muted">
      每一份记录，都是旅途的一部分。
    </p>
  </section>
  <section class="empty-archive">
    <div
      class="archive-illustration"
      aria-hidden="true"
    >
      <span>✦</span><i /><i /><i />
    </div>
    <p class="eyebrow">
      一切从第一份记录开始
    </p><h2>你的祈愿档案，静待开启</h2>
    <p class="muted">
      还没有游戏档案。记录导入、查询与分析功能正在准备中。<br>你现在可以在个人设置中管理登录密码。
    </p>
    <RouterLink
      class="outline-link"
      to="/settings"
    >
      前往个人设置 <span aria-hidden="true">↗</span>
    </RouterLink>
  </section>
</template>
