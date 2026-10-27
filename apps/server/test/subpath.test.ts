import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';

it('keeps login, cookie scope, CSRF, user management and authenticated APIs under the deployment path', async () => {
  const directory = await temporaryDirectory();
  const deployment = await initializeDeployment({ dataDirectory: directory.directory, env: { PUBLIC_URL: 'https://example.test/gacha/' } });
  const app = await buildApp({ serveWeb: true, webRoot: fileURLToPath(new URL('./fixtures/web/', import.meta.url)), database: deployment.connection, auth: {
    connection: deployment.connection, credentialKey: deployment.credentialKey, adminPassword: deployment.config.adminPassword,
    adminSessionVersion: deployment.adminSessionVersion, publicUrl: deployment.config.publicUrl,
  } });
  try {
    const login = await app.inject({ method: 'POST', url: '/gacha/api/admin/login', headers: { origin: 'https://example.test' }, payload: { username: 'admin', password: deployment.config.adminPassword } });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/^__Secure-grv_admin=/); expect(setCookie).toContain('Path=/gacha/'); expect(setCookie).toContain('Secure');
    const headers = { origin: 'https://example.test', cookie: setCookie.split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
    const create = { method: 'POST' as const, url: '/gacha/api/admin/users', payload: { username: 'subpath_friend' } };
    expect((await app.inject({ ...create, headers: { ...headers, origin: 'https://wrong.example' } })).statusCode).toBe(403);
    expect((await app.inject({ ...create, headers: { origin: headers.origin, cookie: headers.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ ...create, headers })).statusCode).toBe(201);
    const user = await app.inject({ method: 'POST', url: '/gacha/api/auth/login', headers: { origin: headers.origin }, payload: { username: 'subpath_friend', password: '12345678' } });
    expect(user.statusCode).toBe(200);
    const cookie = String(user.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/gacha/api/profiles', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject('/gacha/api/profiles')).statusCode).toBe(401);
    expect((await app.inject('/api/auth/me')).statusCode).toBe(404);
    const logout = await app.inject({ method: 'POST', url: '/gacha/api/auth/logout', payload: {}, headers: { origin: headers.origin, cookie, 'x-csrf-token': user.json().csrfToken as string } });
    expect(logout.statusCode).toBe(204); expect(logout.headers['set-cookie']).toContain('Path=/gacha/');
    expect((await app.inject({ url: '/gacha/api/profiles', headers: { cookie } })).statusCode).toBe(401);
  } finally { await app.close(); deployment.credentialKey.fill(0); await directory.cleanup(); }
});
