import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@gacha/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const webRoot = fileURLToPath(new URL('./fixtures/web/', import.meta.url));

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('application bootstrap', () => {
  it('checks database readiness separately from liveness and closes the connection', async () => {
    let available = true, closed = false;
    const app = await buildApp({ database: {
      probe: async () => { if (!available) throw new Error('private database credentials'); },
      close: async () => { closed = true; },
    } });
    apps.push(app);
    expect((await app.inject('/api/ready')).statusCode).toBe(200);
    available = false;
    const response = await app.inject('/api/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', service: APP_NAME });
    expect(response.body).not.toContain('private');
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    expect(closed).toBe(true);
  });
  it('serves the health contract without requiring a frontend build', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject('/api/health');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: APP_NAME });
    expect((await app.inject('/')).statusCode).toBe(404);
  });

  it('serves the frontend entry and browser history routes', async () => {
    const app = await buildApp({ serveWeb: true, webRoot });
    apps.push(app);

    for (const url of ['/', '/records?sort=desc']) {
      const response = await app.inject({ url, headers: { accept: 'text/html' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Gacha SPA fixture');
    }

    expect((await app.inject('/api/health')).json()).toEqual({
      status: 'ok',
      service: APP_NAME,
    });
  });

  it.each(['/api', '/api/unknown', '/assets/missing.js', '/UIGF_private.json'])(
    'does not replace missing API or asset requests with the SPA: %s',
    async (url) => {
      const app = await buildApp({ serveWeb: true, webRoot });
      apps.push(app);
      const response = await app.inject({ url, headers: { accept: 'text/html' } });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
    },
  );

  it('does not serve SPA HTML for mutations or non-browser requests', async () => {
    const app = await buildApp({ serveWeb: true, webRoot });
    apps.push(app);

    expect((await app.inject({ method: 'POST', url: '/records' })).statusCode).toBe(404);
    expect((await app.inject('/records')).statusCode).toBe(404);
  });

  it('fails clearly when the production frontend has not been built', async () => {
    await expect(
      buildApp({ serveWeb: true, webRoot: fileURLToPath(new URL('./missing-build/', import.meta.url)) }),
    ).rejects.toThrow('pnpm build');
  });
});
