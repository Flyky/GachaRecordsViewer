import { createHash } from 'node:crypto';
import type { DictionaryStatus } from '@gacha/contracts';
import { metadataRepository, type DatabaseConnection } from '@gacha/db';
import { createMetadataCatalog, genshinMetadata, type ItemMetadata, type MetadataCatalog, type MetadataSnapshot } from '@gacha/gacha-core';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './auth/security.js';

export interface MetadataOptions { fetch?: typeof globalThis.fetch; now?: () => number }
const sourceUrl = 'https://github.com/theBowja/genshin-db';

async function readJson(response: Response) {
  if (!response.ok || !response.body) throw new Error('Dictionary source unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Dictionary response too large');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}

export async function downloadDictionary(fetcher: typeof globalThis.fetch, signal: AbortSignal, now: number): Promise<MetadataSnapshot> {
  const requests = (['characters', 'weapons'] as const).flatMap((folder) =>
    (['ChineseSimplified', 'English'] as const).map(async (language) => {
      const url = new URL(`https://genshin-db-api.vercel.app/api/v5/${folder}`);
      url.search = new URLSearchParams({ query: 'names', matchCategories: 'true', verboseCategories: 'true', resultLanguage: language }).toString();
      const rows = await readJson(await fetcher(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } }));
      if (!Array.isArray(rows) || !rows.length) throw new Error('Invalid dictionary source');
      return { folder, language, rows: rows as Record<string, unknown>[] };
    }));
  const pages = await Promise.all(requests), items = new Map<string, ItemMetadata>();
  for (const { folder, language, rows } of pages) {
    const locale = language === 'ChineseSimplified' ? 'zh-cn' : 'en-us', itemType = folder === 'characters' ? 'character' : 'weapon';
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || !Number.isInteger(row.rarity)) throw new Error('Invalid dictionary item');
      if (![3, 4, 5].includes(Number(row.rarity))) continue;
      if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 512) throw new Error('Invalid dictionary name');
      const id = String(row.id), existing = items.get(id);
      if (existing && (existing.itemType !== itemType || existing.rank !== row.rarity || existing.names[locale])) throw new Error('Conflicting dictionary item');
      items.set(id, { id, itemType, rank: row.rarity as 3 | 4 | 5, names: { ...existing?.names, [locale]: row.name } });
    }
  }
  const sorted = [...items.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id, 'en'));
  if (sorted.length < 100 || sorted.some((item) => !item.names['zh-cn'] || !item.names['en-us'])) throw new Error('Incomplete dictionary');
  const hash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 12);
  return { schemaVersion: 1, game: 'hk4e', source: { name: 'genshin-db-api', version: `v5-${hash}`, url: sourceUrl, license: 'MIT', retrievedAt: new Date(now).toISOString() }, items: sorted };
}

export async function metadataService(connection: DatabaseConnection, options: MetadataOptions = {}) {
  const repo = metadataRepository(connection);
  let current = genshinMetadata, storage: DictionaryStatus['storage'] = 'builtin', cacheWarning = false;
  try {
    const saved = await repo.load();
    if (saved !== undefined) { current = createMetadataCatalog(saved); if (!current.size) throw new Error(); storage = 'database'; }
  } catch { current = genshinMetadata; cacheWarning = true; }
  // Each application owns its facade; updates do not mutate another instance's catalog.
  const catalog: MetadataCatalog = {
    get source() { return current.source; }, get size() { return current.size; }, all: () => current.all(),
    get: (id) => current.get(id), find: (name, language, type, rank) => current.find(name, language, type, rank),
  };
  let controller: AbortController | undefined, pending: Promise<DictionaryStatus> | undefined, closed = false;
  const status = (): DictionaryStatus => ({ source: current.source.name, version: current.source.version, count: current.size,
    updatedAt: current.source.retrievedAt, storage, updating: pending !== undefined, cacheWarning });
  return {
    catalog, status,
    refresh: async () => {
      if (closed) throw new ApiError(503, 'DICTIONARY_UNAVAILABLE');
      if (pending) throw new ApiError(409, 'DICTIONARY_BUSY');
      const refreshController = new AbortController(); controller = refreshController;
      const signal = AbortSignal.any([refreshController.signal, AbortSignal.timeout(45000)]);
      const run = async () => {
        try {
          const snapshot = await downloadDictionary(options.fetch ?? globalThis.fetch, signal, (options.now ?? Date.now)());
          const candidate = createMetadataCatalog(snapshot);
          if (current.all().some((item) => !candidate.get(item.id))) throw new Error('Dictionary lost existing items');
          if (closed || signal.aborted) throw new Error('Dictionary refresh stopped');
          await repo.save(snapshot);
          current = candidate; storage = 'database'; cacheWarning = false;
          return { ...status(), updating: false };
        } catch { throw new ApiError(502, 'DICTIONARY_REFRESH_FAILED'); }
        finally { refreshController.abort(); controller = undefined; pending = undefined; }
      };
      pending = run();
      return pending;
    },
    close: async () => { closed = true; controller?.abort(); await pending?.catch(() => undefined); },
  };
}

export function registerMetadata(app: FastifyInstance, service: Awaited<ReturnType<typeof metadataService>>) {
  app.get('/api/admin/dictionary', { onRequest: app.authenticateAdmin }, async () => service.status());
  app.post('/api/admin/dictionary/refresh', { onRequest: app.authenticateAdmin,
    schema: { body: { type: 'object', additionalProperties: false } },
  }, async () => service.refresh());
}
