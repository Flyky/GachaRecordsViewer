import type { UigfDocument, UigfRecord } from '@gacha/uigf';

export function analysisFixture(): UigfDocument {
  const row = (id: string, item: string, time: string, pool: string, rank?: string, type?: string, name?: string): UigfRecord => ({
    id, item_id: item, time, gacha_type: pool, uigf_gacha_type: pool === '400' ? '301' : pool,
    ...(rank ? { rank_type: rank } : {}), ...(type ? { item_type: type } : {}), ...(name ? { name } : {}),
  });
  return { info: { version: 'v4.1', export_timestamp: 1793073600, export_app: 'R10 synthetic', export_app_version: '1' }, hk4e: [
    { uid: '111111111', timezone: 8, lang: 'zh-cn', list: [
      row('9007199254740993001', '10000016', '2023-12-31 23:59:59', '100'),
      row('9007199254740993002', '010000016', '2024-02-29 00:30:00', '301'),
      row('9007199254740993003', '10000014', '2024-02-29 00:30:00', '400'),
      row('9007199254740993004', '11301', '2024-02-29 12:00:00', '200'),
      row('9007199254740993005', '99000005', '2024-02-29 12:00:00', '302', '5', '武器', '测试五星武器'),
      row('9007199254740993006', '10000014', '2024-02-29 12:00:00', '500'),
      row('9007199254740993007', '99900001', '2025-01-01 00:30:00', '301'),
      row('9007199254740993008', '11301', '2025-01-01 12:00:00', '302', '6', '武器', '无效星级'),
      row('9007199254740993009', '99000004', '2025-01-01 12:00:00', '302', '4', '武器', '测试四星武器'),
    ] },
    { uid: '222222222', timezone: -5, lang: 'en-us', list: [row('9007199254740993010', '10000016', '2026-12-31 23:30:00', '301')] },
    { uid: '333333333', timezone: 8, list: [] },
  ] };
}
