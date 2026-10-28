import { afterEach, beforeEach, expect, it } from 'vitest';
import { builtinCharacterBanners, genshinMetadata } from '@gacha/gacha-core';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';
import { bannerService, parseBannerSource } from '../src/banners.js';

const revision = 'f'.repeat(40), origin = 'https://banners.example.test';
const entries = builtinCharacterBanners.entries.map((entry) => ({ start: entry.start, end: entry.end, timezoneDependent: entry.startGlobal,
  timezoneDependentEnd: entry.endGlobal, featured: entry.itemIds.map((id) => genshinMetadata.get(id)!.names['en-us']) }));
const source = (rows = entries) => `export const banners = { /* data only */ characters: ${JSON.stringify(rows)} };`;
let fixture: Awaited<ReturnType<typeof temporaryDirectory>>, deployment: Awaited<ReturnType<typeof initializeDeployment>>, app: Awaited<ReturnType<typeof buildApp>>;
let session: { cookie: string; 'x-csrf-token': string }, mode: 'good' | 'unknown' | 'network' | 'shrunk';
const fetcher: typeof fetch = async (input) => {
  if (mode === 'network') throw new Error('synthetic network failure');
  if (String(input).includes('api.github.com')) return new Response(JSON.stringify([{ sha: revision }]));
  return new Response(mode === 'unknown' ? source([{ ...entries[0]!, featured: ['not_in_dictionary'] }, ...entries.slice(1)]) : mode === 'shrunk' ? source(entries.slice(0, -1)) : source());
};
const post = (headers: Record<string, string> = session) => app.inject({ method: 'POST', url: '/gacha/api/admin/banners/refresh', headers: { origin, ...headers }, payload: {} });
beforeEach(async () => {
  mode = 'good'; fixture = await temporaryDirectory(); deployment = await initializeDeployment({ dataDirectory: fixture.directory, env: {} });
  app = await buildApp({ database: deployment.connection, banners: { fetch: fetcher }, auth: { connection: deployment.connection, credentialKey: deployment.credentialKey,
    adminPassword: deployment.config.adminPassword, adminSessionVersion: deployment.adminSessionVersion, publicUrl: `${origin}/gacha/` } });
  const login = await app.inject({ method: 'POST', url: '/gacha/api/admin/login', headers: { origin }, payload: { username: 'admin', password: deployment.config.adminPassword } });
  session = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
});
afterEach(async () => { await app?.close(); deployment?.credentialKey.fill(0); await fixture?.cleanup(); });

it('refreshes and persists a fully parsed banner snapshot behind administrator and CSRF guards', async () => {
  expect((await post({})).statusCode).toBe(401); expect((await post({ cookie: session.cookie })).statusCode).toBe(403);
  expect((await post({ ...session, origin: 'https://other.test' })).statusCode).toBe(403);
  await app.inject({ method: 'POST', url: '/gacha/api/admin/users', headers: { origin, ...session }, payload: { username: 'viewer' } });
  const viewer = await app.inject({ method: 'POST', url: '/gacha/api/auth/login', headers: { origin }, payload: { username: 'viewer', password: '12345678' } });
  const userHeaders = { cookie: String(viewer.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': viewer.json().csrfToken as string };
  expect((await post(userHeaders)).statusCode).toBe(401);
  const profile = await deployment.repositories.profiles.create(viewer.json().user.id, { game: 'hk4e', uid: '123456789', timezone: 8 });
  const response = await post(); expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ version: revision, count: entries.length, storage: 'database', updating: false });
  const analysis = await app.inject({ url: `/gacha/api/profiles/${profile.id}/analysis/luck`, headers: userHeaders });
  expect(analysis.json()).toMatchObject({ bannerVersion: revision, bannerSource: { revision } });
  const reloaded = await bannerService(deployment.connection, genshinMetadata);
  expect(reloaded.get().source.revision).toBe(revision); expect(reloaded.status().storage).toBe('database');
  expect(reloaded.get().entries).toEqual(builtinCharacterBanners.entries); await reloaded.close();
});
it('keeps the previous snapshot on network failure or unknown featured characters', async () => {
  expect((await post()).statusCode).toBe(200);
  mode = 'unknown'; expect((await post()).json().error.code).toBe('BANNER_CHARACTER_UNKNOWN');
  mode = 'shrunk'; expect((await post()).json().error.code).toBe('BANNER_REFRESH_FAILED');
  mode = 'network'; expect((await post()).json().error.code).toBe('BANNER_REFRESH_FAILED');
  const response = await app.inject({ url: '/gacha/api/admin/banners', headers: session });
  expect(response.json()).toMatchObject({ version: revision, storage: 'database' });
});
it('does not execute expressions and rejects nonliteral featured lists and duplicate properties', () => {
  expect(() => parseBannerSource('export const banners={characters:[{start:"x",end:"y",featured:[globalThis.fetch("https://invalid.test")]}]}', genshinMetadata)).toThrow();
  expect(() => parseBannerSource('export const banners={characters:[],characters:[]}', genshinMetadata)).toThrow();
  expect(parseBannerSource(source(), genshinMetadata)).toEqual(builtinCharacterBanners.entries);
});
