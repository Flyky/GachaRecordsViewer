<script setup lang="ts">
import { NButton, NTag } from 'naive-ui';
import { RouterLink } from 'vue-router';
import type { CheckinJob } from '@gacha/contracts';
import { operationLabel, operationMessage, useOperation } from '../operations.js';
const { job, busy, loading, error, running, load, start, cancel } = useOperation<CheckinJob>('/api/community/checkin');
const games = { hk4e_cn: '原神', hkrpg_cn: '星穹铁道', nap_cn: '绝区零' };
const resultLabel = (status: string) => ({ pending: '等待处理', signed: '签到成功', already_signed: '今日已签到', no_roles: '未绑定支持的游戏', failed: '未完成', verification_required: '需要安全验证' } as Record<string, string>)[status] ?? status;
</script>
<template>
  <section class="page-heading">
    <p class="eyebrow">
      MIYOUSHE UTILITIES
    </p><h1>米游社功能</h1><p class="muted">
      统一处理已添加的米游社账号，不受侧边栏当前游戏档案限制。
    </p>
  </section>
  <section class="surface account-form">
    <h2>游戏每日签到</h2><p class="muted">
      一键检查所有已添加米游社账号下的国服原神、星穹铁道、绝区零角色，未签到的逐个签到；官服和渠道服分别处理。
    </p>
    <p class="field-hint">
      需要 Cookie Token 或能换取它的 SToken。首次绑定和安全验证需先在米游社 App 手动处理；不会自动或定时执行。
    </p>
    <div class="button-row">
      <NButton
        type="primary"
        :loading="busy"
        :disabled="busy || loading || running"
        @click="start({})"
      >
        一键签到全部账号
      </NButton><NButton
        :disabled="busy || loading"
        :loading="loading"
        @click="load"
      >
        刷新状态
      </NButton><NButton
        v-if="running"
        :disabled="busy"
        @click="cancel"
      >
        取消任务
      </NButton><RouterLink
        class="outline-link"
        to="/accounts"
      >
        管理米游社账号
      </RouterLink>
    </div>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <div
      v-if="job"
      class="sync-result"
      aria-live="polite"
    >
      <h3>{{ operationLabel(job.status) }} · 已处理 {{ job.accountsCompleted }} / {{ job.accountsTotal }} 个米游社账号</h3><p
        v-if="job.code"
        class="feedback"
      >
        {{ operationMessage(job.code) }}
      </p>
      <div class="sync-pool-results">
        <article
          v-for="(result, index) in job.results"
          :key="`${job.id}:${index}`"
          class="sync-pool-result"
        >
          <div class="list-heading">
            <strong>{{ result.game ? games[result.game] : '米游社账号' }}</strong><NTag
              size="small"
              :bordered="false"
              :type="['signed', 'already_signed'].includes(result.status) ? 'success' : result.status === 'pending' || result.status === 'no_roles' ? 'default' : 'warning'"
            >
              {{ resultLabel(result.status) }}
            </NTag>
          </div>
          <p>米游社 {{ result.accountId }}</p><p v-if="result.uid">
            {{ result.nickname || '游戏角色' }} · UID {{ result.uid }}<br>{{ result.region }}
          </p><p
            v-if="result.code"
            class="field-hint"
          >
            {{ operationMessage(result.code) }}
          </p>
        </article>
      </div>
      <p
        v-if="running"
        class="field-hint"
      >
        正在逐个处理，可离开页面后回来查看；取消不会撤销已完成的签到。
      </p>
    </div>
    <p class="data-footnote">
      服务重启后不保留任务状态。重复执行会先检查官方签到状态，已签到的角色不会再次提交。
    </p>
  </section>
</template>
