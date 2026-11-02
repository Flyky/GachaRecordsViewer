<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { NButton, NSlider, NSwitch } from 'naive-ui';
import { AUTO_CHECKIN_MIN_MINUTE, AUTO_CHECKIN_MAX_MINUTE, AUTO_CHECKIN_STEP_MINUTE, type AutoCheckinSettings } from '@gacha/contracts';
import { userRequest } from '../auth.js';
import { operationLabel, operationMessage } from '../operations.js';

const state = shallowRef<AutoCheckinSettings | null>(null), range = ref<[number, number]>([90, 1350]);
const busy = ref(false), loading = ref(false), error = ref(''), notice = ref('');
const changed = computed(() => state.value && (range.value[0] !== state.value.startMinute || range.value[1] !== state.value.endMinute));
const formatMinute = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const statusLabel = (value: string) => value === 'skipped' ? '错过时间范围，已跳过' : value === 'interrupted' ? '服务重启，任务中断' : operationLabel(value);
function changeRange(value: number | [number, number]) {
  if (!Array.isArray(value)) return;
  const end = Math.max(AUTO_CHECKIN_MIN_MINUTE + AUTO_CHECKIN_STEP_MINUTE, value[1]);
  range.value = [Math.min(value[0], end - AUTO_CHECKIN_STEP_MINUTE), end];
}
let active = true, epoch = 0, timer: ReturnType<typeof setTimeout> | undefined;
function schedule() {
  if (timer) globalThis.clearTimeout(timer);
  if (active && !globalThis.document.hidden) timer = setTimeout(() => { void load(); }, 30000);
}
async function load() {
  if (busy.value || loading.value) { schedule(); return; }
  loading.value = true; const current = ++epoch;
  try {
    const result = await userRequest<AutoCheckinSettings>('/api/community/checkin/automatic');
    if (!active || epoch !== current) return;
    if (!changed.value) range.value = [result.startMinute, result.endMinute];
    state.value = result; error.value = '';
  } catch (cause) { if (active && epoch === current) error.value = operationMessage(cause); }
  finally { if (active && epoch === current) { loading.value = false; schedule(); } }
}
async function save(enabled: boolean) {
  if (busy.value || loading.value || !state.value) return;
  busy.value = true; error.value = ''; notice.value = ''; const current = ++epoch;
  try {
    const result = await userRequest<AutoCheckinSettings>('/api/community/checkin/automatic', { enabled, startMinute: range.value[0], endMinute: range.value[1] });
    if (!active || epoch !== current) return;
    state.value = result; range.value = [result.startMinute, result.endMinute];
    notice.value = result.enabled ? '自动签到已开启，时间范围已保存。' : '自动签到已关闭，时间范围已保存。';
  } catch (cause) { if (active && epoch === current) error.value = operationMessage(cause); }
  finally { if (active && epoch === current) { busy.value = false; schedule(); } }
}
function visibility() { if (globalThis.document.hidden) { if (timer) globalThis.clearTimeout(timer); } else void load(); }
onMounted(() => { void load(); globalThis.document.addEventListener('visibilitychange', visibility); });
onUnmounted(() => { active = false; epoch++; if (timer) globalThis.clearTimeout(timer); globalThis.document.removeEventListener('visibilitychange', visibility); });
</script>
<template>
  <div class="auto-checkin">
    <div class="list-heading">
      <h3>每日自动签到</h3>
      <NSwitch
        :value="state?.enabled ?? false"
        :disabled="!state || busy || loading"
        :loading="busy"
        aria-label="开启或关闭每日自动签到"
        @update:value="save"
      >
        <template #checked>
          已开启
        </template><template #unchecked>
          已关闭
        </template>
      </NSwitch>
    </div>
    <p class="field-hint">
      北京时间 · 每天在选定范围内随机一个时间发起签到任务，覆盖本用户所有已添加的米游社账号，无需保持网页打开。服务器需要持续运行。
    </p>
    <label class="range-label">随机签到范围：{{ formatMinute(range[0]) }} ～ {{ formatMinute(range[1]) }}<span v-if="changed">（尚未保存）</span></label>
    <NSlider
      :value="range"
      range
      :min="AUTO_CHECKIN_MIN_MINUTE"
      :max="AUTO_CHECKIN_MAX_MINUTE"
      :step="AUTO_CHECKIN_STEP_MINUTE"
      :format-tooltip="formatMinute"
      :disabled="!state || busy || loading"
      aria-label="每日自动签到时间范围"
      @update:value="changeRange"
    />
    <div class="range-limits">
      <span>01:30</span><span>22:30</span>
    </div>
    <p class="field-hint">
      拖动两个滑块缩小范围，每步 10 分钟，范围至少 10 分钟；调整后点击保存，或切换开关一并保存。
    </p>
    <div class="button-row">
      <NButton
        :disabled="!state || busy || loading || !changed"
        :loading="busy"
        @click="save(state?.enabled ?? false)"
      >
        保存时间范围
      </NButton>
      <NButton
        :disabled="busy || loading"
        :loading="loading"
        @click="load"
      >
        刷新自动签到状态
      </NButton>
    </div>
    <p
      v-if="state?.enabled && state.nextRunAt"
      class="field-hint"
    >
      下次自动签到：{{ formatTime(state.nextRunAt) }}（北京时间）
    </p>
    <p
      v-else-if="state"
      class="field-hint"
    >
      当前已关闭，不会自动执行；仍可使用一键签到。
    </p>
    <div
      v-if="state?.lastRun"
      class="field-hint"
      role="status"
    >
      <p>最近自动签到：{{ state.lastRun.day }} · {{ statusLabel(state.lastRun.status) }}<br>成功 {{ state.lastRun.signed }} · 已签到 {{ state.lastRun.alreadySigned }} · 未完成 {{ state.lastRun.failed }}</p>
      <p v-if="state.lastRun.code">
        {{ operationMessage(state.lastRun.code) }}
      </p>
    </div>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="feedback success"
      role="status"
    >
      {{ notice }}
    </p>
  </div>
</template>
<style scoped>
.auto-checkin { margin-top: 24px; padding-top: 20px; border-top: 1px solid #e0e4db; }
.range-label { display: block; font-size: 13px; margin: 18px 0 12px; }
.range-limits { display: flex; justify-content: space-between; font-size: 12px; color: #73806b; margin: 5px 0 16px; }
</style>
