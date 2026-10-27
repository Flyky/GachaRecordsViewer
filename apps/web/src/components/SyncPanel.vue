<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { NButton } from 'naive-ui';
import { RouterLink } from 'vue-router';
import type { GameProfileSummary, SyncJob, SyncJobResponse, SyncJobsResponse, SyncPool } from '@gacha/contracts';
import { ApiError, userRequest } from '../auth.js';
import { communityError, displayTime, jobActive, jobLabel } from '../community.js';
import { refreshProfiles, regionLabel } from '../profiles.js';
import { poolLabel } from '../records.js';
const props = defineProps<{ profile: GameProfileSummary; canSync: boolean }>();
const pools = ref<SyncPool[]>(['100', '200', '301', '302', '500']), mode = ref<'incremental' | 'full'>('incremental');
const allPools: SyncPool[] = ['100', '200', '301', '302', '500'];
const jobs = shallowRef<SyncJob[]>([]), selectedId = ref(''), loading = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const current = computed(() => jobs.value.find((job) => job.id === selectedId.value) ?? null), hasActive = computed(() => jobs.value.some(jobActive));
const totals = computed(() => current.value?.pools.reduce((sum, pool) => ({ fetched: sum.fetched + pool.fetched, inserted: sum.inserted + pool.inserted, duplicates: sum.duplicates + pool.duplicates, enriched: sum.enriched + pool.enriched }), { fetched: 0, inserted: 0, duplicates: 0, enriched: 0 }));
const done = computed(() => current.value?.pools.filter((pool) => pool.status === 'completed').length ?? 0);
let active = true, generation = 0, readRevision = 0, timer: ReturnType<typeof setTimeout> | undefined;
const refreshed = new Set<string>();
function schedule() {
  globalThis.clearTimeout(timer); if (active && !document.hidden && hasActive.value && !error.value) timer = setTimeout(() => void load(false), 2500);
}
async function load(manual = true) {
  const revision = generation, read = ++readRevision; loading.value = true;
  if (manual) error.value = '';
  try {
    const data = await userRequest<SyncJobsResponse>(`/api/sync/jobs?profileId=${encodeURIComponent(props.profile.id)}`);
    if (!active || revision !== generation || read !== readRevision) return;
    jobs.value = data.jobs; if (!jobs.value.some((job) => job.id === selectedId.value)) selectedId.value = jobs.value[0]?.id ?? '';
    error.value = '';
    if (data.jobs.some((job) => !jobActive(job) && !refreshed.has(job.id))) {
      for (const job of data.jobs) if (!jobActive(job)) refreshed.add(job.id);
      void refreshProfiles();
    }
  } catch (cause) { if (active && revision === generation && read === readRevision) error.value = `进度暂时无法更新，任务可能仍在运行。${communityError(cause)}`; }
  finally { if (active && revision === generation && read === readRevision) { loading.value = false; schedule(); } }
}
async function mutate(action: 'create' | 'retry' | 'cancel') {
  if (busy.value || action !== 'cancel' && (!props.canSync || !!error.value) || action === 'create' && (!pools.value.length || hasActive.value)) return;
  const job = current.value, revision = generation; busy.value = true; error.value = ''; notice.value = ''; globalThis.clearTimeout(timer); readRevision++; loading.value = false;
  try {
    const path = action === 'create' ? `/api/profiles/${encodeURIComponent(props.profile.id)}/sync` : `/api/sync/jobs/${encodeURIComponent(job!.id)}/${action}`;
    const result = await userRequest<SyncJobResponse>(path, action === 'create' ? { pools: [...pools.value], mode: mode.value } : {});
    if (!active || revision !== generation) return;
    jobs.value = [result.job, ...jobs.value.filter((entry) => entry.id !== result.job.id)].slice(0, 20); selectedId.value = result.job.id;
    notice.value = action === 'cancel' ? '已更新任务状态，已保存记录保留。' : action === 'retry' ? '已创建重试任务，仅重试原任务未完成的卡池。' : '任务已加入队列，可以离开页面，稍后回来查看。';
    await load(false);
  } catch (cause) {
    if (!active || revision !== generation) return;
    error.value = cause instanceof ApiError && cause.code === 'NETWORK_ERROR'
      ? '未能确认操作结果，任务可能已经创建或取消。请先更新任务列表，不要重复提交。' : communityError(cause);
    if (cause instanceof ApiError && cause.code === 'SYNC_ALREADY_ACTIVE') await load();
  } finally { if (active && revision === generation) { busy.value = false; schedule(); } }
}
function visibility() { if (document.hidden) globalThis.clearTimeout(timer); else void load(); }
function showActive() { const job = jobs.value.find(jobActive); if (job) selectedId.value = job.id; }
watch(() => props.profile.id, () => {
  generation++; readRevision++; jobs.value = []; selectedId.value = ''; error.value = ''; notice.value = ''; busy.value = false; refreshed.clear();
  pools.value = [...allPools]; mode.value = 'incremental'; globalThis.clearTimeout(timer); void load();
}, { immediate: true });
onMounted(() => document.addEventListener('visibilitychange', visibility));
onUnmounted(() => { active = false; generation++; readRevision++; globalThis.clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); });
</script>

<template>
  <section
    class="surface account-form sync-panel"
    aria-label="在线刷新记录"
  >
    <div class="list-heading">
      <div>
        <h2>在线刷新记录</h2><p class="muted">
          UID {{ profile.uid }} · {{ regionLabel(profile.region) }}
        </p>
      </div><NButton
        size="small"
        :loading="loading"
        :disabled="busy || loading"
        @click="load()"
      >
        更新任务列表
      </NButton>
    </div>
    <p
      v-if="profile.region !== 'cn_gf01'"
      class="feedback"
    >
      该服务器的在线拉取尚未实测，请以实际任务结果为准；也可使用 UIGF 导入。
    </p>
    <p
      v-if="!canSync"
      class="feedback"
    >
      当前账号缺少已校验的 SToken 或需要更新授权。请在上方扫码或补充凭证；既有任务和历史仍可查看。
    </p>
    <form
      class="sync-form"
      @submit.prevent="mutate('create')"
    >
      <fieldset :disabled="busy || hasActive">
        <legend>选择卡池</legend><div class="sync-pools">
          <label
            v-for="pool in allPools"
            :key="pool"
          ><input
            v-model="pools"
            type="checkbox"
            :value="pool"
          >{{ poolLabel(pool) }}</label>
        </div>
      </fieldset>
      <fieldset :disabled="busy || hasActive">
        <legend>刷新方式</legend><div class="button-row">
          <label><input
            v-model="mode"
            type="radio"
            value="incremental"
          >增量刷新</label><label><input
            v-model="mode"
            type="radio"
            value="full"
          >完整重扫当前窗口</label>
        </div>
      </fieldset>
      <p class="field-hint">
        首次自动拉取上游当前可查询范围，以后增量获取新记录。完整重扫用于重新核对当前窗口；不会删除本地更早历史。千星奇域不在范围内。
      </p>
      <NButton
        attr-type="submit"
        type="primary"
        :loading="busy"
        :disabled="busy || hasActive || loading || !pools.length || !canSync || !!error"
      >
        {{ hasActive ? '此 UID 已有刷新任务' : '开始刷新记录' }}
      </NButton>
      <NButton
        v-if="hasActive"
        @click="showActive"
      >
        查看运行中任务
      </NButton>
    </form>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p><p
      v-if="notice"
      class="feedback success"
      role="status"
    >
      {{ notice }}
    </p>
    <div
      v-if="jobs.length"
      class="sync-result"
    >
      <label
        class="field"
        for="sync-job"
      >最近任务（最多 20 个）</label><select
        id="sync-job"
        v-model="selectedId"
        class="native-input"
      >
        <option
          v-for="job in jobs"
          :key="job.id"
          :value="job.id"
        >
          {{ displayTime(job.createdAt) }} · {{ jobLabel(job.status) }}
        </option>
      </select>
      <template v-if="current">
        <div class="list-heading">
          <strong role="status">{{ jobLabel(current.status) }} · 完成卡池 {{ done }} / {{ current.pools.length }}</strong><span class="field-hint">更新于 {{ displayTime(current.updatedAt) }}</span>
        </div>
        <progress
          :value="done"
          :max="current.pools.length"
          aria-label="已完成卡池数"
        />
        <p
          v-if="totals"
          class="sync-totals"
        >
          已读取 {{ totals.fetched }} 条 · 新增 {{ totals.inserted }} 条 · 重复 {{ totals.duplicates }} 条 · 补全 {{ totals.enriched }} 条
        </p>
        <p
          v-if="current.failureCode"
          class="feedback"
          :class="{ error: current.status === 'failed' || current.status === 'partial' }"
        >
          {{ communityError(current.failureCode) }}
        </p>
        <div class="sync-pool-results">
          <article
            v-for="pool in current.pools"
            :key="pool.pool"
            class="sync-pool-result"
            :aria-label="`${poolLabel(pool.pool)}进度`"
          >
            <div class="list-heading">
              <strong>{{ poolLabel(pool.pool) }}</strong><span>{{ !jobActive(current) && ['queued', 'running', 'retrying'].includes(pool.status) ? jobLabel(current.status) : jobLabel(pool.status) }}</span>
            </div>
            <p>成功请求 {{ pool.pages }} 页 · 读取 {{ pool.fetched }} 条</p><p>新增 {{ pool.inserted }} · 重复 {{ pool.duplicates }} · 补全 {{ pool.enriched }}</p>
            <p
              v-if="pool.retries || pool.authKeyRenewals"
              class="field-hint"
            >
              请求重试 {{ pool.retries }} 次 · 临时授权更新 {{ pool.authKeyRenewals }} 次
            </p>
            <p
              v-if="pool.code"
              class="feedback error"
            >
              {{ communityError(pool.code) }}
            </p><p
              v-else-if="pool.stopReason"
              class="field-hint"
            >
              {{ pool.stopReason === 'checkpoint' ? '已核对至上次成功记录' : '已到达上游当前可提供范围末尾' }}
            </p>
          </article>
        </div>
        <div class="button-row">
          <NButton
            v-if="jobActive(current)"
            :disabled="busy"
            @click="mutate('cancel')"
          >
            取消当前任务
          </NButton><NButton
            v-else-if="['partial', 'failed', 'cancelled', 'interrupted'].includes(current.status)"
            :disabled="busy || hasActive || !canSync || !!error"
            @click="mutate('retry')"
          >
            重试未完成卡池
          </NButton><RouterLink
            class="outline-link"
            to="/records"
          >
            查看记录
          </RouterLink><RouterLink
            class="outline-link"
            to="/data"
          >
            导出 UIGF
          </RouterLink>
        </div>
        <p class="field-hint">
          完成表示已核对所选卡池的当前窗口或增量检查点，不代表账号从开服开始的完整历史。较早记录可从 UIGF 合并补齐。
        </p>
      </template>
    </div>
    <p
      v-else-if="!loading && !error"
      class="muted"
    >
      这个 UID 还没有刷新任务。
    </p>
  </section>
</template>
