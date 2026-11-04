import characterBanners from './catalog/character-banners.json' with { type: 'json' };
import type { AnalyzedRecord } from './history.js';
import { compareIds, decimalId, gameTime } from './primitives.js';
import { analysisMetadata } from './statistics.js';
import { itemIdentityKey, type MetadataCatalog } from './metadata.js';

export interface CharacterBanner { start: string; end: string; startGlobal: boolean; endGlobal: boolean; itemIds: string[]; featured?: string[]; unresolvedMembers?: number }
export interface BannerSnapshot { source: { name: string; revision: string; url: string }; entries: CharacterBanner[] }
export const builtinCharacterBanners: BannerSnapshot = characterBanners;
const mean = (sum: number, count: number) => count ? sum / count : null;
const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
export function resolveBannerSnapshot(snapshot: BannerSnapshot, catalog: MetadataCatalog): BannerSnapshot {
  const names = new Map<string, string[]>();
  for (const item of catalog.all()) if (item.itemType === 'character' && item.rank === 5 && item.names['en-us']) {
    const key = normalizeName(item.names['en-us']); names.set(key, [...names.get(key) ?? [], item.id]);
  }
  return { ...snapshot, entries: snapshot.entries.map((entry) => {
    if (!entry.featured?.length) return { start: entry.start, end: entry.end, startGlobal: entry.startGlobal, endGlobal: entry.endGlobal, itemIds: [...entry.itemIds] };
    const ids = new Set(entry.itemIds); let unresolvedMembers = 0;
    for (const name of entry.featured) { const matched = names.get(normalizeName(name)); if (matched?.length === 1) ids.add(matched[0]!); else unresolvedMembers++; }
    return { ...entry, itemIds: [...ids], unresolvedMembers };
  }) };
}

/** Descriptive statistics of saved history; missing boundaries never become exact pity or 50/50 samples. */
export function luckStatistics(records: readonly AnalyzedRecord[], options: { timezone: number; banners?: BannerSnapshot }) {
  const banners: BannerSnapshot = options.banners ?? characterBanners;
  const windows = banners.entries.map((entry) => ({
    start: gameTime(entry.start, entry.startGlobal ? 8 : options.timezone).timestamp,
    end: gameTime(entry.end, entry.endGlobal ? 8 : options.timezone).timestamp,
    itemIds: new Set(entry.itemIds.map(decimalId)),
    unresolvedMembers: entry.unresolvedMembers ?? (entry.featured?.length ? entry.featured.length : 0),
  }));
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp || compareIds(a.id, b.id));
  const ranks = new Map<string, Set<number>>(), types = new Map<string, Set<string>>();
  for (const row of sorted) {
    const key = itemIdentityKey(row), rankSet = ranks.get(key) ?? new Set<number>(), typeSet = types.get(key) ?? new Set<string>();
    if (row.metadata.rank !== null) rankSet.add(row.metadata.rank);
    if (row.metadata.itemType !== null) typeSet.add(row.metadata.itemType);
    ranks.set(key, rankSet); types.set(key, typeSet);
  }
  const rank = (row: AnalyzedRecord) => ranks.get(itemIdentityKey(row))!.size > 1 ? null : row.metadata.rank;
  const pools = (['301', '302', '200', '500'] as const).map((pool) => {
    const rows = sorted.filter((row) => row.group === pool);
    let fiveStars = 0, completeIntervals = 0, intervalPulls = 0, sinceFive = 0, known = true, unknownRankRecords = 0;
    for (const row of rows) {
      sinceFive++;
      if (row.pity.reasons.includes('known-gap')) known = false;
      if (rank(row) === null) { known = false; unknownRankRecords++; }
      if (rank(row) !== 5) continue;
      fiveStars++;
      if (known && row.pity.status === 'exact') { completeIntervals++; intervalPulls += sinceFive; }
      sinceFive = 0; known = true;
    }
    return { pool, totalPulls: rows.length, fiveStars, completeIntervals, excludedFiveStars: fiveStars - completeIntervals,
      averageFiveStarPulls: mean(intervalPulls, completeIntervals), observedPullsPerFiveStar: mean(rows.length, fiveStars), unknownRankRecords };
  });
  const rows = sorted.filter((row) => row.group === '301');
  let state: 'small' | 'guaranteed' | 'unknown' = rows[0]?.pity.status === 'exact' ? 'small' : 'unknown';
  let costKnown = state === 'small', sinceUp = 0, upCost = 0, upCostSamples = 0;
  let upFiveStars = 0, offBannerFiveStars = 0, unclassifiedFiveStars = 0, unknownStateFiveStars = 0, inconsistentFiveStars = 0;
  let smallWins = 0, smallLosses = 0, guaranteedUps = 0, winStreak = 0, lossStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  const breakChain = () => { state = 'unknown'; costKnown = false; winStreak = 0; lossStreak = 0; };
  for (const row of rows) {
    sinceUp++;
    if (rank(row) === null || row.pity.reasons.includes('known-gap')) breakChain();
    if (rank(row) !== 5) continue;
    const active = windows.filter((entry) => entry.start <= row.timestamp && row.timestamp <= entry.end);
    if (row.metadata.itemType !== 'character' || types.get(itemIdentityKey(row))!.size > 1 || !active.length || row.metadata.itemId === null) {
      unclassifiedFiveStars++; breakChain(); continue;
    }
    const up = active.some((entry) => entry.itemIds.has(decimalId(row.metadata.itemId!)));
    if (!up && active.some((entry) => entry.unresolvedMembers > 0)) { unclassifiedFiveStars++; breakChain(); continue; }
    if (up) upFiveStars++; else offBannerFiveStars++;
    if (state === 'small') {
      if (up) { smallWins++; winStreak++; lossStreak = 0; maxWinStreak = Math.max(maxWinStreak, winStreak); }
      else { smallLosses++; lossStreak++; winStreak = 0; maxLossStreak = Math.max(maxLossStreak, lossStreak); }
    } else if (state === 'guaranteed') {
      if (up) guaranteedUps++;
      else { inconsistentFiveStars++; breakChain(); }
    } else { unknownStateFiveStars++; winStreak = 0; lossStreak = 0; }
    if (up) {
      if (costKnown) { upCost += sinceUp; upCostSamples++; }
      sinceUp = 0; costKnown = true; state = 'small';
    } else state = 'guaranteed';
  }
  const smallAttempts = smallWins + smallLosses;
  return { historyCount: records.length, metadataIssues: analysisMetadata(records), pools,
    bannerSource: { ...banners.source, firstStart: banners.entries.map((entry) => entry.start).sort()[0] ?? null,
      lastEnd: banners.entries.map((entry) => entry.end).sort().at(-1) ?? null },
    character: { upFiveStars, offBannerFiveStars, unclassifiedFiveStars, unknownStateFiveStars, inconsistentFiveStars,
      smallAttempts, smallWins, smallLosses, guaranteedUps, smallWinRate: mean(smallWins, smallAttempts),
      averageUpPulls: mean(upCost, upCostSamples), upCostSamples,
      maxWinStreak: smallAttempts ? maxWinStreak : null, maxLossStreak: smallAttempts ? maxLossStreak : null } };
}
