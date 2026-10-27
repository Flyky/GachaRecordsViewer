import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decodeUigf } from '@gacha/uigf';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { pull, sample } from '../../../packages/uigf/test/fixtures.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';

let fixture: Awaited<ReturnType<typeof temporaryDirectory>>, deployment: Awaited<ReturnType<typeof initializeDeployment>>;
let app: Awaited<ReturnType<typeof buildApp>>, time = Date.now(), profileId: string;
let userA: Record<string, string>, userB: Record<string, string>, admin: Record<string, string>;
const origin = 'https://mock.example.test', prefix = '/gacha';
const document = sample('v4.1', [pull(), pull('9007199254740993002', { gacha_type: '400' }), pull('9007199254740993003', { gacha_type: '200', uigf_gacha_type: '200' })]);
const auth = () => ({ connection: deployment.connection, credentialKey: deployment.credentialKey, adminPassword: deployment.config.adminPassword,
  adminSessionVersion: deployment.adminSessionVersion, publicUrl: `${origin}${prefix}/`, now: () => time });
const post = (path: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: `${prefix}${path}`, payload, headers: { origin, ...headers } });
const get = (path: string, headers: Record<string, string> = {}) => app.inject({ url: `${prefix}${path}`, headers });
const read = (url: string, query = '') => { const parsed = new URL(url); return app.inject(`${parsed.pathname}${parsed.search}${query}`); };
const create = async (format?: string) => {
  const response = await post('/api/mock', { profileId, ...(format ? { format } : {}) }, userA);
  expect(response.statusCode).toBe(201); return response.json().link;
};
async function importDocument(input: unknown) {
  const preview = await post('/api/uigf/preview', { document: input }, userA);
  expect(preview.statusCode).toBe(200);
  const imported = await post('/api/uigf/import', { document: input, profileIndexes: [0], previewToken: preview.json().previewToken }, userA);
  expect(imported.statusCode).toBe(200); return imported.json().profiles[0].targetProfileId as string;
}
beforeAll(async () => {
  fixture = await temporaryDirectory(); deployment = await initializeDeployment({ dataDirectory: fixture.directory, env: {} });
  app = await buildApp({ auth: auth() });
  const session = (response: Awaited<ReturnType<typeof post>>) => ({ cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string });
  admin = session(await post('/api/admin/login', { username: 'admin', password: deployment.config.adminPassword }));
  for (const username of ['usera', 'userb']) expect((await post('/api/admin/users', { username }, admin)).statusCode).toBe(201);
  userA = session(await post('/api/auth/login', { username: 'usera', password: '12345678' }));
  userB = session(await post('/api/auth/login', { username: 'userb', password: '12345678' }));
  profileId = await importDocument(document);
});
afterAll(async () => { vi.useRealTimers(); await app?.close(); await deployment?.connection.close(); deployment?.credentialKey.fill(0); await fixture?.cleanup(); });

it('requires an owning user and protects link management with Origin and CSRF', async () => {
  expect((await post('/api/mock', { profileId })).statusCode).toBe(401);
  expect((await post('/api/mock', { profileId }, admin)).statusCode).toBe(401);
  expect((await post('/api/mock', { profileId }, { cookie: userA.cookie! })).statusCode).toBe(403);
  expect((await post('/api/mock', { profileId }, { ...userA, origin: 'https://other.test' })).statusCode).toBe(403);
  expect((await post('/api/mock', { profileId }, userB)).statusCode).toBe(404);
  expect((await post('/api/mock', { profileId, format: 'unknown' }, userA)).statusCode).toBe(400);
  expect((await get('/api/mock')).statusCode).toBe(401);
  expect((await post('/api/mock/destroy', {})).statusCode).toBe(401);
  expect((await post('/api/mock/destroy', {}, { cookie: userA.cookie! })).statusCode).toBe(403);
});

it('returns all pools without slicing, retains decimal IDs and emits the three formats without credentials', async () => {
  for (const format of ['wish-link', 'miyoushe', 'uigf']) {
    const link = await create(format), response = await read(link.url, '&size=1&gacha_type=200&profileId=other');
    expect(link.url.startsWith(`${origin}${prefix}/api/mock/getGachaLog?authkey=`)).toBe(true);
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.body).not.toMatch(/stoken|ltoken|cookieToken|authkey|metadata_json|owner_id/);
    if (format === 'uigf') {
      const exported = response.json(); expect(exported.info.version).toBe('v4.0');
      expect(decodeUigf(exported).profiles[0]!.records).toHaveLength(3);
      expect(exported.hk4e[0].list).toEqual(document.hk4e![0]!.list);
    } else {
      const data = response.json().data;
      expect(response.json()).toMatchObject({ retcode: 0, message: 'OK', data: { page: '1', size: '3', total: '3', region_time_zone: 8 } });
      expect(data.list.map((row: { id: string }) => row.id)).toEqual(['9007199254740993003', '9007199254740993002', '9007199254740993001']);
      expect(data.list[1]).toMatchObject({ uid: '123456789', gacha_type: '400', item_id: '11301', rank_type: '3', item_type: '武器', count: '1' });
      expect(data.list[1].name).toBeTruthy();
      expect((await read(link.url, '&page=2')).json().data.list).toEqual([]);
      expect((await read(link.url, '&end_id=9007199254740993001')).json().data.list).toEqual([]);
    }
  }
  expect((await get('/api/mock/getGachaLog?authkey=invalid')).statusCode).toBe(404);
});

it('replaces, isolates, destroys and expires links without access extending their lifetime', async () => {
  const first = await create(), second = await create();
  expect(second.format).toBe('wish-link'); expect(second.expiresAt - second.createdAt).toBe(900000);
  expect((await read(first.url)).statusCode).toBe(404);
  expect((await get('/api/mock', userB)).json().link).toBeNull();
  await post('/api/mock/destroy', {}, userB);
  expect((await read(second.url)).statusCode).toBe(200);
  expect((await get('/api/mock', userA)).json().link.id).toBe(second.id);
  time = second.expiresAt - 1; expect((await read(second.url)).statusCode).toBe(200);
  time++; expect((await read(second.url)).statusCode).toBe(404);
  expect((await get('/api/mock', userA)).json().link).toBeNull();
  const third = await create();
  expect((await post('/api/mock/destroy', {}, userA)).json().link).toBeNull();
  expect((await read(third.url)).statusCode).toBe(404);
  // Timed deletion also releases the snapshot when nobody requests the expired URL.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const fourth = await create(); vi.advanceTimersByTime(900000);
    expect((await read(fourth.url)).statusCode).toBe(404);
  } finally { vi.useRealTimers(); }
});

it('keeps a fixed snapshot and never restores a bearer link in another server instance', async () => {
  const link = await create();
  await importDocument(sample('v4.1', [...document.hk4e![0]!.list, pull('9007199254740993004')]));
  expect((await read(link.url)).json().data.list).toHaveLength(3);
  const replacement = await create(); expect((await read(replacement.url)).json().data.list).toHaveLength(4);
  const restarted = await buildApp({ auth: auth() });
  try {
    const parsed = new URL(replacement.url);
    expect((await restarted.inject(`${parsed.pathname}${parsed.search}`)).statusCode).toBe(404);
  } finally { await restarted.close(); }
});
