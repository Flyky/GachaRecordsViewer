import { describe, expect, it } from 'vitest';
import { analyzeHistory, compareIds, createMetadataCatalog, gameTime, genshinMetadata, pityGroup, resolveMetadata, type GachaRecord, type Rank } from '../src/index.js';

const source = { name: 'fixture', version: '1', url: 'https://example.test/metadata', license: 'fixture', retrievedAt: '2026-10-27T00:00:00.000Z' };
const snapshot = { schemaVersion: 1, game: 'hk4e', source, items: [
  { id: '10', itemType: 'character', rank: 5, names: { 'zh-cn': '测试五星', 'en-us': 'Test Five' } },
  { id: '20', itemType: 'weapon', rank: 3, names: { 'zh-cn': '测试三星武器' } },
  { id: '30', itemType: 'character', rank: 4, names: { 'zh-cn': '测试四星' } },
] };
const catalog = createMetadataCatalog(snapshot);
const options = { timezone: 8, catalog };
function row(id: string, rank?: Rank, pool = '301', time = '2026-10-27 12:00:00'): GachaRecord {
  return { id, itemId: rank === 5 ? '10' : rank === 4 ? '30' : rank === 3 ? '20' : '99999', gachaType: pool, time };
}

describe('lossless ordering and game time', () => {
  it('sorts same-second pulls using decimal strings without mutating input', () => {
    const records = [row('90071992547409930001', 5), row('90071992547409930000', 3), row('999', 4)];
    const result = analyzeHistory(records, options).records;
    expect(result.map((record) => record.id)).toEqual(['999', '90071992547409930000', '90071992547409930001']);
    expect(records[0]?.id).toBe('90071992547409930001');
    expect(result[2]?.pity.count).toBe(3);
    expect(compareIds('00012', '12')).toBe(0);
    expect(() => compareIds('1e20', '2')).toThrow('INVALID_ID');
    expect(() => analyzeHistory([row('1', 3), row('01', 3)], options)).toThrow('DUPLICATE_ID');
  });
  it('uses explicit offsets and local grouping keys across years and leap days', () => {
    expect(gameTime('2024-01-01 00:30:00', 8)).toMatchObject({ timeUtc: '2023-12-31T16:30:00.000Z', dateKey: '2024-01-01', monthKey: '2024-01', year: 2024 });
    expect(gameTime('2024-12-31 23:30:00', -5).timeUtc).toBe('2025-01-01T04:30:00.000Z');
    expect(gameTime('2024-02-29 00:00:00', 0).dateKey).toBe('2024-02-29');
    expect(() => gameTime('2023-02-29 12:00:00', 8)).toThrow('INVALID_TIME');
    expect(() => gameTime('2024-01-01 24:00:00', 8)).toThrow('INVALID_TIME');
    expect(() => gameTime('2024-01-01 00:00:00', 5.5)).toThrow('INVALID_TIMEZONE');
  });
  it('preserves raw pool identity, merges 301/400 and rejects incompatible declared groups', () => {
    expect(['100', '200', '301', '400', '302', '500'].map((pool) => pityGroup(pool))).toEqual(['100', '200', '301', '301', '302', '500']);
    const result = analyzeHistory([row('1', 3), row('2', 3, '302'), row('3', 5, '400')], options);
    expect(result.totals).toEqual({ '301': 2, '302': 1 });
    expect(result.records[2]).toMatchObject({ gachaType: '400', group: '301', groupOrdinal: 2, pity: { count: 2 } });
    expect(() => pityGroup('400', '400')).toThrow('POOL_GROUP_MISMATCH');
    expect(() => pityGroup('unknown')).toThrow('UNSUPPORTED_POOL');
  });
});

describe('saved-history counters', () => {
  it('marks the first segment incomplete, resets after five-stars and preserves annotations through filtering', () => {
    const records = [row('1', 3), row('2', 5), row('3', 4), row('4', 3), row('5', 5)];
    const full = analyzeHistory(records, options).records;
    expect(full.map((record) => record.pity.count)).toEqual([1, 2, 1, 2, 3]);
    expect(full.map((record) => record.pity.status)).toEqual(['partial-history', 'partial-history', 'exact', 'exact', 'exact']);
    const visible = full.filter((record) => record.metadata.rank === 5).reverse().slice(0, 1);
    expect(visible[0]).toMatchObject({ id: '5', groupOrdinal: 5, pity: { count: 3, status: 'exact' } });
    const supplemented = analyzeHistory([row('0', 3, '400', '2026-10-26 12:00:00'), ...records], options).records;
    expect(supplemented.find((record) => record.id === '2')).toMatchObject({ groupOrdinal: 3, pity: { count: 3 } });
    expect(supplemented.find((record) => record.id === '5')).toMatchObject({ groupOrdinal: 6, pity: { count: 3 } });
  });
  it('only marks explicit gaps and resumes certainty after the next known five-star', () => {
    const records = [row('1', 5, '301', '2024-01-01 12:00:00'), row('2', 3), row('3', 5), row('4', 3)];
    expect(analyzeHistory(records, options).records[1]?.pity.status).toBe('exact');
    const result = analyzeHistory(records, { ...options, boundaries: { '301': { startsAtBeginning: true, gapBeforeIds: ['2'] } } }).records;
    expect(result.map((record) => record.pity.status)).toEqual(['exact', 'partial-history', 'partial-history', 'exact']);
    expect(result[2]?.pity).toMatchObject({ count: 2, reasons: ['known-gap'] });
    expect(() => analyzeHistory(records, { ...options, boundaries: { '302': { gapBeforeIds: ['2'] } } })).toThrow('INVALID_HISTORY_BOUNDARY');
  });
  it('does not guess resets across unknown rarity, and recomputes after metadata enrichment', () => {
    const records = [row('1', 5), row('2'), row('3', 3), row('4', 5), row('5', 3)];
    const result = analyzeHistory(records, options);
    expect(result.metadataIncomplete).toBe(true);
    expect(result.records.map((record) => record.pity.count)).toEqual([1, null, null, null, 1]);
    expect(result.records[3]?.pity).toMatchObject({ status: 'unknown-rarity', observedSinceFiveStar: 3 });
    const enriched = records.map((record) => record.id === '2' ? { ...record, rank: 3 as const } : record);
    expect(analyzeHistory(enriched, options).records[3]?.pity).toMatchObject({ status: 'exact', count: 3 });
    expect(analyzeHistory([], options)).toEqual({ records: [], totals: {}, metadataIncomplete: false });
  });
});

describe('local metadata boundary', () => {
  it('resolves absent upstream IDs only from an exact, unique name, language, type and rarity', () => {
    expect(catalog.find('测试五星', 'zh-cn', 'character', 5)?.id).toBe('10');
    expect(catalog.find('测试五星', 'en-us', 'character', 5)).toBeUndefined();
    expect(catalog.find('测试五星', 'zh-cn', 'character', 4)).toBeUndefined();
    expect(catalog.find('测试', 'zh-cn', 'character', 5)).toBeUndefined();
    const ambiguous = createMetadataCatalog({ ...snapshot, items: [...snapshot.items, { ...snapshot.items[0], id: '11' }] });
    expect(ambiguous.find('测试五星', 'zh-cn', 'character', 5)).toBeUndefined();
  });
  it('fills missing fields, retains original-language names and leaves unknown IDs unknown', () => {
    expect(resolveMetadata('10', {}, catalog)).toMatchObject({ name: '测试五星', rank: 5, itemType: 'character', status: 'complete', provenance: { rank: 'dictionary' } });
    expect(resolveMetadata('10', { name: 'Test Five', lang: 'en-us' }, catalog)).toMatchObject({ name: '测试五星', nameLanguage: 'zh-cn' });
    expect(resolveMetadata('99999', { name: 'External Name', lang: 'en-us' }, catalog)).toMatchObject({ name: 'External Name', nameLanguage: 'en-us', rank: null, itemType: null, missing: ['rank', 'itemType'] });
    expect(resolveMetadata('99999', {}, catalog)).toMatchObject({ name: null, rank: null, itemType: null, status: 'incomplete' });
  });
  it('reports conflicts without overwriting hints or producing certain pity counts', () => {
    const input = { ...row('1', 5), rank: 3 as const, itemType: 'weapon' as const };
    const result = analyzeHistory([input], options).records[0]!;
    expect(input.rank).toBe(3);
    expect(result.metadata).toMatchObject({ rank: null, itemType: null, status: 'conflict', conflicts: ['rank', 'itemType'] });
    expect(result.pity.count).toBeNull();
    expect(() => createMetadataCatalog({ ...snapshot, items: [snapshot.items[0], snapshot.items[0]] })).toThrow('INVALID_METADATA');
    expect(catalog.get('10')?.rank).toBe(5);
  });
  it('ships a usable, attributed snapshot without needing an online query', () => {
    expect(genshinMetadata.size).toBeGreaterThan(300);
    expect(genshinMetadata.source).toMatchObject({ name: 'genshin-db', license: 'MIT' });
    expect(resolveMetadata('11515', {}, genshinMetadata)).toMatchObject({ name: '赦罪', itemType: 'weapon', rank: 5 });
    expect(resolveMetadata('10000121', {}, genshinMetadata)).toMatchObject({ name: '爱诺', itemType: 'character', rank: 4 });
  });
});
