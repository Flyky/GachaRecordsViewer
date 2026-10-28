<script setup lang="ts">
import type { LuckAnalysisResponse } from '@gacha/contracts';
import { poolLabel } from '../records.js';
defineProps<{ data: LuckAnalysisResponse }>();
const number = (value: number | null) => value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const rate = (value: number | null) => value === null ? '—' : `${number(value * 100)}%`;
</script>

<template>
  <section
    class="surface analysis-section"
    aria-labelledby="luck-analysis-title"
  >
    <div class="analysis-section-heading">
      <div>
        <h2 id="luck-analysis-title">
          欧非分析
        </h2><p class="muted">
          按卡池统计五星平均抽数，再看看角色 UP 的实际获取情况。角色活动祈愿与祈愿 2 合并计算。
        </p>
      </div>
    </div>
    <div class="luck-pool-grid">
      <article
        v-for="entry in data.pools"
        :key="entry.pool"
        class="luck-card"
      >
        <h3>{{ poolLabel(entry.pool) }}</h3>
        <p class="luck-value">
          {{ number(entry.averageFiveStarPulls) }}<small> 抽／五星</small>
        </p>
        <p class="field-hint">
          {{ entry.completeIntervals }} 个完整五星间隔 · 已确认 {{ entry.fiveStars }} 个五星<br>
          已保存 {{ entry.totalPulls.toLocaleString() }} 抽 · 总抽数 ÷ 五星数：{{ number(entry.observedPullsPerFiveStar) }}
        </p>
        <p
          v-if="entry.excludedFiveStars || entry.unknownRankRecords"
          class="field-hint"
        >
          排除 {{ entry.excludedFiveStars }} 个起点不明或不完整间隔；{{ entry.unknownRankRecords }} 条星级未知记录。
        </p>
      </article>
    </div>
    <p class="field-hint">
      五星平均抽数使用完整的两次五星间隔；起点明确时也包含首次五星。首段历史起点未知、已知缺口、未知星级与末尾尚未出金的抽数不计入该平均；“总抽数 ÷ 五星数”另列作参考。
    </p>
    <h3 class="luck-character-heading">
      角色 UP 池
    </h3>
    <div class="luck-pool-grid">
      <article class="luck-card">
        <h3>小保底不歪率</h3><p class="luck-value">
          {{ rate(data.character.smallWinRate) }}
        </p><p class="field-hint">
          不歪 {{ data.character.smallWins }} 次／可判定小保底 {{ data.character.smallAttempts }} 次<br>
          大保底命中 {{ data.character.guaranteedUps }} 次，单独排除
        </p>
      </article>
      <article class="luck-card">
        <h3>获取 UP 五星的平均抽数</h3><p class="luck-value">
          {{ number(data.character.averageUpPulls) }}<small> 抽</small>
        </p><p class="field-hint">
          {{ data.character.upCostSamples }} 个完整 UP 获取周期<br>
          包含周期中歪掉的五星所用抽数
        </p>
      </article>
      <article class="luck-card">
        <h3>最多连续歪</h3><p class="luck-value">
          {{ number(data.character.maxLossStreak) }}<small> 次</small>
        </p><p class="field-hint">
          连续小保底结果，中间的大保底不打断
        </p>
      </article>
      <article class="luck-card">
        <h3>最多连续不歪</h3><p class="luck-value">
          {{ number(data.character.maxWinStreak) }}<small> 次</small>
        </p><p class="field-hint">
          仅计小保底直接获得 UP，大保底不计入
        </p>
      </article>
    </div>
    <p class="field-hint">
      已识别 UP 五星 {{ data.character.upFiveStars }} 个、非当期 UP 五星 {{ data.character.offBannerFiveStars }} 个。UP 成本从上一次 UP 之后累计到本次 UP；首次起点不明时不计入平均。以上是不完整历史中可确认样本的实际统计，不代表下一抽概率；捕获明光产生的 UP 也计为实际不歪，不能从记录单独识别其触发。
    </p>
    <p
      v-if="data.character.unclassifiedFiveStars || data.character.unknownStateFiveStars || data.character.inconsistentFiveStars"
      class="metadata-notice"
    >
      {{ data.character.unclassifiedFiveStars }} 个五星缺少可用卡池／角色信息，{{ data.character.unknownStateFiveStars }} 个五星无法确定抽取前的大小保底状态，{{ data.character.inconsistentFiveStars }} 个五星与连续保底状态矛盾；相应样本不计入小保底结果，未知处中断连续次数统计。没有足够样本时显示“—”。
    </p>
    <details class="unclassified-details">
      <summary>查看 UP 判断依据与统计范围</summary>
      <p class="field-hint">
        按记录时间、游戏服务器时区和历史 UP 角色 ID 判断，处理常驻角色曾经 UP 的情况。只统计当前档案角色池；新手、武器、常驻和集录不参与角色 UP 判定。没有对应历史卡池时标为未知，不根据名称猜测。
      </p><p class="field-hint">
        卡池数据：{{ data.bannerSource.name }} · {{ data.bannerSource.firstStart }} 至 {{ data.bannerSource.lastEnd }}（各服务器起止时间按来源规则换算）。未声明的历史遗漏无法自动发现，连续次数仅代表已保存记录。
      </p>
    </details>
  </section>
</template>
