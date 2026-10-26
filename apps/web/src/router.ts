import { createRouter, createWebHistory } from 'vue-router';
import ShellView from './views/ShellView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ShellView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
