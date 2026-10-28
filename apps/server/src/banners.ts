import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { BANNER_SOURCE_URL, type BannerStatus } from '@gacha/contracts';
import { snapshotRepository, type DatabaseConnection } from '@gacha/db';
import { builtinCharacterBanners, gameTime, type BannerSnapshot, type CharacterBanner, type MetadataCatalog } from '@gacha/gacha-core';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './auth/security.js';
import { requestPublicData } from './public-data.js';

export interface BannerOptions { fetch?: typeof globalThis.fetch; now?: () => number; githubProxy?: () => string }
type Node = { type: string; [key: string]: unknown };
const node = (input: unknown) => { if (!input || typeof input !== 'object' || typeof (input as Node).type !== 'string') throw new Error('Invalid AST'); return input as Node; };
const field = (input: Node, key: string): Node | undefined => {
  if (input.type !== 'ObjectExpression' || !Array.isArray(input.properties)) throw new Error('Expected object');
  const matches = input.properties.map(node).filter((property) => {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init' || property.method) throw new Error('Expected literal property');
    const name = node(property.key); return name.name === key || name.value === key;
  });
  if (matches.length > 1) throw new Error('Duplicate property');
  return matches[0] ? node(matches[0].value) : undefined;
};
const literal = (input: Node | undefined) => { if (!input || input.type !== 'Literal') throw new Error('Expected literal'); return input.value; };
const text = (value: unknown) => { if (typeof value !== 'string' || !value.length || value.length > 1024) throw new Error('Expected text'); return value; };
const flag = (input: Node | undefined) => { if (!input) return false; const value = literal(input); if (typeof value !== 'boolean') throw new Error('Expected flag'); return value; };
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
export function parseBannerSource(source: string, catalog: MetadataCatalog): CharacterBanner[] {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let root: Node | undefined;
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declaration.declarations) if (declaration.id.type === 'Identifier' && declaration.id.name === 'banners') root = node(declaration.init);
  }
  if (!root) throw new Error('Missing banners');
  const array = field(root, 'characters'); if (array?.type !== 'ArrayExpression' || !Array.isArray(array.elements)) throw new Error('Missing characters');
  const ids = new Map<string, string>();
  for (const item of catalog.all()) if (item.itemType === 'character' && item.rank === 5 && item.names['en-us']) {
    const key = normalize(item.names['en-us']); if (ids.has(key)) throw new Error('Ambiguous character name'); ids.set(key, item.id);
  }
  return array.elements.map((input) => {
    const entry = node(input), featured = field(entry, 'featured');
    if (featured?.type !== 'ArrayExpression' || !Array.isArray(featured.elements)) throw new Error('Missing featured');
    return { start: text(literal(field(entry, 'start'))), end: text(literal(field(entry, 'end'))), startGlobal: flag(field(entry, 'timezoneDependent')),
      endGlobal: flag(field(entry, 'timezoneDependentEnd')), itemIds: [...new Set(featured.elements.map((item) => {
        const id = ids.get(normalize(text(literal(node(item))))); if (!id) throw new ApiError(422, 'BANNER_CHARACTER_UNKNOWN'); return id;
      }))] };
  });
}
function validate(input: unknown): BannerSnapshot & { source: BannerSnapshot['source'] & { retrievedAt?: string } } {
  const value = input as BannerSnapshot;
  if (!value?.source || value.source.name !== 'paimon-moe'
    || !(/^[a-f0-9]{40}$/.test(value.source.revision)
      ? value.source.url === `https://raw.githubusercontent.com/MadeBaruna/paimon-moe/${value.source.revision}/src/data/banners.js`
      : /^manual-[a-f0-9]{64}$/.test(value.source.revision) && value.source.url === BANNER_SOURCE_URL)
    || !Array.isArray(value.entries) || value.entries.length < 100 || value.entries.length > 4096) throw new Error('Invalid banner snapshot');
  for (const entry of value.entries) {
    if (gameTime(entry.start, 8).timestamp >= gameTime(entry.end, 8).timestamp || typeof entry.startGlobal !== 'boolean' || typeof entry.endGlobal !== 'boolean'
      || !Array.isArray(entry.itemIds) || !entry.itemIds.length || entry.itemIds.length > 16 || entry.itemIds.some((id) => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))) throw new Error('Invalid banner period');
  }
  return value;
}
const range = (snapshot: BannerSnapshot) => ({ firstStart: snapshot.entries.map((entry) => entry.start).sort()[0]!, lastEnd: snapshot.entries.map((entry) => entry.end).sort().at(-1)! });
async function read(response: Response) {
  if (!response.ok || !response.body) throw new Error('Banner source unavailable');
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > 1024 * 1024) throw new Error('Banner source too large'); chunks.push(result.value); } return Buffer.concat(chunks).toString('utf8'); }
  catch (error) { await reader.cancel().catch(() => undefined); throw error; } finally { reader.releaseLock(); }
}
export async function bannerService(connection: DatabaseConnection, catalog: MetadataCatalog, options: BannerOptions = {}) {
  const repo = snapshotRepository(connection), now = options.now ?? Date.now;
  let current = validate(builtinCharacterBanners), storage: BannerStatus['storage'] = 'builtin', cacheWarning = false;
  try { const saved = await repo.load('hk4e-character-banners'); if (saved !== undefined) { current = validate(saved); storage = 'database'; } } catch { cacheWarning = true; }
  let controller: AbortController | undefined, pending: Promise<BannerStatus> | undefined, closed = false;
  const status = (): BannerStatus => ({ source: current.source.name, version: current.source.revision, count: current.entries.length, ...range(current),
    updatedAt: current.source.retrievedAt ?? '', storage, updating: !!pending, cacheWarning });
  const execute = (load: (signal: AbortSignal) => Promise<BannerSnapshot>, manual = false) => {
    if (closed) throw new ApiError(503, 'BANNER_UNAVAILABLE'); if (pending) throw new ApiError(409, 'BANNER_BUSY');
    controller = new AbortController(); const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
    pending = (async () => {
      try {
        const candidate = validate(await load(signal));
        if (candidate.entries.some((entry) => entry.itemIds.some((id) => catalog.get(id)?.itemType !== 'character' || catalog.get(id)?.rank !== 5))) throw new ApiError(422, 'BANNER_CHARACTER_UNKNOWN');
        const before = range(current), after = range(candidate);
        if (after.firstStart > before.firstStart || after.lastEnd < before.lastEnd) throw new Error('Banner coverage shrank');
        signal.throwIfAborted(); if (closed) throw new Error('Closed');
        await repo.save('hk4e-character-banners', candidate); current = candidate; storage = 'database'; cacheWarning = false;
        return { ...status(), updating: false };
      } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(manual ? 400 : 502, manual ? 'BANNER_IMPORT_INVALID' : 'BANNER_REFRESH_FAILED'); }
      finally { controller?.abort(); controller = undefined; pending = undefined; }
    })(); return pending;
  };
  return { get: () => current, status,
    refresh: (useProxy = false) => {
      const proxy = useProxy ? options.githubProxy?.() : '';
      if (useProxy && !proxy) throw new ApiError(400, 'DATA_PROXY_REQUIRED');
      return execute(async (signal) => {
        const request = <T>(url: string, parse: (text: string) => T) => requestPublicData(url, async (response) => parse(await read(response)),
          { fetch: options.fetch ?? globalThis.fetch, signal, proxy, proxyOnly: useProxy });
        const revision = await request('https://api.github.com/repos/MadeBaruna/paimon-moe/commits?path=src/data/banners.js&per_page=1', (text) => {
          const commits = JSON.parse(text) as { sha: string }[], sha = commits[0]?.sha;
          if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Missing revision'); return sha;
        });
        const url = `https://raw.githubusercontent.com/MadeBaruna/paimon-moe/${revision}/src/data/banners.js`;
        const { source, entries } = await request(url, (source) => ({ source, entries: parseBannerSource(source, catalog) }));
        return { source: { name: 'paimon-moe', revision, url, retrievedAt: new Date(now()).toISOString(), license: 'MIT', sha256: createHash('sha256').update(source).digest('hex') }, entries };
      });
    },
    import: (content: string) => execute(async () => {
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Banner source too large');
      const source = content.replace(/^\uFEFF/, '');
      let json: unknown;
      try { json = JSON.parse(source); } catch { /* Upstream provides literal JavaScript. It is parsed, never executed. */ }
      let entries: CharacterBanner[];
      if (json && typeof json === 'object' && 'entries' in json) entries = (json as BannerSnapshot).entries;
      else entries = parseBannerSource(json === undefined ? source : `export const banners = ${JSON.stringify(Array.isArray(json) ? { characters: json } : json)};`, catalog);
      const hash = createHash('sha256').update(source).digest('hex');
      return { source: { name: 'paimon-moe', revision: `manual-${hash}`, url: BANNER_SOURCE_URL, retrievedAt: new Date(now()).toISOString(), license: 'MIT', sha256: hash }, entries };
    }, true),
    close: async () => { closed = true; controller?.abort(); await pending?.catch(() => undefined); },
  };
}
export function registerBanners(app: FastifyInstance, service: Awaited<ReturnType<typeof bannerService>>) {
  app.get('/api/admin/banners', { onRequest: app.authenticateAdmin }, async () => service.status());
  app.post<{ Body: { useProxy?: boolean } }>('/api/admin/banners/refresh', { onRequest: app.authenticateAdmin,
    schema: { body: { type: 'object', additionalProperties: false, properties: { useProxy: { type: 'boolean' } } } },
  }, async (request) => service.refresh(request.body.useProxy));
  app.post<{ Body: { content: string } }>('/api/admin/banners/import', { onRequest: app.authenticateAdmin, bodyLimit: 3 * 1024 * 1024,
    schema: { body: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string', minLength: 1, maxLength: 1024 * 1024 } } } },
  }, async (request) => service.import(request.body.content));
}
