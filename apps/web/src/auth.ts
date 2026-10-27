import { computed, shallowRef } from 'vue';
import type { AccountPasswordResponse, AdminSessionResponse, AdminUsersResponse, UserSessionResponse } from '@gacha/contracts';
import { appUrl } from './base.js';

type Role = 'user' | 'admin';
export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfter = 0, readonly details?: unknown) { super(code); }
}
export const userSession = shallowRef<UserSessionResponse | null>(null);
export const adminSession = shallowRef<AdminSessionResponse | null>(null);
const dismissed = shallowRef(false);
let reminderTag = '', userEpoch = 0, adminEpoch = 0;
let exitReason = 'expired';
export function userExitQuery() {
  if (exitReason === 'password-changed') return { notice: 'password-changed' };
  return exitReason === 'logout' ? {} : { reason: 'expired' };
}
export const showInitialReminder = computed(() => userSession.value?.user.isInitialPassword && !dismissed.value);
export function forgetUser(reason = 'expired') { exitReason = reason; userEpoch++; userSession.value = null; dismissed.value = false; reminderTag = ''; }
export function forgetAdmin() { adminEpoch++; adminSession.value = null; }
function storageGet() { try { return sessionStorage.getItem('grv.reminder'); } catch { return null; } }
export function dismissInitialReminder() {
  dismissed.value = true;
  try { sessionStorage.setItem('grv.reminder', reminderTag); } catch { /* In-memory dismissal still works. */ }
}
async function acceptUser(session: UserSessionResponse, epoch: number) {
  if (!globalThis.crypto?.subtle) {
    if (epoch !== userEpoch) return;
    dismissed.value = userSession.value?.csrfToken === session.csrfToken && dismissed.value;
    userSession.value = session; return;
  }
  // Persist only a one-way marker, never the CSRF token or session cookie.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.csrfToken));
  if (epoch !== userEpoch) return;
  reminderTag = `${session.user.id}:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  dismissed.value = storageGet() === reminderTag; userSession.value = session;
}
async function request<T>(path: string, role: Role, body?: Record<string, unknown>, timeout = 15000): Promise<T> {
  const csrf = role === 'user' ? userSession.value?.csrfToken : adminSession.value?.csrfToken;
  const epoch = role === 'user' ? userEpoch : adminEpoch;
  let response: Response;
  try {
    response = await fetch(appUrl(path), { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } : {},
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
  } catch { throw new ApiError('NETWORK_ERROR'); }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code ?? 'REQUEST_FAILED';
    if ((code === 'UNAUTHENTICATED' || code === 'SESSION_CHANGED') && epoch === (role === 'user' ? userEpoch : adminEpoch)) {
      if (role === 'user') forgetUser(); else forgetAdmin();
    }
    throw new ApiError(code, response.status, Number(response.headers.get('retry-after')) || 0, payload?.error?.details);
  }
  if (!payload) throw new ApiError('REQUEST_FAILED');
  return payload as T;
}
/** Discard a response from an account or session that has since been replaced. */
export async function userRequest<T>(path: string, body?: Record<string, unknown>, timeout = 15000): Promise<T> {
  const session = userSession.value;
  if (!session) throw new ApiError('UNAUTHENTICATED', 401);
  try {
    const result = await request<T>(path, 'user', body, timeout);
    if (userSession.value?.user.id !== session.user.id || userSession.value.csrfToken !== session.csrfToken) throw new ApiError('SESSION_CHANGED');
    return result;
  } catch (error) {
    if (userSession.value?.user.id !== session.user.id || userSession.value.csrfToken !== session.csrfToken) throw new ApiError('SESSION_CHANGED');
    throw error;
  }
}
export async function refreshUser() {
  const epoch = ++userEpoch;
  try { await acceptUser(await request<UserSessionResponse>('/api/auth/me', 'user'), epoch); }
  catch (error) { if (!(error instanceof ApiError && error.code === 'UNAUTHENTICATED')) throw error; }
}
export async function refreshAdmin() {
  const epoch = ++adminEpoch;
  try { const session = await request<AdminSessionResponse>('/api/admin/me', 'admin'); if (epoch === adminEpoch) adminSession.value = session; }
  catch (error) { if (!(error instanceof ApiError && error.code === 'UNAUTHENTICATED')) throw error; }
}
export async function loginUser(username: string, password: string) {
  forgetUser(); const epoch = userEpoch;
  await acceptUser(await request<UserSessionResponse>('/api/auth/login', 'user', { username, password }), epoch);
}
export async function loginAdmin(password: string) {
  forgetAdmin(); const epoch = adminEpoch;
  const session = await request<AdminSessionResponse>('/api/admin/login', 'admin', { username: 'admin', password });
  if (epoch === adminEpoch) adminSession.value = session;
}
export async function logout(role: Role) {
  try { await request<void>(`/api/${role === 'user' ? 'auth' : 'admin'}/logout`, role, {}); }
  catch (error) { if (!(error instanceof ApiError && error.code === 'UNAUTHENTICATED')) throw error; }
  if (role === 'user') forgetUser('logout'); else forgetAdmin();
}
export async function changePassword(currentPassword: string, newPassword: string) {
  await request<void>('/api/auth/password', 'user', { currentPassword, newPassword }); forgetUser('password-changed');
}
export const listUsers = () => request<AdminUsersResponse>('/api/admin/users', 'admin');
export const createUser = (username: string) => request<AccountPasswordResponse>('/api/admin/users', 'admin', { username });
export const resetPassword = (id: string) => request<AccountPasswordResponse>(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, 'admin', {});
export function errorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return '操作未完成，请稍后重试。';
  if (error.code === 'RATE_LIMITED') return `尝试次数较多，请约 ${Math.max(1, Math.ceil(error.retryAfter / 60))} 分钟后再试。`;
  const messages: Record<string, string> = {
    NETWORK_ERROR: '暂时无法连接服务，请检查网络后重试。', INVALID_CREDENTIALS: '账号或密码不正确，请重新输入。',
    UNAUTHENTICATED: '登录已失效，请重新登录。', SESSION_CHANGED: '账号密码已变化，请重新登录。',
    USERNAME_TAKEN: '这个账号已存在，请换一个名称。', INVALID_USERNAME: '账号需为 3–32 位字母、数字、点、短横线或下划线，以字母或数字开头；不能使用 admin。',
    INVALID_REQUEST: '请检查填写内容是否符合要求。', USER_NOT_FOUND: '该账号已不存在，请刷新列表。',
    ORIGIN_REJECTED: '当前访问地址与服务配置不一致，请使用正确的站点地址。', CSRF_REJECTED: '登录状态已变化，请刷新页面后重试。',
  };
  return messages[error.code] ?? '操作未完成，请稍后重试。';
}
