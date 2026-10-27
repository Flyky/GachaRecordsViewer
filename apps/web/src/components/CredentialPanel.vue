<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import type { CommunityAccount, CredentialKind, CredentialRevealResponse, CredentialExportResponse } from '@gacha/contracts';
import { userRequest } from '../auth.js';
import { capabilityLabel, communityError, credentialNames } from '../community.js';
const props = defineProps<{ account: CommunityAccount; disabled: boolean }>();
const revealed = shallowRef<Partial<Record<CredentialKind, CredentialRevealResponse>>>({}), busy = ref<CredentialKind | 'bundle' | null>(null), error = ref(''), notice = ref(''), importJson = ref('');
let active = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
function hide() { generation++; revealed.value = {}; importJson.value = ''; globalThis.clearTimeout(timer); timer = undefined; busy.value = null; notice.value = ''; }
function armTimer() { timer ??= setTimeout(hide, 60000); }
function visibility() { if (document.hidden) hide(); }
onMounted(() => { globalThis.window.addEventListener('blur', hide); document.addEventListener('visibilitychange', visibility); });
onUnmounted(() => { active = false; hide(); globalThis.window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', visibility); });
watch(() => [props.account.id, props.account.capabilities.lastValidation.checkedAt, props.disabled], hide);
async function reveal(type: CredentialKind, copy = false) {
  if (busy.value || props.disabled) return;
  const revision = ++generation; busy.value = type; error.value = ''; notice.value = '';
  try {
    const value = await userRequest<CredentialRevealResponse>(`/api/community/accounts/${encodeURIComponent(props.account.id)}/reveal`, { type });
    if (!active || revision !== generation || document.hidden) return;
    if (copy) {
      if (!globalThis.navigator.clipboard?.writeText) { error.value = '当前浏览器不支持安全复制，请点击查看后手动复制。'; return; }
      try { await globalThis.navigator.clipboard.writeText(value.value); if (active && revision === generation) notice.value = `${credentialNames[type]} 已复制。`; }
      catch { if (active && revision === generation) error.value = '浏览器未允许复制，请点击查看后手动复制。'; }
    } else {
      revealed.value = { ...revealed.value, [type]: value }; armTimer();
    }
  } catch (cause) { if (active && revision === generation) error.value = communityError(cause); }
  finally { if (active && revision === generation) busy.value = null; }
}
async function copyCredentials() {
  if (busy.value || props.disabled) return;
  const revision = ++generation; busy.value = 'bundle'; error.value = ''; notice.value = ''; importJson.value = '';
  try {
    const result = await userRequest<CredentialExportResponse>(`/api/community/accounts/${encodeURIComponent(props.account.id)}/export-credentials`, {});
    if (!active || revision !== generation || document.hidden) return;
    const text = JSON.stringify(result.credentials, null, 2);
    try {
      if (!globalThis.navigator.clipboard?.writeText) throw new Error();
      await globalThis.navigator.clipboard.writeText(text);
      if (active && revision === generation) notice.value = '凭证 JSON 已复制，可直接粘贴到“手动导入凭证”。';
    } catch {
      if (!active || revision !== generation || document.hidden) return;
      importJson.value = text; armTimer(); error.value = '浏览器未允许自动复制，请手动复制下方完整 JSON。';
    }
  } catch (cause) { if (active && revision === generation) error.value = communityError(cause); }
  finally { if (active && revision === generation) busy.value = null; }
}
</script>

<template>
  <section
    class="credential-panel"
    aria-label="本人 Token"
  >
    <div class="list-heading">
      <h3>本人 Token</h3><div class="button-row">
        <NButton
          size="small"
          :disabled="disabled || !!busy || !account.credentials.some((entry) => entry.present)"
          :loading="busy === 'bundle'"
          @click="copyCredentials"
        >
          复制凭证
        </NButton><NButton
          size="small"
          :disabled="!Object.keys(revealed).length && !importJson && !busy"
          @click="hide"
        >
          隐藏全部
        </NButton>
      </div>
    </div>
    <div
      v-if="importJson"
      class="credential-export"
    >
      <label for="credential-import-json">可手动导入的凭证 JSON</label>
      <NInput
        id="credential-import-json"
        :value="importJson"
        type="textarea"
        readonly
        :autosize="{ minRows: 5, maxRows: 10 }"
        :input-props="{ spellcheck: false, autocomplete: 'off' }"
      />
    </div>
    <p class="field-hint">
      只有点击查看或复制才读取明文。查看后 60 秒、窗口失焦或离开页面会隐藏；请勿公开分享。
    </p>
    <div
      v-for="entry in account.credentials"
      :key="entry.type"
      class="credential-row"
    >
      <div class="credential-heading">
        <strong>{{ credentialNames[entry.type] }}</strong><span class="muted">{{ capabilityLabel(account.capabilities.tokens[entry.type]) }}</span>
      </div>
      <div class="credential-value">
        {{ revealed[entry.type]?.value ?? (entry.present ? '••••••••' : '未取得') }}
      </div>
      <p
        v-if="revealed[entry.type]"
        class="field-hint credential-context"
      >
        账号 ID：{{ revealed[entry.type]!.accountId }} · mid：{{ revealed[entry.type]!.mid ?? '未取得' }}
      </p>
      <div class="button-row">
        <NButton
          size="small"
          :disabled="disabled || !!busy || !entry.present"
          :loading="busy === entry.type"
          @click="reveal(entry.type)"
        >
          查看 {{ credentialNames[entry.type] }}
        </NButton>
        <NButton
          size="small"
          :disabled="disabled || !!busy || !entry.present"
          @click="reveal(entry.type, true)"
        >
          复制 {{ credentialNames[entry.type] }}
        </NButton>
      </div>
    </div>
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
