import { describe, expect, it } from 'vitest';
import { analyzeHistory, createMetadataCatalog, dailyStatistics, itemStatistics, monthlyStatistics, type GachaRecord } from '../src/index.js';

const catalog = createMetadataCatalog({ schemaVersion: 1, game: 'hk4e', source: { name: 'synthetic', version: '1', url: 'https://example.test/items', license: 'test', retrievedAt: '2026-10-27' }, items: [
  { id: '10', itemType: 'character', rank: 5, names: { 'zh-cn': '五星角色', 'en-us': 'Five Star' } },
  { id: '20', itemType: 'weapon', rank: 3, names: { 'zh-cn': '三星武器' } },
  { id: '30', itemType: 'character', rank: 4, names: { 'zh-cn': '四星角色' } },
] });
function history(rows: Omit<GachaRecord, 'id'>[]) {
  return analyzeHistory(rows.map((row, index) => ({ ...row, id: String(9007199254740993000n + BigInt(index)) })), { timezone: 8, catalog, displayLanguage: 'zh-cn' }).records;
}
const row = (itemId: string, time = '2024-02-29 00:30:00', gachaType = '301'): Omit<GachaRecord, 'id'> => ({ itemId, time, gachaType });

describe('R10 statistics calculations', () => {
  it('aggregates canonical item IDs across languages, orders quantities and conservatively separates incomplete or conflicting IDs', () => {
    const records = history([row('00010'), { ...row('10'), name: 'Five Star', lang: 'en-us' }, row('20'), row('20'), row('30'),
      { ...row('40'), itemType: 'weapon', rank: 4, name: 'B' }, { ...row('40'), itemType: 'weapon', rank: 4, name: 'B alias' }, { ...row('50'), itemType: 'weapon', rank: 4, name: 'A' },
      row('99'), { ...row('90'), itemType: 'character', rank: 4 }, { ...row('90'), itemType: 'character', rank: 5 },
      { ...row('80'), itemType: 'character', rank: 3 }, { ...row('70'), itemType: 'weapon', rank: 4 }, { ...row('70'), itemType: 'weapon' }]);
    const characters = itemStatistics(records);
    expect(characters.groups.map((group) => [group.rank, group.total])).toEqual([[5, 2], [4, 1]]);
    expect(characters.groups[0]!.items).toEqual([{ itemId: '10', name: '五星角色', quantity: 2 }]);
    expect(characters.unclassified.total).toBe(5);
    expect(characters.unclassified.items.find((item) => item.itemId === '90')?.reasons).toContain('conflicting-metadata');
    expect(characters.selectedTypeCount + characters.otherTypeCount + characters.unclassified.total).toBe(records.length);
    const weapons = itemStatistics(records, 'weapon', 'asc');
    expect(weapons.groups.map((group) => group.rank)).toEqual([5, 4, 3]);
    expect(weapons.groups[1]!.items.map((item) => item.itemId)).toEqual(['50', '70', '40']);
    expect(itemStatistics(records, 'weapon', 'desc').groups[1]!.items.map((item) => item.itemId)).toEqual(['40', '50', '70']);
    expect(weapons.groups[1]!.items.find((item) => item.itemId === '70')?.quantity).toBe(1);
    expect(weapons.unclassified.items.find((item) => item.itemId === '70')?.quantity).toBe(1);
    expect(weapons.groups[2]!.total).toBe(2);
    expect(itemStatistics([...records].reverse(), 'weapon', 'asc')).toEqual(weapons);
  });
  it('fills missing months across years and preserves exactly five series, including new/chronicle draws only in the appropriate totals', () => {
    const records = history([row('20', '2023-12-31 23:59:59', '100'), row('10', '2024-02-01 00:30:00', '500'),
      row('30', '2024-02-29 12:00:00', '400'), row('20', '2024-02-29 12:00:00', '200'), row('99', '2025-01-01 00:00:00', '302')]);
    const monthly = monthlyStatistics(records);
    expect(monthly.months).toHaveLength(14);
    expect(monthly.months[1]).toEqual({ month: '2024-01', total: 0, fiveStars: 0, standard: 0, characterEvent: 0, weaponEvent: 0 });
    expect(monthly.months[2]).toEqual({ month: '2024-02', total: 3, fiveStars: 1, standard: 1, characterEvent: 1, weaponEvent: 0 });
    expect(monthly.totals).toEqual({ total: 5, fiveStars: 1, standard: 1, characterEvent: 1, weaponEvent: 1 });
    expect(monthly.fiveStarCountsIncomplete).toBe(true);
    const conflict = monthlyStatistics(history([{ ...row('99'), rank: 4 }, { ...row('99'), rank: 5 }]));
    expect(conflict.totals.fiveStars).toBe(0); expect(conflict.metadataIssues.unknownRankRecords).toBe(2);
  });
  it('emits all calendar dates, merges 301/400, handles game-local midnight and keeps current/record/requested years available', () => {
    const records = history([row('20'), row('10', '2024-02-29 00:30:00', '400'), row('99', '2024-02-29 12:00:00', '500'), row('20', '2023-12-31 23:59:59')]);
    const all = dailyStatistics(records, { year: 2024, currentYear: 2027 });
    expect(all.days).toHaveLength(366); expect(all.days.find((day) => day.date === '2024-02-29')?.count).toBe(3);
    expect(all.days.find((day) => day.date === '2024-02-28')?.count).toBe(0);
    expect(all).toMatchObject({ total: 3, maxDailyCount: 3, pool: null, availableYears: [2027, 2024, 2023], hasRecords: true });
    expect(dailyStatistics(records, { year: 2024, currentYear: 2027, pool: '301' }).total).toBe(2);
    for (const [year, length] of [[1, 365], [1900, 365], [2000, 366], [2100, 365], [9999, 365]]) {
      const empty = dailyStatistics([], { year: year!, currentYear: 2027 });
      expect(empty.days).toHaveLength(length!); expect(empty).toMatchObject({ total: 0, maxDailyCount: 0, hasRecords: false });
      expect(empty.days.every((day) => day.count === 0)).toBe(true);
    }
    expect(() => dailyStatistics([], { year: 0, currentYear: 2027 })).toThrow('INVALID_ANALYSIS_OPTIONS');
  });
  it('returns stable empty columns/months and retains known rarity with an unknown name', () => {
    expect(itemStatistics([]).groups.map((group) => [group.rank, group.total, group.items])).toEqual([[5, 0, []], [4, 0, []]]);
    expect(monthlyStatistics([])).toMatchObject({ months: [], fiveStarCountsIncomplete: false, totals: { total: 0, fiveStars: 0 } });
    const records = history([{ ...row('99'), rank: 4, itemType: 'weapon' }]);
    expect(itemStatistics(records, 'weapon').groups[1]!.items).toEqual([{ itemId: '99', name: null, quantity: 1 }]);
    expect(itemStatistics(records, 'weapon').metadataIssues.incompleteRecords).toBe(1);
  });
});
