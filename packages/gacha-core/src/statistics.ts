import type { AnalyzedRecord } from './history.js';
import { compareIds, decimalId, POOLS, type ItemType, type PityGroup, type Rank } from './primitives.js';

interface ItemEntry {
  itemId: string; rows: AnalyzedRecord[]; ranks: Set<Rank>; types: Set<ItemType>;
}
type ItemIssue = 'unknown-type' | 'unknown-rank' | 'conflicting-metadata' | 'unsupported-combination';
interface ItemCount { itemId: string; name: string | null; quantity: number }
interface MonthCounts { total: number; fiveStars: number; standard: number; characterEvent: number; weaponEvent: number }
function indexItems(records: readonly AnalyzedRecord[]) {
  const items = new Map<string, ItemEntry>();
  for (const record of records) {
    const itemId = decimalId(record.itemId);
    let entry = items.get(itemId);
    if (!entry) { entry = { itemId, rows: [], ranks: new Set(), types: new Set() }; items.set(itemId, entry); }
    entry.rows.push(record);
    if (record.metadata.rank !== null) entry.ranks.add(record.metadata.rank);
    if (record.metadata.itemType !== null) entry.types.add(record.metadata.itemType);
  }
  return items;
}
function metadataSummary(items: Map<string, ItemEntry>) {
  let incompleteRecords = 0, conflictRecords = 0, unknownRankRecords = 0;
  for (const entry of items.values()) {
    const rankConflict = entry.ranks.size > 1, typeConflict = entry.types.size > 1;
    for (const row of entry.rows) {
      if (row.metadata.status !== 'complete' || rankConflict || typeConflict) incompleteRecords++;
      if (row.metadata.status === 'conflict' || rankConflict || typeConflict) conflictRecords++;
      if (row.metadata.rank === null || rankConflict) unknownRankRecords++;
    }
  }
  return { incompleteRecords, conflictRecords, unknownRankRecords };
}
function displayName(entry: ItemEntry) {
  const names = entry.rows.filter((row) => row.metadata.name !== null).map((row) => ({ name: row.metadata.name!,
    priority: row.metadata.nameLanguage === 'zh-cn' ? 0 : row.metadata.nameLanguage === 'en-us' ? 1 : 2 }));
  names.sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return names[0]?.name ?? null;
}
export function itemStatistics(records: readonly AnalyzedRecord[], itemType: ItemType = 'character', order: 'asc' | 'desc' = 'desc') {
  const index = indexItems(records), groups = (itemType === 'character' ? [5, 4] as const : [5, 4, 3] as const)
    .map((rank) => ({ rank, total: 0, items: [] as ItemCount[] }));
  const unclassified: { total: number; items: (ItemCount & { reasons: ItemIssue[] })[] } = { total: 0, items: [] };
  let otherTypeCount = 0;
  for (const entry of index.values()) {
    const reasons = new Set<ItemIssue>(), valid: AnalyzedRecord[] = [];
    for (const row of entry.rows) {
      const issues: ItemIssue[] = [];
      if (row.metadata.itemType === null) issues.push('unknown-type');
      if (row.metadata.rank === null) issues.push('unknown-rank');
      if (entry.ranks.size > 1 || entry.types.size > 1 || row.metadata.status === 'conflict') issues.push('conflicting-metadata');
      if (row.metadata.itemType === 'character' && row.metadata.rank === 3) issues.push('unsupported-combination');
      if (issues.length) for (const issue of issues) reasons.add(issue); else valid.push(row);
    }
    const excluded = entry.rows.length - valid.length;
    if (excluded) {
      unclassified.total += excluded;
      unclassified.items.push({ itemId: entry.itemId, name: displayName(entry), quantity: excluded, reasons: [...reasons].sort() });
    }
    if (!valid.length) continue;
    const type = valid[0]!.metadata.itemType, rank = valid[0]!.metadata.rank;
    if (type !== itemType) { otherTypeCount += valid.length; continue; }
    const group = groups.find((candidate) => candidate.rank === rank)!;
    group.total += valid.length; group.items.push({ itemId: entry.itemId, name: displayName({ ...entry, rows: valid }), quantity: valid.length });
  }
  const compare = (a: ItemCount, b: ItemCount) => (order === 'desc' ? b.quantity - a.quantity : a.quantity - b.quantity) || compareIds(a.itemId, b.itemId);
  for (const group of groups) group.items.sort(compare);
  unclassified.items.sort(compare);
  return { historyCount: records.length, metadataIssues: metadataSummary(index), itemType, order, groups, unclassified,
    selectedTypeCount: groups.reduce((total, group) => total + group.total, 0), otherTypeCount };
}

const zeroMonth = (): MonthCounts => ({ total: 0, fiveStars: 0, standard: 0, characterEvent: 0, weaponEvent: 0 });
export function monthlyStatistics(records: readonly AnalyzedRecord[]) {
  const index = indexItems(records), metadataIssues = metadataSummary(index), counts = new Map<string, MonthCounts>();
  for (const row of records) {
    let month = counts.get(row.monthKey);
    if (!month) { month = zeroMonth(); counts.set(row.monthKey, month); }
    month.total++;
    if (row.metadata.rank === 5 && index.get(decimalId(row.itemId))!.ranks.size <= 1) month.fiveStars++;
    if (row.group === '200') month.standard++;
    if (row.group === '301') month.characterEvent++;
    if (row.group === '302') month.weaponEvent++;
  }
  const months: (MonthCounts & { month: string })[] = [], keys = [...counts.keys()].sort();
  if (keys.length) {
    const monthNumber = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
    for (let cursor = monthNumber(keys[0]!); cursor <= monthNumber(keys.at(-1)!); cursor++) {
      const month = `${String(Math.floor(cursor / 12)).padStart(4, '0')}-${String(cursor % 12 + 1).padStart(2, '0')}`;
      months.push({ month, ...(counts.get(month) ?? zeroMonth()) });
    }
  }
  const totals = zeroMonth();
  for (const month of months) for (const key of Object.keys(totals) as (keyof MonthCounts)[]) totals[key] += month[key];
  return { historyCount: records.length, metadataIssues, months, totals, fiveStarCountsIncomplete: metadataIssues.unknownRankRecords > 0 };
}

export function dailyStatistics(records: readonly AnalyzedRecord[], options: { year: number; currentYear: number; pool?: PityGroup }) {
  const { year, currentYear, pool } = options;
  if (![year, currentYear].every((value) => Number.isInteger(value) && value >= 1 && value <= 9999) ||
    pool !== undefined && !Object.values(POOLS).some((value) => value.group === pool)) throw new RangeError('INVALID_ANALYSIS_OPTIONS');
  const counts = new Map<string, number>();
  for (const row of records) if (row.year === year && (!pool || row.group === pool)) counts.set(row.dateKey, (counts.get(row.dateKey) ?? 0) + 1);
  const days: { date: string; count: number }[] = [], leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let month = 1; month <= 12; month++) for (let day = 1; day <= lengths[month - 1]!; day++) {
    const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    days.push({ date, count: counts.get(date) ?? 0 });
  }
  const total = days.reduce((sum, day) => sum + day.count, 0);
  return { historyCount: records.length, metadataIssues: metadataSummary(indexItems(records)), year, pool: pool ?? null,
    availableYears: [...new Set([year, currentYear, ...records.map((row) => row.year)])].sort((a, b) => b - a), days,
    total, maxDailyCount: Math.max(0, ...counts.values()), hasRecords: total > 0 };
}
