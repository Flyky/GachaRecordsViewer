import { randomUUID } from 'node:crypto';
import type { SyncJob, SyncPool, SyncPoolProgress } from '@gacha/contracts';
import type { ImportRecord, MetadataCatalog } from '@gacha/uigf';
import { sql } from 'drizzle-orm';
import { mergeOnlineRecords } from './imports.js';
import type { ProfileRow } from './repositories.js';
import type { DatabaseConnection, SqlExecutor } from './types.js';

export class SyncError extends Error { constructor(readonly code: string) { super(code); } }
export interface PoolState extends SyncPoolProgress { cursor: string; newestId: string | null; checkpoint: string | null }
export interface SyncState {
  version: 1; communityAccountId: string; credentialId: string; uid: string; region: string;
  mode: SyncJob['mode']; updatedAt: string; finishedAt: string | null; retryOf: string | null; pools: PoolState[];
}
export interface StoredJob { id: string; owner_id: string; profile_id: string; status: SyncJob['status']; progress_json: string; failure_code: string | null; created_at: string }
export const syncState = (row: StoredJob): SyncState => {
  const state = JSON.parse(row.progress_json) as SyncState;
  if (state.version !== 1 || !Array.isArray(state.pools)) throw new SyncError('INVALID_JOB_STATE');
  return state;
};
export function publicJob(row: StoredJob): SyncJob {
  const state = syncState(row);
  return { id: row.id, profileId: row.profile_id, status: row.status, mode: state.mode, createdAt: row.created_at,
    updatedAt: state.updatedAt, finishedAt: state.finishedAt, retryOf: state.retryOf, failureCode: row.failure_code,
    pools: state.pools.map(({ pool, status, pages, fetched, inserted, duplicates, enriched, retries, authKeyRenewals, code, stopReason }) =>
      ({ pool, status, pages, fetched, inserted, duplicates, enriched, retries, authKeyRenewals, code, stopReason })) };
}
export function syncRepository(connection: DatabaseConnection, catalog?: MetadataCatalog) {
  const transaction = <T>(owner: string, action: (tx: SqlExecutor) => Promise<T>) => connection.transaction(async (tx) => {
    if (connection.kind === 'postgres') await tx.execute(sql`SELECT pg_advisory_xact_lock(72407001, hashtext(${owner}))`);
    return action(tx);
  });
  async function owned(tx: SqlExecutor, owner: string, id: string) {
    const row = (await tx.query<StoredJob>(sql`SELECT * FROM sync_jobs WHERE owner_id=${owner} AND id=${id}`))[0];
    if (!row) throw new SyncError('SYNC_NOT_FOUND'); return row;
  }
  async function bound(tx: SqlExecutor, owner: string, profileId: string, state: SyncState) {
    const profile = (await tx.query<ProfileRow & { credential_id: string }>(sql`
      SELECT p.*, c.id AS credential_id FROM game_profiles p JOIN community_accounts a ON a.owner_id=p.owner_id AND a.id=p.community_account_id
      JOIN credentials c ON c.owner_id=a.owner_id AND c.community_account_id=a.id AND c.type='miyoushe_bundle'
      WHERE p.owner_id=${owner} AND p.id=${profileId} AND p.game='hk4e' AND a.provider='cn'`))[0];
    if (!profile || profile.community_account_id !== state.communityAccountId || profile.uid !== state.uid || profile.region !== state.region || profile.timezone !== 8) throw new SyncError('SYNC_BINDING_CHANGED');
    if (profile.credential_id !== state.credentialId) throw new SyncError('CREDENTIALS_CHANGED');
    return profile;
  }
  async function active(tx: SqlExecutor, owner: string, id: string) {
    const row = await owned(tx, owner, id);
    if (!['queued', 'running', 'retrying'].includes(row.status)) throw new SyncError('SYNC_NO_LONGER_ACTIVE');
    return { row, profile: await bound(tx, owner, row.profile_id, syncState(row)) };
  }
  return {
    get: (owner: string, id: string) => transaction(owner, (tx) => owned(tx, owner, id)),
    list: (owner: string, profileId?: string) => transaction(owner, (tx) => tx.query<StoredJob>(sql`SELECT * FROM sync_jobs WHERE owner_id=${owner}
      ${profileId ? sql`AND profile_id=${profileId}` : sql``} ORDER BY created_at DESC, id DESC LIMIT 20`)),
    next: async () => (await connection.executor.query<StoredJob>(sql`SELECT * FROM sync_jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1`))[0],
    assertActive: (owner: string, id: string) => transaction(owner, async (tx) => { await active(tx, owner, id); }),
    create: (owner: string, profileId: string, state: SyncState, createdAt: string) => connection.transaction(async (tx) => {
      if (connection.kind === 'postgres') {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(72414001)`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(72407001, hashtext(${owner}))`);
      }
      await bound(tx, owner, profileId, state);
      if ((await tx.query(sql`SELECT id FROM sync_jobs WHERE owner_id=${owner} AND profile_id=${profileId} AND status IN ('queued','running','retrying')`)).length) throw new SyncError('SYNC_ALREADY_ACTIVE');
      if ((await tx.query(sql`SELECT id FROM sync_jobs WHERE status IN ('queued','running','retrying') LIMIT 32`)).length >= 32) throw new SyncError('SYNC_QUEUE_FULL');
      const previous = await tx.query<StoredJob>(sql`SELECT * FROM sync_jobs WHERE owner_id=${owner} AND profile_id=${profileId}
        AND status IN ('completed','partial') ORDER BY created_at DESC, id DESC LIMIT 100`);
      if (state.mode === 'incremental') for (const pool of state.pools) {
        for (const row of previous) {
          const completed = syncState(row).pools.find((entry) => entry.pool === pool.pool && entry.status === 'completed' && entry.newestId !== null);
          if (completed) { pool.checkpoint = completed.newestId; break; }
        }
      }
      const row: StoredJob = { id: randomUUID(), owner_id: owner, profile_id: profileId, status: 'queued', progress_json: JSON.stringify(state), failure_code: null, created_at: createdAt };
      await tx.execute(sql`INSERT INTO sync_jobs (id, owner_id, profile_id, status, progress_json, failure_code, created_at)
        VALUES (${row.id}, ${owner}, ${profileId}, 'queued', ${row.progress_json}, NULL, ${createdAt})`);
      return row;
    }),
    update: (owner: string, id: string, state: SyncState, status: StoredJob['status'], code: string | null = null) => transaction(owner, async (tx) => {
      const row = await owned(tx, owner, id);
      if (!['queued', 'running', 'retrying'].includes(row.status)) return false;
      await tx.execute(sql`UPDATE sync_jobs SET status=${status}, progress_json=${JSON.stringify(state)}, failure_code=${code} WHERE owner_id=${owner} AND id=${id}`);
      return true;
    }),
    page: (owner: string, id: string, state: SyncState, pool: SyncPool, incoming: ImportRecord[]) => transaction(owner, async (tx) => {
      const { profile } = await active(tx, owner, id), next = structuredClone(state), progress = next.pools.find((entry) => entry.pool === pool)!;
      const counts = await mergeOnlineRecords(tx, owner, profile, incoming, catalog);
      progress.pages++; progress.fetched += incoming.length; progress.inserted += counts.inserted; progress.duplicates += counts.duplicates; progress.enriched += counts.enriched;
      await tx.execute(sql`UPDATE sync_jobs SET status='running', progress_json=${JSON.stringify(next)} WHERE owner_id=${owner} AND id=${id}`);
      return progress;
    }),
    cancel: (owner: string, id: string, timestamp: string) => transaction(owner, async (tx) => {
      const row = await owned(tx, owner, id);
      if (['queued', 'running', 'retrying'].includes(row.status)) {
        const state = syncState(row); state.updatedAt = timestamp; state.finishedAt = timestamp;
        await tx.execute(sql`UPDATE sync_jobs SET status='cancelled', failure_code='SYNC_CANCELLED', progress_json=${JSON.stringify(state)} WHERE owner_id=${owner} AND id=${id}`);
      }
    }),
    recover: async (code: 'SERVER_RESTARTED' | 'SERVER_STOPPED', timestamp: string) => connection.transaction(async (tx) => {
      const rows = await tx.query<StoredJob>(sql`SELECT * FROM sync_jobs WHERE status IN ('queued','running','retrying')`);
      for (const row of rows) {
        let progress = row.progress_json;
        try { const state = syncState(row); state.updatedAt = timestamp; state.finishedAt = timestamp; progress = JSON.stringify(state); } catch { /* Legacy rows remain inspectable as raw database data. */ }
        await tx.execute(sql`UPDATE sync_jobs SET status='interrupted', failure_code=${code}, progress_json=${progress} WHERE owner_id=${row.owner_id} AND id=${row.id}`);
      }
    }),
  };
}
