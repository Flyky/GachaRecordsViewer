import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { OperationJob } from '@gacha/contracts';
import { ApiError, userRequest, userSession } from './auth.js';
export const operationActive = (job: OperationJob | null) => job?.status === 'queued' || job?.status === 'running';
export const operationLabel = (status: string) => ({ queued: '等待执行', running: '正在执行', completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
export function operationMessage(value: unknown): string {
  const code = value instanceof ApiError ? value.code : typeof value === 'string' ? value : '';
  return ({ INVALID_WISH_LINK: '请粘贴完整的原神祈愿记录链接。', WISH_LINK_REGION_MISMATCH: '链接与所选服务器不匹配，请检查服务器选项。',
    WISH_LINK_EMPTY: '链接未返回可见记录，未创建空档案。', NO_COMMUNITY_ACCOUNTS: '请先在米游社账号页面添加账号。',
    COOKIE_TOKEN_REQUIRED: '缺少 Cookie Token，请扫码授权或更新凭证。', CHECKIN_FIRST_BIND: '首次绑定，请先在米游社 App 手动签到一次。',
    CHECKIN_NOT_CONFIRMED: '未能确认签到结果，重新执行时会先检查官方状态。', CREDENTIALS_CHANGED: '凭证已变更，请重新执行任务。',
    COMMUNITY_NOT_FOUND: '米游社账号已解绑，请刷新账号列表。', MIYOUSHE_VERIFICATION_REQUIRED: '请先在米游社 App 完成安全验证，再回来重试。',
    MIYOUSHE_AUTH_INVALID: '授权失效，请更新凭证或重新获取祈愿链接。', MIYOUSHE_EXPIRED: '授权已过期，请更新凭证或重新获取链接。',
    MIYOUSHE_ROLE_MISMATCH: '上游角色与任务不一致，已停止该项处理。', MIYOUSHE_NETWORK: '上游网络暂不可用，请稍后重试。', MIYOUSHE_TIMEOUT: '上游请求超时，请检查结果后再重试。',
    ITEM_ID_UNRESOLVED: '物品暂不在字典中，请联系管理员刷新字典后重试。', TIMEZONE_CONFLICT: '已有档案时区与所选服务器不同。',
    REGION_CONFLICT: '已有档案服务器与选择不同，请检查服务器。', AMBIGUOUS_PROFILE: '同一 UID 有多个档案，无法自动确定合并目标。',
    RECORD_CONFLICT: '记录与已有历史冲突，该页未写入，原历史保留。', OPERATION_BUSY: '已有同类任务，请查看任务状态。', OPERATION_QUEUE_FULL: '任务较多，请稍后再试。',
    OPERATION_LIMIT: '达到处理上限，已保存结果保留，请稍后重试。', NETWORK_ERROR: '暂时无法连接服务，请先检查任务状态再重试。', UNAUTHENTICATED: '登录已失效，请重新登录。',
    CSRF_REJECTED: '登录状态已变化，请刷新页面后重试。', ORIGIN_REJECTED: '访问地址与服务配置不一致。', OPERATION_CANCELLED: '已取消，已完成的签到和记录保留。',
    OPERATION_UNAVAILABLE: '服务正在停止，请稍后重试。',
  } as Record<string, string>)[code] ?? '暂未完成，请稍后重试；必要时在官方 App 检查账号状态。';
}
export function useOperation<T extends OperationJob>(base: string, onFinished?: (job: T) => Promise<void>) {
  const job = shallowRef<T | null>(null), busy = ref(false), loading = ref(false), error = ref('');
  const running = computed(() => operationActive(job.value));
  let active = true, revision = 0, timer: ReturnType<typeof setTimeout> | undefined, lastFinished = '';
  const stop = () => { globalThis.clearTimeout(timer); timer = undefined; };
  function schedule() { stop(); if (active && running.value && !document.hidden) timer = setTimeout(() => { void load(); }, 1500); }
  async function accept(value: T | null) {
    job.value = value;
    if (value && !operationActive(value) && lastFinished !== `${value.id}:${value.status}`) { lastFinished = `${value.id}:${value.status}`; await onFinished?.(value); }
  }
  async function load() {
    if (loading.value || !userSession.value) return;
    const current = revision; loading.value = true;
    try { const response = await userRequest<{ job: T | null }>(`${base}/job`); if (active && current === revision) { await accept(response.job); if (active && current === revision) error.value = ''; } }
    catch (cause) { if (active && current === revision) error.value = operationMessage(cause); }
    finally { if (active && current === revision) { loading.value = false; schedule(); } }
  }
  async function start(payload: Record<string, unknown>) {
    if (busy.value || loading.value || running.value) return false;
    const current = ++revision; busy.value = true; error.value = ''; stop();
    try { const response = await userRequest<{ job: T }>(`${base}/jobs`, payload); if (!active || current !== revision) return false; await accept(response.job); return active && current === revision; }
    catch (cause) { if (active && current === revision) { await load(); if (active && current === revision) error.value = operationMessage(cause); } return false; }
    finally { if (active && current === revision) { busy.value = false; schedule(); } }
  }
  async function cancel() {
    if (busy.value) return;
    loading.value = false;
    const current = ++revision; busy.value = true; error.value = ''; stop();
    try { const response = await userRequest<{ job: T }>(`${base}/job/cancel`, {}); if (active && current === revision) await accept(response.job); }
    catch (cause) { if (active && current === revision) error.value = operationMessage(cause); }
    finally { if (active && current === revision) { busy.value = false; schedule(); } }
  }
  function visibility() { if (document.hidden) stop(); else void load(); }
  watch(() => userSession.value?.user.id, () => { revision++; stop(); job.value = null; busy.value = false; loading.value = false; error.value = ''; lastFinished = ''; if (userSession.value) void load(); }, { immediate: true });
  onMounted(() => document.addEventListener('visibilitychange', visibility));
  onUnmounted(() => { active = false; revision++; stop(); document.removeEventListener('visibilitychange', visibility); });
  return { job, busy, loading, error, running, load, start, cancel };
}
