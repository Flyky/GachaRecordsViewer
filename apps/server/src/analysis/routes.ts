import { RECORD_POOLS, type DailyAnalysisResponse, type ItemAnalysisResponse, type LuckAnalysisResponse, type MonthlyAnalysisResponse, type RecordPool } from '@gacha/contracts';
import { ImportError, uigfRepository } from '@gacha/db';
import { dailyStatistics, genshinMetadata, itemStatistics, luckStatistics, monthlyStatistics } from '@gacha/gacha-core';
import type { FastifyInstance } from 'fastify';
import type { AuthOptions } from '../auth/routes.js';
import { ApiError } from '../auth/security.js';
import { analyzeProfile } from '../history.js';

const params = { type: 'object', required: ['profileId'], additionalProperties: false,
  properties: { profileId: { type: 'string', minLength: 1, maxLength: 128 } } };
const querySchema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties });
const calendarTimeZone = 'Asia/Shanghai';
export function registerAnalysis(app: FastifyInstance, options: AuthOptions) {
  const repository = uigfRepository(options.connection), now = options.now ?? Date.now;
  async function snapshot(owner: string, profileId: string) {
    try {
      const saved = await repository.snapshot(owner, profileId);
      const catalog = options.metadataCatalog ?? genshinMetadata;
      return { context: { profileId, uid: saved.uid, timezone: saved.timezone, dataVersion: saved.dataVersion,
        dictionaryVersion: `${catalog.source.name}@${catalog.source.version}` }, history: analyzeProfile(saved, catalog).records };
    } catch (error) {
      if (error instanceof ImportError && error.code === 'PROFILE_NOT_FOUND') throw new ApiError(404, 'PROFILE_NOT_FOUND');
      throw error;
    }
  }
  app.get<{ Params: { profileId: string }; Querystring: { itemType?: 'character' | 'weapon'; order?: 'asc' | 'desc' } }>('/api/profiles/:profileId/analysis/items', {
    onRequest: app.authenticateUser, schema: { params, querystring: querySchema({ itemType: { type: 'string', enum: ['character', 'weapon'] }, order: { type: 'string', enum: ['asc', 'desc'] } }) },
  }, async (request): Promise<ItemAnalysisResponse> => {
    const { context, history } = await snapshot(request.principal!.user!.id, request.params.profileId);
    return { ...context, ...itemStatistics(history, request.query.itemType, request.query.order) };
  });
  app.get<{ Params: { profileId: string } }>('/api/profiles/:profileId/analysis/monthly', {
    onRequest: app.authenticateUser, schema: { params, querystring: querySchema({}) },
  }, async (request): Promise<MonthlyAnalysisResponse> => {
    const { context, history } = await snapshot(request.principal!.user!.id, request.params.profileId);
    return { ...context, ...monthlyStatistics(history) };
  });
  app.get<{ Params: { profileId: string } }>('/api/profiles/:profileId/analysis/luck', {
    onRequest: app.authenticateUser, schema: { params, querystring: querySchema({}) },
  }, async (request): Promise<LuckAnalysisResponse> => {
    const { context, history } = await snapshot(request.principal!.user!.id, request.params.profileId);
    return { ...context, ...luckStatistics(history, { timezone: context.timezone }) };
  });
  app.get<{ Params: { profileId: string }; Querystring: { year?: string; pool?: RecordPool | '' } }>('/api/profiles/:profileId/analysis/daily', {
    onRequest: app.authenticateUser, schema: { params, querystring: querySchema({ year: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' }, pool: { type: 'string', enum: ['', ...RECORD_POOLS] } }) },
  }, async (request): Promise<DailyAnalysisResponse> => {
    const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: calendarTimeZone, year: 'numeric' }).format(now()));
    const year = request.query.year === undefined ? currentYear : Number(request.query.year);
    const { context, history } = await snapshot(request.principal!.user!.id, request.params.profileId);
    return { ...context, calendarTimeZone, ...dailyStatistics(history, { year, currentYear, ...(request.query.pool ? { pool: request.query.pool } : {}) }) };
  });
}
