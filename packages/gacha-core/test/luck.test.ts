import { expect, it } from 'vitest';
import { analyzeHistory, createMetadataCatalog, genshinMetadata, luckStatistics, type BannerSnapshot, type GachaRecord, type HistoryBoundary } from '../src/index.js';

const catalog = createMetadataCatalog({ schemaVersion: 1, game: 'hk4e', source: { name: 'synthetic', version: '1', url: 'https://example.test/items', license: 'test', retrievedAt: '2026-10-28' }, items: [
  ...['10', '11', '12'].map((id) => ({ id, itemType: 'character', rank: 5, names: { 'zh-cn': `角色${id}` } })),
  { id: '20', itemType: 'weapon', rank: 3, names: { 'zh-cn': '三星武器' } },
  { id: '40', itemType: 'weapon', rank: 5, names: { 'zh-cn': '五星武器' } },
] });
const banners: BannerSnapshot = { source: { name: 'synthetic', revision: '1', url: 'https://example.test/banners' },
  entries: [{ start: '2024-01-01 00:00:00', end: '2024-12-31 23:59:59', startGlobal: false, endGlobal: false, itemIds: ['10', '11'] }] };
type Row = Omit<GachaRecord, 'id'>;
const row = (itemId: string, gachaType = '301', time = '2024-02-01 12:00:00'): Row => ({ itemId, gachaType, time });
const fill = (count: number, pool = '301') => Array.from({ length: count }, () => row('20', pool));
const prepare = (rows: Row[], boundaries?: Partial<Record<'100' | '200' | '301' | '302' | '500', HistoryBoundary>>, timezone = 8) => analyzeHistory(
  rows.map((entry, index) => ({ ...entry, id: String(9007199254740993000n + BigInt(index)) })), { timezone, catalog, ...(boundaries ? { boundaries } : {}) }).records;
const calculate = (rows: Row[], complete = false) => luckStatistics(prepare(rows, complete ? Object.fromEntries(['100', '200', '301', '302', '500'].map((pool) => [pool, { startsAtBeginning: true }])) : undefined), { timezone: 8, banners });

it('merges 301/400 pity, separates the other three pools and excludes the unfinished tail from full-interval means', () => {
  const result = calculate([
    ...fill(2), row('10'), ...fill(1, '400'), row('12', '400'), ...fill(2),
    row('40', '302'), ...fill(3, '302'), row('40', '302'),
    ...fill(3, '200'), row('12', '200'), ...fill(1, '500'), row('10', '500'), row('12', '100'),
  ], true);
  expect(result.pools.map((entry) => [entry.pool, entry.totalPulls, entry.fiveStars, entry.completeIntervals, entry.averageFiveStarPulls])).toEqual([
    ['301', 7, 2, 2, 2.5], ['302', 5, 2, 2, 2.5], ['200', 4, 1, 1, 4], ['500', 2, 1, 1, 2],
  ]);
  expect(result.pools[0]!.observedPullsPerFiveStar).toBe(3.5);
});

it('excludes guarantees from small-pity wins and streaks while including lost pulls in full UP costs', () => {
  const result = calculate([row('10'), ...fill(1), row('12'), ...fill(2), row('11'), ...fill(1), row('12', '400'),
    ...fill(2), row('10', '400'), ...fill(3), row('11'), row('10')]);
  expect(result.character).toEqual({ upFiveStars: 5, offBannerFiveStars: 2, unclassifiedFiveStars: 0, unknownStateFiveStars: 1, inconsistentFiveStars: 0,
    smallAttempts: 4, smallWins: 2, smallLosses: 2, guaranteedUps: 2, smallWinRate: 0.5,
    averageUpPulls: 3.75, upCostSamples: 4, maxWinStreak: 2, maxLossStreak: 2 });
  expect(result.pools[0]).toMatchObject({ completeIntervals: 6, averageFiveStarPulls: 2.5, excludedFiveStars: 1 });
});

it('excludes the first unknown state equally for wins and losses, and flags impossible consecutive guaranteed losses', () => {
  const unknownLoss = calculate([row('12'), row('10'), row('11')]);
  expect(unknownLoss.character).toMatchObject({ smallAttempts: 1, smallWins: 1, unknownStateFiveStars: 1, guaranteedUps: 1, averageUpPulls: 1, upCostSamples: 1 });
  const inconsistent = calculate([row('10'), row('12'), row('12'), row('10'), row('11')]);
  expect(inconsistent.character).toMatchObject({ smallAttempts: 2, smallLosses: 1, smallWins: 1, inconsistentFiveStars: 1, maxLossStreak: 1, upCostSamples: 1 });
});

it('breaks intervals and small-pity chains at unknown rarity, declared gaps, unknown banners and conflicting item metadata', () => {
  const uncertain = luckStatistics(prepare([row('10'), row('99'), row('11'), row('12'), row('10')], { '301': { gapBeforeIds: ['9007199254740993003'] } }), { timezone: 8, banners });
  expect(uncertain.character).toMatchObject({ smallAttempts: 0, unknownStateFiveStars: 3, averageUpPulls: null, maxWinStreak: null });
  expect(uncertain.pools[0]).toMatchObject({ fiveStars: 4, completeIntervals: 1, excludedFiveStars: 3, unknownRankRecords: 1 });
  const outside = calculate([row('10', '301', '2025-01-01 00:00:00')]);
  expect(outside.character).toMatchObject({ unclassifiedFiveStars: 1, smallAttempts: 0, averageUpPulls: null });
  const conflict = calculate([row('10'), { ...row('99'), rank: 3, itemType: 'weapon' }, { ...row('99'), rank: 5, itemType: 'weapon' }, row('11')]);
  expect(conflict.pools[0]).toMatchObject({ fiveStars: 2, completeIntervals: 0, unknownRankRecords: 2 });
  expect(conflict.metadataIssues.unknownRankRecords).toBe(2);
});

it('classifies historical Keqing, Tighnari, Dehya and Mizuki promotions by ID and date rather than permanent membership', () => {
  for (const [itemId, upDate, lossDate] of [
    ['10000042', '2021-02-20', '2021-03-20'], ['10000069', '2022-09-01', '2022-10-01'],
    ['10000079', '2023-03-05', '2023-03-25'], ['10000109', '2025-02-15', '2025-04-15'],
  ]) {
    for (const [date, up] of [[upDate, true], [lossDate, false]] as const) {
      const history = analyzeHistory([{ id: '9007199254740993001', itemId: itemId!, gachaType: '301', time: `${date} 12:00:00` }], { timezone: 8, catalog: genshinMetadata }).records;
      expect(luckStatistics(history, { timezone: 8 }).character).toMatchObject({ upFiveStars: up ? 1 : 0, offBannerFiveStars: up ? 0 : 1, unclassifiedFiveStars: 0 });
    }
  }
});

it('converts simultaneous banner boundaries across server timezones but keeps local-time phases local', () => {
  const global: BannerSnapshot = { ...banners, entries: [{ start: '2024-02-01 06:00:00', end: '2024-02-02 06:00:00', startGlobal: true, endGlobal: true, itemIds: ['10'] }] };
  const us = prepare([row('10', '301', '2024-01-31 17:00:00')], undefined, -5);
  const asia = prepare([row('10', '301', '2024-02-01 06:00:00')]);
  expect(luckStatistics(us, { timezone: -5, banners: global }).character.upFiveStars).toBe(1);
  expect(luckStatistics(asia, { timezone: 8, banners: global }).character.upFiveStars).toBe(1);
  expect(luckStatistics(us, { timezone: -5, banners: { ...global, entries: global.entries.map((entry) => ({ ...entry, startGlobal: false, endGlobal: false })) } }).character.unclassifiedFiveStars).toBe(1);
});

it('represents absent samples as null, including pools with no five-stars', () => {
  expect(calculate([]).pools.every((entry) => entry.averageFiveStarPulls === null && entry.observedPullsPerFiveStar === null)).toBe(true);
  expect(calculate(fill(3)).character).toMatchObject({ smallWinRate: null, averageUpPulls: null, maxWinStreak: null, maxLossStreak: null });
});
