import { setTimeout as delay } from 'node:timers/promises';
import type { SyncJob, SyncPool } from '@gacha/contracts';
import { ImportError, publicJob, SyncError, syncRepository, syncState, type DatabaseConnection, type PoolState, type StoredJob, type SyncState } from '@gacha/db';
import { gameTime, genshinMetadata, pityGroup, type Rank, type MetadataCatalog } from '@gacha/gacha-core';
import { MiyousheClient, ProbeError, type DeviceContext } from '@gacha/providers';
import { resolveRawMetadata, type ImportRecord, type RawMetadata } from '@gacha/uigf';
import { ApiError } from '../auth/security.js';
import type { communityService } from './service.js';

export const SYNC_POOLS: SyncPool[] = ['100', '200', '301', '302', '500'];
type Client = Pick<MiyousheClient, 'getCookieToken' | 'listRoles' | 'generateAuthKey' | 'getWishPage'>;
export interface SyncOptions {
  client?: (device: DeviceContext, signal: AbortSignal) => Client;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
const failure = (error: unknown) => error instanceof ProbeError ? `MIYOUSHE_${error.code.toUpperCase()}`
  : error instanceof ApiError || error instanceof SyncError || error instanceof ImportError ? error.code : 'SYNC_FAILED';
const transient = (error: unknown) => error instanceof ProbeError && (['network', 'timeout'].includes(error.code)
  || error.code === 'upstream' && (error.upstreamCode === 429 || (error.upstreamCode ?? 0) >= 500 && (error.upstreamCode ?? 0) <= 599));
const fatal = (error: unknown) => error instanceof SyncError && error.code !== 'ITEM_ID_UNRESOLVED' || error instanceof ApiError || error instanceof ProbeError
  && ['auth_invalid', 'expired', 'verification_required', 'role_mismatch', 'cancelled'].includes(error.code);
const initialPool = (pool: SyncPool): PoolState => ({ pool, status: 'queued', pages: 0, fetched: 0, inserted: 0, duplicates: 0, enriched: 0,
  retries: 0, authKeyRenewals: 0, code: null, stopReason: null, cursor: '0', newestId: null, checkpoint: null });
export async function syncService(connection: DatabaseConnection, community: ReturnType<typeof communityService>, options: SyncOptions = {}, now = Date.now, catalog: MetadataCatalog = genshinMetadata) {
  const repo = syncRepository(connection, catalog), wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const timestamp = () => new Date(now()).toISOString();
  await repo.recover('SERVER_RESTARTED', timestamp());
  let stopping = false, runner: Promise<void> | undefined, scheduled = false, lastRequest = 0;
  let current: { owner: string; id: string; communityAccountId: string; controller: AbortController } | undefined;
  async function run(row: StoredJob) {
    const state = syncState(row), owner = row.owner_id, id = row.id, started = now(), controller = new AbortController();
    current = { owner, id, communityAccountId: state.communityAccountId, controller };
    const save = async (status: StoredJob['status'], code: string | null = null) => {
      state.updatedAt = timestamp(); return repo.update(owner, id, state, status, code);
    };
    async function guard() {
      if (stopping || controller.signal.aborted) throw new SyncError(stopping ? 'SERVER_STOPPED' : 'SYNC_CANCELLED');
      if (now() - started >= 1800000 || state.pools.reduce((count, pool) => count + pool.fetched, 0) >= 100000) throw new SyncError('SYNC_LIMIT_EXCEEDED');
      await repo.assertActive(owner, id);
    }
    async function request<T>(action: () => Promise<T>, pool?: PoolState): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        await guard();
        await wait(Math.max(0, 1000 - (now() - lastRequest)), controller.signal); await guard(); lastRequest = now();
        try { return await action(); } catch (error) {
          if (!transient(error) || attempt >= 2) throw error;
          if (pool) { pool.retries++; pool.status = 'retrying'; }
          await save('retrying'); await wait(1000 * 2 ** attempt, controller.signal);
          if (pool) pool.status = 'running'; await save('running');
        }
      }
    }
    try {
      if (!await save('running')) return;
      const access = await community.wishCredentials(owner, row.profile_id);
      if (access.credentialId !== state.credentialId || access.communityAccountId !== state.communityAccountId) throw new SyncError('CREDENTIALS_CHANGED');
      const client = options.client?.(access.device, controller.signal) ?? new MiyousheClient({ device: access.device, signal: controller.signal });
      const cookieToken = await request(() => client.getCookieToken(access.credentials));
      const roles = await request(() => client.listRoles(access.credentials.accountId, cookieToken));
      const role = roles.find((entry) => entry.gameBiz === 'hk4e_cn' && entry.uid === state.uid && entry.region === state.region);
      if (!role) throw new ProbeError('role_mismatch', 'roles');
      for (const pool of state.pools) {
        pool.status = 'running'; await save('running');
        try {
          let authkey = await request(() => client.generateAuthKey(access.credentials, role), pool);
          while (true) {
            if (pool.pages >= 5000) throw new SyncError('SYNC_LIMIT_EXCEEDED');
            let page;
            try { page = await request(() => client.getWishPage(authkey, role, pool.pool, pool.cursor), pool); }
            catch (error) {
              if (!(error instanceof ProbeError) || !['auth_invalid', 'expired'].includes(error.code) || pool.authKeyRenewals >= 1) throw error;
              pool.authKeyRenewals++; await save('running');
              authkey = await request(() => client.generateAuthKey(access.credentials, role), pool);
              page = await request(() => client.getWishPage(authkey, role, pool.pool, pool.cursor), pool);
            }
            const records: ImportRecord[] = page.records.map((record) => {
              const metadata: RawMetadata = { lang: 'zh-cn', ...(record.name ? { name: record.name } : {}),
                ...(record.itemType ? { item_type: record.itemType } : {}), ...(record.rankType ? { rank_type: record.rankType } : {}), ...(record.count ? { count: record.count } : {}) };
              try {
                const type = record.itemType === '角色' ? 'character' : record.itemType === '武器' ? 'weapon' : null;
                const itemId = record.itemId ?? (record.name && type && ['3', '4', '5'].includes(record.rankType ?? '')
                  ? catalog.find(record.name, 'zh-cn', type, Number(record.rankType) as Rank)?.id : undefined);
                if (!itemId) throw new SyncError('ITEM_ID_UNRESOLVED');
                const resolved = resolveRawMetadata(itemId, metadata, catalog);
                return { id: record.id, itemId, gachaType: record.gachaType, pityGroup: pityGroup(record.gachaType), timeLocal: record.time,
                  timeUtc: gameTime(record.time, 8).timeUtc, name: resolved.name, itemType: resolved.itemType, rank: resolved.rank, metadata };
              } catch (error) { if (error instanceof SyncError) throw error; throw new ProbeError('protocol', 'history'); }
            });
            if (records.length && !pool.newestId) pool.newestId = records[0]!.id;
            if (page.nextId && (page.nextId !== records.at(-1)?.id || pool.cursor !== '0' && BigInt(page.nextId) >= BigInt(pool.cursor))) throw new ProbeError('protocol', 'history');
            if (!page.nextId && records.length) throw new ProbeError('protocol', 'history');
            if (page.nextId) pool.cursor = page.nextId;
            state.updatedAt = timestamp(); Object.assign(pool, await repo.page(owner, id, state, pool.pool, records));
            if (!page.nextId || pool.checkpoint && records.some((record) => BigInt(record.id) <= BigInt(pool.checkpoint!))) {
              pool.status = 'completed'; pool.stopReason = page.nextId ? 'checkpoint' : 'upstream_end'; await save('running'); break;
            }
          }
          authkey = '';
        } catch (error) {
          pool.status = 'failed'; pool.code = failure(error); await save('running');
          if (fatal(error)) throw error;
        }
      }
      state.finishedAt = timestamp();
      const failed = state.pools.find((pool) => pool.status === 'failed');
      await save(!failed ? 'completed' : state.pools.some((pool) => pool.status === 'completed' || pool.inserted > 0) ? 'partial' : 'failed', failed?.code ?? null);
    } catch (error) {
      const code = stopping ? 'SERVER_STOPPED' : failure(error);
      for (const pool of state.pools) if (pool.status !== 'completed') { pool.status = 'failed'; pool.code ??= code; }
      state.finishedAt = timestamp();
      await save(stopping ? 'interrupted' : state.pools.some((pool) => pool.status === 'completed' || pool.inserted > 0) ? 'partial' : 'failed', code);
    } finally { current = undefined; }
  }
  function kick() {
    if (stopping || runner || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false; if (stopping) return;
      runner = (async () => { for (;;) { if (stopping) break; const row = await repo.next(); if (!row) break; await run(row); } })()
        .catch(() => { /* Persistent state is recovered on restart; never log raw database/upstream failures. */ })
        .finally(async () => { runner = undefined; if (!stopping && await repo.next()) kick(); }).catch(() => undefined);
    });
  }
  async function create(owner: string, profileId: string, pools: SyncPool[], mode: SyncJob['mode'], retryOf: string | null = null) {
    if (stopping) throw new ApiError(503, 'SYNC_UNAVAILABLE');
    if (!pools.length || pools.some((pool) => !SYNC_POOLS.includes(pool)) || new Set(pools).size !== pools.length) throw new ApiError(400, 'INVALID_POOLS');
    const access = await community.wishCredentials(owner, profileId), at = timestamp();
    const state: SyncState = { version: 1, communityAccountId: access.communityAccountId, credentialId: access.credentialId, uid: access.profile.uid, region: access.profile.region,
      mode, updatedAt: at, finishedAt: null, retryOf, pools: pools.map(initialPool) };
    const row = await repo.create(owner, profileId, state, at); kick(); return publicJob(row);
  }
  return {
    create,
    get: async (owner: string, id: string) => publicJob(await repo.get(owner, id)),
    list: async (owner: string, profileId?: string) => (await repo.list(owner, profileId)).map(publicJob),
    retry: async (owner: string, id: string) => {
      const row = await repo.get(owner, id), state = syncState(row);
      if (!['partial', 'failed', 'interrupted', 'cancelled'].includes(row.status)) throw new ApiError(409, 'SYNC_NOT_RETRYABLE');
      return create(owner, row.profile_id, state.pools.filter((pool) => pool.status !== 'completed').map((pool) => pool.pool), state.mode, id);
    },
    cancel: async (owner: string, id: string) => {
      await repo.cancel(owner, id, timestamp()); if (current?.owner === owner && current.id === id) current.controller.abort(); return publicJob(await repo.get(owner, id));
    },
    stopCommunity(owner: string, id: string) { if (current?.owner === owner && current.communityAccountId === id) current.controller.abort(); },
    async close() { stopping = true; current?.controller.abort(); await runner; await repo.recover('SERVER_STOPPED', timestamp()); },
  };
}
