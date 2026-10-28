import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { genshinMetadata, type ItemMetadata } from '@gacha/gacha-core';
import { decodeUigf } from '@gacha/uigf';
import { uigfRepository } from '@gacha/db';
import { sql, temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { pull, sample } from '../../../packages/uigf/test/fixtures.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';
import { metadataService } from '../src/metadata.js';
import { DICTIONARY_RESOURCES } from '@gacha/contracts';

const prefix = '/gacha/api', origin = 'https://dictionary.example.test';
const extra: ItemMetadata = { id: '199999999', itemType: 'character', rank: 5, names: { 'zh-cn': '测试新角色', 'en-us': 'Synthetic New Character' } };
const manualSources = (omit = '') => DICTIONARY_RESOURCES.map(({ folder, language }) => JSON.stringify([...genshinMetadata.all(), extra]
  .filter((item) => item.itemType === (folder === 'characters' ? 'character' : 'weapon') && item.id !== omit)
  .map((item) => ({ id: Number(item.id), rarity: item.rank, name: item.names[language === 'English' ? 'en-us' : 'zh-cn'] }))));
type Session = { cookie: string; 'x-csrf-token': string };
describe('administrator runtime dictionary', () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>, deployment: Awaited<ReturnType<typeof initializeDeployment>>, app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session, user: Session, calls: string[], mode: 'good' | 'network' | 'missing', gate: Promise<void> | undefined, onFetch: (() => void) | undefined;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input)); calls.push(url.href);
    onFetch?.();
    if (gate) await gate;
    if (mode === 'network') throw new Error('synthetic network error');
    const type = url.pathname.endsWith('/characters') ? 'character' : 'weapon';
    const locale = url.searchParams.get('resultLanguage') === 'English' ? 'en-us' : 'zh-cn';
    const all = [...genshinMetadata.all(), extra].filter((item) => item.itemType === type && (mode !== 'missing' || item.id !== '11301'));
    return new Response(JSON.stringify(all.map((item) => ({ id: Number(item.id), name: item.names[locale], rarity: item.rank }))));
  };
  const open = async () => {
    deployment = await initializeDeployment({ dataDirectory: directory.directory, env: { PUBLIC_URL: `${origin}/gacha/` } });
    app = await buildApp({ database: deployment.connection, auth: { connection: deployment.connection, credentialKey: deployment.credentialKey,
      publicUrl: deployment.config.publicUrl, adminPassword: deployment.config.adminPassword, adminSessionVersion: deployment.adminSessionVersion }, metadata: { fetch: fetcher } });
  };
  const post = (path: string, payload: object, session = admin) => app.inject({ method: 'POST', url: `${prefix}${path}`, payload, headers: { origin, ...session } });
  const get = (path: string, session = admin) => app.inject({ url: `${prefix}${path}`, headers: { cookie: session.cookie } });
  beforeEach(async () => {
    directory = await temporaryDirectory(); calls = []; mode = 'good'; gate = undefined; onFetch = undefined; await open();
    const login = async (kind: string, username: string, password: string) => {
      const response = await app.inject({ method: 'POST', url: `${prefix}/${kind}/login`, headers: { origin }, payload: { username, password } });
      expect(response.statusCode).toBe(200);
      return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string };
    };
    admin = await login('admin', 'admin', deployment.config.adminPassword);
    expect((await post('/admin/users', { username: 'dictionary_user' })).statusCode).toBe(201);
    user = await login('auth', 'dictionary_user', '12345678');
  });
  afterEach(async () => { await app?.close(); deployment?.credentialKey.fill(0); await directory.cleanup(); });

  it('requires admin, Origin and CSRF, and refreshes only after an explicit protected action', async () => {
    expect(calls).toHaveLength(0);
    expect((await get('/admin/dictionary')).json()).toMatchObject({ count: genshinMetadata.size, storage: 'builtin', updating: false });
    expect((await get('/admin/dictionary', user)).statusCode).toBe(401);
    expect((await post('/admin/dictionary/refresh', {}, user)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${prefix}/admin/dictionary/refresh`, payload: {}, headers: { origin, cookie: admin.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${prefix}/admin/dictionary/refresh`, payload: {}, headers: { origin: 'https://foreign.example', ...admin } })).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    const refreshed = await post('/admin/dictionary/refresh', {});
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ storage: 'database', count: genshinMetadata.size + 1, updating: false });
    expect(calls).toHaveLength(4);
    expect(calls.every((url) => url.startsWith('https://genshin-db-api.vercel.app/api/v5/') && !url.includes('dictionary_user'))).toBe(true);
  });

  it('re-resolves existing history, analysis and overview, invalidates stale previews, and keeps the dictionary across restart', async () => {
    const document = sample('v4.1', [pull(undefined, { item_id: extra.id })]);
    const preview = await post('/uigf/preview', { document }, user);
    const imported = await post('/uigf/import', { document, profileIndexes: [0], previewToken: preview.json().previewToken }, user);
    expect(imported.statusCode).toBe(200);
    const profileId = imported.json().profiles[0].targetProfileId as string;
    expect((await get(`/profiles/${profileId}/records`, user)).json().records[0].name).toBeNull();
    expect((await get('/profiles', user)).json().profiles[0].metadataIncomplete).toBe(1);
    const oldPreview = await post('/uigf/preview', { document }, user);
    const version = (await post('/admin/dictionary/refresh', {})).json().version;
    const query = await get(`/profiles/${profileId}/records`, user);
    expect(query.json().records[0]).toMatchObject({ itemId: extra.id, name: '测试新角色', rank: 5, metadataStatus: 'complete' });
    expect((await get(`/profiles/${profileId}/analysis/items`, user)).json().groups[0].items[0].name).toBe('测试新角色');
    expect((await get('/profiles', user)).json().profiles[0].metadataIncomplete).toBe(0);
    expect((await deployment.connection.executor.query<{ name: string | null }>(sql`SELECT name FROM gacha_records`))[0]!.name).toBeNull();
    expect((await post('/uigf/import', { document, profileIndexes: [0], previewToken: oldPreview.json().previewToken }, user)).json().error.code).toBe('PREVIEW_STALE');
    const updatedPreview = await post('/uigf/preview', { document: sample('v4.1', [pull('9007199254740993002', { item_id: extra.id })]) }, user);
    expect(updatedPreview.json().profiles[0].metadataIncomplete).toBe(0);
    // No runtime-global catalog: a separate app using another database keeps its bundled catalog.
    const independent = await temporaryDirectory();
    const other = await initializeDeployment({ dataDirectory: independent.directory, env: {} });
    const otherApp = await buildApp({ database: other.connection, auth: { connection: other.connection, credentialKey: other.credentialKey,
      publicUrl: other.config.publicUrl, adminPassword: other.config.adminPassword, adminSessionVersion: other.adminSessionVersion } });
    try {
      const repo = uigfRepository(other.connection), parsed = decodeUigf(document);
      expect((await repo.preview('independent-owner', parsed))[0]!.metadataIncomplete).toBe(1);
      const login = await otherApp.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: 'http://127.0.0.1:3000' }, payload: { username: 'admin', password: other.config.adminPassword } });
      const response = await otherApp.inject({ url: '/api/admin/dictionary', headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! } });
      expect(response.json()).toMatchObject({ storage: 'builtin', count: genshinMetadata.size });
    } finally { await otherApp.close(); other.credentialKey.fill(0); await independent.cleanup(); }
    await app.close(); deployment.credentialKey.fill(0); await open();
    expect((await get('/admin/dictionary')).json()).toMatchObject({ version, storage: 'database' });
    expect((await get(`/profiles/${profileId}/records`, user)).json().records[0].name).toBe('测试新角色');
    expect(calls).toHaveLength(4);
  });

  it('retains the active and persisted snapshot on network or incomplete-source failures', async () => {
    const saved = (await post('/admin/dictionary/refresh', {})).json();
    const rows = await deployment.connection.executor.query(sql`SELECT * FROM item_metadata ORDER BY item_id`);
    for (const failure of ['network', 'missing'] as const) {
      mode = failure;
      const response = await post('/admin/dictionary/refresh', {});
      expect(response.statusCode).toBe(502); expect(response.json().error.code).toBe('DICTIONARY_REFRESH_FAILED');
      expect((await get('/admin/dictionary')).json()).toEqual(saved);
      expect(await deployment.connection.executor.query(sql`SELECT * FROM item_metadata ORDER BY item_id`)).toEqual(rows);
    }
  });

  it('rejects a concurrent refresh and keeps its old dictionary available while downloading', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { onFetch = resolve; });
    const first = post('/admin/dictionary/refresh', {}).then((response) => response);
    try {
      await started;
      expect((await get('/admin/dictionary')).json()).toMatchObject({ updating: true, storage: 'builtin' });
      expect((await post('/admin/dictionary/refresh', {})).statusCode).toBe(409);
      expect((await post('/admin/dictionary/import', { sources: manualSources() })).statusCode).toBe(409);
    } finally { release(); }
    expect((await first).statusCode).toBe(200);
  });

  it('imports all four local JSON sources atomically behind admin guards without fetching', async () => {
    const sources = manualSources(), url = `${prefix}/admin/dictionary/import`;
    expect((await post('/admin/dictionary/import', { sources }, user)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { origin, cookie: admin.cookie }, payload: { sources } })).statusCode).toBe(403);
    expect((await post('/admin/dictionary/import', { sources: sources.slice(1) })).statusCode).toBe(400);
    const saved = await post('/admin/dictionary/import', { sources });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ source: 'genshin-db-manual', count: genshinMetadata.size + 1, storage: 'database' });
    const loaded = await metadataService(deployment.connection);
    expect(loaded.catalog.get(extra.id)?.names['zh-cn']).toBe(extra.names['zh-cn']); await loaded.close();
    const repeated = JSON.parse(sources[0]!) as unknown[]; repeated.push(repeated[0]);
    for (const bad of [manualSources('11301'), ['invalid', ...sources.slice(1)], [JSON.stringify(repeated), ...sources.slice(1)]]) {
      expect((await post('/admin/dictionary/import', { sources: bad })).json().error.code).toBe('DICTIONARY_IMPORT_INVALID');
      expect((await get('/admin/dictionary')).json()).toEqual(saved.json());
    }
    expect(calls).toHaveLength(0);
  });

  it('never uses a saved proxy on the initial refresh and requires a configured prefix for explicit proxy requests', async () => {
    expect((await post('/admin/dictionary/refresh', { useProxy: true })).json().error.code).toBe('DATA_PROXY_REQUIRED');
    await post('/admin/data-sources', { githubProxy: 'https://proxy.example.test/' }); mode = 'network';
    expect((await post('/admin/dictionary/refresh', {})).statusCode).toBe(502);
    expect(calls).toHaveLength(4); expect(calls.every((value) => value.startsWith('https://genshin-db-api.vercel.app/'))).toBe(true);
    calls.length = 0;
    expect((await post('/admin/dictionary/refresh', { useProxy: true })).statusCode).toBe(502);
    expect(calls).toEqual(['https://proxy.example.test/https://github.com/theBowja/genshin-db/archive/refs/heads/main.tar.gz']);
  });
});
