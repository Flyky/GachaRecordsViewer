<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NButton, NPopconfirm } from 'naive-ui';
import QRCode from 'qrcode';
import type { TopupOrder } from '@gacha/contracts';
const props = defineProps<{ order: TopupOrder; busy: boolean }>();
defineEmits<{ check: [id: string]; archive: [id: string] }>();
const image = ref(''), imageError = ref(''), clock = ref(Date.now());
let active = true, revision = 0;
const timer = globalThis.setInterval(() => { clock.value = Date.now(); }, 1000);
onUnmounted(() => { active = false; revision++; globalThis.clearInterval(timer); image.value = ''; });
const url = computed(() => props.order.status === 'pending' && props.order.expiresAt !== null && props.order.expiresAt > clock.value ? props.order.qrUrl : null);
const seconds = computed(() => Math.max(0, Math.ceil(((props.order.expiresAt ?? 0) - clock.value) / 1000)));
const statusLabel = { creating: '创建中／等待确认', pending: '待支付', paid: '支付成功（官方确认）', unknown: '下单结果未确认', verification_required: '需要官方安全验证', failed: '未完成', archived: '已结束本地跟踪' };
watch(url, async (value) => {
  const current = ++revision; image.value = ''; imageError.value = ''; if (!value) return;
  try { const result = await QRCode.toDataURL(value, { width: 240, margin: 2, errorCorrectionLevel: 'M' }); if (active && current === revision) image.value = result; }
  catch { if (active && current === revision) imageError.value = '二维码显示失败，请刷新订单状态。'; }
}, { immediate: true });
</script>
<template>
  <article class="topup-order">
    <div class="list-heading">
      <strong>{{ order.goodsName }} · ¥{{ (order.amount / 100).toFixed(2) }}</strong><span>{{ statusLabel[order.status] }}</span>
    </div>
    <p class="field-hint">
      米游社 {{ order.accountId }} · 原神官服 UID {{ order.uid }}<br>
      {{ order.method === 'alipay' ? '支付宝' : '微信' }} · {{ new Date(order.createdAt).toLocaleString() }}<br>
      {{ order.orderNo ? `官方订单号：${order.orderNo}` : '尚未取得官方订单号' }}
    </p>
    <div
      v-if="image && url"
      class="qr-image"
    >
      <img
        :src="image"
        :alt="`${order.method === 'alipay' ? '支付宝' : '微信'}付款二维码，原神 UID ${order.uid}，${order.goodsName}，${(order.amount / 100).toFixed(2)} 元`"
        width="240"
        height="240"
      >
      <p>请使用{{ order.method === 'alipay' ? '支付宝' : '微信' }}扫码并核对收款方、金额和 UID。</p>
      <p class="field-hint">
        二维码剩余 {{ Math.floor(seconds / 60) }}:{{ String(seconds % 60).padStart(2, '0') }}；支付完成后点击查询支付结果。
      </p>
    </div>
    <p
      v-if="order.status === 'pending' && !url"
      class="feedback"
    >
      二维码已过期或账号授权已变化，请先查询支付结果。本页不会自动重新下单。
    </p>
    <p
      v-if="['unknown', 'verification_required', 'creating'].includes(order.status)"
      class="feedback"
    >
      {{ order.status === 'verification_required' ? '请前往官方充值中心处理安全验证。' : '可能已创建官方订单，暂未能确认结果。' }} 请先查询或到官方核实，避免重复创建、重复付款。
    </p>
    <p
      v-if="imageError"
      class="feedback error"
    >
      {{ imageError }}
    </p>
    <div
      v-if="!['paid', 'archived'].includes(order.status)"
      class="button-row"
    >
      <NButton
        :disabled="busy"
        @click="$emit('check', order.id)"
      >
        查询支付结果
      </NButton><NPopconfirm
        :disabled="busy"
        positive-text="结束本地跟踪"
        negative-text="保留"
        @positive-click="$emit('archive', order.id)"
      >
        <template #trigger>
          <NButton :disabled="busy">
            结束本地跟踪
          </NButton>
        </template>
        这只会清除本页二维码和支付凭证，不会取消官方订单或退款。请先核实支付情况，再开始新的充值。
      </NPopconfirm>
    </div>
  </article>
</template>
