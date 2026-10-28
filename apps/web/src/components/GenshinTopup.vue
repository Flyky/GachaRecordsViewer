<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { NButton, NModal, NSelect } from 'naive-ui';
import type { CommunityAccount, TopupCatalog, TopupMethod, TopupOrder, TopupQuote } from '@gacha/contracts';
import { ApiError, errorMessage, userRequest } from '../auth.js';
import TopupOrderCard from './TopupOrderCard.vue';
const accounts = shallowRef<CommunityAccount[]>([]), orders = shallowRef<TopupOrder[]>([]), catalog = shallowRef<TopupCatalog | null>(null), quote = shallowRef<TopupQuote | null>(null);
const accountId = ref<string | null>(null), uid = ref<string | null>(null), goodsId = ref<string | null>(null), method = ref<TopupMethod>('alipay');
const busy = ref(false), error = ref(''), requestId = ref('');
const methods = computed(() => (catalog.value?.methods ?? []).map((value) => ({ value, label: value === 'alipay' ? '支付宝' : '微信' })));
const selectedGoods = computed(() => catalog.value?.goods.find((goods) => goods.id === goodsId.value));
let active = true;
onUnmounted(() => { active = false; quote.value = null; orders.value = []; });
function message(cause: unknown) {
  const messages: Record<string, string> = {
    TOPUP_ROLE_NOT_AVAILABLE: '当前米游社账号下没有这个可充值的原神官服角色。渠道服暂不支持。',
    TOPUP_GOODS_NOT_AVAILABLE: '商品当前不可购买，请重新加载商品。', TOPUP_METHOD_NOT_AVAILABLE: '当前商品暂不支持所选支付方式。',
    TOPUP_QUOTE_EXPIRED: '确认信息已过期，请重新核对商品。', TOPUP_QUOTE_CHANGED: '商品或价格已变化，请重新核对，未按旧价格下单。',
    TOPUP_PENDING_ORDER: '已有待处理的充值订单，请先查询支付结果，或核实后结束旧订单的本地跟踪。',
    TOPUP_ORDER_NOT_FOUND: '订单不存在或不属于当前账号，请刷新订单列表。', TOPUP_UNAVAILABLE: '服务正在停止，请稍后重试。',
    CREDENTIALS_CHANGED: '米游社授权已变更，请重新加载角色和商品。', COMMUNITY_NOT_FOUND: '米游社账号已不存在，请刷新页面。',
    COOKIE_TOKEN_REQUIRED: '缺少可用 Cookie Token，请到米游社账号页面更新授权。', TOPUP_BUSY: '充值操作正在处理，请稍候。',
    MIYOUSHE_VERIFICATION_REQUIRED: '官方要求安全验证，请在官方充值中心完成操作。',
    MIYOUSHE_AUTH_INVALID: '米游社登录凭证已失效，请到账号页面更新授权。',
    MIYOUSHE_PROTOCOL: '官方充值响应与当前适配不一致，请使用官方充值中心并反馈。',
    MIYOUSHE_UPSTREAM: '官方暂未接受请求，请稍后重试或使用官方充值中心。',
    NETWORK_ERROR: '未能确认操作结果，请先刷新订单列表；下单请求可能已到达服务端，不会自动重新下单。',
  };
  return cause instanceof ApiError && messages[cause.code] || errorMessage(cause);
}
async function perform(work: () => Promise<void>) {
  if (busy.value) return; busy.value = true; error.value = '';
  try { await work(); } catch (cause) { if (active) error.value = message(cause); }
  finally { if (active) busy.value = false; }
}
function changeAccount(value: string) { accountId.value = value; uid.value = null; goodsId.value = null; catalog.value = null; quote.value = null; requestId.value = ''; }
async function loadCatalog() {
  const account = accountId.value, selectedUid = uid.value; if (!account) return;
  await perform(async () => {
    const response = await userRequest<TopupCatalog>('/api/community/topup/catalog', { communityAccountId: account, ...(selectedUid ? { uid: selectedUid } : {}) }, 120000);
    if (!active || account !== accountId.value) return;
    catalog.value = response; uid.value = response.uid; goodsId.value = null; quote.value = null;
    if (!response.methods.includes(method.value)) method.value = response.methods[0] ?? 'alipay';
  });
}
async function changeRole(value: string) { uid.value = value; goodsId.value = null; await loadCatalog(); }
async function loadOrders() {
  const response = await userRequest<{ orders: TopupOrder[] }>('/api/community/topup/orders');
  if (active) orders.value = response.orders;
}
async function preview() {
  if (!accountId.value || !uid.value || !selectedGoods.value?.available) return;
  await perform(async () => {
    const result = await userRequest<TopupQuote>('/api/community/topup/quote', { communityAccountId: accountId.value, uid: uid.value, goodsId: goodsId.value, method: method.value }, 120000);
    if (!active) return;
    requestId.value = result.id; quote.value = result;
  });
}
async function create() {
  const current = quote.value; if (!current || busy.value) return false;
  await perform(async () => {
    const response = await userRequest<{ order: TopupOrder }>('/api/community/topup/orders', { quoteId: current.id, requestId: requestId.value }, 120000);
    if (!active) return; quote.value = null; orders.value = [response.order, ...orders.value.filter((entry) => entry.id !== response.order.id)];
  }); return false;
}
async function action(id: string, value: 'check' | 'archive') {
  await perform(async () => {
    const response = await userRequest<{ order: TopupOrder }>(`/api/community/topup/orders/${encodeURIComponent(id)}/${value}`, {}, 60000);
    if (active) orders.value = orders.value.map((entry) => entry.id === id ? response.order : entry);
  });
}
onMounted(() => { void perform(async () => {
  const [saved] = await Promise.all([userRequest<{ accounts: CommunityAccount[] }>('/api/community/accounts'), loadOrders()]);
  if (active) { accounts.value = saved.accounts; accountId.value = saved.accounts[0]?.id ?? null; }
}); });
</script>
<template>
  <section class="surface account-form">
    <h2>原神充值</h2><p class="muted">
      为已添加米游社账号下的原神官服角色充值，支持支付宝和微信扫码支付。
    </p>
    <p class="field-hint">
      先加载实时商品并核对信息，确认后才创建官方订单。每次购买数量为 1，不使用优惠券。首次适配仅支持官服，渠道服请使用对应渠道的充值入口。
    </p>
    <div class="topup-fields">
      <div class="field">
        <label id="topup-account-label">米游社账号</label><NSelect
          :value="accountId"
          :options="accounts.map((account) => ({ value: account.id, label: account.accountId }))"
          :disabled="busy || !accounts.length"
          placeholder="请先添加米游社账号"
          aria-labelledby="topup-account-label"
          @update:value="changeAccount"
        />
      </div>
      <div class="field">
        <label id="topup-role-label">原神角色</label><NSelect
          :value="uid"
          :options="catalog?.roles.map((role) => ({ value: role.uid, label: `${role.nickname} · ${role.uid}` })) ?? []"
          :disabled="busy || !catalog?.roles.length"
          placeholder="先加载角色与商品"
          aria-labelledby="topup-role-label"
          @update:value="changeRole"
        />
      </div>
      <NButton
        :disabled="busy || !accountId"
        :loading="busy"
        @click="loadCatalog"
      >
        加载／刷新角色与商品
      </NButton>
    </div>
    <p
      v-if="catalog && !catalog.roles.length"
      class="feedback"
    >
      此米游社账号下没有可充值的原神官服角色。
    </p>
    <div
      v-if="catalog?.roles.length"
      class="topup-fields"
    >
      <div class="field">
        <label id="topup-goods-label">充值商品</label><NSelect
          v-model:value="goodsId"
          :options="catalog.goods.map((goods) => ({ value: goods.id, label: `${goods.name} · ¥${(goods.amount / 100).toFixed(2)}${goods.available ? '' : '（不可购买）'}`, disabled: !goods.available }))"
          :disabled="busy"
          aria-labelledby="topup-goods-label"
        />
      </div>
      <div class="field">
        <label id="topup-method-label">支付方式</label><NSelect
          v-model:value="method"
          :options="methods"
          :disabled="busy"
          aria-labelledby="topup-method-label"
        />
      </div>
      <NButton
        type="primary"
        :disabled="busy || !selectedGoods?.available || !methods.length"
        @click="preview"
      >
        核对充值信息
      </NButton>
    </div>
    <p
      v-if="selectedGoods?.description"
      class="field-hint"
    >
      {{ selectedGoods.description }}
    </p>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="button-row topup-history-heading">
      <h3>最近充值订单</h3><NButton
        size="small"
        :disabled="busy"
        @click="perform(loadOrders)"
      >
        刷新订单列表
      </NButton>
    </div>
    <TopupOrderCard
      v-for="order in orders"
      :key="order.id"
      :order="order"
      :busy="busy"
      @check="action($event, 'check')"
      @archive="action($event, 'archive')"
    />
    <p
      v-if="!orders.length"
      class="field-hint"
    >
      还没有通过本应用创建的充值订单。
    </p>
    <p class="field-hint">
      遇到官方安全验证或商品限制时，请使用
      <a
        class="wish-link-download"
        href="https://pay.mihoyo.com/ys/index.html"
        target="_blank"
        rel="noopener noreferrer"
      >原神官方充值中心</a>。本页不会自动付款、自动重建二维码或自动重试下单。
    </p>
    <NModal
      :show="!!quote"
      preset="dialog"
      title="确认原神充值"
      positive-text="确认创建订单并生成二维码"
      negative-text="返回"
      :mask-closable="!busy"
      :closable="!busy"
      :close-on-esc="!busy"
      :positive-button-props="{ loading: busy, disabled: busy }"
      :negative-button-props="{ disabled: busy }"
      @positive-click="create"
      @negative-click="quote = null"
      @update:show="(show) => { if (!show && !busy) quote = null; }"
    >
      <template v-if="quote">
        <p>米游社账号：{{ quote.accountId }}</p><p>原神官服 UID：<strong>{{ quote.role.uid }}</strong> · {{ quote.role.nickname }}</p>
        <p>商品：{{ quote.goods.name }} × 1</p><p>应付：<strong>¥{{ (quote.goods.amount / 100).toFixed(2) }}</strong> · {{ quote.method === 'alipay' ? '支付宝' : '微信' }}</p>
        <p class="field-hint">
          确认后创建官方待支付订单，仍需你在支付 App 扫码完成付款。商品信息变化时会停止，要求重新核对。
        </p>
        <p
          v-if="error"
          class="feedback error"
          role="alert"
        >
          {{ error }}
        </p>
      </template>
    </NModal>
  </section>
</template>
