import { createHash, createHmac } from 'node:crypto';
import type { ImportPreviewResponse } from '@gacha/contracts';
import { ImportError, uigfRepository, type PreviewState } from '@gacha/db';
import { decodeUigf, encodeUigf, isUigfVersion, MAX_PROFILES, MAX_UPLOAD_BYTES, UigfError } from '@gacha/uigf';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthOptions } from './auth/routes.js';
import { ApiError, equalSecret } from './auth/security.js';

interface PreviewTicket { owner: string; fileHash: string; expiresAt: number; states: PreviewState[]; dictionaryVersion: string }
const documentProperty = { type: 'object' };
const bodySchema = (extra: Record<string, unknown> = {}) => ({
  type: 'object', required: ['document', ...Object.keys(extra)], additionalProperties: false,
  properties: { document: documentProperty, ...extra },
});
export function registerUigf(app: FastifyInstance, options: AuthOptions) {
  const repo = uigfRepository(options.connection, options.metadataCatalog), now = options.now ?? Date.now;
  const key = createHmac('sha256', options.credentialKey).update('uigf-preview-v1').digest();
  app.addHook('onClose', async () => { key.fill(0); });
  const signature = (payload: string) => createHmac('sha256', key).update(payload).digest('base64url');
  const dictionaryVersion = () => options.metadataCatalog ? `${options.metadataCatalog.source.name}@${options.metadataCatalog.source.version}` : 'bundled';
  const fingerprint = (document: unknown) => createHash('sha256').update(JSON.stringify(document)).digest('hex');
  function sign(ticket: PreviewTicket) {
    const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
    return `${payload}.${signature(payload)}`;
  }
  function verify(token: string, owner: string, fileHash: string): PreviewTicket {
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra !== undefined || !equalSecret(mac, signature(payload))) throw new ApiError(400, 'INVALID_PREVIEW_TOKEN');
    const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString()) as PreviewTicket;
    if (ticket.owner !== owner || ticket.fileHash !== fileHash) throw new ApiError(400, 'INVALID_PREVIEW_TOKEN');
    if (ticket.expiresAt <= now()) throw new ApiError(409, 'PREVIEW_EXPIRED');
    if (ticket.dictionaryVersion !== dictionaryVersion()) throw new ApiError(409, 'PREVIEW_STALE');
    return ticket;
  }
  async function respond<T>(reply: FastifyReply, action: () => Promise<T>) {
    try { return await action(); } catch (error) {
      if (error instanceof UigfError || error instanceof ImportError) {
        const code = error.code;
        const status = code === 'PROFILE_NOT_FOUND' ? 404 : ['PREVIEW_STALE', 'IMPORT_CONFLICT'].includes(code) ? 409 : 400;
        return reply.code(status).send({ error: { code, ...(error.details === undefined ? {} : { details: error.details }) } });
      }
      throw error;
    }
  }
  app.post<{ Body: { document: unknown } }>('/api/uigf/preview', {
    onRequest: app.authenticateUser, bodyLimit: MAX_UPLOAD_BYTES, schema: { body: bodySchema() },
  }, (request, reply) => respond(reply, async (): Promise<ImportPreviewResponse> => {
    const owner = request.principal!.user!.id, input = decodeUigf(request.body.document, options.metadataCatalog);
    const profiles = await repo.preview(owner, input), fileHash = fingerprint(request.body.document), expiresAt = now() + 15 * 60_000;
    return { version: input.version, fileHash, expiresAt, profiles, skippedBlocks: input.skippedBlocks,
      warnings: input.profiles.length ? [] : ['NO_GENSHIN_DATA'],
      previewToken: sign({ owner, fileHash, expiresAt, dictionaryVersion: dictionaryVersion(), states: profiles.map(({ index, targetProfileId, dataVersion }) => ({ index, targetProfileId, dataVersion })) }) };
  }));
  app.post<{ Body: { document: unknown; previewToken: string; profileIndexes: number[] } }>('/api/uigf/import', {
    onRequest: app.authenticateUser, bodyLimit: MAX_UPLOAD_BYTES,
    schema: { body: bodySchema({ previewToken: { type: 'string', minLength: 1, maxLength: 32768 },
      profileIndexes: { type: 'array', minItems: 1, maxItems: MAX_PROFILES, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: MAX_PROFILES - 1 } } }) },
  }, (request, reply) => respond(reply, async () => {
    const owner = request.principal!.user!.id, { document, previewToken, profileIndexes } = request.body;
    const fileHash = fingerprint(document), ticket = verify(previewToken, owner, fileHash);
    return repo.import(owner, decodeUigf(document, options.metadataCatalog), profileIndexes, ticket.states, fileHash);
  }));
  app.get('/api/profiles', { onRequest: app.authenticateUser }, (request, reply) => respond(reply, async () => ({ profiles: await repo.list(request.principal!.user!.id) })));
  app.get<{ Params: { profileId: string }; Querystring: { version?: string } }>('/api/uigf/export/:profileId', {
    onRequest: app.authenticateUser,
    schema: { params: { type: 'object', required: ['profileId'], properties: { profileId: { type: 'string', minLength: 1, maxLength: 128 } } },
      querystring: { type: 'object', additionalProperties: false, properties: { version: { type: 'string' } } } },
  }, (request, reply) => respond(reply, async () => {
    const version = request.query.version ?? 'v4.0';
    if (!isUigfVersion(version)) throw new UigfError('UNSUPPORTED_UIGF_VERSION');
    const profile = await repo.export(request.principal!.user!.id, request.params.profileId);
    const document = encodeUigf([profile], version, now());
    // UID came through persistence; sanitize even if a future source stores an unexpected value.
    const uid = profile.uid.replace(/[^0-9]/g, '').slice(0, 20) || 'profile';
    reply.header('Content-Disposition', `attachment; filename="UIGF_${version}_${uid}_${now()}.json"`);
    return document;
  }));
}
