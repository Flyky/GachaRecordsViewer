import type { RecordPageRequest } from '@gacha/contracts';

export const poolOptions = [
  { label: '新手祈愿', value: '100' }, { label: '常驻祈愿', value: '200' },
  { label: '角色活动祈愿（含 -2）', value: '301' }, { label: '武器活动祈愿', value: '302' }, { label: '集录祈愿', value: '500' },
];
export const poolLabel = (type: string) => type === '400' ? '角色活动祈愿-2' : poolOptions.find((option) => option.value === type)?.label.replace('（含 -2）', '') ?? type;
export const itemTypeOptions = [{ label: '角色', value: 'character' }, { label: '武器', value: 'weapon' }];
export const rankOptions = [3, 4, 5].map((value) => ({ label: `${value} 星`, value }));
export const orderOptions = [{ label: '时间倒序', value: 'desc' }, { label: '时间正序', value: 'asc' }];
export function recordQueryString(query: RecordPageRequest) {
  const params = new globalThis.URLSearchParams();
  for (const key of ['from', 'to', 'name', 'order'] as const) if (query[key]) params.set(key, query[key]);
  for (const key of ['pools', 'itemTypes', 'ranks'] as const) if (query[key]?.length) params.set(key, query[key].join(','));
  params.set('page', String(query.page ?? 1)); params.set('pageSize', String(query.pageSize ?? 20));
  return params.toString();
}
/** datetime-local values represent the game's wall clock, regardless of browser timezone. */
export const gameTimeInput = (value: string) => value.replace('T', ' ').padEnd(19, ':00');
export function recentRange(kind: 'week' | 'month' | 'quarter', timezone: number, now = Date.now()) {
  const end = new Date(now + timezone * 3600_000), start = new Date(end);
  if (kind === 'week') start.setUTCDate(start.getUTCDate() - 7);
  else {
    const day = start.getUTCDate(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - (kind === 'month' ? 1 : 3));
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
  }
  return [start.toISOString().slice(0, 19), end.toISOString().slice(0, 19)] as const;
}
