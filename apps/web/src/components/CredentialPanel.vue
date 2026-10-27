<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { CommunityAccount, CredentialKind, CredentialRevealResponse } from '@gacha/contracts';
import { userRequest } from '../auth.js';
import { capabilityLabel, communityError, credentialNames } from '../community.js';
const props = defineProps<{ account: CommunityAccount; disabled: boolean }>();
const revealed = shallowRef<Partial<Record<CredentialKind, CredentialRevealResponse>>>({}), busy = ref<CredentialKind | null>(null), error = ref(''), notice = ref('');
let active = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
function hide() { generation++; revealed.value = {}; globalThis.clearTimeout(timer); busy.value = null; notice.value = ''; }
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
      const first = !Object.keys(revealed.value).length;
      revealed.value = { ...revealed.value, [type]: value }; if (first) timer = setTimeout(hide, 60000);
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
      <h3>本人 Token</h3><NButton
        size="small"
        :disabled="!Object.keys(revealed).length"
        @click="hide"
      >
        隐藏全部
      </NButton>
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
