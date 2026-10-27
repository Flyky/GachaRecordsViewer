<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { userSession } from '../auth.js';
import { currentProfile, profilesLoading, profilesError, regionLabel, timezoneLabel } from '../profiles.js';
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">
      YOUR PERSONAL ARCHIVE
    </p><h1>欢迎回来，{{ userSession?.user.username }}</h1><p class="muted">
      每一份记录，都是旅途的一部分。
    </p>
  </section>
  <p
    v-if="profilesLoading && !currentProfile"
    class="muted"
    role="status"
  >
    正在加载档案…
  </p>
  <section
    v-else-if="currentProfile"
    class="surface archive-summary"
  >
    <div class="list-heading">
      <div>
        <p class="eyebrow">
          GENSHIN IMPACT
        </p><h2>UID {{ currentProfile.uid }}</h2>
      </div>
      <span class="status-badge">{{ regionLabel(currentProfile.region) }}</span>
    </div>
    <dl class="summary-grid">
      <div>
        <dt>已保存记录</dt><dd class="large-number">
          {{ currentProfile.recordCount.toLocaleString() }}<small> 条</small>
        </dd>
      </div>
      <div><dt>游戏时区</dt><dd>{{ timezoneLabel(currentProfile.timezone) }}</dd></div>
      <div><dt>最早记录</dt><dd>{{ currentProfile.firstTime ?? '暂无记录' }}</dd></div>
      <div><dt>最近记录</dt><dd>{{ currentProfile.lastTime ?? '暂无记录' }}</dd></div>
    </dl>
    <p
      v-if="currentProfile.metadataIncomplete"
      class="feedback"
    >
      {{ currentProfile.metadataIncomplete }} 条记录的名称、类型或星级尚不完整；原始记录已保留。
    </p>
    <p class="form-help">
      以上时间按游戏时区显示。已保存记录可能不是完整历史，首段保底次数仍需结合历史完整性判断。
    </p>
    <RouterLink
      class="outline-link"
      to="/data"
    >
      导入或导出记录 <span aria-hidden="true">↗</span>
    </RouterLink>
  </section>
  <section
    v-else-if="!profilesError"
    class="empty-archive"
  >
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
      导入 UIGF 或连接米游社，建立你的原神祈愿档案。<br>同一账号可以分别保存多个 UID。
    </p>
    <RouterLink
      class="outline-link"
      to="/data"
    >
      导入第一份记录 <span aria-hidden="true">↗</span>
    </RouterLink>
    <RouterLink
      class="outline-link"
      to="/accounts"
    >
      连接米游社 <span aria-hidden="true">↗</span>
    </RouterLink>
  </section>
</template>
