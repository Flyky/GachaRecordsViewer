import { ImportError, uigfRepository } from '@gacha/db';
import type { FastifyInstance } from 'fastify';
import type { AuthOptions } from '../auth/routes.js';
import { ApiError } from '../auth/security.js';
import { parseRecordQuery, queryRecords, type RecordQueryStrings } from './query.js';

export function registerRecords(app: FastifyInstance, options: AuthOptions) {
  const repository = uigfRepository(options.connection);
  app.get<{ Params: { profileId: string }; Querystring: RecordQueryStrings }>('/api/profiles/:profileId/records', {
    onRequest: app.authenticateUser,
    schema: {
      params: { type: 'object', required: ['profileId'], additionalProperties: false, properties: { profileId: { type: 'string', minLength: 1, maxLength: 128 } } },
      querystring: { type: 'object', additionalProperties: false, properties: {
        from: { type: 'string', maxLength: 19 }, to: { type: 'string', maxLength: 19 },
        pools: { type: 'string', maxLength: 32 }, itemTypes: { type: 'string', maxLength: 32 }, ranks: { type: 'string', maxLength: 8 },
        name: { type: 'string', maxLength: 512 }, order: { type: 'string', enum: ['asc', 'desc'] },
        page: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' }, pageSize: { type: 'string', enum: ['20', '50', '100', '200'] },
      } },
    },
  }, async (request) => {
    const query = parseRecordQuery(request.query);
    try {
      const snapshot = await repository.export(request.principal!.user!.id, request.params.profileId);
      return queryRecords(request.params.profileId, snapshot, query, options.metadataCatalog);
    } catch (error) {
      if (error instanceof ImportError && error.code === 'PROFILE_NOT_FOUND') throw new ApiError(404, 'PROFILE_NOT_FOUND');
      throw error;
    }
  });
}
