import { CommunityError } from '@gacha/db';
import { ProbeError } from '@gacha/providers';
import type { CredentialKind } from '@gacha/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthOptions } from '../auth/routes.js';
import { AuthLimiter } from '../auth/security.js';
import { communityService, type CommunityOptions } from './service.js';

const identifier = { type: 'string', minLength: 1, maxLength: 128 };
const params = { type: 'object', required: ['accountId'], additionalProperties: false, properties: { accountId: identifier } };
const input = { type: 'object', required: ['input'], additionalProperties: false, properties: { input: { type: 'string', minLength: 1, maxLength: 24000 } } };
const noBody = { type: 'object', additionalProperties: false, properties: {} };
export function registerCommunity(app: FastifyInstance, auth: AuthOptions, options: CommunityOptions = {}) {
  const service = communityService(auth.connection, auth.credentialKey, options, auth.now), limiter = new AuthLimiter(auth.now ?? Date.now);
  app.addHook('onClose', async () => { service.close(); });
  const owner = (request: FastifyRequest) => request.principal!.user!.id;
  const limit = async (request: FastifyRequest) => { limiter.consume(request.ip, `community:${owner(request)}`); };
  async function respond<T>(reply: FastifyReply, action: () => Promise<T>) {
    try { return await action(); } catch (error) {
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
  }, (request, reply) => respond(reply, async () => { await service.unlink(owner(request), request.params.accountId); return reply.code(204).send(); }));
}
