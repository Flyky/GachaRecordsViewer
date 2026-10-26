export class GachaError extends Error {
  constructor(readonly code: 'INVALID_ID' | 'INVALID_TIME' | 'INVALID_TIMEZONE' | 'UNSUPPORTED_POOL' | 'POOL_GROUP_MISMATCH' | 'DUPLICATE_ID' | 'INVALID_HISTORY_BOUNDARY' | 'INVALID_METADATA') {
    super(code); this.name = 'GachaError';
  }
}

export const POOLS = {
  '100': { group: '100', label: '新手祈愿' },
  '200': { group: '200', label: '常驻祈愿' },
  '301': { group: '301', label: '角色活动祈愿' },
  '400': { group: '301', label: '角色活动祈愿-2' },
  '302': { group: '302', label: '武器活动祈愿' },
  '500': { group: '500', label: '集录祈愿' },
} as const;
export type GachaType = keyof typeof POOLS;
export type PityGroup = typeof POOLS[GachaType]['group'];
export type Rank = 3 | 4 | 5;
export type ItemType = 'character' | 'weapon';

export function pityGroup(gachaType: string, declaredGroup?: string): PityGroup {
  if (!Object.hasOwn(POOLS, gachaType)) throw new GachaError('UNSUPPORTED_POOL');
  const group = POOLS[gachaType as GachaType].group;
  if (declaredGroup !== undefined && declaredGroup !== group) throw new GachaError('POOL_GROUP_MISMATCH');
  return group;
}

/** The original string remains on the record; normalization is only for comparison. */
export function decimalId(id: string): string {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new GachaError('INVALID_ID');
  return id.replace(/^0+(?=\d)/, '');
}
export function compareIds(left: string, right: string): number {
  const a = decimalId(left), b = decimalId(right);
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
export function validateTimezone(timezone: number) {
  if (!Number.isInteger(timezone) || timezone < -12 || timezone > 14) throw new GachaError('INVALID_TIMEZONE');
}
export function gameTime(time: string, timezone: number) {
  validateTimezone(timezone);
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new GachaError('INVALID_TIME');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day); local.setUTCHours(hour, minute, second, 0);
  if (year < 1 || local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day ||
      local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) throw new GachaError('INVALID_TIME');
  const timestamp = local.getTime() - timezone * 3600_000;
  return { timeUtc: new Date(timestamp).toISOString(), timestamp, dateKey: time.slice(0, 10), monthKey: time.slice(0, 7), year };
}
