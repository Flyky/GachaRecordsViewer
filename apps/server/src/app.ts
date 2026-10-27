import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { APP_NAME, type HealthResponse } from '@gacha/contracts';
import type { DatabaseConnection } from '@gacha/db';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { registerAuth, type AuthOptions } from './auth/routes.js';
import { ApiError } from './auth/security.js';
import { registerUigf } from './uigf.js';
import { registerRecords } from './records/routes.js';
import { registerAnalysis } from './analysis/routes.js';
import { registerCommunity } from './community/routes.js';
import type { CommunityOptions } from './community/service.js';
import type { QrOptions } from './community/qr.js';
import type { SyncOptions } from './community/sync.js';
import { metadataService, registerMetadata, type MetadataOptions } from './metadata.js';
import type { CheckinOptions } from './community/checkin.js';
import { registerWishLink, type WishLinkOptions } from './wish-link.js';
import { registerApiMock } from './api-mock.js';

interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  serveWeb?: boolean;
  webRoot?: string;
  basePath?: string;
  database?: Pick<DatabaseConnection, 'probe' | 'close'>;
  auth?: AuthOptions;
  community?: CommunityOptions & { qr?: QrOptions; sync?: SyncOptions; checkin?: CheckinOptions };
  metadata?: MetadataOptions;
  wishLink?: WishLinkOptions;
}

const defaultWebRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export async function buildApp(options: AppOptions = {}) {
  const basePath = (options.auth ? new URL(options.auth.publicUrl).pathname : options.basePath ?? '/').replace(/\/+$/, '') + '/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('Invalid application base path');
  const prefix = basePath.slice(0, -1), apiPrefix = `${basePath}api`;
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
  // Fastify runs close hooks in reverse order: stop workers before closing their database.
  if (options.database) app.addHook('onClose', async () => { await options.database!.close(); });
  function registerHealth(target: FastifyInstance) {
    target.get<{ Reply: HealthResponse }>('/api/health', async () => ({
      status: 'ok',
      service: APP_NAME,
    }));
    target.get('/api/ready', async (_request, reply) => {
      try {
        if (!options.database) return reply.code(503).send({ status: 'unavailable', service: APP_NAME });
        await options.database.probe();
        return { status: 'ok', service: APP_NAME };
      } catch {
        return reply.code(503).send({ status: 'unavailable', service: APP_NAME });
      }
    });
  }

  let html: string | undefined;
  const webRoot = options.webRoot ?? defaultWebRoot;
  if (options.serveWeb) {
    try {
      html = (await readFile(join(webRoot, 'index.html'), 'utf8'))
        .replace(/<head\b[^>]*>/i, (head) => `${head}<base data-grv-base href="${basePath}">`);
    } catch {
      throw new Error('Frontend build not found. Run "pnpm build" before "pnpm start".');
    }
  }

  // Root health endpoints remain available for container probes after config changes.
  if (prefix) registerHealth(app);
  await app.register(async (site) => {
    if (options.auth) {
      const metadata = await metadataService(options.auth.connection, options.metadata);
      site.addHook('onClose', async () => { await metadata.close(); });
      const auth = { ...options.auth, metadataCatalog: metadata.catalog };
      await registerAuth(site, auth);
      registerMetadata(site, metadata);
      registerUigf(site, auth);
      registerApiMock(site, auth);
      registerRecords(site, auth);
      registerAnalysis(site, auth);
      registerWishLink(site, auth, options.wishLink);
      await registerCommunity(site, auth, options.community);
    }
    registerHealth(site);
    if (options.serveWeb) {
      await site.register(fastifyStatic, { root: webRoot, wildcard: false, index: false, globIgnore: ['index.html'] });
      const entry = async (_request: unknown, reply: FastifyReply) => reply.type('text/html').header('Cache-Control', 'no-store').send(html);
      site.get('/', { prefixTrailingSlash: 'slash' }, entry);
      site.get('/index.html', entry);
    }
  }, { prefix });
  if (prefix && options.serveWeb) {
    app.get(prefix, async (request, reply) => reply.redirect(`${basePath}${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`, 308));
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '/';
    const isApiPath = pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`);
    const isNavigation = request.method === 'GET' || request.method === 'HEAD';

    if (
      options.serveWeb &&
      pathname.startsWith(basePath) &&
      isNavigation &&
      !isApiPath &&
      !extname(pathname) &&
      request.headers.accept?.includes('text/html')
    ) {
      return reply.type('text/html').header('Cache-Control', 'no-store').send(html);
    }

    return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
  });

  return app;
}
