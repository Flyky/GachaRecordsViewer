import { afterEach, expect, it } from 'vitest';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { sample } from '../../../packages/uigf/test/fixtures.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let fixture: Awaited<ReturnType<typeof temporaryDirectory>> | undefined;
afterEach(async () => { await app?.close(); await fixture?.cleanup(); });

it('protects UIGF endpoints and binds preview tickets to owner, file, expiry and database version', async () => {
  fixture = await temporaryDirectory();
  const deployment = await initializeDeployment({ dataDirectory: fixture.directory, env: {} });
  let time = Date.now(); const origin = 'https://uigf.example.test';
  app = await buildApp({ database: deployment.connection, auth: { connection: deployment.connection,
    credentialKey: deployment.credentialKey, adminPassword: deployment.config.adminPassword,
    adminSessionVersion: deployment.adminSessionVersion, publicUrl: origin, now: () => time } });
  const post = (url: string, payload: unknown, headers = {}) => app!.inject({ method: 'POST', url, payload: payload as object, headers: { origin, ...headers } });
  const admin = await post('/api/admin/login', { username: 'admin', password: deployment.config.adminPassword });
  const session = (response: typeof admin) => ({ cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string });
  for (const username of ['usera', 'userb']) expect((await post('/api/admin/users', { username }, session(admin))).statusCode).toBe(201);
  const userA = session(await post('/api/auth/login', { username: 'usera', password: '12345678' }));
  const userB = session(await post('/api/auth/login', { username: 'userb', password: '12345678' }));
  const document = sample();
  expect((await post('/api/uigf/preview', { document })).statusCode).toBe(401);
  expect((await post('/api/uigf/preview', { document }, session(admin))).statusCode).toBe(401);
  expect((await post('/api/uigf/preview', { document }, { cookie: userA.cookie })).statusCode).toBe(403);
  const preview = await post('/api/uigf/preview', { document }, userA);
  expect(preview.statusCode).toBe(200); expect(preview.headers['cache-control']).toBe('no-store');
  expect((await app.inject({ url: '/api/profiles', headers: userA })).json().profiles).toEqual([]);
  const payload = { document, profileIndexes: [0], previewToken: preview.json().previewToken as string };
  for (const [body, headers] of [[payload, userB], [{ ...payload, document: sample('v4.0') }, userA], [{ ...payload, previewToken: `${payload.previewToken}x` }, userA]] as const) {
    expect((await post('/api/uigf/import', body, headers)).json().error.code).toBe('INVALID_PREVIEW_TOKEN');
  }
  const imported = await post('/api/uigf/import', payload, userA); expect(imported.statusCode).toBe(200);
  const id = imported.json().profiles[0].targetProfileId as string;
  expect((await post('/api/uigf/import', payload, userA)).json().error.code).toBe('PREVIEW_STALE');
  expect((await app.inject({ url: `/api/uigf/export/${id}`, headers: userB })).statusCode).toBe(404);
  const download = await app.inject({ url: `/api/uigf/export/${id}`, headers: userA });
  expect(download.statusCode).toBe(200); expect(download.headers['content-disposition']).toContain('attachment');
  expect(download.json().info.version).toBe('v4.0'); expect(download.json().hk4e[0].list).toEqual(document.hk4e![0]!.list);
  expect((await app.inject({ url: `/api/uigf/export/${id}?version=v4.3`, headers: userA })).statusCode).toBe(400);
  const fresh = await post('/api/uigf/preview', { document }, userA);
  time += 15 * 60_000;
  expect((await post('/api/uigf/import', { ...payload, previewToken: fresh.json().previewToken }, userA)).json().error.code).toBe('PREVIEW_EXPIRED');
  expect((await post('/api/uigf/preview', { document: { info: document.info, hk4e_ugc: {} } }, userA)).json()).toMatchObject({ profiles: [], warnings: ['NO_GENSHIN_DATA'], skippedBlocks: ['hk4e_ugc'] });
  deployment.credentialKey.fill(0);
});
