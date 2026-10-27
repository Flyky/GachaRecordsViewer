import { access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { APP_NAME, type HealthResponse } from '@gacha/contracts';
import type { DatabaseConnection } from '@gacha/db';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerAuth, type AuthOptions } from './auth/routes.js';
import { ApiError } from './auth/security.js';
import { registerUigf } from './uigf.js';
import { registerRecords } from './records/routes.js';
import { registerAnalysis } from './analysis/routes.js';
import { registerCommunity } from './community/routes.js';
import type { CommunityOptions } from './community/service.js';

interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  serveWeb?: boolean;
  webRoot?: string;
  database?: Pick<DatabaseConnection, 'probe' | 'close'>;
  auth?: AuthOptions;
  community?: CommunityOptions;
}

const defaultWebRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: options.logger ? { ...(typeof options.logger === 'object' ? options.logger : {}), serializers: { req: (request) => ({ method: request.method, url: request.url.split('?')[0] ?? '/', remoteAddress: request.ip }) },
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] } : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
      return reply.code(error.status).send({ error: { code: error.code } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: { code: 'INVALID_REQUEST' } });
    // Database errors can contain SQL parameters including password hashes; do not serialize them.
    app.log.error({ requestId: request.id }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  if (options.auth) {
    await registerAuth(app, options.auth);
    registerUigf(app, options.auth);
    registerRecords(app, options.auth);
    registerAnalysis(app, options.auth);
    registerCommunity(app, options.auth, options.community);
  }

  app.get<{ Reply: HealthResponse }>('/api/health', async () => ({
    status: 'ok',
    service: APP_NAME,
  }));

  if (options.database) app.addHook('onClose', async () => { await options.database!.close(); });
  app.get('/api/ready', async (_request, reply) => {
    try {
      if (!options.database) return reply.code(503).send({ status: 'unavailable', service: APP_NAME });
      await options.database.probe();
      return { status: 'ok', service: APP_NAME };
    } catch {
      return reply.code(503).send({ status: 'unavailable', service: APP_NAME });
    }
  });

  if (options.serveWeb) {
    const webRoot = options.webRoot ?? defaultWebRoot;
    try {
      await access(join(webRoot, 'index.html'));
    } catch {
      throw new Error('Frontend build not found. Run "pnpm build" before "pnpm start".');
    }

    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '/';
    const isApiPath = pathname === '/api' || pathname.startsWith('/api/');
    const isNavigation = request.method === 'GET' || request.method === 'HEAD';

    if (
      options.serveWeb &&
      isNavigation &&
      !isApiPath &&
      !extname(pathname) &&
      request.headers.accept?.includes('text/html')
    ) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }

    return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
  });

  return app;
}
