<script setup lang="ts">
import { ref } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { useRouter } from 'vue-router';
import { ApiError, changePassword, errorMessage, userSession } from '../auth.js';
const router = useRouter();
const currentPassword = ref(''), newPassword = ref(''), confirmation = ref(''), error = ref(''), busy = ref(false);
async function submit() {
  if (busy.value) return;
  error.value = '';
  if (newPassword.value.length < 8 || newPassword.value.length > 128) { error.value = '新密码长度需为 8–128 个字符。'; return; }
  if (newPassword.value !== confirmation.value) { error.value = '两次输入的新密码不一致。'; return; }
  busy.value = true;
  try {
    await changePassword(currentPassword.value, newPassword.value);
    currentPassword.value = ''; newPassword.value = ''; confirmation.value = '';
    await router.replace({ path: '/login', query: { notice: 'password-changed' } });
  } catch (cause) { error.value = cause instanceof ApiError && cause.code === 'INVALID_CREDENTIALS' ? '当前密码不正确，请重新输入。' : errorMessage(cause); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">
      ACCOUNT SETTINGS
    </p><h1>个人设置</h1><p class="muted">
      管理你的登录账号与密码。
    </p>
  </section>
  <section class="settings-card surface">
    <div class="section-heading">
      <h2>修改密码</h2><p class="muted">
        当前账号：{{ userSession?.user.username }}
      </p>
    </div>
    <form
      class="stack-form"
      @submit.prevent="submit"
    >
      <div class="field">
        <label for="current-password">当前密码</label><NInput
          v-model:value="currentPassword"
          type="password"
          show-password-on="click"
          :disabled="busy"
          :input-props="{ id: 'current-password', autocomplete: 'current-password', required: true }"
        />
      </div>
      <div class="field">
        <label for="new-password">新密码</label><NInput
          v-model:value="newPassword"
          type="password"
          show-password-on="click"
          placeholder="8–128 个字符"
          :maxlength="128"
          :disabled="busy"
          :input-props="{ id: 'new-password', autocomplete: 'new-password', required: true }"
        />
      </div>
      <div class="field">
        <label for="confirm-password">确认新密码</label><NInput
          v-model:value="confirmation"
          type="password"
          show-password-on="click"
          :maxlength="128"
          :disabled="busy"
          :input-props="{ id: 'confirm-password', autocomplete: 'new-password', required: true }"
        />
      </div>
      <p class="form-help">
        修改后，所有设备上的旧登录都会失效，需要使用新密码重新登录。
      </p>
      <p
        v-if="error"
        class="feedback error"
        role="alert"
      >
        {{ error }}
      </p>
      <div>
        <NButton
          type="primary"
          attr-type="submit"
          :loading="busy"
          :disabled="busy"
        >
          保存新密码
        </NButton>
      </div>
    </form>
  </section>
</template>
