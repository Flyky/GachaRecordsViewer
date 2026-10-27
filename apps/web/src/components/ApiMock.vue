<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { NButton, NInput, NSelect } from 'naive-ui';
import type { ApiMockFormat, ApiMockLink, ApiMockResponse } from '@gacha/contracts';
import { ApiError, errorMessage, userRequest } from '../auth.js';
import { currentProfile, profiles } from '../profiles.js';

const profileId = ref<string | null>(currentProfile.value?.id ?? null), format = ref<ApiMockFormat>('wish-link');
const link = shallowRef<ApiMockLink | null>(null), busy = ref(false), error = ref(''), notice = ref('');
const clock = ref(Date.now()), offset = ref(0);
const activeLink = computed(() => link.value && link.value.expiresAt > clock.value + offset.value ? link.value : null);
const remaining = computed(() => Math.max(0, Math.ceil(((activeLink.value?.expiresAt ?? 0) - clock.value - offset.value) / 1000)));
const countdown = computed(() => `${Math.floor(remaining.value / 60)}:${String(remaining.value % 60).padStart(2, '0')}`);
const formats = [{ label: '祈愿链接', value: 'wish-link' }, { label: '米游社', value: 'miyoushe' }, { label: 'UIGF v4.0', value: 'uigf' }];
const formatLabel = (value: ApiMockFormat) => formats.find((entry) => entry.value === value)?.label;
let active = true;
const timer = globalThis.setInterval(() => { clock.value = Date.now(); }, 1000);
onUnmounted(() => { active = false; globalThis.clearInterval(timer); link.value = null; });
watch(profiles, (entries) => {
  if (!entries.some((entry) => entry.id === profileId.value)) profileId.value = currentProfile.value?.id ?? entries[0]?.id ?? null;
}, { immediate: true });
async function request(action: 'load' | 'create' | 'destroy') {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await userRequest<ApiMockResponse>(action === 'destroy' ? '/api/mock/destroy' : '/api/mock',
      action === 'load' ? undefined : action === 'destroy' ? {} : { profileId: profileId.value, format: format.value }, 120000);
    if (!active) return;
    clock.value = Date.now(); offset.value = response.serverTime - clock.value; link.value = response.link;
    if (action === 'create') notice.value = '已生成接口，旧链接已失效。';
    if (action === 'destroy') notice.value = 'API 已销毁，原链接立即失效。';
  } catch (cause) {
    if (!active) return;
    const messages: Record<string, string> = {
      PROFILE_NOT_FOUND: '这个游戏档案已不存在，请刷新档案列表。',
      MOCK_BUSY: '正在生成接口，请稍后刷新状态。', MOCK_CANCELLED: '生成已被取消，请刷新状态。',
      MOCK_UNAVAILABLE: '服务正在停止，请稍后重试。', MOCK_CAPACITY: '临时接口容量不足，请稍后重试。',
      NETWORK_ERROR: '未能确认操作结果，请刷新接口状态；服务端可能已完成操作。',
    };
    error.value = cause instanceof ApiError && messages[cause.code] || errorMessage(cause);
  } finally { if (active) busy.value = false; }
}
async function copy() {
  const current = activeLink.value; if (!current) return;
  error.value = ''; notice.value = '';
  try {
    await globalThis.navigator.clipboard.writeText(current.url);
    if (active && activeLink.value?.id === current.id) notice.value = 'URL 已复制。';
  } catch { if (active) error.value = '无法访问剪贴板，请选中下方 URL 手动复制。'; }
}
onMounted(() => { void request('load'); });
</script>

<template>
  <section
    class="surface data-section api-mock"
    aria-labelledby="api-mock-title"
  >
    <div class="section-heading">
      <h2 id="api-mock-title">
        API 模拟
      </h2><p class="muted">
        为所选游戏档案生成临时数据接口，供支持自定义接口地址的应用导入。
      </p>
    </div>
    <form
      class="api-mock-form"
      @submit.prevent="request('create')"
    >
      <div class="field">
        <label id="api-mock-profile-label">游戏账号</label><NSelect
          v-model:value="profileId"
          :options="profiles.map((profile) => ({ label: `原神 · UID ${profile.uid}`, value: profile.id }))"
          :disabled="busy || !profiles.length"
          placeholder="请先导入记录建立档案"
          aria-labelledby="api-mock-profile-label"
        />
      </div>
      <div class="field">
        <label id="api-mock-format-label">输出格式</label><NSelect
          v-model:value="format"
          :options="formats"
          :disabled="busy"
          aria-labelledby="api-mock-format-label"
        />
      </div>
      <NButton
        type="primary"
        attr-type="submit"
        :loading="busy"
        :disabled="busy || !profileId"
      >
        {{ activeLink ? '重新生成 API' : '生成 API' }}
      </NButton>
      <NButton
        :disabled="busy"
        @click="request('load')"
      >
        刷新接口状态
      </NButton>
    </form>
    <p class="form-help">
      一次返回该 UID 在本应用中保存的全部卡池记录，不分页、不限制条数。生成后数据固定；后续新增记录需重新生成。每个本地账号同时保留一个 API，重新生成会替换旧链接。
    </p>
    <p class="field-hint">
      祈愿链接与米游社授权读取使用相同的祈愿记录响应结构。此接口使用本站域名，不含真实米游社凭证；只接受官方域名或固定分页的应用可能无法直接导入。
    </p>
    <div
      v-if="activeLink"
      class="api-mock-result"
    >
      <div class="list-heading">
        <strong>UID {{ activeLink.uid }} · {{ formatLabel(activeLink.format) }}</strong><span role="timer">剩余 {{ countdown }}</span>
      </div>
      <p class="field-hint">
        {{ activeLink.recordCount.toLocaleString() }} 条记录 · 到期时间 {{ new Date(activeLink.expiresAt).toLocaleTimeString() }}
      </p>
      <NInput
        :value="activeLink.url"
        type="textarea"
        readonly
        :autosize="{ minRows: 2, maxRows: 4 }"
        aria-label="临时 API URL"
        :input-props="{ spellcheck: false }"
      />
      <div class="button-row">
        <NButton
          :disabled="busy"
          @click="copy"
        >
          复制 URL
        </NButton><NButton
          type="error"
          secondary
          :disabled="busy"
          @click="request('destroy')"
        >
          销毁 API
        </NButton>
      </div>
      <p class="field-hint">
        持有链接的人可在有效期内读取该 UID 的全部记录，请仅提供给可信应用。15 分钟后自动销毁，也可立即手动销毁；离开页面或退出登录不会延长有效期，服务重启后链接失效。
      </p>
    </div>
    <p
      v-else-if="link"
      class="feedback"
    >
      API 已到期，原链接已失效。
    </p>
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
  </section>
</template>
