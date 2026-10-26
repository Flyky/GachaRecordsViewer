<script setup lang="ts">
import { ref } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '../components/BrandMark.vue';
import { errorMessage, loginUser } from '../auth.js';
import { loginDestination } from '../router.js';
const route = useRoute(), router = useRouter();
const username = ref(''), password = ref(''), error = ref(''), busy = ref(false);
async function submit() {
  if (busy.value) return;
  error.value = ''; busy.value = true;
  try { await loginUser(username.value.trim(), password.value); password.value = ''; await router.replace(loginDestination(route.query.redirect)); }
  catch (cause) { error.value = errorMessage(cause); password.value = ''; }
  finally { busy.value = false; }
}
</script>

<template>
  <main class="login-page">
    <section
      class="login-story"
      aria-label="祈愿档案"
    >
      <BrandMark />
      <div class="story-copy">
        <p class="eyebrow">
          YOUR WISHES, YOUR STORY
        </p><h1>每一次祈愿，<br>都有迹可循。</h1><p>收藏旅途中的幸运，<br>也记住那些等待星光的日子。</p>
      </div>
      <div
        class="orbit-art"
        aria-hidden="true"
      >
        <i /><i /><span>✦</span><b>✧</b>
      </div>
      <p class="story-footer">
        原神 · 私人祈愿记录
      </p>
    </section>
    <section class="login-panel">
      <div class="login-form-wrap">
        <p class="eyebrow">
          欢迎回来
        </p><h2>登录你的档案</h2><p class="muted">
          使用本应用的账号，继续你的祈愿旅程。
        </p>
        <p
          v-if="route.query.notice === 'password-changed'"
          class="feedback success"
          role="status"
        >
          密码已修改，请使用新密码重新登录。
        </p>
        <p
          v-else-if="route.query.reason === 'expired'"
          class="feedback"
          role="status"
        >
          登录已失效，请重新登录。
        </p>
        <p
          v-else-if="route.query.reason === 'unavailable'"
          class="feedback"
          role="status"
        >
          暂时无法连接服务，请稍后重试。
        </p>
        <form
          class="stack-form"
          @submit.prevent="submit"
        >
          <div class="field">
            <label for="login-username">账号</label><NInput
              v-model:value="username"
              size="large"
              placeholder="请输入账号"
              :disabled="busy"
              :maxlength="64"
              :input-props="{ id: 'login-username', autocomplete: 'username', required: true }"
            />
          </div>
          <div class="field">
            <label for="login-password">密码</label><NInput
              v-model:value="password"
              size="large"
              type="password"
              show-password-on="click"
              placeholder="请输入密码"
              :disabled="busy"
              :maxlength="1024"
              :input-props="{ id: 'login-password', autocomplete: 'current-password', required: true }"
            />
          </div>
          <p
            v-if="error"
            class="feedback error"
            role="alert"
          >
            {{ error }}
          </p>
          <NButton
            type="primary"
            size="large"
            block
            attr-type="submit"
            :loading="busy"
            :disabled="busy"
          >
            登录
          </NButton>
        </form>
        <p class="form-help">
          账号由管理员创建。首次登录请使用管理员提供的初始密码；忘记密码时请联系管理员重置。
        </p>
      </div>
      <footer>GachaRecordsViewer <span>·</span> 留下每一份幸运</footer>
    </section>
  </main>
</template>
