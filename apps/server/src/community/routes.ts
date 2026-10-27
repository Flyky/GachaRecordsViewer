import { CommunityError, SyncError } from '@gacha/db';
import { ProbeError } from '@gacha/providers';
import type { CredentialKind, SyncPool } from '@gacha/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthOptions } from '../auth/routes.js';
import { AuthLimiter } from '../auth/security.js';
import { communityService, type CommunityOptions } from './service.js';
import { qrService, type QrOptions } from './qr.js';
import { syncService, SYNC_POOLS, type SyncOptions } from './sync.js';

const identifier = { type: 'string', minLength: 1, maxLength: 128 };
const params = { type: 'object', required: ['accountId'], additionalProperties: false, properties: { accountId: identifier } };
const input = { type: 'object', required: ['input'], additionalProperties: false, properties: { input: { type: 'string', minLength: 1, maxLength: 24000 } } };
const noBody = { type: 'object', additionalProperties: false, properties: {} };
export async function registerCommunity(app: FastifyInstance, auth: AuthOptions, options: CommunityOptions & { qr?: QrOptions; sync?: SyncOptions } = {}) {
  const service = communityService(auth.connection, auth.credentialKey, options, auth.now), limiter = new AuthLimiter(auth.now ?? Date.now);
  const qr = qrService(service, options.qr, auth.now), qrLimiter = new AuthLimiter(auth.now ?? Date.now);
  const sync = await syncService(auth.connection, service, options.sync, auth.now), syncLimiter = new AuthLimiter(auth.now ?? Date.now);
  app.addHook('onClose', async () => { await sync.close(); qr.close(); service.close(); });
  const owner = (request: FastifyRequest) => request.principal!.user!.id;
  const limit = async (request: FastifyRequest) => { limiter.consume(request.ip, `community:${owner(request)}`); };
  async function respond<T>(reply: FastifyReply, action: () => Promise<T>) {
    try { return await action(); } catch (error) {
      if (error instanceof SyncError) return reply.code(error.code === 'SYNC_NOT_FOUND' ? 404 : 409).send({ error: { code: error.code } });
      if (error instanceof CommunityError) return reply.code(['COMMUNITY_NOT_FOUND', 'PROFILE_NOT_BOUND'].includes(error.code) ? 404 : 409).send({ error: { code: error.code } });
      if (error instanceof ProbeError) {
        const code = error.stage === 'credential_input' ? 'INVALID_CREDENTIAL_INPUT' : `MIYOUSHE_${error.code.toUpperCase()}`;
        const status = error.stage === 'credential_input' ? 400 : error.code === 'timeout' ? 504
          : ['network', 'protocol', 'upstream'].includes(error.code) ? 502 : error.code === 'verification_required' ? 409 : 422;
        return reply.code(status).send({ error: { code } });
      }
      throw error;
    }
  }
  const jobParams = { type: 'object', required: ['jobId'], additionalProperties: false, properties: { jobId: identifier } };
  const syncLimit = async (request: FastifyRequest) => { syncLimiter.consume(request.ip, `sync:${owner(request)}`); };
  app.post<{ Params: { profileId: string }; Body: { pools?: SyncPool[]; mode?: 'incremental' | 'full' } }>('/api/profiles/:profileId/sync', {
    onRequest: app.authenticateUser, preHandler: syncLimit, schema: {
      params: { type: 'object', required: ['profileId'], additionalProperties: false, properties: { profileId: identifier } },
      body: { type: 'object', additionalProperties: false, properties: {
        pools: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', enum: SYNC_POOLS } }, mode: { type: 'string', enum: ['incremental', 'full'] },
      } },
    },
  }, (request, reply) => respond(reply, async () => {
    const job = await sync.create(owner(request), request.params.profileId, request.body.pools ?? SYNC_POOLS, request.body.mode ?? 'incremental'); reply.code(202); return { job };
  }));
  app.get<{ Querystring: { profileId?: string } }>('/api/sync/jobs', { onRequest: app.authenticateUser,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { profileId: identifier } } },
  }, (request, reply) => respond(reply, async () => ({ jobs: await sync.list(owner(request), request.query.profileId) })));
  app.get<{ Params: { jobId: string } }>('/api/sync/jobs/:jobId', { onRequest: app.authenticateUser, schema: { params: jobParams } },
    (request, reply) => respond(reply, async () => ({ job: await sync.get(owner(request), request.params.jobId) })));
  app.post<{ Params: { jobId: string }; Body: Record<string, never> }>('/api/sync/jobs/:jobId/retry', {
    onRequest: app.authenticateUser, preHandler: syncLimit, schema: { params: jobParams, body: noBody },
  }, (request, reply) => respond(reply, async () => { const job = await sync.retry(owner(request), request.params.jobId); reply.code(202); return { job }; }));
  app.post<{ Params: { jobId: string }; Body: Record<string, never> }>('/api/sync/jobs/:jobId/cancel', {
    onRequest: app.authenticateUser, schema: { params: jobParams, body: noBody },
  }, (request, reply) => respond(reply, async () => ({ job: await sync.cancel(owner(request), request.params.jobId) })));
  const qrParams = { type: 'object', required: ['qrId'], additionalProperties: false, properties: { qrId: identifier } };
  app.post<{ Body: { communityAccountId?: string } }>('/api/community/qr', {
    onRequest: app.authenticateUser, preHandler: async (request) => { qrLimiter.consume(request.ip, `qr:${owner(request)}`); },
    schema: { body: { type: 'object', additionalProperties: false, properties: { communityAccountId: identifier } } },
  }, (request, reply) => respond(reply, async () => {
    const result = await qr.create(owner(request), request.principal!.sessionHash, request.body.communityAccountId);
    reply.code(201); return result;
  }));
  app.get<{ Params: { qrId: string } }>('/api/community/qr/:qrId', { onRequest: app.authenticateUser, schema: { params: qrParams } },
    (request, reply) => respond(reply, async () => qr.get(owner(request), request.principal!.sessionHash, request.params.qrId)));
  app.post<{ Params: { qrId: string }; Body: Record<string, never> }>('/api/community/qr/:qrId/poll', {
    onRequest: app.authenticateUser, schema: { params: qrParams, body: noBody },
  }, (request, reply) => respond(reply, () => qr.poll(owner(request), request.principal!.sessionHash, request.params.qrId)));
  app.post<{ Params: { qrId: string }; Body: Record<string, never> }>('/api/community/qr/:qrId/cancel', {
    onRequest: app.authenticateUser, schema: { params: qrParams, body: noBody },
  }, (request, reply) => respond(reply, async () => qr.cancel(owner(request), request.principal!.sessionHash, request.params.qrId)));
  app.get('/api/community/accounts', { onRequest: app.authenticateUser }, (request, reply) => respond(reply, async () => ({ accounts: await service.list(owner(request)) })));
  app.get<{ Params: { accountId: string } }>('/api/community/accounts/:accountId', { onRequest: app.authenticateUser, schema: { params } },
    (request, reply) => respond(reply, async () => ({ account: await service.get(owner(request), request.params.accountId) })));
  app.post<{ Body: { input: string } }>('/api/community/accounts', { onRequest: app.authenticateUser, preHandler: limit, bodyLimit: 32768, schema: { body: input } },
    (request, reply) => respond(reply, async () => { const account = await service.import(owner(request), request.body.input); reply.code(201); return { account }; }));
  app.post<{ Params: { accountId: string }; Body: { input: string } }>('/api/community/accounts/:accountId/credentials', {
    onRequest: app.authenticateUser, preHandler: limit, bodyLimit: 32768, schema: { params, body: input },
  }, (request, reply) => respond(reply, async () => ({ account: await service.import(owner(request), request.body.input, request.params.accountId) })));
  app.post<{ Params: { accountId: string }; Body: { profileId?: string } }>('/api/community/accounts/:accountId/validate', {
    onRequest: app.authenticateUser, preHandler: limit, schema: { params, body: { type: 'object', additionalProperties: false, properties: { profileId: identifier } } },
  }, (request, reply) => respond(reply, async () => ({ account: await service.validate(owner(request), request.params.accountId, request.body.profileId) })));
  app.post<{ Params: { accountId: string }; Body: { type: CredentialKind } }>('/api/community/accounts/:accountId/reveal', {
    onRequest: app.authenticateUser, schema: { params, body: { type: 'object', required: ['type'], additionalProperties: false, properties: { type: { type: 'string', enum: ['stoken', 'ltoken', 'cookieToken'] } } } },
  }, (request, reply) => respond(reply, async () => service.reveal(owner(request), request.params.accountId, request.body.type)));
  app.post<{ Params: { accountId: string }; Body: Record<string, never> }>('/api/community/accounts/:accountId/unlink', {
    onRequest: app.authenticateUser, schema: { params, body: noBody },
  }, (request, reply) => respond(reply, async () => { await service.unlink(owner(request), request.params.accountId); sync.stopCommunity(owner(request), request.params.accountId); return reply.code(204).send(); }));
}
