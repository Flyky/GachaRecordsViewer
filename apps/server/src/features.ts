import type { FeatureSettings } from '@gacha/contracts';
import { snapshotRepository, type DatabaseConnection } from '@gacha/db';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './auth/security.js';

export async function featureService(connection: DatabaseConnection, now = Date.now) {
  const repo = snapshotRepository(connection);
  let current: FeatureSettings = { genshinTopup: true, updatedAt: null }, busy = false;
  try {
    const saved = await repo.load('feature-settings');
    if (saved !== undefined) {
      const value = saved as FeatureSettings;
      if (typeof value?.genshinTopup !== 'boolean' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid features');
      current = { genshinTopup: value.genshinTopup, updatedAt: value.updatedAt };
    }
  } catch { current = { genshinTopup: false, updatedAt: null }; }
  return {
    status: (): FeatureSettings => ({ ...current }),
    topupEnabled: () => current.genshinTopup,
    setTopup: async (enabled: boolean) => {
      if (busy) throw new ApiError(409, 'FEATURE_BUSY'); busy = true;
      try {
        const candidate = { genshinTopup: enabled, updatedAt: new Date(now()).toISOString() };
        await repo.save('feature-settings', candidate); current = candidate; return { ...current };
      } finally { busy = false; }
    },
  };
}
export function registerFeatures(app: FastifyInstance, service: Awaited<ReturnType<typeof featureService>>) {
  app.get('/api/features', { onRequest: app.authenticateUser }, async () => service.status());
  app.get('/api/admin/features', { onRequest: app.authenticateAdmin }, async () => service.status());
  app.post<{ Body: { enabled: boolean } }>('/api/admin/features/genshin-topup', {
    onRequest: app.authenticateAdmin, bodyLimit: 4096,
    schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
  }, async (request) => service.setTopup(request.body.enabled));
}
