<script setup lang="ts">
import { computed, h, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import { NButton, NDataTable, NSelect, type DataTableColumns } from 'naive-ui';
import { RouterLink } from 'vue-router';
import { RECORD_PAGE_SIZES, type RecordFilters, type RecordListItem, type RecordPageResponse, type RecordPool } from '@gacha/contracts';
import { ApiError, errorMessage, userRequest } from '../auth.js';
import { currentProfile, profilesLoading, profilesError, timezoneLabel } from '../profiles.js';
import { gameTimeInput, itemTypeOptions, orderOptions, poolLabel, poolOptions, rankOptions, recentRange, recordQueryString } from '../records.js';

function initialDraft() { return { from: '', to: '', pools: [] as RecordPool[], itemTypes: [] as ('character' | 'weapon')[], ranks: [] as (3 | 4 | 5)[], name: '', order: 'desc' as 'asc' | 'desc' }; }
const draft = reactive(initialDraft()), applied = shallowRef<RecordFilters>({});
const response = shallowRef<RecordPageResponse | null>(null), busy = ref(false), error = ref('');
const page = ref(1), pageSize = ref<20 | 50 | 100 | 200>(20), jumpPage = ref(1), showTotal = ref(true), showPity = ref(true);
let generation = 0, active = true;
onUnmounted(() => { active = false; generation++; });
function filters(): RecordFilters {
  return { ...(draft.from ? { from: gameTimeInput(draft.from) } : {}), ...(draft.to ? { to: gameTimeInput(draft.to) } : {}),
    pools: [...draft.pools], itemTypes: [...draft.itemTypes], ranks: [...draft.ranks], name: draft.name.trim(), order: draft.order };
}
const dirty = computed(() => JSON.stringify(filters()) !== JSON.stringify(applied.value));
async function load(requestedPage = 1) {
  const profile = currentProfile.value;
  if (!profile) return;
  const requestGeneration = ++generation;
  busy.value = true; error.value = ''; response.value = null;
  try {
    const data = await userRequest<RecordPageResponse>(`/api/profiles/${encodeURIComponent(profile.id)}/records?${recordQueryString({ ...applied.value, page: requestedPage, pageSize: pageSize.value })}`, undefined, 60000);
    if (!active || requestGeneration !== generation) return;
    response.value = data; page.value = data.page; jumpPage.value = data.page;
  } catch (cause) {
    if (!active || requestGeneration !== generation) return;
    error.value = cause instanceof ApiError && ['INVALID_RECORD_QUERY', 'INVALID_REQUEST'].includes(cause.code)
      ? '查询条件不合法，请检查起止时间、筛选项和页码。'
      : cause instanceof ApiError && cause.code === 'PROFILE_NOT_FOUND' ? '档案不存在或不可访问，请刷新档案列表。' : errorMessage(cause);
  } finally { if (active && requestGeneration === generation) busy.value = false; }
}
function apply() {
  if (busy.value) return;
  const query = filters();
  if (query.from && query.to && query.from > query.to) { error.value = '开始时间不能晚于结束时间。'; return; }
  applied.value = query; page.value = 1; void load(1);
}
function reset() { Object.assign(draft, initialDraft()); apply(); }
function quickRange(kind: 'week' | 'month' | 'quarter') {
  if (!currentProfile.value) return;
  const range = recentRange(kind, currentProfile.value.timezone); draft.from = range[0]; draft.to = range[1];
}
function changePageSize(size: 20 | 50 | 100 | 200) { pageSize.value = size; page.value = 1; void load(1); }
function jump() { if (Number.isInteger(jumpPage.value) && jumpPage.value > 0) void load(jumpPage.value); }
watch(() => [currentProfile.value?.id, currentProfile.value?.dataVersion] as const, (value, previous) => {
  generation++; response.value = null; error.value = ''; busy.value = false; page.value = 1; jumpPage.value = 1;
  if (value[0] !== previous?.[0]) { Object.assign(draft, initialDraft()); pageSize.value = 20; applied.value = filters(); }
  if (value[0]) void load(1);
}, { immediate: true, flush: 'sync' });

const columns = computed<DataTableColumns<RecordListItem>>(() => {
  const list: DataTableColumns<RecordListItem> = [
    { title: '时间', key: 'time', width: 180, render: (row) => h('span', { title: `记录 ID：${row.id}` }, row.time) },
    { title: '物品名称', key: 'name', minWidth: 190, render: (row) => h('div', [
      h('span', { class: `item-name rarity-${row.rank ?? 'unknown'}`, title: `物品 ID：${row.itemId}` }, row.name ?? `未知物品 #${row.itemId}`),
      ...(row.metadataStatus === 'complete' ? [] : [h('small', { class: 'record-metadata-label' }, row.metadataStatus === 'conflict' ? '元数据冲突' : '元数据待补全')]),
    ]) },
    { title: '物品类型', key: 'itemType', width: 85, render: (row) => row.itemType === 'character' ? '角色' : row.itemType === 'weapon' ? '武器' : '未知' },
    { title: '星级', key: 'rank', width: 65, render: (row) => row.rank === null ? '未知' : `${row.rank} 星` },
    { title: '卡池类型', key: 'gachaType', width: 150, render: (row) => poolLabel(row.gachaType) },
  ];
  if (showTotal.value) list.push({ title: '总次数', key: 'groupOrdinal', width: 90, render: (row) => row.groupOrdinal.toLocaleString() });
  if (showPity.value) list.push({ title: '保底内次数', key: 'pity', width: 125, render: (row) => h('span', {
    class: row.pity.status === 'exact' ? '' : 'uncertain-pity',
    title: row.pity.status === 'unknown-rarity' ? '历史中存在未知或冲突星级，无法确定五星重置。'
      : row.pity.status === 'partial-history' ? '已知记录内次数，首段或缺口历史可能不完整。' : '自上个已知五星后的次数，五星后下一抽从 1 开始。',
  }, row.pity.count === null ? '不确定' : `${row.pity.status === 'partial-history' ? '≥ ' : ''}${row.pity.count}`) });
  return list;
});
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">
      WISH HISTORY
    </p><h1>查询记录</h1>
    <p class="muted">
      {{ currentProfile ? `UID ${currentProfile.uid} · ${timezoneLabel(currentProfile.timezone)} · 按游戏时区筛选时间` : '选择一个游戏档案，查看每一次祈愿。' }}
    </p>
  </section>
  <template v-if="currentProfile">
    <section
      class="surface records-filter"
      aria-label="记录筛选"
    >
      <form @submit.prevent="apply">
        <div class="record-filter-grid">
          <div class="field">
            <label for="record-from">开始时间</label><input
              id="record-from"
              v-model="draft.from"
              class="native-input"
              type="datetime-local"
              step="1"
              :disabled="busy"
            >
          </div>
          <div class="field">
            <label for="record-to">结束时间</label><input
              id="record-to"
              v-model="draft.to"
              class="native-input"
              type="datetime-local"
              step="1"
              :disabled="busy"
            >
          </div>
          <div class="field">
            <label for="record-pools">卡池类型</label><NSelect
              id="record-pools"
              v-model:value="draft.pools"
              multiple
              clearable
              :options="poolOptions"
              :disabled="busy"
              placeholder="全部卡池"
              aria-label="筛选卡池类型"
            />
          </div>
          <div class="field">
            <label for="record-types">物品类型</label><NSelect
              id="record-types"
              v-model:value="draft.itemTypes"
              multiple
              clearable
              :options="itemTypeOptions"
              :disabled="busy"
              placeholder="角色与武器"
              aria-label="筛选物品类型"
            />
          </div>
          <div class="field">
            <label for="record-ranks">稀有度</label><NSelect
              id="record-ranks"
              v-model:value="draft.ranks"
              multiple
              clearable
              :options="rankOptions"
              :disabled="busy"
              placeholder="全部星级（含未知）"
              aria-label="筛选稀有度"
            />
          </div>
          <div class="field">
            <label for="record-name">物品名称</label><input
              id="record-name"
              v-model="draft.name"
              class="native-input"
              type="search"
              maxlength="512"
              :disabled="busy"
              placeholder="名称包含…"
            >
          </div>
          <div class="field">
            <label for="record-order">时间顺序</label><NSelect
              id="record-order"
              v-model:value="draft.order"
              :options="orderOptions"
              :disabled="busy"
              aria-label="时间顺序"
            />
          </div>
        </div>
        <div class="record-filter-actions">
          <div
            class="date-shortcuts"
            aria-label="日期快捷筛选"
          >
            <NButton
              size="small"
              :disabled="busy"
              @click="quickRange('week')"
            >
              最近一周
            </NButton><NButton
              size="small"
              :disabled="busy"
              @click="quickRange('month')"
            >
              最近一月
            </NButton><NButton
              size="small"
              :disabled="busy"
              @click="quickRange('quarter')"
            >
              最近三月
            </NButton>
          </div>
          <div class="record-submit">
            <NButton
              :disabled="busy"
              @click="reset"
            >
              重置筛选
            </NButton><NButton
              attr-type="submit"
              type="primary"
              :loading="busy"
              :disabled="busy"
            >
              查询记录
            </NButton>
          </div>
        </div>
      </form>
      <p
        v-if="dirty"
        class="field-hint"
        role="status"
      >
        筛选条件已修改，点击「查询记录」后生效。
      </p>
    </section>
    <p
      v-if="error"
      class="feedback error records-error"
      role="alert"
    >
      {{ error }}
    </p>
    <section
      class="surface records-table-section"
      aria-label="查询结果"
    >
      <div class="record-results-heading">
        <h2>祈愿记录 <small>{{ response ? `匹配 ${response.total.toLocaleString()} 条 / 已保存 ${response.historyCount.toLocaleString()} 条` : busy ? '正在查询…' : '等待查询' }}</small></h2>
        <div class="record-display-options">
          <label><input
            v-model="showTotal"
            type="checkbox"
          >显示总次数（按卡池组）</label><label><input
            v-model="showPity"
            type="checkbox"
          >显示保底内次数</label>
        </div>
      </div>
      <NDataTable
        :columns="columns"
        :data="response?.records ?? []"
        :loading="busy"
        :row-key="(row: RecordListItem) => row.id"
        :scroll-x="showTotal && showPity ? 885 : 760"
        :bordered="false"
        size="small"
      >
        <template #empty>
          {{ busy ? '正在读取记录…' : error ? '查询未完成，请检查提示后重试。' : response?.historyCount === 0 ? '这个档案还没有抽卡记录。' : '没有符合条件的记录。' }}
        </template>
      </NDataTable>
      <div
        class="records-pagination"
        aria-label="记录分页"
      >
        <div class="page-size-control">
          <label for="record-page-size">每页条数</label><NSelect
            id="record-page-size"
            :value="pageSize"
            :options="RECORD_PAGE_SIZES.map((value) => ({ label: `${value} 条`, value }))"
            :disabled="busy || dirty"
            aria-label="每页条数"
            @update:value="changePageSize"
          />
        </div>
        <div class="page-navigation">
          <NButton
            size="small"
            :disabled="busy || dirty || page <= 1 || !response?.total"
            @click="load(page - 1)"
          >
            上一页
          </NButton><span>第 {{ page }} / {{ Math.max(1, response?.pageCount ?? 1) }} 页</span><NButton
            size="small"
            :disabled="busy || dirty || page >= (response?.pageCount ?? 1)"
            @click="load(page + 1)"
          >
            下一页
          </NButton>
        </div>
        <form
          class="page-jump"
          @submit.prevent="jump"
        >
          <label for="record-jump">跳至</label><input
            id="record-jump"
            v-model.number="jumpPage"
            class="native-input"
            type="number"
            min="1"
            :max="Math.max(1, response?.pageCount ?? 1)"
            :disabled="busy || dirty || !response?.total"
            required
          ><NButton
            attr-type="submit"
            size="small"
            :disabled="busy || dirty || !response?.total"
          >
            跳转
          </NButton>
        </form>
      </div>
      <p class="record-count-help">
        总次数是对应卡池组内「已保存记录」的累计序号；角色活动 301 / 400 共用计数。保底内次数按五星间隔计算，不是剩余保底抽数。「≥」表示历史可能不完整；「不确定」表示存在未知或冲突星级。
      </p>
    </section>
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
      导入 UIGF 后即可查询记录。
    </p><RouterLink
      class="outline-link"
      to="/data"
    >
      前往数据管理
    </RouterLink>
  </section>
</template>
