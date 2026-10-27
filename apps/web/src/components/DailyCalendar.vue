<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { DailyAnalysisResponse } from '@gacha/contracts';
const props = defineProps<{ data: DailyAnalysisResponse }>();
const container = ref<HTMLElement | null>(null), focusIndex = ref(0);
const tooltip = ref<{ text: string; left: number; top: number } | null>(null);
let activeCell: HTMLElement | null = null, activeText = '', frame: number | undefined;
const offset = computed(() => (new Date(`${String(props.data.year).padStart(4, '0')}-01-01T00:00:00Z`).getUTCDay() + 6) % 7);
const columns = computed(() => Math.ceil((offset.value + props.data.days.length) / 7));
const months = computed(() => props.data.days.flatMap((day, index) => day.date.endsWith('-01')
  ? [{ label: `${Number(day.date.slice(5, 7))}月`, column: Math.floor((offset.value + index) / 7) + 1 }] : []));
const dayText = (date: string, count: number) => `${date} · ${count.toLocaleString()} 抽`;
function show(event: Event, date: string, count: number) {
  activeCell = event.currentTarget as HTMLElement; activeText = dayText(date, count); reposition();
}
function reposition() {
  if (!activeCell) return;
  if (frame !== undefined) globalThis.cancelAnimationFrame(frame);
  frame = globalThis.requestAnimationFrame(() => {
    frame = undefined;
    if (!activeCell?.isConnected) return;
    const rect = activeCell.getBoundingClientRect(), clip = container.value?.parentElement?.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > globalThis.innerHeight || clip && (rect.right < clip.left || rect.left > clip.right)) { tooltip.value = null; return; }
    tooltip.value = { text: activeText, left: Math.max(8, Math.min(rect.left, globalThis.innerWidth - 205)), top: rect.bottom + 48 > globalThis.innerHeight ? rect.top - 40 : rect.bottom + 8 };
  });
}
function hideTooltip() {
  activeCell = null; tooltip.value = null;
  if (frame !== undefined) { globalThis.cancelAnimationFrame(frame); frame = undefined; }
}
function navigate(event: KeyboardEvent, index: number) {
  const deltas: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
  let next = event.key === 'Home' ? 0 : event.key === 'End' ? props.data.days.length - 1 : index + (deltas[event.key] ?? 0);
  if (!(event.key in deltas) && !['Home', 'End'].includes(event.key)) return;
  event.preventDefault(); next = Math.max(0, Math.min(next, props.data.days.length - 1)); focusIndex.value = next;
  container.value?.querySelectorAll<HTMLButtonElement>('.calendar-day')[next]?.focus();
}
watch(() => props.data, () => { hideTooltip(); focusIndex.value = 0; });
onMounted(() => { globalThis.addEventListener('scroll', reposition, true); globalThis.addEventListener('resize', reposition); });
onUnmounted(() => { hideTooltip(); globalThis.removeEventListener('scroll', reposition, true); globalThis.removeEventListener('resize', reposition); });
</script>

<template>
  <div
    class="calendar-scroll"
    aria-label="年度日历，可横向滚动"
  >
    <div
      ref="container"
      class="calendar-layout"
      :style="{ '--week-count': columns }"
    >
      <div class="calendar-months">
        <span
          v-for="month in months"
          :key="month.label"
          :style="{ gridColumn: month.column }"
        >{{ month.label }}</span>
      </div>
      <div
        class="calendar-weekdays"
        aria-hidden="true"
      >
        <span
          v-for="label in ['一', '二', '三', '四', '五', '六', '日']"
          :key="label"
        >{{ label }}</span>
      </div>
      <div
        class="calendar-days"
        role="group"
        :aria-label="`${data.year} 年每日抽卡次数`"
      >
        <span
          v-for="pad in offset"
          :key="`pad-${pad}`"
          aria-hidden="true"
        />
        <button
          v-for="(day, index) in data.days"
          :key="day.date"
          type="button"
          class="calendar-day"
          :class="`heat-${day.count === 0 ? 0 : Math.max(1, Math.ceil(day.count / Math.max(1, data.maxDailyCount) * 4))}`"
          :aria-label="dayText(day.date, day.count)"
          :aria-describedby="tooltip?.text === dayText(day.date, day.count) ? 'daily-tooltip' : undefined"
          :tabindex="focusIndex === index ? 0 : -1"
          @mouseenter="show($event, day.date, day.count)"
          @mouseleave="hideTooltip"
          @focus="focusIndex = index; show($event, day.date, day.count)"
          @blur="hideTooltip"
          @click="show($event, day.date, day.count)"
          @keydown="navigate($event, index)"
        />
      </div>
    </div>
  </div>
  <div class="calendar-caption">
    <span>{{ data.year }} 年 · {{ data.days.length }} 天 · {{ data.total.toLocaleString() }} 抽</span>
    <span
      class="heat-legend"
      aria-label="抽卡次数颜色从少到多"
    >少 <i
      v-for="level in [0, 1, 2, 3, 4]"
      :key="level"
      :class="`heat-${level}`"
      aria-hidden="true"
    /> 多</span>
  </div>
  <p
    v-if="!data.hasRecords"
    class="field-hint"
  >
    该年份和卡池没有抽卡记录，全年日期均为 0 抽。
  </p>
  <p class="field-hint">
    悬停、点击或键盘聚焦单日查看日期和次数；方向键按日／周移动，窄屏可横向滚动日历。
  </p>
  <Teleport to="body">
    <div
      v-if="tooltip"
      id="daily-tooltip"
      class="daily-tooltip"
      role="tooltip"
      :style="{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }"
    >
      {{ tooltip.text }}
    </div>
  </Teleport>
</template>
