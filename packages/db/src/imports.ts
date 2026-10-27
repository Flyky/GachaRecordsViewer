import { randomUUID } from 'node:crypto';
import type { GameProfileSummary, ImportProfileReport, ImportResultResponse } from '@gacha/contracts';
import { decimalId, resolveRawMetadata, type DecodedUigf, type ExportProfile, type ImportProfile, type ImportRecord, type RawMetadata } from '@gacha/uigf';
import { sql } from 'drizzle-orm';
import type { ProfileRow } from './repositories.js';
import type { DatabaseConnection, SqlExecutor } from './types.js';

export class ImportError extends Error {
  constructor(readonly code: string, readonly details?: unknown) { super(code); }
}
export interface PreviewState { index: number; targetProfileId: string | null; dataVersion: number | null }
interface RecordRow {
  record_id: string; item_id: string; gacha_type: string; pity_group: string; time_local: string; time_utc: string;
  name: string | null; item_type: ImportRecord['itemType']; rank: ImportRecord['rank']; metadata_json: string;
}
function recordFromRow(row: RecordRow): ImportRecord {
  return { id: row.record_id, itemId: row.item_id, gachaType: row.gacha_type, pityGroup: row.pity_group,
    timeLocal: row.time_local, timeUtc: row.time_utc, name: row.name, itemType: row.item_type, rank: row.rank,
    metadata: JSON.parse(row.metadata_json) as RawMetadata };
}
async function records(tx: SqlExecutor, owner: string, profile: string) {
  return (await tx.query<RecordRow>(sql`SELECT * FROM gacha_records WHERE owner_id=${owner} AND profile_id=${profile}`)).map(recordFromRow);
}
function mergeMetadata(existing: ImportRecord, incoming: ImportRecord) {
  const metadata = { ...existing.metadata };
  let warning = false, changed = false;
  for (const key of ['name', 'item_type', 'rank_type', 'count'] as const) {
    const value = incoming.metadata[key];
    if (!value) continue;
    if (metadata[key]) { if (metadata[key] !== value) warning = true; continue; }
    if ((key === 'name' || key === 'item_type') && (metadata.name || metadata.item_type) && metadata.lang !== incoming.metadata.lang) {
      warning = true; continue;
    }
    metadata[key] = value; changed = true;
    if (key === 'name' || key === 'item_type') {
      if (incoming.metadata.lang) metadata.lang = incoming.metadata.lang;
      else delete metadata.lang;
    }
  }
  if (!changed) return { record: existing, changed, warning };
  const effective = resolveRawMetadata(existing.itemId, metadata);
  return { record: { ...existing, metadata, name: effective.name, itemType: effective.itemType, rank: effective.rank }, changed, warning };
}
async function plan(tx: SqlExecutor, owner: string, input: ImportProfile) {
  const matches = await tx.query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE owner_id=${owner} AND game='hk4e' AND uid=${input.uid} ORDER BY id`);
  const profile = matches[0];
  const stored = profile ? await records(tx, owner, profile.id) : [];
  const originalIds = new Set(stored.map((row) => decimalId(row.id)));
  const combined = new Map(stored.map((row) => [decimalId(row.id), row]));
  const updates = new Set<string>(), inserts = new Set<string>();
  const times = input.records.map((record) => record.timeLocal).sort();
  const report: ImportProfileReport = {
    index: input.index, uid: input.uid, timezone: input.timezone, lang: input.lang,
    targetProfileId: profile?.id ?? null, dataVersion: profile?.data_version ?? null,
    total: input.records.length, inserted: 0, duplicates: 0, enriched: 0, conflicts: 0, conflictDetails: [], blockers: [], metadataWarnings: 0,
    metadataIncomplete: input.metadataIncomplete, metadataConflicts: input.metadataConflicts,
    firstTime: times[0] ?? null, lastTime: times.at(-1) ?? null,
  };
  if (matches.length > 1) report.blockers.push('AMBIGUOUS_PROFILE');
  if (profile && profile.timezone !== input.timezone) report.blockers.push('TIMEZONE_CONFLICT');
  for (const incoming of input.records) {
    const key = decimalId(incoming.id), existing = combined.get(key);
    if (!existing) { combined.set(key, incoming); inserts.add(key); continue; }
    const fields = (['gachaType', 'pityGroup', 'timeLocal', 'timeUtc'] as const).filter((field) => existing[field] !== incoming[field]) as string[];
    if (decimalId(existing.itemId) !== decimalId(incoming.itemId)) fields.push('itemId');
    if (existing.metadata.count && incoming.metadata.count && existing.metadata.count !== incoming.metadata.count) fields.push('count');
    if (fields.length) {
      report.conflicts++;
      if (report.conflictDetails.length < 20) report.conflictDetails.push({ id: incoming.id, fields });
      continue;
    }
    report.duplicates++;
    const merged = mergeMetadata(existing, incoming);
    if (merged.warning) report.metadataWarnings++;
    if (merged.changed) { combined.set(key, merged.record); if (originalIds.has(key)) updates.add(key); }
  }
  report.inserted = inserts.size; report.enriched = updates.size;
  return { report, input, inserts: [...inserts].map((key) => combined.get(key)!), updates: [...updates].map((key) => combined.get(key)!) };
}

/** One owner lock serializes preview/merge/export; every read and write also scopes its SQL by owner. */
export function uigfRepository(connection: DatabaseConnection) {
  async function transaction<T>(owner: string, work: (tx: SqlExecutor) => Promise<T>) {
    return connection.transaction(async (tx) => {
      if (connection.kind === 'postgres') await tx.execute(sql`SELECT pg_advisory_xact_lock(72407001, hashtext(${owner}))`);
      return work(tx);
    });
  }
  const snapshot = (owner: string, profileId: string) => transaction(owner, async (tx) => {
    const profile = (await tx.query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE owner_id=${owner} AND id=${profileId} AND game='hk4e'`))[0];
    if (!profile) throw new ImportError('PROFILE_NOT_FOUND');
    return { profileId: profile.id, dataVersion: profile.data_version, uid: profile.uid, timezone: profile.timezone, lang: profile.lang,
      records: await records(tx, owner, profile.id) };
  });
  return {
    preview: (owner: string, input: DecodedUigf) => transaction(owner, async (tx) => {
      const result: ImportProfileReport[] = [];
      for (const profile of input.profiles) result.push((await plan(tx, owner, profile)).report);
      return result;
    }),
    import: (owner: string, input: DecodedUigf, indexes: number[], states: PreviewState[], fileHash: string): Promise<ImportResultResponse> => transaction(owner, async (tx) => {
      if (!indexes.length || new Set(indexes).size !== indexes.length || indexes.some((index) => !Number.isInteger(index) || !input.profiles[index])) throw new ImportError('INVALID_SELECTION');
      const plans: Awaited<ReturnType<typeof plan>>[] = [];
      for (const index of indexes) {
        const current = await plan(tx, owner, input.profiles[index]!);
        const state = states.find((entry) => entry.index === index);
        if (!state || state.targetProfileId !== current.report.targetProfileId || state.dataVersion !== current.report.dataVersion) throw new ImportError('PREVIEW_STALE');
        plans.push(current);
      }
      if (plans.some(({ report }) => report.conflicts || report.blockers.length)) throw new ImportError('IMPORT_CONFLICT', plans.map(({ report }) => report));
      for (const entry of plans) {
        const { input: profile, report } = entry;
        const profileId = report.targetProfileId ?? randomUUID();
        if (!report.targetProfileId) await tx.execute(sql`INSERT INTO game_profiles (id, owner_id, game, uid, region, timezone, lang)
          VALUES (${profileId}, ${owner}, 'hk4e', ${profile.uid}, 'unknown', ${profile.timezone}, ${profile.lang})`);
        for (const record of entry.inserts) await tx.execute(sql`INSERT INTO gacha_records
          (owner_id, profile_id, record_id, item_id, gacha_type, pity_group, time_local, time_utc, name, item_type, rank, source, metadata_json)
          VALUES (${owner}, ${profileId}, ${record.id}, ${record.itemId}, ${record.gachaType}, ${record.pityGroup}, ${record.timeLocal}, ${record.timeUtc},
            ${record.name}, ${record.itemType}, ${record.rank}, 'uigf', ${JSON.stringify(record.metadata)})`);
        for (const record of entry.updates) await tx.execute(sql`UPDATE gacha_records SET name=${record.name}, item_type=${record.itemType}, rank=${record.rank}, metadata_json=${JSON.stringify(record.metadata)}
          WHERE owner_id=${owner} AND profile_id=${profileId} AND record_id=${record.id}`);
        if (entry.inserts.length || entry.updates.length) await tx.execute(sql`UPDATE game_profiles SET data_version=data_version+1 WHERE owner_id=${owner} AND id=${profileId}`);
        report.targetProfileId = profileId;
        report.dataVersion = (report.dataVersion ?? 0) + (entry.inserts.length || entry.updates.length ? 1 : 0);
      }
      const result = { batchId: randomUUID(), profiles: plans.map(({ report }) => report), skippedBlocks: input.skippedBlocks };
      await tx.execute(sql`INSERT INTO import_batches (id, owner_id, file_hash, status, result_json, created_at)
        VALUES (${result.batchId}, ${owner}, ${fileHash}, 'completed', ${JSON.stringify(result)}, ${new Date().toISOString()})`);
      return result;
    }),
    snapshot,
    export: async (owner: string, profileId: string): Promise<ExportProfile> => {
      const { uid, timezone, lang, records } = await snapshot(owner, profileId);
      return { uid, timezone, lang, records };
    },
    list: (owner: string): Promise<GameProfileSummary[]> => transaction(owner, async (tx) => {
      const rows = await tx.query<ProfileRow & { record_count: string | number; first_time: string | null; last_time: string | null; incomplete: string | number }>(sql`
        SELECT p.*, (SELECT count(*) FROM gacha_records r WHERE r.owner_id=p.owner_id AND r.profile_id=p.id) AS record_count,
        (SELECT min(time_local) FROM gacha_records r WHERE r.owner_id=p.owner_id AND r.profile_id=p.id) AS first_time,
        (SELECT max(time_local) FROM gacha_records r WHERE r.owner_id=p.owner_id AND r.profile_id=p.id) AS last_time,
        (SELECT count(*) FROM gacha_records r WHERE r.owner_id=p.owner_id AND r.profile_id=p.id AND (name IS NULL OR item_type IS NULL OR rank IS NULL)) AS incomplete
        FROM game_profiles p WHERE owner_id=${owner} AND game='hk4e' ORDER BY uid, region, id`);
      return rows.map((row) => ({ id: row.id, uid: row.uid, game: 'hk4e', region: row.region, timezone: row.timezone, lang: row.lang,
        historyStatus: row.history_status, dataVersion: row.data_version, recordCount: Number(row.record_count),
        firstTime: row.first_time, lastTime: row.last_time, metadataIncomplete: Number(row.incomplete) }));
    }),
  };
}
