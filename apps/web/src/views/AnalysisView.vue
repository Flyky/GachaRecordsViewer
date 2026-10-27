<script setup lang="ts">
import { onUnmounted, ref, shallowRef, watch } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import { RouterLink } from 'vue-router';
import type { DailyAnalysisResponse, ItemAnalysisResponse, MonthlyAnalysisResponse, RecordPool } from '@gacha/contracts';
import { ApiError, errorMessage, userRequest } from '../auth.js';
import { currentProfile, profilesLoading, profilesError, timezoneLabel } from '../profiles.js';
import { consistentAnalysis, itemIssueLabel, type AnalysisBundle } from '../analysis.js';
import { poolOptions } from '../records.js';
import MonthlyChart from '../components/MonthlyChart.vue';
import DailyCalendar from '../components/DailyCalendar.vue';

const bundle = shallowRef<AnalysisBundle | null>(null), busy = ref(false), error = ref('');
const itemType = ref<'character' | 'weapon'>('character'), order = ref<'asc' | 'desc'>('desc');
const year = ref<number | null>(null), pool = ref<RecordPool | null>(null), availableYears = ref<number[]>([]);
let generation = 0, active = true;
onUnmounted(() => { active = false; generation++; });
async function load() {
  const profile = currentProfile.value;
  if (!profile) return;
  const requestGeneration = ++generation;
  const params = new globalThis.URLSearchParams();
  if (year.value !== null) params.set('year', String(year.value));
  if (pool.value) params.set('pool', pool.value);
  const itemQuery = `itemType=${itemType.value}&order=${order.value}`;
  busy.value = true; error.value = '';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const prefix = `/api/profiles/${encodeURIComponent(profile.id)}/analysis`;
      const [items, monthly, daily] = await Promise.all([
        userRequest<ItemAnalysisResponse>(`${prefix}/items?${itemQuery}`, undefined, 60000),
        userRequest<MonthlyAnalysisResponse>(`${prefix}/monthly`, undefined, 60000),
        userRequest<DailyAnalysisResponse>(`${prefix}/daily?${params}`, undefined, 60000),
      ]);
      if (!active || requestGeneration !== generation) return;
      if (!consistentAnalysis(profile.id, [items, monthly, daily])) continue;
      bundle.value = { items, monthly, daily }; year.value = daily.year; availableYears.value = daily.availableYears; return;
    }
    throw new ApiError('ANALYSIS_CHANGED');
  } catch (cause) {
    if (!active || requestGeneration !== generation) return;
    bundle.value = null;
    error.value = cause instanceof ApiError && cause.code === 'ANALYSIS_CHANGED' ? '档案正在变化，暂时无法取得一致的统计。请稍后重新加载。'
      : cause instanceof ApiError && cause.code === 'PROFILE_NOT_FOUND' ? '档案不存在或不可访问，请刷新档案列表。' : errorMessage(cause);
  } finally { if (active && requestGeneration === generation) busy.value = false; }
}
function changeType(value: 'character' | 'weapon') { itemType.value = value; void load(); }
function changeOrder(value: 'asc' | 'desc') { order.value = value; void load(); }
function changeYear(value: number) { year.value = value; void load(); }
function changePool(value: RecordPool | null) { pool.value = value; void load(); }
watch(() => [currentProfile.value?.id, currentProfile.value?.dataVersion] as const, (value, previous) => {
  if (value[0] === previous?.[0] && value[1] === previous?.[1]) return;
  generation++; bundle.value = null; error.value = ''; busy.value = false;
  if (value[0] !== previous?.[0]) { itemType.value = 'character'; order.value = 'desc'; year.value = null; pool.value = null; availableYears.value = []; }
  if (value[0]) void load();
}, { immediate: true, flush: 'sync' });
</script>

<template>
  <section class="page-heading analysis-heading">
    <div>
      <p class="eyebrow">
        WISH INSIGHTS
      </p><h1>统计分析</h1>
      <p class="muted">
        {{ currentProfile ? `UID ${currentProfile.uid} · ${timezoneLabel(currentProfile.timezone)} · 当前档案完整记录` : '从每一份记录中，看见旅途的积累。' }}
      </p>
    </div>
    <NButton
      v-if="currentProfile"
      :loading="busy"
      :disabled="busy"
      @click="load"
    >
      刷新统计
    </NButton>
  </section>
  <template v-if="currentProfile">
    <p
      v-if="busy"
      class="feedback analysis-feedback"
      role="status"
    >
      正在更新统计…
    </p>
    <p
      v-if="error"
      class="feedback error analysis-feedback"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="bundle?.items.metadataIssues.incompleteRecords"
      class="feedback analysis-feedback"
    >
      全档案 {{ bundle.items.metadataIssues.incompleteRecords }} 条记录的元数据不完整或矛盾，其中 {{ bundle.items.metadataIssues.unknownRankRecords }} 条无法确定星级；原始记录仍保留。
    </p>
    <div
      class="analysis-stack"
      :class="{ 'analysis-pending': busy }"
      :aria-busy="busy"
    >
      <section
        class="surface analysis-section"
        aria-labelledby="item-analysis-title"
      >
        <div class="analysis-section-heading">
          <div>
            <h2 id="item-analysis-title">
              物品分组统计
            </h2><p class="muted">
              按物品 ID 合并，统计已保存记录中的获得数量。
            </p>
          </div>
          <div class="analysis-controls">
            <div
              class="item-type-toggle"
              aria-label="统计物品类型"
            >
              <NButton
                :type="itemType === 'character' ? 'primary' : 'default'"
                :aria-pressed="itemType === 'character'"
                :disabled="busy"
                @click="changeType('character')"
              >
                角色
              </NButton><NButton
                :type="itemType === 'weapon' ? 'primary' : 'default'"
                :aria-pressed="itemType === 'weapon'"
                :disabled="busy"
                @click="changeType('weapon')"
              >
                武器
              </NButton>
            </div>
            <div class="analysis-select">
              <label for="item-sort">数量排序</label><NSelect
                id="item-sort"
                :value="order"
                :options="[{ label: '数量从多到少', value: 'desc' }, { label: '数量从少到多', value: 'asc' }]"
                :disabled="busy"
                aria-label="物品数量排序"
                @update:value="changeOrder"
              />
            </div>
          </div>
        </div>
        <template v-if="bundle">
          <p class="field-hint">
            当前{{ bundle.items.itemType === 'character' ? '角色' : '武器' }}已归类 {{ bundle.items.selectedTypeCount.toLocaleString() }} 条 · 全档案 {{ bundle.items.historyCount.toLocaleString() }} 条
          </p>
          <div
            class="item-stat-grid"
            :class="{ weapons: bundle.items.itemType === 'weapon' }"
          >
            <article
              v-for="group in bundle.items.groups"
              :key="group.rank"
              class="item-stat-column"
              :aria-label="`${group.rank} 星${bundle.items.itemType === 'character' ? '角色' : '武器'}`"
            >
              <h3 :class="`rarity-${group.rank}`">
                {{ group.rank }} 星 <small>{{ group.total.toLocaleString() }} 次</small>
              </h3>
              <ul
                v-if="group.items.length"
                tabindex="0"
                :aria-label="`${group.rank} 星物品列表，可滚动查看更多`"
              >
                <li
                  v-for="item in group.items"
                  :key="item.itemId"
                >
                  <span
                    :class="`rarity-${group.rank}`"
                    :title="`物品 ID：${item.itemId}`"
                  >{{ item.name ?? `未知名称 #${item.itemId}` }}</span><strong>× {{ item.quantity.toLocaleString() }}</strong>
                </li>
              </ul>
              <p
                v-else
                class="analysis-empty"
              >
                暂无此星级记录
              </p>
            </article>
          </div>
          <details
            v-if="bundle.items.unclassified.total"
            class="unclassified-details"
          >
            <summary>全档案 {{ bundle.items.unclassified.total.toLocaleString() }} 条记录暂未归类，查看详情</summary>
            <ul>
              <li
                v-for="item in bundle.items.unclassified.items"
                :key="item.itemId"
              >
                <strong>{{ item.name ?? `未知物品 #${item.itemId}` }} × {{ item.quantity }}</strong><span>物品 ID {{ item.itemId }} · {{ item.reasons.map(itemIssueLabel).join('、') }}</span>
              </li>
            </ul>
          </details>
        </template>
      </section>
      <section
        class="surface analysis-section"
        aria-labelledby="monthly-analysis-title"
      >
        <div class="analysis-section-heading">
          <div>
            <h2 id="monthly-analysis-title">
              年月统计
            </h2><p class="muted">
              完整时间范围，缺少记录的月份补 0。总抽数包含新手和集录祈愿。
            </p>
          </div>
        </div>
        <template v-if="bundle">
          <p
            v-if="bundle.monthly.fiveStarCountsIncomplete"
            class="metadata-notice"
          >
            存在 {{ bundle.monthly.metadataIssues.unknownRankRecords }} 条未知或矛盾星级记录，五星数仅代表可以确认的部分。
          </p>
          <MonthlyChart
            v-if="bundle.monthly.months.length"
            :data="bundle.monthly"
          />
          <p
            v-else
            class="analysis-empty"
          >
            还没有月度记录，导入后即可查看趋势。
          </p>
        </template>
      </section>
      <section
        class="surface analysis-section"
        aria-labelledby="daily-analysis-title"
      >
        <div class="analysis-section-heading">
          <div>
            <h2 id="daily-analysis-title">
              Daily 分析
            </h2><p class="muted">
              按游戏时区查看每一天的抽卡次数。
            </p>
          </div>
          <div class="analysis-controls">
            <div class="analysis-select year-select">
              <label for="analysis-year">年份</label><NSelect
                id="analysis-year"
                :value="year"
                :options="availableYears.map((value) => ({ label: `${value} 年`, value }))"
                :disabled="busy || !availableYears.length"
                aria-label="日历年份"
                @update:value="changeYear"
              />
            </div>
            <div class="analysis-select">
              <label for="analysis-pool">卡池类型</label><NSelect
                id="analysis-pool"
                :value="pool"
                clearable
                :options="poolOptions"
                :disabled="busy"
                placeholder="全部卡池"
                aria-label="日历卡池类型"
                @update:value="changePool"
              />
            </div>
          </div>
        </div>
        <DailyCalendar
          v-if="bundle"
          :data="bundle.daily"
        />
        <p class="field-hint">
          默认年份按 Asia/Shanghai 当前日期选择；年月／日的记录归属使用游戏时区。当前选择只影响 Daily 分析。
        </p>
      </section>
    </div>
    <p
      v-if="bundle"
      class="data-footnote analysis-version"
    >
      已保存 {{ bundle.items.historyCount.toLocaleString() }} 条记录 · 数据版本 {{ bundle.items.dataVersion }} · 查询页筛选不会影响统计
    </p>
  </template>
  <p
    v-else-if="profilesLoading"
    class="muted"
    role="status"
  >
    正在加载档案…
  </p>
  <section
    v-else-if="!profilesError"
    class="empty-archive"
  >
    <h2>先建立一份祈愿档案</h2><p class="muted">
      导入 UIGF 后即可查看统计分析。
    </p><RouterLink
      class="outline-link"
      to="/data"
    >
      前往数据管理
    </RouterLink>
  </section>
</template>
