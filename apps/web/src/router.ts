import { createRouter, createWebHistory } from 'vue-router';
import WorkspaceView from './views/WorkspaceView.vue';
import { refreshUser, userSession } from './auth.js';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/LoginView.vue') },
    { path: '/admin', component: () => import('./views/AdminView.vue') },
    { path: '/', component: WorkspaceView, meta: { requiresUser: true }, children: [
      { path: '', component: () => import('./views/OverviewView.vue') },
      { path: 'settings', component: () => import('./views/SettingsView.vue') },
    ] },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

export function loginDestination(value: unknown) { return value === '/settings' ? '/settings' : '/'; }
router.beforeEach(async (to) => {
  if (to.meta.requiresUser || to.path === '/login') {
    try { await refreshUser(); }
    catch {
      if (to.meta.requiresUser) return { path: '/login', query: { reason: 'unavailable', redirect: to.path } };
      return;
    }
    if (to.meta.requiresUser && !userSession.value) return { path: '/login', query: { redirect: to.path } };
    if (to.path === '/login' && userSession.value) return loginDestination(to.query.redirect);
  }
});
