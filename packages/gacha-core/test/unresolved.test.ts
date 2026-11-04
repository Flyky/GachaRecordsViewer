import { expect, it } from 'vitest';
import { analyzeHistory, createMetadataCatalog, itemStatistics, monthlyStatistics, dailyStatistics, luckStatistics, resolveBannerSnapshot,
  type GachaRecord, type ItemMetadata, type BannerSnapshot } from '../src/index.js';

const source = { name: 'synthetic', version: '1', url: 'https://example.test', retrievedAt: '2026-11-04', license: 'test' };
const future: ItemMetadata = { id: '10000999', itemType: 'character', rank: 5, names: { 'zh-cn': '未来角色', 'en-us': 'Future Character' } };
const other: ItemMetadata = { id: '10000001', itemType: 'character', rank: 5, names: { 'zh-cn': '其他角色', 'en-us': 'Other Character' } };
const catalog = (items: ItemMetadata[]) => createMetadataCatalog({ schemaVersion: 1, game: 'hk4e', source, items });
const facts: GachaRecord[] = [1, 2].map((id) => ({ id: String(id), itemId: null, time: `2026-11-04 12:00:0${id}`, gachaType: '301',
  name: '未来角色', lang: 'zh-cn', itemType: 'character', rank: 5 }));
it('counts and groups raw facts while IDs are unresolved, then resolves dynamically without changing those facts', () => {
  const before = structuredClone(facts), missing = analyzeHistory(facts, { timezone: 8, catalog: catalog([]) }).records;
  expect(missing[0]?.metadata).toMatchObject({ itemId: null, rank: 5, itemType: 'character', status: 'incomplete' });
  expect(itemStatistics(missing).groups[0]).toMatchObject({ total: 2, items: [{ itemId: null, name: '未来角色', quantity: 2 }] });
  expect(monthlyStatistics(missing).totals).toMatchObject({ total: 2, fiveStars: 2 });
  expect(dailyStatistics(missing, { year: 2026, currentYear: 2026 }).total).toBe(2);
  const resolved = analyzeHistory(facts, { timezone: 8, catalog: catalog([future]) }).records;
  expect(resolved[0]?.metadata).toMatchObject({ itemId: future.id, identityStatus: 'dictionary', status: 'complete' });
  expect(itemStatistics(resolved).groups[0]?.items).toEqual([{ itemId: future.id, name: '未来角色', quantity: 2 }]);
  expect(facts).toEqual(before);
});
it('does not guess ambiguous aliases or replace a stored item ID', () => {
  const ambiguous = catalog([future, { ...future, id: '10000998' }]);
  expect(analyzeHistory(facts, { timezone: 8, catalog: ambiguous }).records[0]?.metadata.itemId).toBeNull();
  const stored = analyzeHistory([{ ...facts[0]!, itemId: other.id }], { timezone: 8, catalog: catalog([future, other]) }).records[0]!;
  expect(stored.metadata.itemId).toBe(other.id); expect(stored.metadata.name).toBe('未来角色');
});
it('keeps raw banner members and treats negative UP classifications as unknown until all members resolve', () => {
  const raw: BannerSnapshot = { source: { name: 'synthetic', revision: 'raw', url: 'https://example.test' }, entries: [{
    start: '2026-11-01 00:00:00', end: '2026-11-30 23:59:59', startGlobal: false, endGlobal: false, itemIds: [], featured: ['future_character'],
  }] };
  const rows = analyzeHistory([{ ...facts[0]!, itemId: other.id, name: '其他角色' }], { timezone: 8, catalog: catalog([other]), boundaries: { '301': { startsAtBeginning: true } } }).records;
  const pending = resolveBannerSnapshot(raw, catalog([other]));
  expect(pending.entries[0]?.unresolvedMembers).toBe(1);
  expect(luckStatistics(rows, { timezone: 8, banners: pending }).character).toMatchObject({ offBannerFiveStars: 0, smallLosses: 0, unclassifiedFiveStars: 1 });
  const resolved = resolveBannerSnapshot(raw, catalog([other, future]));
  expect(luckStatistics(rows, { timezone: 8, banners: resolved }).character).toMatchObject({ offBannerFiveStars: 1, smallLosses: 1, unclassifiedFiveStars: 0 });
  expect(raw.entries[0]?.itemIds).toEqual([]);
  const mixed = resolveBannerSnapshot({ ...raw, entries: [{ ...raw.entries[0]!, itemIds: [other.id] }] }, catalog([other]));
  expect(luckStatistics(rows, { timezone: 8, banners: mixed }).character).toMatchObject({ upFiveStars: 1, smallWins: 1, smallLosses: 0 });
});
