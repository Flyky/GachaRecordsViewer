<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { NButton } from 'naive-ui';
import type { MiyousheQrCreateResponse, MiyousheQrResponse, MiyousheQrSession } from '@gacha/contracts';
import { ApiError, userRequest, userSession } from '../auth.js';
import { communityError, qrActive, qrLabel } from '../community.js';
const props = defineProps<{ targetId?: string; targetIdentity?: string }>();
const emit = defineEmits<{ authorized: [id: string]; close: [] }>();
const session = shallowRef<MiyousheQrSession | null>(null), image = ref(''), busy = ref(false), error = ref(''), clock = ref(Date.now());
const seconds = computed(() => session.value ? Math.max(0, Math.ceil((Date.parse(session.value.expiresAt) - clock.value) / 1000)) : 0);
let active = true, generation = 0, pollTimer: ReturnType<typeof setTimeout> | undefined, clockTimer: ReturnType<typeof globalThis.setInterval> | undefined;
const csrf = userSession.value?.csrfToken;
function cancelOnLeave(id: string) {
  void fetch(`/api/community/qr/${encodeURIComponent(id)}/cancel`, { method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: '{}' }).catch(() => undefined);
}
function stop() { globalThis.clearTimeout(pollTimer); }
function accept(value: MiyousheQrSession) {
  const wasConfirmed = session.value?.status === 'confirmed'; session.value = value; clock.value = Date.now();
  if (!qrActive(value)) { image.value = ''; stop(); }
  if (value.status === 'confirmed' && !wasConfirmed && value.communityAccountId) emit('authorized', value.communityAccountId);
}
function schedule() {
  stop(); if (!active || document.hidden || !qrActive(session.value) || error.value) return;
  pollTimer = setTimeout(() => void poll(), Math.max(2000, session.value?.pollAfterMs ?? 0));
}
async function poll() {
  const value = session.value; if (!value || !qrActive(value) || busy.value || !active) return;
  const revision = generation; busy.value = true;
  try {
    const response = await userRequest<MiyousheQrResponse>(`/api/community/qr/${encodeURIComponent(value.id)}/poll`, {}, 75000);
    if (active && revision === generation) accept(response.session);
  } catch (cause) {
    if (active && revision === generation) error.value = cause instanceof ApiError && cause.code === 'NETWORK_ERROR'
      ? '暂时无法确认扫码结果，授权可能仍在保存。请检查状态，不要重复生成二维码。' : communityError(cause);
  } finally { if (active && revision === generation) { busy.value = false; schedule(); } }
}
async function create() {
  if (busy.value || qrActive(session.value)) return;
  const revision = ++generation; stop(); session.value = null; image.value = ''; busy.value = true; error.value = '';
  try {
    const response = await userRequest<MiyousheQrCreateResponse>('/api/community/qr', props.targetId ? { communityAccountId: props.targetId } : {}, 20000);
    if (!active || revision !== generation) { cancelOnLeave(response.session.id); return; }
    accept(response.session);
    const QRCode = await import('qrcode');
    const data = await QRCode.toDataURL(response.qrUrl, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
    if (active && revision === generation && qrActive(session.value)) image.value = data;
  } catch (cause) {
    if (active && revision === generation) error.value = cause instanceof ApiError && cause.code === 'NETWORK_ERROR'
      ? '未能确认二维码是否已创建。请最多等待 3 分钟后重试，避免连续生成。' : communityError(cause);
  } finally { if (active && revision === generation) { busy.value = false; schedule(); } }
}
async function check() {
  if (!session.value || busy.value) return;
  const revision = generation; busy.value = true; error.value = '';
  try {
    const response = await userRequest<MiyousheQrResponse>(`/api/community/qr/${encodeURIComponent(session.value.id)}`);
    if (active && revision === generation) accept(response.session);
  } catch (cause) { if (active && revision === generation) error.value = communityError(cause); }
  finally { if (active && revision === generation) { busy.value = false; schedule(); } }
}
async function cancel(close = false) {
  const value = session.value;
  if (!value || !qrActive(value)) { if (close) emit('close'); return; }
  const revision = ++generation; stop(); busy.value = true; error.value = '';
  try {
    const response = await userRequest<MiyousheQrResponse>(`/api/community/qr/${encodeURIComponent(value.id)}/cancel`, {}, 20000);
    if (!active || revision !== generation) return;
    accept(response.session); if (close && !qrActive(response.session)) emit('close');
  } catch (cause) { if (active && revision === generation) error.value = communityError(cause); }
  finally { if (active && revision === generation) busy.value = false; }
}
function visibility() { if (document.hidden) stop(); else if (session.value && qrActive(session.value)) void check(); }
onMounted(() => {
  document.addEventListener('visibilitychange', visibility);
  clockTimer = globalThis.setInterval(() => { clock.value = Date.now(); if (session.value && seconds.value === 0) { image.value = ''; if (!busy.value && qrActive(session.value) && !document.hidden && !error.value) void check(); } }, 1000);
});
onUnmounted(() => { active = false; generation++; stop(); globalThis.clearInterval(clockTimer); image.value = ''; if (session.value && qrActive(session.value)) cancelOnLeave(session.value.id); document.removeEventListener('visibilitychange', visibility); });
</script>

<template>
  <section
    class="surface account-form qr-panel"
    aria-label="App 扫码授权"
  >
    <div class="list-heading">
      <h2>{{ targetId ? '重新扫码授权' : 'App 扫码添加账号' }}</h2><NButton
        size="small"
        :disabled="busy && !session"
        @click="cancel(true)"
      >
        关闭扫码
      </NButton>
    </div>
    <p class="muted">
      {{ targetIdentity ? `请使用米游社账号 ${targetIdentity} 扫码，验证成功后替换原授权。` : '使用官方米游社 App 扫码并确认，授权将加密保存在本应用服务端。' }}
    </p>
    <div
      v-if="image && seconds > 0"
      class="qr-image"
    >
      <img
        :src="image"
        alt="请使用官方米游社 App 扫描此授权二维码"
        width="320"
        height="320"
      >
    </div>
    <p
      v-if="session"
      class="qr-status"
      role="status"
    >
      {{ qrLabel(session.status) }}<span v-if="qrActive(session)"> · {{ seconds > 0 ? `剩余约 ${seconds} 秒` : '有效期已到，正在确认最终状态' }}</span>
    </p>
    <p
      v-if="session?.code"
      class="feedback"
      :class="{ error: session.status === 'failed' || session.status === 'verification_required' }"
    >
      {{ communityError(session.code) }}
    </p>
    <p
      v-if="error"
      class="feedback error"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="button-row">
      <NButton
        v-if="!qrActive(session)"
        type="primary"
        :loading="busy"
        :disabled="busy"
        @click="create"
      >
        {{ session ? '重新生成二维码' : '生成二维码' }}
      </NButton>
      <NButton
        v-if="session"
        :disabled="busy"
        @click="check"
      >
        检查扫码状态
      </NButton>
      <NButton
        v-if="qrActive(session)"
        :disabled="!session"
        @click="cancel()"
      >
        取消扫码
      </NButton>
    </div>
    <p class="field-hint">
      无需在本应用输入米游社密码。扫码过期或取消后可重建；离开页面会尝试取消未完成会话，临时票据最迟约 3 分钟失效。
    </p>
  </section>
</template>
