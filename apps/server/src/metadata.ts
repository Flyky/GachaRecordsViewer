import { createHash } from 'node:crypto';
import { DICTIONARY_RESOURCES, type DictionaryStatus } from '@gacha/contracts';
import { metadataRepository, type DatabaseConnection } from '@gacha/db';
import { createMetadataCatalog, genshinMetadata, type ItemMetadata, type MetadataCatalog, type MetadataSnapshot } from '@gacha/gacha-core';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './auth/security.js';
import { requestPublicData } from './public-data.js';
import { readDictionaryArchive, type DictionaryPage } from './dictionary-archive.js';

export interface MetadataOptions { fetch?: typeof globalThis.fetch; now?: () => number; githubProxy?: () => string }
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

export async function downloadDictionary(fetcher: typeof globalThis.fetch, signal: AbortSignal, now: number, proxy = ''): Promise<MetadataSnapshot> {
  if (!proxy) return downloadApiDictionary(fetcher, signal, now);
  const pages = await requestPublicData('https://codeload.github.com/theBowja/genshin-db/tar.gz/refs/heads/main', readDictionaryArchive,
    { fetch: fetcher, signal, proxy, proxyOnly: true, proxyUrl: 'https://github.com/theBowja/genshin-db/archive/refs/heads/main.tar.gz' });
  return dictionarySnapshot(pages, now, 'genshin-db-github');
}

async function downloadApiDictionary(fetcher: typeof globalThis.fetch, signal: AbortSignal, now: number): Promise<MetadataSnapshot> {
  const requests = DICTIONARY_RESOURCES.map(async ({ folder, language, url }) => {
    const rows = await requestPublicData(url, readJson, { fetch: fetcher, signal });
    if (!Array.isArray(rows) || !rows.length) throw new Error('Invalid dictionary source');
    return { folder, language, rows: rows as Record<string, unknown>[] };
  });
  return dictionarySnapshot(await Promise.all(requests), now, 'genshin-db-api');
}

export function dictionarySnapshot(pages: DictionaryPage[], now: number, name: string): MetadataSnapshot {
  const items = new Map<string, ItemMetadata>();
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
  return { schemaVersion: 1, game: 'hk4e', source: { name, version: `v5-${hash}`, url: sourceUrl, license: 'MIT', retrievedAt: new Date(now).toISOString() }, items: sorted };
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
  const execute = (load: (signal: AbortSignal) => Promise<MetadataSnapshot>, manual = false) => {
    if (closed) throw new ApiError(503, 'DICTIONARY_UNAVAILABLE');
    if (pending) throw new ApiError(409, 'DICTIONARY_BUSY');
    const refreshController = new AbortController(); controller = refreshController;
    const signal = AbortSignal.any([refreshController.signal, AbortSignal.timeout(45000)]);
    const run = async () => {
      try {
        const snapshot = await load(signal);
        const candidate = createMetadataCatalog(snapshot);
        if (current.all().some((item) => !candidate.get(item.id))) throw new Error('Dictionary lost existing items');
        if (closed || signal.aborted) throw new Error('Dictionary refresh stopped');
        await repo.save(snapshot);
        current = candidate; storage = 'database'; cacheWarning = false;
        return { ...status(), updating: false };
      } catch { throw new ApiError(manual ? 400 : 502, manual ? 'DICTIONARY_IMPORT_INVALID' : 'DICTIONARY_REFRESH_FAILED'); }
      finally { refreshController.abort(); controller = undefined; pending = undefined; }
    };
    pending = run();
    return pending;
  };
  return {
    catalog, status,
    refresh: (useProxy = false) => {
      const proxy = useProxy ? options.githubProxy?.() : '';
      if (useProxy && !proxy) throw new ApiError(400, 'DATA_PROXY_REQUIRED');
      return execute((signal) => downloadDictionary(options.fetch ?? globalThis.fetch, signal, (options.now ?? Date.now)(), proxy));
    },
    import: (sources: string[]) => execute(async () => {
      if (sources.length !== DICTIONARY_RESOURCES.length) throw new Error('Missing sources');
      const pages = DICTIONARY_RESOURCES.map(({ folder, language }, index) => {
        const content = sources[index]!; if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('Source too large');
        const rows = JSON.parse(content.replace(/^\uFEFF/, '')) as unknown;
        if (!Array.isArray(rows) || !rows.length) throw new Error('Expected dictionary array');
        return { folder, language, rows };
      });
      return dictionarySnapshot(pages, (options.now ?? Date.now)(), 'genshin-db-manual');
    }, true),
    close: async () => { closed = true; controller?.abort(); await pending?.catch(() => undefined); },
  };
}

export function registerMetadata(app: FastifyInstance, service: Awaited<ReturnType<typeof metadataService>>) {
  app.get('/api/admin/dictionary', { onRequest: app.authenticateAdmin }, async () => service.status());
  app.post<{ Body: { useProxy?: boolean } }>('/api/admin/dictionary/refresh', { onRequest: app.authenticateAdmin,
    schema: { body: { type: 'object', additionalProperties: false, properties: { useProxy: { type: 'boolean' } } } },
  }, async (request) => service.refresh(request.body.useProxy));
  app.post<{ Body: { sources: string[] } }>('/api/admin/dictionary/import', { onRequest: app.authenticateAdmin, bodyLimit: 40 * 1024 * 1024,
    schema: { body: { type: 'object', additionalProperties: false, required: ['sources'], properties: {
      sources: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 8 * 1024 * 1024 } },
    } } },
  }, async (request) => service.import(request.body.sources));
}
