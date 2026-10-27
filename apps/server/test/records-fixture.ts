import type { UigfDocument, UigfRecord } from '@gacha/uigf';

export const recordId = (index: number) => String(9007199254740993000n + BigInt(index));
export function queryFixture(): UigfDocument {
  const list: UigfRecord[] = Array.from({ length: 40 }, (_, index) => {
    const number = index + 1;
    const pool = number <= 30 ? number % 2 ? '301' : '400' : number <= 34 ? '200' : number <= 37 ? '302' : number <= 39 ? '500' : '100';
    const rank = number === 4 || number === 25 || number === 37 ? '5' : number === 10 || number === 31 ? '4' : '3';
    return { id: recordId(number), item_id: `9900000${rank}`, gacha_type: pool, uigf_gacha_type: pool === '400' ? '301' : pool,
      time: number >= 31 && number <= 34 ? '2026-10-26 23:59:59' : '2026-10-27 12:00:00',
      rank_type: rank, item_type: rank === '5' ? '角色' : '武器', name: number === 10 ? '字面%_测试' : rank === '5' ? '测试五星角色' : '测试武器' };
  });
  list[19] = { ...list[19]!, item_id: '99900020', name: '未知星级武器' }; delete list[19].rank_type;
  list[20] = { ...list[20]!, item_id: '11301', rank_type: '5', name: '星级冲突武器' };
  list[21] = { ...list[21]!, item_id: '11301', rank_type: '6', name: '无效星级武器' };
  return { info: { version: 'v4.1', export_timestamp: 1793073600, export_app: 'R09 synthetic', export_app_version: '1' }, hk4e: [
    { uid: '111111111', timezone: 8, lang: 'zh-cn', list },
    { uid: '222222222', timezone: -5, lang: 'zh-cn', list: [{ ...list[0]!, id: recordId(100), time: '2024-01-01 00:30:00', name: '第二档案武器' }] },
    { uid: '333333333', timezone: 8, list: [] },
  ] };
}
