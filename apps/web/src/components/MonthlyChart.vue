<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { init, use, type EChartsType } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { MonthlyAnalysisResponse } from '@gacha/contracts';
import { monthlySeries } from '../analysis.js';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, SVGRenderer]);
const props = defineProps<{ data: MonthlyAnalysisResponse }>();
const host = ref<HTMLElement | null>(null), tableOpen = ref(false);
const visible = reactive(Object.fromEntries(monthlySeries.map((series) => [series.key, true])));
let chart: EChartsType | undefined, observer: InstanceType<typeof globalThis.ResizeObserver> | undefined;
function draw() {
  chart?.setOption({ animation: false, color: monthlySeries.map((series) => series.color),
    textStyle: { fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', color: '#78877c' },
    tooltip: { trigger: 'axis', confine: true, renderMode: 'richText' },
    legend: { show: false, selected: Object.fromEntries(monthlySeries.map((series) => [series.label, visible[series.key]])) },
    grid: { left: 48, right: 18, top: 24, bottom: 82 },
    xAxis: { type: 'category', boundaryGap: false, data: props.data.months.map((month) => month.month), axisLabel: { hideOverlap: true }, axisLine: { lineStyle: { color: '#dce4d9' } } },
    yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#edf1e9' } } },
    dataZoom: [{ type: 'slider', left: 48, right: 18, bottom: 10, height: 24, start: 0, end: 100, brushSelect: false }, { type: 'inside', start: 0, end: 100 }],
    series: monthlySeries.map((series) => ({ name: series.label, type: 'line', showSymbol: props.data.months.length < 24,
      symbolSize: 5, itemStyle: { color: series.color }, lineStyle: { width: 2, color: series.color }, data: props.data.months.map((month) => month[series.key]) })),
  }, { notMerge: true });
}
function resize() {
  if (!host.value || !host.value.clientWidth || !host.value.clientHeight) return;
  if (!chart) { chart = init(host.value, undefined, { renderer: 'svg' }); draw(); }
  else chart.resize();
}
function toggle(event: Event, key: typeof monthlySeries[number]['key'], name: string) {
  const checked = (event.target as HTMLInputElement).checked;
  visible[key] = checked;
  chart?.dispatchAction({ type: checked ? 'legendSelect' : 'legendUnSelect', name });
}
function reset() { for (const series of monthlySeries) visible[series.key] = true; draw(); }
watch(() => props.data, (data, previous) => {
  if (data.profileId !== previous.profileId || data.dataVersion !== previous.dataVersion) draw();
});
onMounted(async () => {
  await nextTick(); resize();
  if (host.value) { observer = new globalThis.ResizeObserver(resize); observer.observe(host.value); }
});
onUnmounted(() => { observer?.disconnect(); chart?.dispose(); chart = undefined; });
</script>

<template>
  <div
    class="monthly-legend"
    aria-label="月度系列图例"
  >
    <label
      v-for="series in monthlySeries"
      :key="series.key"
      :style="{ '--series-color': series.color }"
    >
      <input
        :checked="visible[series.key]"
        type="checkbox"
        @change="toggle($event, series.key, series.label)"
      >
      <span>{{ series.label }}</span><strong>{{ data.totals[series.key].toLocaleString() }}</strong>
    </label>
    <button
      class="chart-reset"
      type="button"
      @click="reset"
    >
      重置图表
    </button>
  </div>
  <div
    ref="host"
    class="monthly-chart"
    role="img"
    aria-label="年月祈愿折线图，包含五条可切换系列；可拖动底部滑块缩放，下方可查看完整数据表"
  />
  <p class="field-hint">
    点击图例切换系列；拖动底部滑块，或在图内滚轮／触屏缩放月份范围。
  </p>
  <details
    class="monthly-details"
    @toggle="tableOpen = ($event.target as HTMLDetailsElement).open"
  >
    <summary>查看月度明细（{{ data.months.length }} 个月）</summary>
    <div
      v-if="tableOpen"
      class="analysis-table-scroll"
    >
      <table class="analysis-detail-table">
        <thead>
          <tr>
            <th>年月</th><th
              v-for="series in monthlySeries"
              :key="series.key"
            >
              {{ series.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="month in data.months"
            :key="month.month"
          >
            <td>{{ month.month }}</td><td
              v-for="series in monthlySeries"
              :key="series.key"
            >
              {{ month[series.key] }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>
