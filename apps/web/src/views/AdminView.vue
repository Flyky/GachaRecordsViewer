<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { NButton, NInput, NModal, NSpin, NTag } from 'naive-ui';
import type { LocalUser, DictionaryStatus } from '@gacha/contracts';
import BrandMark from '../components/BrandMark.vue';
import AdminBanners from '../components/AdminBanners.vue';
import AdminFeatures from '../components/AdminFeatures.vue';
import { adminSession, createUser, errorMessage, listUsers, loginAdmin, logout, refreshAdmin, resetPassword, getDictionary, refreshDictionary } from '../auth.js';
const checking = ref(true), busy = ref(false), password = ref(''), username = ref('');
const error = ref(''), success = ref(''), users = ref<LocalUser[]>([]), target = ref<LocalUser | null>(null), showReset = ref(false);
const listError = ref(''), loadingUsers = ref(false);
const dictionary = shallowRef<DictionaryStatus | null>(null), dictionaryBusy = ref(false), dictionaryError = ref(''), dictionaryNotice = ref('');
let active = true, dictionaryEpoch = 0;
onUnmounted(() => { active = false; dictionaryEpoch++; });
watch(adminSession, (session) => { if (!session) { dictionaryEpoch++; dictionary.value = null; dictionaryBusy.value = false; dictionaryError.value = ''; dictionaryNotice.value = ''; } });
async function loadDictionary(refresh = false) {
  if (dictionaryBusy.value) return;
  const epoch = ++dictionaryEpoch; dictionaryBusy.value = true; dictionaryError.value = ''; dictionaryNotice.value = '';
  try {
    const result = await (refresh ? refreshDictionary() : getDictionary());
    if (!active || epoch !== dictionaryEpoch || !adminSession.value) return;
    dictionary.value = result;
    if (refresh) dictionaryNotice.value = `字典已刷新，共 ${result.count} 个物品。新的查询、导入和刷新会立即使用，无需重启。`;
  } catch (cause) { if (active && epoch === dictionaryEpoch && adminSession.value) dictionaryError.value = errorMessage(cause); }
  finally { if (active && epoch === dictionaryEpoch) dictionaryBusy.value = false; }
}
watch(adminSession, (session) => { if (!session) { users.value = []; target.value = null; showReset.value = false; success.value = ''; } });
async function loadUsers() {
  loadingUsers.value = true; listError.value = '';
  try { const result = await listUsers(); if (adminSession.value) users.value = result.users; } catch (cause) { listError.value = errorMessage(cause); }
  finally { loadingUsers.value = false; }
}
onMounted(async () => {
  try { await refreshAdmin(); if (adminSession.value) await Promise.all([loadUsers(), loadDictionary()]); } catch (cause) { error.value = errorMessage(cause); }
  finally { checking.value = false; }
});
async function signIn() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await loginAdmin(password.value); password.value = ''; await Promise.all([loadUsers(), loadDictionary()]); } catch (cause) { error.value = errorMessage(cause); password.value = ''; }
  finally { busy.value = false; }
}
async function signOut() {
  busy.value = true; error.value = '';
  try { await logout('admin'); } catch (cause) { error.value = errorMessage(cause); }
  finally { busy.value = false; }
}
async function register() {
  if (busy.value) return;
  busy.value = true; error.value = ''; success.value = '';
  try {
    const result = await createUser(username.value.trim()); username.value = '';
    success.value = `账号「${result.user.username}」已创建，初始密码为 ${result.initialPassword}。请将账号和密码告知使用者。`; await loadUsers();
  } catch (cause) { error.value = errorMessage(cause); }
  finally { busy.value = false; }
}
function confirmReset(user: LocalUser) { target.value = user; showReset.value = true; }
async function reset() {
  if (!target.value || busy.value) return false;
  busy.value = true; error.value = ''; success.value = '';
  try {
    const result = await resetPassword(target.value.id); showReset.value = false; target.value = null;
    success.value = `账号「${result.user.username}」的密码已重置为 ${result.initialPassword}，旧登录已失效。`; await loadUsers();
  } catch (cause) { error.value = errorMessage(cause); showReset.value = false; }
  finally { busy.value = false; }
  return false;
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-header">
      <BrandMark /><span class="admin-label">管理页面</span><NButton
        v-if="adminSession"
        quaternary
        :loading="busy"
        :disabled="busy"
        @click="signOut"
      >
        退出管理
      </NButton>
    </header>
    <main
      v-if="checking"
      class="admin-loading"
    >
      <NSpin size="large" /><p>正在检查登录状态…</p>
    </main>
    <main
      v-else-if="!adminSession"
      class="admin-login surface"
    >
      <p class="eyebrow">
        ADMINISTRATOR
      </p><h1>管理员登录</h1><p class="muted">
        登录后可管理普通账号和刷新物品字典。
      </p>
      <form
        class="stack-form"
        @submit.prevent="signIn"
      >
        <div class="field">
          <label for="admin-username">管理员账号</label><NInput
            value="admin"
            readonly
            :input-props="{ id: 'admin-username', autocomplete: 'username' }"
          />
        </div>
        <div class="field">
          <label for="admin-password">管理员密码</label><NInput
            v-model:value="password"
            type="password"
            show-password-on="click"
            :maxlength="1024"
            :disabled="busy"
            :input-props="{ id: 'admin-password', autocomplete: 'current-password', required: true }"
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
          block
          attr-type="submit"
          :loading="busy"
          :disabled="busy"
        >
          登录管理
        </NButton>
      </form>
    </main>
    <main
      v-else
      class="admin-content"
    >
      <section class="page-heading">
        <p class="eyebrow">
          ADMINISTRATION
        </p><h1>管理设置</h1><p class="muted">
          管理普通账号，更新原神物品字典。
        </p>
      </section>
      <p
        v-if="success"
        class="feedback success"
        role="status"
      >
        {{ success }}
      </p><p
        v-if="error"
        class="feedback error"
        role="alert"
      >
        {{ error }}
      </p>
      <AdminBanners />
      <AdminFeatures />
      <section class="surface dictionary-settings">
        <div class="list-heading">
          <h2>物品字典</h2><NButton
            :loading="dictionaryBusy"
            :disabled="busy || dictionaryBusy"
            @click="loadDictionary(true)"
          >
            刷新字典
          </NButton>
        </div>
        <p class="muted">
          获取最新角色与武器名称、ID、类型和星级。更新后立即生效，重启后保留；失败时继续使用原字典。
        </p>
        <p
          v-if="dictionary"
          class="field-hint dictionary-info"
        >
          {{ dictionary.storage === 'database' ? '已保存的在线字典' : '随应用内置字典' }} · {{ dictionary.count }} 个物品<br>
          {{ dictionary.source }} · {{ dictionary.version }}<br>
          获取时间：{{ new Date(dictionary.updatedAt).toLocaleString() }}
        </p>
        <p
          v-if="dictionary?.cacheWarning"
          class="feedback"
        >
          保存的字典暂不可用，当前使用内置字典，可尝试刷新。
        </p>
        <p
          v-if="dictionaryError"
          class="feedback error"
          role="alert"
        >
          {{ dictionaryError }}
        </p>
        <p
          v-if="dictionaryNotice"
          class="feedback success"
          role="status"
        >
          {{ dictionaryNotice }}
        </p>
      </section>
      <div class="admin-grid">
        <section class="surface create-account">
          <h2>创建普通账号</h2><p class="muted">
            新账号使用初始密码登录。
          </p>
          <form
            class="stack-form"
            @submit.prevent="register"
          >
            <div class="field">
              <label for="new-username">账号名称</label><NInput
                v-model:value="username"
                :maxlength="32"
                :disabled="busy"
                placeholder="例如 traveler"
                :input-props="{ id: 'new-username', autocomplete: 'off', required: true }"
              /><p class="field-hint">
                3–32 位字母、数字、点、短横线或下划线，以字母或数字开头。
              </p>
            </div>
            <div class="initial-password">
              初始密码 <strong>12345678</strong>
            </div>
            <NButton
              type="primary"
              block
              attr-type="submit"
              :loading="busy"
              :disabled="busy"
            >
              创建账号
            </NButton>
          </form>
        </section>
        <section class="surface account-list">
          <div class="list-heading">
            <h2>重置账号密码 <small>{{ users.length }}</small></h2><NButton
              quaternary
              size="small"
              :loading="loadingUsers"
              :disabled="busy || loadingUsers"
              @click="loadUsers"
            >
              刷新列表
            </NButton>
          </div>
          <p class="muted">
            重置为初始密码，并使该账号的旧登录失效。
          </p>
          <p
            v-if="listError"
            class="feedback error"
            role="alert"
          >
            {{ listError }}
          </p>
          <div
            v-if="!users.length && !loadingUsers && !listError"
            class="list-empty"
          >
            还没有普通账号，可以先创建一个。
          </div>
          <ul
            v-else
            class="users-list"
          >
            <li
              v-for="user in users"
              :key="user.id"
            >
              <div>
                <strong>{{ user.username }}</strong><NTag
                  size="small"
                  :bordered="false"
                  :type="user.isInitialPassword ? 'warning' : 'default'"
                >
                  {{ user.isInitialPassword ? '初始密码' : '已修改密码' }}
                </NTag>
              </div><NButton
                size="small"
                :disabled="busy"
                :aria-label="`重置 ${user.username} 的密码`"
                @click="confirmReset(user)"
              >
                重置密码
              </NButton>
            </li>
          </ul>
        </section>
      </div>
    </main>
    <NModal
      v-model:show="showReset"
      preset="dialog"
      title="确认重置密码"
      positive-text="确认重置"
      negative-text="取消"
      :loading="busy"
      :mask-closable="!busy"
      :closable="!busy"
      :close-on-esc="!busy"
      :negative-button-props="{ disabled: busy }"
      :positive-button-props="{ disabled: busy }"
      @positive-click="reset"
    >
      <p>将账号「{{ target?.username }}」的密码重置为 <strong>12345678</strong>。</p><p>该账号在所有设备上的旧登录都会失效。已保存的记录不受影响。</p>
    </NModal>
  </div>
</template>
