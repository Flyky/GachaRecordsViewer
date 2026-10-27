<script setup lang="ts">
import type { ImportProfileReport } from '@gacha/contracts';
import { blockerLabel, conflictFieldLabel } from '../uigf.js';
import { timezoneLabel } from '../profiles.js';
defineProps<{ report: ImportProfileReport; selectable?: boolean; selected?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ toggle: [index: number] }>();
</script>

<template>
  <article
    class="import-profile"
    :class="{ 'has-conflict': report.conflicts || report.blockers.length, selected }"
  >
    <div class="list-heading">
      <label class="import-profile-title">
        <input
          v-if="selectable"
          type="checkbox"
          :checked="selected"
          :disabled="disabled || !!report.conflicts || !!report.blockers.length"
          :aria-label="`选择 UID ${report.uid}`"
          @change="emit('toggle', report.index)"
        >
        <strong>UID {{ report.uid }}</strong>
      </label>
      <span class="status-badge">{{ report.conflicts || report.blockers.length ? '需处理冲突' : report.targetProfileId ? '已有档案' : '新建档案' }}</span>
    </div>
    <p class="profile-caption">
      {{ timezoneLabel(report.timezone) }} · {{ report.lang ?? '未声明语言' }} · 文件内 {{ report.total.toLocaleString() }} 条
    </p>
    <dl class="import-counts">
      <div><dt>新增</dt><dd>{{ report.inserted.toLocaleString() }}</dd></div>
      <div><dt>重复</dt><dd>{{ report.duplicates.toLocaleString() }}</dd></div>
      <div><dt>补全元数据</dt><dd>{{ report.enriched.toLocaleString() }}</dd></div>
    </dl>
    <p class="record-range">
      {{ report.firstTime ? `${report.firstTime} → ${report.lastTime}` : '空档案：没有抽卡记录' }}
    </p>
    <p
      v-if="report.metadataIncomplete || report.metadataConflicts || report.metadataWarnings"
      class="metadata-notice"
    >
      本次文件：元数据不完整 {{ report.metadataIncomplete }} 条，元数据冲突 {{ report.metadataConflicts }} 条，保留原值／语言差异提示 {{ report.metadataWarnings }} 条。原始记录仍会保留。
    </p>
    <p
      v-for="blocker in report.blockers"
      :key="blocker"
      class="conflict-notice"
    >
      {{ blockerLabel(blocker) }}
    </p>
    <details
      v-if="report.conflicts"
      class="conflict-details"
    >
      <summary>{{ report.conflicts }} 条关键字段冲突，查看详情</summary>
      <ul>
        <li
          v-for="(conflict, index) in report.conflictDetails"
          :key="index"
        >
          记录 {{ conflict.id }}：{{ conflict.fields.map(conflictFieldLabel).join('、') }}
        </li>
      </ul>
      <p v-if="report.conflicts > report.conflictDetails.length">
        仅展示前 {{ report.conflictDetails.length }} 条冲突。
      </p>
    </details>
  </article>
</template>
