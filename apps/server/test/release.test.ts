import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import { openConnection, type DatabaseConfig } from '@gacha/db';
import { decodeUigf } from '@gacha/uigf';
import { expect, it } from 'vitest';
import { sql, temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
import { pull, sample } from '../../../packages/uigf/test/fixtures.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';

const secret = 'synthetic-release-SToken', origin = 'https://release.example.test';
type Session = { cookie: string; 'x-csrf-token': string };
for (const driver of ['sqlite', 'postgres'] as const) {
  it.skipIf(driver === 'postgres' && !process.env.TEST_DATABASE_URL)(`R16 ${driver}: clean deployment, legacy upgrade, cold backup recovery and isolated account/data/token APIs`, async () => {
    const original = await temporaryDirectory(), restored = await temporaryDirectory();
    const postgres = driver === 'postgres' ? await temporaryPostgres() : undefined;
    const env = postgres ? { DATABASE_DRIVER: 'postgres', DATABASE_URL: postgres.url } : {};
    let deployment: Awaited<ReturnType<typeof initializeDeployment>> | undefined, app: Awaited<ReturnType<typeof buildApp>> | undefined;
    const open = async (path: string) => {
      deployment = await initializeDeployment({ dataDirectory: path, env });
      app = await buildApp({ serveWeb: true, database: deployment.connection, auth: {
        connection: deployment.connection, credentialKey: deployment.credentialKey, adminPassword: deployment.config.adminPassword,
        adminSessionVersion: deployment.adminSessionVersion, publicUrl: origin,
      }, community: { client: () => ({ getCookieToken: async () => 'synthetic-cookie', getLToken: async () => 'synthetic-ltoken',
        verifyLToken: async () => ({ accountId: '12345', mid: 'synthetic-mid' }), listRoles: async () => [{ gameBiz: 'hk4e_cn', uid: '123456789', region: 'cn_gf01' }], generateAuthKey: async () => 'unused-key' }) } });
    };
    const post = (path: string, payload: object, session?: Session) => app!.inject({ method: 'POST', url: path, payload, headers: { origin, ...session } });
    const get = (path: string, session?: Session) => app!.inject({ url: path, headers: session ? { cookie: session.cookie } : {} });
    const login = async (kind: 'auth' | 'admin', username: string, password: string) => {
      const response = await post(`/api/${kind}/login`, { username, password }); expect(response.statusCode).toBe(200);
      return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string };
    };
    const close = async () => { await app?.close(); app = undefined; deployment?.credentialKey.fill(0); };
    try {
      await open(original.directory);
      const initialPassword = deployment!.config.adminPassword, initialEpoch = deployment!.adminSessionVersion;
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const keyDigest = digest(await readFile(deployment!.config.keyFile, 'utf8'));
      const configDigest = digest(await readFile(deployment!.config.configFile, 'utf8'));
      const admin = await login('admin', 'admin', initialPassword);
      for (const username of ['release_a', 'release_b']) expect((await post('/api/admin/users', { username }, admin)).statusCode).toBe(201);
      let a = await login('auth', 'release_a', '12345678'); const b = await login('auth', 'release_b', '12345678');
      expect((await get('/api/auth/me', a)).json().user.isInitialPassword).toBe(true);
      expect((await post('/api/auth/register', { username: 'public', password: 'anything' })).statusCode).toBe(404);
      expect((await post('/api/admin/users', { username: 'forbidden' }, a)).statusCode).toBe(401);
      const document = sample('v4.1', [pull('9007199254740993001', { time: '2024-02-29 12:00:00' }),
        pull('9007199254740993002', { item_id: '10000016', gacha_type: '400', uigf_gacha_type: '301', rank_type: '5', item_type: '角色', name: '迪卢克' })]);
      const preview = await post('/api/uigf/preview', { document }, a);
      const imported = await post('/api/uigf/import', { document, profileIndexes: [0], previewToken: preview.json().previewToken }, a); expect(imported.statusCode).toBe(200);
      const profileId = imported.json().profiles[0].targetProfileId as string;
      const again = await post('/api/uigf/preview', { document }, a); expect(again.json().profiles[0].inserted).toBe(0);
      const bound = await post('/api/community/accounts', { input: `stuid=12345;mid=synthetic-mid;stoken=${secret}` }, a); expect(bound.statusCode).toBe(201);
      const accountId = bound.json().account.id as string;
      expect(bound.body).not.toContain(secret); expect(bound.json().account.profiles[0].id).toBe(profileId);
      const database: DatabaseConfig = deployment!.config.database;
      await close();

      // Reconstruct the R03 schema state while preserving users, history and encrypted credentials.
      const legacy = await openConnection(database);
      try {
        await legacy.executor.execute(sql`ALTER TABLE gacha_records DROP COLUMN metadata_json`);
        const journal = driver === 'sqlite' ? sql`__drizzle_migrations` : sql`drizzle.__drizzle_migrations`;
        await legacy.executor.execute(sql`DELETE FROM ${journal} WHERE created_at > 1793020873000`);
      } finally { await legacy.close(); }
      await cp(original.directory, restored.directory, { recursive: true });
      await open(restored.directory);
      expect(deployment!.config.adminPassword === initialPassword).toBe(true); expect(deployment!.adminSessionVersion).toBe(initialEpoch);
      expect(digest(await readFile(deployment!.config.keyFile, 'utf8'))).toBe(keyDigest);
      expect(digest(await readFile(deployment!.config.configFile, 'utf8'))).toBe(configDigest);
      expect((await get('/api/auth/me', a)).statusCode).toBe(200); expect((await get('/api/admin/me', admin)).statusCode).toBe(200);
      expect((await get('/api/ready')).statusCode).toBe(200);
      expect((await app!.inject({ url: '/accounts', headers: { accept: 'text/html' } })).headers['content-type']).toContain('text/html');
      expect((await get('/data/config.toml')).statusCode).toBe(404); expect((await get('/data/credential-key')).body).not.toContain(secret);
      const profiles = (await get('/api/profiles', a)).json().profiles;
      expect(profiles).toHaveLength(1); expect(profiles[0]).toMatchObject({ id: profileId, recordCount: 2, region: 'cn_gf01' });
      for (const path of [`/api/profiles/${profileId}/records`, `/api/profiles/${profileId}/analysis/monthly`, `/api/uigf/export/${profileId}`, `/api/community/accounts/${accountId}`]) expect((await get(path, b)).statusCode).toBe(404);
      expect((await post(`/api/community/accounts/${accountId}/reveal`, { type: 'stoken' }, b)).statusCode).toBe(404);
      expect((await post(`/api/community/accounts/${accountId}/reveal`, { type: 'stoken' }, a)).json().value === secret).toBe(true);
      const query = (await get(`/api/profiles/${profileId}/records?order=desc&pageSize=20`, a)).json(); expect(query.total).toBe(2); expect(query.records[0].id).toBe('9007199254740993002');
      const monthly = (await get(`/api/profiles/${profileId}/analysis/monthly`, a)).json(); expect(monthly.totals.total).toBe(2);
      const daily = (await get(`/api/profiles/${profileId}/analysis/daily?year=2024`, a)).json(); expect(daily.days).toHaveLength(366); expect(daily.total).toBe(1);
      for (const version of ['v4.0', 'v4.1', 'v4.2']) {
        const exported = await get(`/api/uigf/export/${profileId}?version=${version}`, a); expect(exported.statusCode).toBe(200);
        expect(decodeUigf(exported.json()).profiles[0]?.records.map((row) => row.id).sort()).toEqual(document.hk4e![0]!.list.map((row) => row.id).sort());
        expect(exported.body).not.toContain(secret);
      }
      const user = await deployment!.repositories.users.findByUsername('release_a');
      expect((await post(`/api/admin/users/${user!.id}/reset-password`, {}, admin)).statusCode).toBe(200);
      expect((await get('/api/auth/me', a)).statusCode).toBe(401); a = await login('auth', 'release_a', '12345678');
      expect((await post(`/api/community/accounts/${accountId}/reveal`, { type: 'stoken' }, a)).json().value === secret).toBe(true);
    } finally {
      await close(); await original.cleanup(); await restored.cleanup(); await postgres?.cleanup();
    }
  }, 30000);
}
