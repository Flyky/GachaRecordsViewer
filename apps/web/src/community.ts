import type { CapabilityResult, CredentialKind, MiyousheQrSession, SyncJob } from '@gacha/contracts';
import { ApiError, errorMessage } from './auth.js';
export const credentialNames: Record<CredentialKind, string> = { stoken: 'SToken', ltoken: 'LToken', cookieToken: 'Cookie Token' };
export const capabilityLabel = (result: CapabilityResult) => ({ verified: '已验证', unverified: '尚未验证', missing: '未取得', invalid: '已失效',
  verification_required: '需要官方验证', error: '验证失败', authkey_verified: '已验证所选 UID 的临时授权' })[result.status];
export const qrActive = (session: MiyousheQrSession | null) => !!session && ['creating', 'waiting', 'scanned', 'confirming'].includes(session.status);
export const qrLabel = (status: MiyousheQrSession['status']) => ({ creating: '正在创建二维码', waiting: '等待扫描', scanned: '已扫描，请在 App 确认',
  confirming: '正在验证并保存授权', confirmed: '授权已保存', cancelled: '扫码已取消', expired: '二维码已过期', verification_required: '需要官方验证', failed: '授权未完成' })[status];
export const jobActive = (job: SyncJob) => ['queued', 'running', 'retrying'].includes(job.status);
export const jobLabel = (status: string) => ({ queued: '等待执行', running: '正在刷新', retrying: '等待重试', completed: '已完成', partial: '部分完成', failed: '失败',
  cancelled: '已取消', interrupted: '服务重启或关闭，中断待重试' } as Record<string, string>)[status] ?? '状态待更新';
export function displayTime(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无'; }
export function communityError(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : '';
  const messages: Record<string, string> = {
    INVALID_CREDENTIAL_INPUT: '无法识别凭证。请提供同一账号的完整 Cookie 或 JSON，不要混用不同账号字段。', STOKEN_MID_REQUIRED: 'SToken 还需要对应的 stuid 和 mid，请一起导入。',
    STOKEN_REQUIRED: '刷新需要 SToken。请使用 App 扫码或补充含 SToken 与 mid 的凭证。', COMMUNITY_EXISTS: '该米游社账号已经添加，请选择已有账号更新凭证或重新授权。',
    COMMUNITY_NOT_FOUND: '账号已不存在，请更新列表。', COMMUNITY_IDENTITY_MISMATCH: '授权身份与目标账号不一致，原凭证未替换。请切换正确的米游社账号后重试。',
    COMMUNITY_BUSY: '此账号还有操作正在进行，请稍后更新状态。', CREDENTIALS_CHANGED: '凭证已被另一次操作更新，请更新列表后重试。',
    CREDENTIAL_NOT_AVAILABLE: '没有保存这类凭证，请补充授权。', CREDENTIAL_DECRYPT_FAILED: '保存的凭证暂时无法解密，请联系部署管理员检查原密钥。',
    PROFILE_BINDING_CONFLICT: '同一 UID 存在多个候选档案，暂时无法自动绑定，请先处理档案冲突。', PROFILE_BOUND_ELSEWHERE: '该 UID 已绑定另一个米游社账号，请核对账号归属。',
    PROFILE_TIMEZONE_CONFLICT: '已有档案时区与国服不一致，无法自动绑定。', PROFILE_NOT_BOUND: '当前 UID 没有有效的国服绑定，请重新校验账号或选择其他 UID。',
    PROFILE_NOT_FOUND: '该档案已不存在或不可访问，请更新档案列表。',
    QR_NOT_FOUND: '扫码会话已清理或不属于本次登录，请重新创建二维码。', QR_ALREADY_ACTIVE: '当前账号已有扫码会话，请完成或取消原会话；遗失会话时最多等待 3 分钟。',
    QR_EXPIRED: '二维码已过期，请重新生成。', QR_POLL_LIMIT: '本次扫码等待已结束，请重新生成。', QR_CANCELLED: '已取消本次扫码。',
    QR_COMMITTING: '授权正在保存，暂时无法取消，请等待最终状态。', QR_ALREADY_CONFIRMED: '授权已经保存，请更新账号列表；需要删除时使用解绑。',
    QR_SESSION_INVALID: '创建二维码时的本地登录已失效，请重新登录后授权。', QR_CAPACITY: '当前扫码会话较多，请稍后再试。', QR_UNAVAILABLE: '扫码服务暂时不可用，可先使用手动导入或 UIGF。',
    MIYOUSHE_AUTH_INVALID: '上游拒绝了授权，请更新凭证或重新扫码；本地登录不受影响。', MIYOUSHE_EXPIRED: '上游授权已过期，请更新凭证或重新授权。',
    MIYOUSHE_VERIFICATION_REQUIRED: '米游社要求额外验证。请在官方 App 中处理后重新授权，也可使用其他工具导出的凭证或 UIGF。',
    MIYOUSHE_ROLE_MISMATCH: '上游身份、UID 或卡池与所选档案不一致，已停止操作，请核对账号绑定。', MIYOUSHE_CANCELLED: '上游已取消本次操作。',
    MIYOUSHE_NETWORK: '暂时无法连接米游社，请检查部署网络后重试。', MIYOUSHE_TIMEOUT: '米游社响应超时，请稍后重试。',
    MIYOUSHE_PROTOCOL: '上游返回的数据暂时无法识别，已停止对应操作；请稍后重试或使用 UIGF。', MIYOUSHE_UPSTREAM: '米游社暂时未能完成请求，请稍后重试。',
    SYNC_ALREADY_ACTIVE: '该 UID 已有刷新任务，请更新任务列表查看进度。', SYNC_QUEUE_FULL: '刷新队列已满，请稍后再试。', SYNC_NOT_FOUND: '任务不存在或不可访问，请更新列表。',
    SYNC_NOT_RETRYABLE: '该任务正在执行或已经完成。请查看当前进度，必要时另建刷新。', SYNC_BINDING_CHANGED: 'UID 绑定已变化，旧任务已停止，请更新账号后重新刷新。',
    SYNC_CANCELLED: '任务已取消，已经保存的记录仍会保留。', ACCOUNT_UNLINKED: '米游社账号已解绑，任务已取消，历史记录保留。', ROLE_UNBOUND: 'UID 已解除绑定，任务已取消。',
    SERVER_RESTARTED: '服务重启导致任务中断，可重试未完成的卡池。', SERVER_STOPPED: '服务关闭导致任务中断，可重试未完成的卡池。',
    RECORD_CONFLICT: '上游记录与本地同 ID 历史存在冲突，该页未写入，请先核对历史数据。', ITEM_ID_UNRESOLVED: '部分物品无法唯一匹配标准 ID，请更新本地物品字典后重试，或先导入 UIGF。',
    SYNC_LIMIT_EXCEEDED: '本次刷新达到时间或数量限制，已保存的记录保留。', SYNC_FAILED: '刷新未完成，已保存的记录保留，请更新状态后重试。',
  };
  return messages[code] ?? (typeof error === 'string' ? '操作未完成，请更新状态后重试。' : errorMessage(error));
}
