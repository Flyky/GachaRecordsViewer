<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import BrandMark from '../components/BrandMark.vue';
import { dismissInitialReminder, errorMessage, logout, refreshUser, showInitialReminder, userSession, userExitQuery } from '../auth.js';
import { profiles, profilesLoading, profilesError, selectedProfileId, selectProfile, refreshProfiles } from '../profiles.js';
const router = useRouter(), route = useRoute(), error = ref(''), busy = ref(false);
watch(userSession, (session) => { if (!session) void router.replace({ path: '/login', query: userExitQuery() }); });
async function signOut() {
  busy.value = true; error.value = '';
  try { await logout('user'); await router.replace('/login'); } catch (cause) { error.value = errorMessage(cause); }
  finally { busy.value = false; }
}
async function refreshOnFocus() { try { await refreshUser(); await refreshProfiles(); } catch { /* Keep the current view during a temporary network failure. */ } }
onMounted(() => globalThis.addEventListener('focus', refreshOnFocus));
onUnmounted(() => globalThis.removeEventListener('focus', refreshOnFocus));
</script>

<template>
  <div
    v-if="userSession"
    class="workspace"
  >
    <aside class="sidebar">
      <BrandMark />
      <div class="profile-picker">
        <label for="profile-select">当前游戏档案</label><NSelect
          id="profile-select"
          :value="selectedProfileId"
          :options="profiles.map((profile) => ({ label: `原神 · ${profile.uid}`, value: profile.id }))"
          :loading="profilesLoading"
          :disabled="profilesLoading || !profiles.length"
          :placeholder="profilesLoading ? '正在加载档案…' : profilesError ? '档案加载失败' : '暂无游戏档案'"
          aria-label="当前游戏档案"
          @update:value="selectProfile"
        />
      </div>
      <nav
        aria-label="主导航"
        class="main-nav"
      >
        <RouterLink
          to="/"
          :class="{ active: route.path === '/' }"
        >
          <span aria-hidden="true">◈</span>档案概览
        </RouterLink>
        <div class="nav-label">
          祈愿记录
        </div>
        <RouterLink
          to="/records"
          active-class="active"
        >
          <span aria-hidden="true">☷</span>查询记录
        </RouterLink>
        <span
          class="nav-pending"
          aria-disabled="true"
        ><span aria-hidden="true">▥</span>统计分析<small>即将开放</small></span>
        <RouterLink
          to="/data"
          active-class="active"
        >
          <span aria-hidden="true">▤</span>数据管理
        </RouterLink>
        <div class="nav-label">
          账号
        </div>
        <RouterLink
          to="/settings"
          active-class="active"
        >
          <span aria-hidden="true">⚙</span>个人设置
        </RouterLink>
      </nav>
      <p class="sidebar-foot">
        GachaRecordsViewer<br>你的私人祈愿档案
      </p>
    </aside>
    <div class="workspace-body">
      <header class="workspace-header">
        <span class="breadcrumb">祈愿档案 <span>/</span> {{ route.path === '/settings' ? '个人设置' : route.path === '/data' ? '数据管理' : route.path === '/records' ? '查询记录' : '概览' }}</span>
        <div class="user-actions">
          <span
            class="avatar"
            aria-hidden="true"
          >{{ userSession.user.username.slice(0, 1).toUpperCase() }}</span><span>{{ userSession.user.username }}</span><NButton
            quaternary
            size="small"
            :loading="busy"
            :disabled="busy"
            @click="signOut"
          >
            退出登录
          </NButton>
        </div>
      </header>
      <main class="workspace-main">
        <div
          v-if="profilesError"
          class="feedback error profile-load-error"
          role="alert"
        >
          <span>{{ profilesError }}</span>
          <NButton
            size="small"
            :loading="profilesLoading"
            :disabled="profilesLoading"
            @click="refreshProfiles"
          >
            重试
          </NButton>
        </div>
        <p
          v-if="error"
          class="feedback error"
          role="alert"
        >
          {{ error }}
        </p>
        <section
          v-if="showInitialReminder"
          class="password-reminder"
          aria-label="初始密码提醒"
        >
          <div><strong>你仍在使用初始密码</strong><p>建议设置一个自己的密码，也可以稍后再改。</p></div>
          <div class="reminder-actions">
            <RouterLink
              class="text-link"
              to="/settings"
            >
              修改密码
            </RouterLink><NButton
              quaternary
              size="small"
              @click="dismissInitialReminder"
            >
              暂时忽略
            </NButton>
          </div>
        </section>
        <RouterView :key="userSession.user.id" />
      </main>
    </div>
  </div>
</template>
