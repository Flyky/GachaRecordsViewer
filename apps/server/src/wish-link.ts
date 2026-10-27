import { randomUUID } from 'node:crypto';
import { WISH_LINK_REGIONS, type WishLinkJob, type WishLinkRegion } from '@gacha/contracts';
import { wishLinkRepository, type DatabaseConnection } from '@gacha/db';
import { gameTime, pityGroup, type Rank, type MetadataCatalog } from '@gacha/gacha-core';
import { MiyousheClient, parseWishLink, ProbeError, type ParsedWishLink } from '@gacha/providers';
import { resolveRawMetadata, type RawMetadata } from '@gacha/uigf';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './auth/security.js';
import { operationCode, ownedTaskQueue, requestPacer, type PaceOptions } from './tasks.js';
import type { AuthOptions } from './auth/routes.js';

export interface WishLinkOptions extends PaceOptions { client?: (signal: AbortSignal) => Pick<MiyousheClient, 'getLinkedWishPage'> }
export function wishLinkService(connection: DatabaseConnection, catalog: MetadataCatalog, options: WishLinkOptions = {}, now = Date.now) {
  const repo = wishLinkRepository(connection, catalog), pace = requestPacer(options), timestamp = () => new Date(now()).toISOString();
  const tasks = ownedTaskQueue<WishLinkJob, ParsedWishLink>(async (owner, job, link, signal) => {
    const client = options.client?.(signal) ?? new MiyousheClient({ signal });
    const region = WISH_LINK_REGIONS.find((entry) => entry.value === job.region)!;
    const started = Date.now(); let fetched = 0;
    for (const pool of job.pools) {
      let cursor = '0'; pool.status = 'running';
      try {
        while (true) {
          signal.throwIfAborted();
          if (Date.now() - started > 1800000 || fetched >= 100000 || pool.pages >= 5000) throw new ApiError(422, 'OPERATION_LIMIT');
          await pace(signal);
          const page = await client.getLinkedWishPage(link, pool.pool, cursor, job.uid ?? undefined);
          signal.throwIfAborted();
          if (page.uid) {
            if (job.uid && page.uid !== job.uid) throw new ProbeError('role_mismatch', 'history');
            job.uid = page.uid;
          }
          const records = page.records.map((record) => {
            const metadata: RawMetadata = { lang: 'zh-cn', ...(record.name ? { name: record.name } : {}), ...(record.itemType ? { item_type: record.itemType } : {}),
              ...(record.rankType ? { rank_type: record.rankType } : {}), ...(record.count ? { count: record.count } : {}) };
            const type = record.itemType === '角色' ? 'character' : record.itemType === '武器' ? 'weapon' : null;
            const itemId = record.itemId ?? (record.name && type && ['3', '4', '5'].includes(record.rankType ?? '')
              ? catalog.find(record.name, 'zh-cn', type, Number(record.rankType) as Rank)?.id : undefined);
            if (!itemId) throw new ApiError(422, 'ITEM_ID_UNRESOLVED');
            const resolved = resolveRawMetadata(itemId, metadata, catalog);
            return { id: record.id, itemId, gachaType: record.gachaType, pityGroup: pityGroup(record.gachaType), timeLocal: record.time,
              timeUtc: gameTime(record.time, region.timezone).timeUtc, name: resolved.name, itemType: resolved.itemType, rank: resolved.rank, metadata };
          });
          if (page.nextId && (page.nextId !== records.at(-1)?.id || cursor !== '0' && BigInt(page.nextId) >= BigInt(cursor))) throw new ProbeError('protocol', 'history');
          if (records.length && (!job.uid || !page.nextId)) throw new ProbeError('protocol', 'history');
          if (records.length) {
            const merged = await repo.page(owner, job.uid!, region.value, region.timezone, records, () => signal.throwIfAborted());
            job.profileId = merged.profileId; pool.inserted += merged.inserted; pool.duplicates += merged.duplicates; pool.enriched += merged.enriched;
          }
          pool.pages++; pool.fetched += records.length; fetched += records.length; job.updatedAt = timestamp();
          if (!page.nextId) break;
          cursor = page.nextId;
        }
        pool.status = 'completed';
      } catch (error) {
        signal.throwIfAborted(); pool.status = 'failed'; pool.code = operationCode(error);
        if (error instanceof ProbeError && ['auth_invalid', 'expired', 'verification_required', 'role_mismatch'].includes(error.code)
          || ['TIMEZONE_CONFLICT', 'REGION_CONFLICT', 'AMBIGUOUS_PROFILE', 'OPERATION_LIMIT'].includes(pool.code)) {
          for (const remaining of job.pools) if (remaining.status === 'queued') { remaining.status = 'failed'; remaining.code = pool.code; }
          break;
        }
      }
    }
    if (!job.uid && job.pools.every((pool) => pool.status === 'completed')) { job.status = 'completed'; job.code = 'WISH_LINK_EMPTY'; }
    else {
      const failures = job.pools.filter((pool) => pool.status === 'failed').length;
      job.status = failures === job.pools.length ? 'failed' : failures ? 'partial' : 'completed';
    }
  }, now);
  return {
    create(owner: string, input: string, region: WishLinkRegion) {
      let parsed: ParsedWishLink;
      try { parsed = parseWishLink(input); } catch { throw new ApiError(400, 'INVALID_WISH_LINK'); }
      const server = WISH_LINK_REGIONS.find((entry) => entry.value === region);
      if (!server || parsed.overseas !== server.overseas || parsed.region && parsed.region !== region) throw new ApiError(400, 'WISH_LINK_REGION_MISMATCH');
      const at = timestamp();
      return tasks.create(owner, { id: randomUUID(), status: 'queued', createdAt: at, updatedAt: at, finishedAt: null, code: null, uid: null, profileId: null, region,
        pools: (['100', '200', '301', '302', '500'] as const).map((pool) => ({ pool, status: 'queued', pages: 0, fetched: 0, inserted: 0, duplicates: 0, enriched: 0, code: null })) }, parsed);
    },
    get: tasks.get, cancel: tasks.cancel, close: tasks.close,
  };
}

export function registerWishLink(app: FastifyInstance, auth: AuthOptions, options: WishLinkOptions = {}) {
  const service = wishLinkService(auth.connection, auth.metadataCatalog!, options, auth.now);
  app.addHook('onClose', async () => { await service.close(); });
  app.get('/api/wish-link/job', { onRequest: app.authenticateUser }, async (request) => ({ job: service.get(request.principal!.user!.id) }));
  app.post<{ Body: { url: string; region: WishLinkRegion } }>('/api/wish-link/jobs', { onRequest: app.authenticateUser, bodyLimit: 40000,
    schema: { body: { type: 'object', required: ['url', 'region'], additionalProperties: false,
      properties: { url: { type: 'string', minLength: 1, maxLength: 32768 }, region: { type: 'string', enum: WISH_LINK_REGIONS.map((region) => region.value) } } } },
  }, async (request, reply) => { const job = service.create(request.principal!.user!.id, request.body.url, request.body.region); return reply.code(202).send({ job }); });
  app.post('/api/wish-link/job/cancel', { onRequest: app.authenticateUser, schema: { body: { type: 'object', additionalProperties: false } } },
    async (request) => ({ job: service.cancel(request.principal!.user!.id) }));
}
