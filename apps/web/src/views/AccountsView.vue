<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { NButton } from 'naive-ui';
import { RouterLink } from 'vue-router';
import type { CommunityAccount, CommunityAccountsResponse } from '@gacha/contracts';
import CredentialPanel from '../components/CredentialPanel.vue';
import QrAuthorization from '../components/QrAuthorization.vue';
import SyncPanel from '../components/SyncPanel.vue';
import { ApiError, userRequest } from '../auth.js';
import { capabilityLabel, communityError, displayTime } from '../community.js';
import { currentProfile, refreshProfiles, regionLabel, selectProfile } from '../profiles.js';
const accounts = shallowRef<CommunityAccount[]>([]), selectedId = ref(''), loading = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const form = ref<'add' | 'replace' | null>(null), input = ref(''), qr = shallowRef<{ targetId?: string; targetIdentity?: string } | null>(null), unlinkConfirm = ref(false);
const account = computed(() => accounts.value.find((entry) => entry.id === selectedId.value) ?? null);
const syncProfile = computed(() => account.value?.profiles.some((profile) => profile.id === currentProfile.value?.id) ? currentProfile.value : null);
let active = true, generation = 0, reads = 0;
onUnmounted(() => { active = false; generation++; reads++; input.value = ''; accounts.value = []; qr.value = null; });
function choose(id: string) {
  if (busy.value) return;
  selectedId.value = id; form.value = null; input.value = ''; qr.value = null; unlinkConfirm.value = false; error.value = ''; notice.value = '';
  const selected = accounts.value.find((entry) => entry.id === id);
  if (selected?.profiles.length && !selected.profiles.some((profile) => profile.id === currentProfile.value?.id)) selectProfile(selected.profiles[0]!.id);
}
async function load(preferred?: string) {
  const revision = generation, read = ++reads; loading.value = true; error.value = '';
  try {
    const result = await userRequest<CommunityAccountsResponse>('/api/community/accounts');
    if (!active || revision !== generation || read !== reads) return;
    accounts.value = result.accounts;
    const matched = result.accounts.find((entry) => entry.profiles.some((profile) => profile.id === currentProfile.value?.id));
    const selected = result.accounts.find((entry) => entry.id === (preferred ?? selectedId.value)) ?? matched ?? result.accounts[0];
    selectedId.value = selected?.id ?? ''; unlinkConfirm.value = false;
    return true;
  } catch (cause) { if (active && revision === generation && read === reads) error.value = communityError(cause); }
  finally { if (active && revision === generation && read === reads) loading.value = false; }
}
function openForm(kind: 'add' | 'replace') { form.value = kind; input.value = ''; qr.value = null; unlinkConfirm.value = false; error.value = ''; notice.value = ''; }
function openQr(replace = false) {
  form.value = null; input.value = ''; unlinkConfirm.value = false; error.value = ''; notice.value = '';
  qr.value = replace && account.value ? { targetId: account.value.id, targetIdentity: account.value.accountId } : {};
}
async function authorized(id: string) {
  notice.value = '授权已保存，正在更新账号与档案。';
  await refreshProfiles(); if (!active) return; const loaded = await load(id);
  if (active) {
    if (!loaded) { notice.value = '授权已保存，请更新账号列表确认账号与 UID。'; return; }
    const selected = accounts.value.find((entry) => entry.id === id); if (selected?.profiles[0]) selectProfile(selected.profiles[0].id);
    notice.value = selected?.capabilities.tokens.stoken.status !== 'verified' ? '凭证已保存，但缺少已验证的 SToken，暂不能刷新祈愿。可补充凭证或 App 扫码。'
      : selected.profiles.length ? '授权已保存，可选择 UID 后刷新记录。' : '授权已保存，未找到原神档案，请检查米游社绑定关系。';
  }
}
async function saveInput() {
  if (busy.value || !input.value.trim()) return;
  const revision = generation, targetId = form.value === 'replace' ? account.value?.id : undefined, value = input.value;
  input.value = ''; busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await userRequest<{ account: CommunityAccount }>(targetId ? `/api/community/accounts/${encodeURIComponent(targetId)}/credentials` : '/api/community/accounts', { input: value }, 75000);
    if (!active || revision !== generation) return;
    form.value = null; await authorized(response.account.id);
  } catch (cause) {
    if (!active || revision !== generation) return;
    error.value = cause instanceof ApiError && cause.code === 'NETWORK_ERROR'
      ? '未能确认凭证是否已保存，请先更新账号列表再决定是否重试。输入已清空。' : `${communityError(cause)} 输入已清空，原凭证不会因验证失败被替换。`;
  } finally { if (active && revision === generation) busy.value = false; }
}
async function validate(profileId?: string) {
  const selected = account.value; if (!selected || busy.value) return;
  const revision = generation; busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await userRequest<{ account: CommunityAccount }>(`/api/community/accounts/${encodeURIComponent(selected.id)}/validate`, profileId ? { profileId } : {}, 75000);
    if (!active || revision !== generation) return;
    await refreshProfiles(); await load(selected.id); notice.value = profileId ? response.account.capabilities.wish.status === 'authkey_verified'
      ? '所选 UID 的临时祈愿授权验证通过，尚未读取抽卡历史。' : '校验已完成，当前凭证仍不足以生成祈愿临时授权，请补充 SToken。' : '凭证校验完成，绑定档案已更新。';
  } catch (cause) {
    if (!active || revision !== generation) return;
    await load(selected.id); if (active) error.value = communityError(cause);
  } finally { if (active && revision === generation) busy.value = false; }
}
async function unlink() {
  const selected = account.value; if (!selected || busy.value || !unlinkConfirm.value) return;
  const revision = generation; busy.value = true; error.value = ''; qr.value = null;
  try {
    await userRequest(`/api/community/accounts/${encodeURIComponent(selected.id)}/unlink`, {});
    if (!active || revision !== generation) return;
    unlinkConfirm.value = false; form.value = null; await refreshProfiles(); await load(); notice.value = '已删除该账号凭证并解除绑定，抽卡历史保留，相关未完成刷新任务已取消。';
  } catch (cause) { if (active && revision === generation) error.value = cause instanceof ApiError && cause.code === 'NETWORK_ERROR' ? '未能确认解绑结果，请先更新账号列表。' : communityError(cause); }
  finally { if (active && revision === generation) busy.value = false; }
}
watch(() => currentProfile.value?.id, (id) => {
  const match = accounts.value.find((entry) => entry.profiles.some((profile) => profile.id === id));
  if (match && match.id !== selectedId.value && !busy.value) { selectedId.value = match.id; form.value = null; input.value = ''; qr.value = null; unlinkConfirm.value = false; }
});
void load();
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">
      MIYOUSHE ACCOUNTS
    </p><h1>米游社账号</h1><p class="muted">
      管理自己的授权与 UID，让新的祈愿记录回到档案中。
    </p>
  </section>
  <div class="accounts-toolbar button-row">
    <NButton
      type="primary"
      :disabled="busy"
      @click="openQr()"
    >
      扫码添加账号
    </NButton><NButton
      :disabled="busy"
      @click="openForm('add')"
    >
      手动导入凭证
    </NButton><NButton
      :loading="loading"
      :disabled="busy || loading"
      @click="load()"
    >
      更新账号列表
    </NButton><RouterLink
      class="text-link"
      to="/help/miyoushe"
    >
      授权获取手册 ↗
    </RouterLink>
  </div>
  <p class="feedback">
    国服官服授权与当前可查询记录已实测。其他服务器以实际结果为准；本地账号与米游社账号相互独立。
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
  <QrAuthorization
    v-if="qr"
    :key="qr.targetId ?? 'add'"
    v-bind="qr"
    @authorized="authorized"
    @close="qr = null"
  />
  <section
    v-if="form"
    class="surface account-form"
    aria-label="手动凭证导入"
  >
    <div class="list-heading">
      <h2>{{ form === 'replace' ? `更新米游社账号 ${account?.accountId} 的凭证` : '手动导入凭证' }}</h2><NButton
        size="small"
        :disabled="busy"
        @click="form = null; input = ''"
      >
        关闭手动导入
      </NButton>
    </div>
    <form @submit.prevent="saveInput">
      <label for="community-input">Cookie 或 JSON 文本</label><textarea
        id="community-input"
        v-model="input"
        class="native-input credential-input"
        rows="5"
        maxlength="24000"
        autocomplete="off"
        autocapitalize="off"
        :spellcheck="false"
        :disabled="busy"
        placeholder="stuid=账号ID; mid=对应mid; stoken=本人SToken"
      />
      <p class="field-hint">
        SToken 需同时提供 stuid 与 mid。只有 LToken 可以校验身份，但不能刷新祈愿。提交后清空输入，验证成功才保存；仅导入你自己的凭证。
      </p>
      <NButton
        attr-type="submit"
        type="primary"
        :loading="busy"
        :disabled="busy || !input.trim()"
      >
        验证并保存凭证
      </NButton>
    </form>
  </section>
  <p
    v-if="loading && !accounts.length"
    class="muted"
    role="status"
  >
    正在加载米游社账号…
  </p><section
    v-else-if="!accounts.length && !error"
    class="surface account-form"
  >
    <h2>还没有添加米游社账号</h2><p class="muted">
      从上方扫码添加，或手动导入本人凭证。不需要在线授权时，也可以直接使用 UIGF。
    </p><RouterLink
      class="outline-link"
      to="/data"
    >
      导入 UIGF
    </RouterLink>
  </section>
  <div
    v-if="accounts.length"
    class="accounts-layout"
  >
    <section
      class="surface community-list"
      aria-label="米游社账号列表"
    >
      <h2>已保存账号</h2><button
        v-for="entry in accounts"
        :key="entry.id"
        type="button"
        class="community-choice"
        :class="{ selected: entry.id === selectedId }"
        :aria-pressed="entry.id === selectedId"
        :disabled="busy"
        @click="choose(entry.id)"
      >
        <strong>米游社 {{ entry.accountId }}</strong><span>{{ capabilityLabel(entry.capabilities.identity) }} · {{ entry.profiles.length }} 个原神档案</span>
      </button>
    </section>
    <section
      v-if="account"
      class="surface account-form account-detail"
      aria-label="米游社账号详情"
    >
      <div class="list-heading">
        <h2>米游社 {{ account.accountId }}</h2><span class="status-badge">{{ capabilityLabel(account.capabilities.identity) }}</span>
      </div>
      <dl class="community-capabilities">
        <div><dt>角色列表</dt><dd>{{ capabilityLabel(account.capabilities.roles) }}</dd></div><div><dt>祈愿授权</dt><dd>{{ account.capabilities.wish.status === 'unverified' ? '已有 SToken，刷新时验证' : account.capabilities.wish.status === 'missing' ? '缺少 SToken，无法刷新' : capabilityLabel(account.capabilities.wish) }}</dd></div><div><dt>最近校验</dt><dd>{{ displayTime(account.capabilities.lastValidation.checkedAt) }} · {{ capabilityLabel(account.capabilities.lastValidation) }}</dd></div>
      </dl>
      <p
        v-if="account.capabilities.lastValidation.code"
        class="feedback"
      >
        {{ communityError(account.capabilities.lastValidation.code) }}
      </p>
      <div class="button-row">
        <NButton
          :disabled="busy"
          :loading="busy"
          @click="validate()"
        >
          校验账号凭证
        </NButton><NButton
          :disabled="busy"
          @click="openQr(true)"
        >
          重新扫码授权
        </NButton><NButton
          :disabled="busy"
          @click="openForm('replace')"
        >
          更新凭证
        </NButton><NButton
          :disabled="busy"
          @click="unlinkConfirm = !unlinkConfirm"
        >
          解除绑定
        </NButton>
      </div>
      <div
        v-if="unlinkConfirm"
        class="feedback error unlink-confirm"
        role="alert"
      >
        <strong>确认解绑米游社 {{ account.accountId }}？</strong><p>将删除本应用保存的凭证、解除 UID 绑定，并取消相关未完成任务。抽卡历史保留；本地解绑不会撤销米游社的上游登录。</p><div class="button-row">
          <NButton
            type="error"
            :disabled="busy"
            @click="unlink"
          >
            确认解绑并删除凭证
          </NButton><NButton
            :disabled="busy"
            @click="unlinkConfirm = false"
          >
            保留绑定
          </NButton>
        </div>
      </div>
      <h3>绑定的原神档案</h3><div
        v-if="account.profiles.length"
        class="bound-profiles"
      >
        <button
          v-for="profile in account.profiles"
          :key="profile.id"
          type="button"
          class="bound-profile"
          :class="{ selected: currentProfile?.id === profile.id }"
          :disabled="busy"
          :aria-pressed="currentProfile?.id === profile.id"
          @click="selectProfile(profile.id)"
        >
          <strong>UID {{ profile.uid }}</strong><span>{{ regionLabel(profile.region) }}{{ currentProfile?.id === profile.id ? ' · 当前档案' : ' · 选择此 UID' }}</span>
        </button>
      </div><p
        v-else
        class="feedback"
      >
        {{ account.capabilities.roles.status === 'verified' ? '角色列表读取成功，但没有可用的国服原神档案，请检查米游社绑定关系。' : '未取得原神角色列表。仅有 LToken 时不能读取角色；请补充 SToken 或 Cookie Token，并检查米游社绑定关系。' }}
      </p>
      <div
        v-if="syncProfile"
        class="button-row"
      >
        <NButton
          size="small"
          :disabled="busy"
          @click="validate(syncProfile!.id)"
        >
          仅验证当前 UID 的临时授权
        </NButton>
      </div>
      <CredentialPanel
        :key="account.id"
        :account="account"
        :disabled="busy"
      />
    </section>
  </div>
  <SyncPanel
    v-if="syncProfile && account"
    :key="syncProfile.id"
    :profile="syncProfile"
    :can-sync="account.capabilities.tokens.stoken.status === 'verified'"
  /><p
    v-else-if="account?.profiles.length"
    class="feedback"
  >
    请在上方选择此账号的 UID，再查看在线刷新任务。
  </p>
</template>
