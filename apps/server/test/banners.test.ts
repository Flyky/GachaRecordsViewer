import { afterEach, beforeEach, expect, it } from 'vitest';
import { builtinCharacterBanners, genshinMetadata } from '@gacha/gacha-core';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';
import { bannerService, parseBannerSource } from '../src/banners.js';
import { dataSourceService } from '../src/public-data.js';

const revision = 'f'.repeat(40), origin = 'https://banners.example.test';
const entries = builtinCharacterBanners.entries.map((entry) => ({ start: entry.start, end: entry.end, timezoneDependent: entry.startGlobal,
  timezoneDependentEnd: entry.endGlobal, featured: entry.itemIds.map((id) => genshinMetadata.get(id)!.names['en-us']) }));
const source = (rows = entries) => `export const banners = { /* data only */ characters: ${JSON.stringify(rows)} };`;
let fixture: Awaited<ReturnType<typeof temporaryDirectory>>, deployment: Awaited<ReturnType<typeof initializeDeployment>>, app: Awaited<ReturnType<typeof buildApp>>;
let session: { cookie: string; 'x-csrf-token': string }, mode: 'good' | 'unknown' | 'network' | 'shrunk' | 'proxy';
let calls: string[];
const fetcher: typeof fetch = async (input) => {
  calls.push(String(input));
  if (mode === 'network') throw new Error('synthetic network failure');
  if (mode === 'proxy' && !String(input).startsWith('https://proxy.example.test/')) return new Response('blocked', { status: 403 });
  if (String(input).includes('api.github.com')) return new Response(JSON.stringify([{ sha: revision }]));
  return new Response(mode === 'unknown' ? source([{ ...entries[0]!, featured: ['not_in_dictionary'] }, ...entries.slice(1)]) : mode === 'shrunk' ? source(entries.slice(0, -1)) : source());
};
const post = (headers: Record<string, string> = session, payload: object = {}) => app.inject({ method: 'POST', url: '/gacha/api/admin/banners/refresh', headers: { origin, ...headers }, payload });
beforeEach(async () => {
  mode = 'good'; calls = []; fixture = await temporaryDirectory(); deployment = await initializeDeployment({ dataDirectory: fixture.directory, env: {} });
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

it('protects and persists proxy settings, and only uses the proxy after explicit confirmation', async () => {
  const url = '/gacha/api/admin/data-sources', headers = { origin, ...session };
  expect(calls).toEqual([]);
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url, headers: { origin, cookie: session.cookie }, payload: { githubProxy: 'https://proxy.example.test/' } })).statusCode).toBe(403);
  await app.inject({ method: 'POST', url: '/gacha/api/admin/users', headers, payload: { username: 'proxy_viewer' } });
  const user = await app.inject({ method: 'POST', url: '/gacha/api/auth/login', headers: { origin }, payload: { username: 'proxy_viewer', password: '12345678' } });
  expect((await app.inject({ url, headers: { cookie: String(user.headers['set-cookie']).split(';')[0]! } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url, headers, payload: { githubProxy: 'http://localhost:3000/' } })).statusCode).toBe(400);
  const saved = await app.inject({ method: 'POST', url, headers, payload: { githubProxy: ' https://proxy.example.test ' } });
  expect(saved.json().githubProxy).toBe('https://proxy.example.test/');
  expect((await dataSourceService(deployment.connection)).proxy()).toBe('https://proxy.example.test/');
  mode = 'proxy'; expect((await post()).statusCode).toBe(502);
  expect(calls).toHaveLength(1); expect(calls[0]).toMatch(/^https:\/\/api.github.com\//);
  expect((await post(session, { useProxy: true })).statusCode).toBe(200);
  expect(calls).toHaveLength(3);
  expect(calls[1]).toBe('https://proxy.example.test/' + calls[0]);
  expect(calls[2]).toMatch(/^https:\/\/proxy.example.test\/https:\/\/raw.githubusercontent.com\//);
  mode = 'network'; expect((await post()).statusCode).toBe(502);
  expect((await app.inject({ url: '/gacha/api/admin/banners', headers })).json().version).toBe(revision);
  expect((await app.inject({ method: 'POST', url, headers, payload: { githubProxy: '' } })).json().githubProxy).toBe('');
  expect((await dataSourceService(deployment.connection)).proxy()).toBe('');
  expect((await post(session, { useProxy: true })).json().error.code).toBe('DATA_PROXY_REQUIRED');
});

it('imports local JSON snapshots or literal upstream JS without network access and keeps valid data on errors', async () => {
  const url = '/gacha/api/admin/banners/import', headers = { origin, ...session };
  const upload = (content: string) => app.inject({ method: 'POST', url, headers, payload: { content } });
  expect((await app.inject({ method: 'POST', url, headers: { origin, cookie: session.cookie }, payload: { content: source() } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url, headers: { origin }, payload: { content: source() } })).statusCode).toBe(401);
  expect((await upload(JSON.stringify(builtinCharacterBanners))).statusCode).toBe(200);
  const loaded = await bannerService(deployment.connection, genshinMetadata);
  expect(loaded.get().entries).toEqual(builtinCharacterBanners.entries);
  expect(loaded.get().source.revision).toMatch(/^manual-[a-f0-9]{64}$/); await loaded.close();
  expect((await upload(source())).statusCode).toBe(200);
  expect((await upload(JSON.stringify({ characters: entries }))).statusCode).toBe(200);
  const before = (await app.inject({ url: '/gacha/api/admin/banners', headers })).json();
  for (const content of ['{broken', 'export const banners = globalThis.fetch("https://evil.test")', JSON.stringify({ ...builtinCharacterBanners, entries: builtinCharacterBanners.entries.slice(0, -1) })]) {
    expect((await upload(content)).json().error.code).toBe('BANNER_IMPORT_INVALID');
  }
  const unknown = structuredClone(builtinCharacterBanners); unknown.entries[0]!.itemIds = ['199999999'];
  expect((await upload(JSON.stringify(unknown))).json().error.code).toBe('BANNER_CHARACTER_UNKNOWN');
  expect((await app.inject({ url: '/gacha/api/admin/banners', headers })).json()).toEqual(before);
  expect(calls).toHaveLength(0);
});
