import { RECORD_PAGE_SIZES, RECORD_POOLS, type RecordPageRequest, type RecordPageResponse } from '@gacha/contracts';
import { gameTime } from '@gacha/gacha-core';
import type { ExportProfile } from '@gacha/uigf';
import { ApiError } from '../auth/security.js';
import { analyzeProfile } from '../history.js';

export interface RecordQueryStrings {
  from?: string; to?: string; pools?: string; itemTypes?: string; ranks?: string; name?: string;
  order?: 'asc' | 'desc'; page?: string; pageSize?: string;
}
export function parseRecordQuery(query: RecordQueryStrings): RecordPageRequest {
  const invalid = () => { throw new ApiError(400, 'INVALID_RECORD_QUERY'); };
  function list<T extends string>(text: string | undefined, allowed: readonly T[]): T[] {
    if (text === undefined || text === '') return [];
    const parts = text.split(',');
    if (parts.length > allowed.length || parts.some((part) => !allowed.includes(part as T)) || new Set(parts).size !== parts.length) return invalid();
    return parts as T[];
  }
  for (const time of [query.from, query.to]) {
    if (time !== undefined) { try { gameTime(time, 0); } catch { invalid(); } }
  }
  if (query.from && query.to && query.from > query.to) invalid();
  const page = query.page === undefined ? 1 : Number(query.page), pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000000 || !RECORD_PAGE_SIZES.includes(pageSize as 20)) invalid();
  return { ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}),
    pools: list(query.pools, RECORD_POOLS), itemTypes: list(query.itemTypes, ['character', 'weapon']),
    ranks: list(query.ranks, ['3', '4', '5']).map(Number) as (3 | 4 | 5)[],
    name: query.name?.trim() ?? '', order: query.order ?? 'desc', page, pageSize: pageSize as 20 | 50 | 100 | 200 };
}

/** Read a complete owner-scoped snapshot, analyze once, then filter/reverse/slice. */
export function queryRecords(profileId: string, profile: ExportProfile, query: RecordPageRequest): RecordPageResponse {
  const history = analyzeProfile(profile);
  const needle = query.name?.toLowerCase() ?? '';
  const filtered = history.records.filter((record) =>
    (!query.from || record.time >= query.from) && (!query.to || record.time <= query.to) &&
    (!query.pools?.length || query.pools.includes(record.group)) &&
    (!query.itemTypes?.length || record.metadata.itemType !== null && query.itemTypes.includes(record.metadata.itemType)) &&
    (!query.ranks?.length || record.metadata.rank !== null && query.ranks.includes(record.metadata.rank)) &&
    (!needle || record.metadata.name?.toLowerCase().includes(needle) || record.name?.toLowerCase().includes(needle)));
  if (query.order !== 'asc') filtered.reverse();
  const pageSize = query.pageSize ?? 20, pageCount = Math.ceil(filtered.length / pageSize);
  const page = Math.max(1, Math.min(query.page ?? 1, pageCount || 1));
  return { profileId, uid: profile.uid, timezone: profile.timezone, historyCount: history.records.length,
    total: filtered.length, page, pageSize, pageCount, totalsByPool: history.totals, metadataIncomplete: history.metadataIncomplete,
    records: filtered.slice((page - 1) * pageSize, page * pageSize).map((record) => ({
      id: record.id, itemId: record.itemId, time: record.time, name: record.metadata.name,
      itemType: record.metadata.itemType, rank: record.metadata.rank, gachaType: record.gachaType, pool: record.group,
      groupOrdinal: record.groupOrdinal, metadataStatus: record.metadata.status,
      pity: { count: record.pity.count, status: record.pity.status, reasons: record.pity.reasons },
    })) };
}
