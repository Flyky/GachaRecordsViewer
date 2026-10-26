<script setup lang="ts">
import { APP_NAME } from '@gacha/contracts';
import { NCard, NTag } from 'naive-ui';
</script>

<template>
  <main class="app-shell">
    <header class="app-header">
      <div
        class="app-mark"
        aria-hidden="true"
      >
        ✦
      </div>
      <div>
        <p class="eyebrow">
          原神祈愿档案
        </p>
        <h1>{{ APP_NAME }}</h1>
      </div>
    </header>

    <NCard
      class="welcome-card"
      :bordered="false"
    >
      <NTag
        type="info"
        :bordered="false"
      >
        建设中
      </NTag>
      <h2>每一次祈愿，都值得留下。</h2>
      <p class="intro">
        这里将用于保存、查询和分析你的原神抽卡记录。
      </p>
      <p class="status-note">
        目前已搭建基础框架，账号登录与记录管理将在后续版本逐步开放。
      </p>
    </NCard>

    <footer class="app-footer">
      GachaRecordsViewer · 私人祈愿档案
    </footer>
  </main>
</template>
