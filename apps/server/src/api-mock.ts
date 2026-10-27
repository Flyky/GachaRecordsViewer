import { randomBytes, randomUUID } from 'node:crypto';
import { API_MOCK_FORMATS, type ApiMockFormat, type ApiMockLink, type ApiMockResponse } from '@gacha/contracts';
import { ImportError, uigfRepository } from '@gacha/db';
import { compareIds, encodeUigf, resolveRawMetadata, type ExportProfile, type MetadataCatalog } from '@gacha/uigf';
import type { FastifyInstance } from 'fastify';
import type { AuthOptions } from './auth/routes.js';
import { ApiError, digest } from './auth/security.js';

const TTL = 15 * 60_000, MAX_BYTES = 128 * 1024 * 1024;
function wishResponse(profile: ExportProfile, catalog?: MetadataCatalog, empty = false) {
  const list = empty ? [] : [...profile.records].sort((a, b) => compareIds(b.id, a.id)).map((record) => {
    const effective = resolveRawMetadata(record.itemId, record.metadata, catalog), lang = record.metadata.lang ?? profile.lang ?? 'zh-cn';
    const types = lang.startsWith('zh') ? { character: '角色', weapon: '武器' } : { character: 'Character', weapon: 'Weapon' };
    return {
      uid: profile.uid, id: record.id, item_id: record.itemId, gacha_type: record.gachaType, time: record.timeLocal,
      name: effective.name ?? '', item_type: record.metadata.item_type ?? (effective.itemType ? types[effective.itemType] : ''),
      rank_type: effective.rank === null ? '' : String(effective.rank), count: record.metadata.count ?? '1', lang,
    };
  });
  return { retcode: 0, message: 'OK', data: { page: empty ? '2' : '1', size: String(list.length), total: String(profile.records.length), region_time_zone: profile.timezone, list } };
}

/** Temporary bearer links contain only a single owner's exported snapshot, never community credentials. */
export function registerApiMock(app: FastifyInstance, options: AuthOptions) {
  const repo = uigfRepository(options.connection, options.metadataCatalog), now = options.now ?? Date.now;
  type Entry = { owner: string; tokenHash: string; link: ApiMockLink; body: string; empty: string; bytes: number; timer: ReturnType<typeof setTimeout> };
  const owners = new Map<string, Entry>(), tokens = new Map<string, Entry>(), pending = new Map<string, object>();
  let usedBytes = 0, closed = false;
  function remove(entry: Entry) {
    if (owners.get(entry.owner) !== entry) return;
    clearTimeout(entry.timer); owners.delete(entry.owner); tokens.delete(entry.tokenHash); usedBytes -= entry.bytes;
    entry.body = ''; entry.empty = ''; entry.link.url = '';
  }
  function prune() { for (const entry of owners.values()) if (entry.link.expiresAt <= now()) remove(entry); }
  const response = (owner: string): ApiMockResponse => { prune(); return { link: structuredClone(owners.get(owner)?.link ?? null), serverTime: now() }; };
  app.addHook('onClose', async () => { closed = true; pending.clear(); for (const entry of owners.values()) remove(entry); });

  app.get('/api/mock', { onRequest: app.authenticateUser }, (request) => response(request.principal!.user!.id));
  app.post<{ Body: { profileId: string; format?: ApiMockFormat } }>('/api/mock', {
    onRequest: app.authenticateUser, bodyLimit: 4096,
    schema: { body: { type: 'object', required: ['profileId'], additionalProperties: false, properties: {
      profileId: { type: 'string', minLength: 1, maxLength: 128 }, format: { type: 'string', enum: API_MOCK_FORMATS },
    } } },
  }, async (request, reply) => {
    const owner = request.principal!.user!.id;
    if (closed) throw new ApiError(503, 'MOCK_UNAVAILABLE');
    if (pending.has(owner)) throw new ApiError(409, 'MOCK_BUSY');
    const reservation = {}; pending.set(owner, reservation);
    try {
      const profile = await repo.export(owner, request.body.profileId), format = request.body.format ?? 'wish-link';
      const createdAt = now(), body = JSON.stringify(format === 'uigf' ? encodeUigf([profile], 'v4.0', createdAt) : wishResponse(profile, options.metadataCatalog));
      const empty = format === 'uigf' ? '' : JSON.stringify(wishResponse(profile, options.metadataCatalog, true)), bytes = Buffer.byteLength(body) + Buffer.byteLength(empty);
      if (closed || pending.get(owner) !== reservation) throw new ApiError(409, 'MOCK_CANCELLED');
      prune();
      if (usedBytes - (owners.get(owner)?.bytes ?? 0) + bytes > MAX_BYTES || !owners.has(owner) && owners.size >= 128) throw new ApiError(429, 'MOCK_CAPACITY');
      const token = randomBytes(32).toString('base64url'), url = new URL(options.publicUrl);
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/mock/getGachaLog`;
      url.search = ''; url.hash = '';
      url.searchParams.set('authkey', token);
      if (format !== 'uigf') {
        url.searchParams.set('authkey_ver', '1'); url.searchParams.set('sign_type', '2'); url.searchParams.set('auth_appid', 'webview_gacha');
      }
      const link: ApiMockLink = { id: randomUUID(), profileId: request.body.profileId, uid: profile.uid, format,
        recordCount: profile.records.length, createdAt, expiresAt: createdAt + TTL, url: url.href };
      const previous = owners.get(owner); if (previous) remove(previous);
      const entry: Entry = { owner, tokenHash: digest(token), link, body, empty, bytes, timer: setTimeout(() => remove(entry), TTL) };
      entry.timer.unref(); owners.set(owner, entry); tokens.set(entry.tokenHash, entry); usedBytes += bytes;
      reply.code(201); return response(owner);
    } catch (error) {
      if (error instanceof ImportError) throw new ApiError(error.code === 'PROFILE_NOT_FOUND' ? 404 : 400, error.code);
      throw error;
    } finally { if (pending.get(owner) === reservation) pending.delete(owner); }
  });
  app.post('/api/mock/destroy', {
    onRequest: app.authenticateUser, bodyLimit: 4096,
    schema: { body: { type: 'object', additionalProperties: false, properties: {} } },
  }, (request): ApiMockResponse => {
    const owner = request.principal!.user!.id; pending.delete(owner);
    const entry = owners.get(owner); if (entry) remove(entry);
    return response(owner);
  });

  // Query-string bearer keeps the secret out of the application's path-only request logger.
  app.get<{ Querystring: { authkey?: string; page?: string; end_id?: string } }>('/api/mock/getGachaLog', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Access-Control-Allow-Origin', '*')
      .header('X-Robots-Tag', 'noindex, nofollow').header('Referrer-Policy', 'no-referrer');
    prune();
    const token = request.query.authkey;
    const entry = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? tokens.get(digest(token)) : undefined;
    if (!entry) return reply.code(404).send({ retcode: -100, message: 'Link expired or destroyed', data: null });
    const { page, end_id: endId } = request.query;
    if (page !== undefined && (typeof page !== 'string' || !/^[1-9]\d{0,7}$/.test(page))
      || endId !== undefined && (typeof endId !== 'string' || !/^\d{1,128}$/.test(endId))) throw new ApiError(400, 'INVALID_REQUEST');
    // One full batch; a following page/cursor returns an empty terminator, never the full batch again.
    const finished = entry.link.format !== 'uigf' && (page !== undefined && Number(page) > 1 || endId !== undefined && BigInt(endId) > 0n);
    return reply.type('application/json; charset=utf-8').send(finished ? entry.empty : entry.body);
  });
}
