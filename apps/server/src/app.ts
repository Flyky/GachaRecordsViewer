import { access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { APP_NAME, type HealthResponse } from '@gacha/contracts';
import type { DatabaseConnection } from '@gacha/db';
import Fastify from 'fastify';

interface AppOptions {
  logger?: boolean;
  serveWeb?: boolean;
  webRoot?: string;
  database?: Pick<DatabaseConnection, 'probe' | 'close'>;
}

const defaultWebRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });

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
