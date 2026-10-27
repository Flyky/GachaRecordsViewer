import { ApiError, errorMessage } from './auth.js';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const exportVersions = ['v4.0', 'v4.1', 'v4.2'].map((value) => ({ label: value, value }));
export const skippedGameLabel = (game: string) => ({ hkrpg: '崩坏：星穹铁道', nap: '绝区零', hk4e_ugc: '千星奇域' } as Record<string, string>)[game] ?? game;
export const conflictFieldLabel = (field: string) => ({ itemId: '物品 ID', gachaType: '卡池类型', pityGroup: '保底分组', timeLocal: '本地时间', timeUtc: 'UTC 时间', count: '物品数量' } as Record<string, string>)[field] ?? field;
export const blockerLabel = (code: string) => ({ AMBIGUOUS_PROFILE: '已有多个地区的同 UID 档案，暂时无法确定合并目标。', TIMEZONE_CONFLICT: '文件时区与已有档案不同，请核对来源和时区后重新导入。' } as Record<string, string>)[code] ?? code;
export function importErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return errorMessage(error);
  if (error.status === 413) return '请求超过 16 MiB，请减少单次文件内容后重试。';
  const messages: Record<string, string> = {
    UNSUPPORTED_FORMAT: '不支持旧工具内部 JSON，也不提供历史迁移。请使用 UIGF v4.0、v4.1 或 v4.2 文件。',
    UNSUPPORTED_UIGF_VERSION: '暂只支持 UIGF v4.0、v4.1、v4.2，请检查文件版本。',
    INVALID_UIGF: '文件不符合对应版本的 UIGF 标准，请检查必填字段和数据类型。',
    INVALID_RECORD: '记录的日期、卡池类型或保底分组不合法，请核对源文件。',
    INVALID_IDENTIFIER: 'UID、记录 ID 或物品 ID 必须是规定长度内的十进制字符串。',
    INVALID_UID: 'UID 不合法；较长的 UID 需使用字符串，不能使用可能丢失精度的数字。',
    INVALID_TIMEZONE: '时区必须是 -12 至 +14 之间的整数。',
    DUPLICATE_OR_INVALID_PROFILE: '文件中包含重复或不合法的原神 UID，请整理后重新导入。',
    IMPORT_LIMIT_EXCEEDED: '单次最多 32 个原神档案、100,000 条记录；请减少文件内容或过长的字段。',
    INVALID_SELECTION: '所选档案已无效，请重新预览并选择。',
    INVALID_PREVIEW_TOKEN: '文件或登录状态已变化，请重新预览。',
    PREVIEW_EXPIRED: '预览已超过 15 分钟，请重新预览后确认导入。',
    PREVIEW_STALE: '档案已有变化，请重新预览最新的合并结果。',
    IMPORT_CONFLICT: '所选档案存在冲突，本次没有写入。请重新预览并查看冲突详情。',
    EXPORT_INCOMPATIBLE_VERSION: '现有数据不符合所选版本的标准。v4.2 的记录 ID 最多 19 位，请尝试 v4.0 或 v4.1。',
    PROFILE_NOT_FOUND: '档案已不存在或不可访问，请刷新档案列表。',
  };
  let message = messages[error.code] ?? errorMessage(error);
  if (error.code === 'INVALID_UIGF' && Array.isArray(error.details)) {
    const first = error.details[0] as { path?: unknown } | undefined;
    if (typeof first?.path === 'string') message += ` 位置：${first.path || '文件根节点'}。`;
  } else if (error.code === 'INVALID_RECORD' && error.details && typeof error.details === 'object') {
    const details = error.details as { profile?: unknown; record?: unknown };
    if (typeof details.profile === 'number' && typeof details.record === 'number') message += ` 第 ${details.profile + 1} 个原神档案，第 ${details.record + 1} 条记录。`;
  }
  return message;
}
