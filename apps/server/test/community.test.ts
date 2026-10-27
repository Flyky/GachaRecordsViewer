import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { CommunityAccount } from '@gacha/contracts';
import { communityRepository, openConnection, repositories, type DatabaseConfig, type DatabaseConnection } from '@gacha/db';
import { MiyousheClient, type Transport } from '@gacha/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/security.js';

type Session = { cookie: string; 'x-csrf-token': string };
const secret = 'fixture-private-SToken', newSecret = 'fixture-private-replacement';
const input = (stoken = secret) => `stuid=12345; mid=fixture-mid; stoken=${stoken}`;
for (const driver of ['sqlite', 'postgres'] as const) {
  describe.skipIf(driver === 'postgres' && !process.env.TEST_DATABASE_URL)(`R12 ${driver} community API`, () => {
    let connection: DatabaseConnection, config: DatabaseConfig, cleanup: () => Promise<void>, app: Awaited<ReturnType<typeof buildApp>>;
    let a: Session, b: Session, admin: Session, originalProfile: string, otherProfile: string, logs: string, mode: string;
    let gate: (() => Promise<void>) | undefined;
    const key = randomBytes(32), origin = 'https://community.example.test';
    const calls: { path: string; device: string | null }[] = [];
    const transport: Transport = async (url, init) => {
      const headers = new Headers(init.headers), cookie = headers.get('cookie') ?? '';
      calls.push({ path: url.pathname, device: headers.get('x-rpc-device_id') });
      if (gate && url.pathname.endsWith('getCookieAccountInfoBySToken')) await gate();
      if (mode === 'network') throw new Error(`private transport error ${secret}`);
      if (mode === 'invalid' || mode === 'challenge') return new Response(JSON.stringify({ retcode: mode === 'invalid' ? -100 : 1034, message: secret, data: {} }));
      const token = url.searchParams.get('stoken') ?? '';
      let data: unknown;
      if (url.pathname.endsWith('getCookieAccountInfoBySToken')) data = { uid: '12345', cookie_token: `cookie:${token}` };
      else if (url.pathname.endsWith('getLTokenBySToken')) data = { ltoken: `ltoken:${token}` };
      else if (url.pathname.endsWith('verifyLtoken')) data = { need_realperson: false, user_info: { aid: '12345', mid: 'fixture-mid', mobile: secret, identity_code: secret } };
      else if (url.pathname.endsWith('getUserGameRolesByCookie')) {
        expect(cookie).toContain('account_id=12345;');
        data = { list: mode === 'no-roles' ? [] : [{ game_biz: 'hk4e_cn', game_uid: '111111111', region: 'cn_gf01' }, { game_biz: 'hk4e_cn', game_uid: '222222222', region: 'cn_qd01' }] };
      } else if (url.pathname.endsWith('genAuthKey')) data = { authkey: 'fixture-private-authkey', sign_type: 2, authkey_ver: 1 };
      else throw new Error('Unexpected upstream endpoint');
      return new Response(JSON.stringify({ retcode: 0, data }));
    };
    const openApp = () => buildApp({ database: connection, logger: { stream: new Writable({ write(chunk, _encoding, callback) { logs += String(chunk); callback(); } }) },
      auth: { connection, credentialKey: key, publicUrl: origin, adminPassword: 'Synthetic-admin-only', adminSessionVersion: 'fixture-admin-version' },
      community: { client: (device) => new MiyousheClient({ device, transport }) },
    });
    const post = (url: string, payload: unknown, session: Session = a) => app.inject({ method: 'POST', url, payload: payload as object, headers: { origin, ...session } });
    const get = (url: string, session: Session = a) => app.inject({ url, headers: { cookie: session.cookie } });
    const accountUrl = (id: string) => `/api/community/accounts/${id}`;
    const create = async (value = input()) => {
      const response = await post('/api/community/accounts', { input: value }); expect(response.statusCode).toBe(201); return response.json().account as CommunityAccount;
    };
    beforeEach(async () => {
      logs = ''; mode = 'good'; gate = undefined; calls.length = 0;
      if (driver === 'sqlite') {
        const fixture = await temporaryDirectory(); cleanup = fixture.cleanup; config = { driver, filename: join(fixture.directory, 'community.sqlite') };
      } else {
        const fixture = await temporaryPostgres(); cleanup = fixture.cleanup; config = { driver, url: fixture.url };
      }
      connection = await openConnection(config); await connection.migrate();
      await connection.executor.execute(sql`INSERT INTO app_state (id, installation_id, key_fingerprint, admin_fingerprint, admin_session_version)
        VALUES ('primary', 'fixture-installation', 'fixture-key', 'fixture-admin', 'fixture-admin-version')`);
      const repository = repositories(connection), passwordHash = await hashPassword('12345678');
      for (const id of ['a', 'b']) await repository.users.create({ id, username: `r12_${id}`, passwordHash });
      originalProfile = (await repository.profiles.create('a', { game: 'hk4e', uid: '111111111', timezone: 8 })).id;
      otherProfile = (await repository.profiles.create('b', { game: 'hk4e', uid: '111111111', timezone: 8 })).id;
      await repository.records.insertBatch('a', originalProfile, [{ id: '9007199254740993001', itemId: '11301', gachaType: '301', pityGroup: '301', timeLocal: '2026-10-27 00:00:00', timeUtc: '2026-10-26T16:00:00.000Z', source: 'synthetic' }]);
      app = await openApp();
      const login = async (kind: string, username: string, password: string) => {
        const response = await post(`/api/${kind}/login`, { username, password }, { cookie: '', 'x-csrf-token': '' });
        expect(response.statusCode).toBe(200);
        return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string };
      };
      a = await login('auth', 'r12_a', '12345678'); b = await login('auth', 'r12_b', '12345678'); admin = await login('admin', 'admin', 'Synthetic-admin-only');
    });
    afterEach(async () => { await app?.close(); await cleanup?.(); });

    it('stores encrypted reusable credentials, binds the existing offline profile and reveals only to the owner; survives restart', async () => {
      const account = await create();
      expect(account.capabilities).toMatchObject({ identity: { status: 'verified' }, roles: { status: 'verified' }, wish: { status: 'unverified' } });
      expect(account.credentials.every((entry) => entry.present && entry.maskedValue === '••••••••')).toBe(true);
      const profile = await repositories(connection).profiles.get('a', originalProfile);
      expect(profile).toMatchObject({ region: 'cn_gf01', community_account_id: account.id });
      expect(account.profiles).toHaveLength(2); expect(account.profiles.find((profile) => profile.uid === '111111111')?.id).toBe(originalProfile);
      expect((await repositories(connection).profiles.get('b', otherProfile))?.region).toBe('unknown');
      expect(await repositories(connection).records.count('a', originalProfile)).toBe(1);
      const listed = await get('/api/community/accounts'); expect(listed.headers['cache-control']).toBe('no-store'); expect(listed.body).not.toMatch(/fixture-private|encrypted_value|fixture-mid/);
      expect((await get('/api/community/accounts', b)).json().accounts).toEqual([]);
      expect((await get(accountUrl(account.id), b)).statusCode).toBe(404);
      expect((await get(accountUrl(account.id), admin)).statusCode).toBe(401);
      expect((await post(`${accountUrl(account.id)}/reveal`, { type: 'stoken' }, b)).statusCode).toBe(404);
      const beforeForeign = calls.length;
      expect((await post(`${accountUrl(account.id)}/credentials`, { input: input() }, b)).statusCode).toBe(404);
      expect((await post(`${accountUrl(account.id)}/validate`, {}, b)).statusCode).toBe(404);
      expect((await post(`${accountUrl(account.id)}/unlink`, {}, b)).statusCode).toBe(404);
      expect(calls.length).toBe(beforeForeign);
      expect((await app.inject({ method: 'POST', url: `${accountUrl(account.id)}/reveal`, payload: { type: 'stoken' }, headers: { origin, cookie: a.cookie } })).statusCode).toBe(403);
      expect((await post(`${accountUrl(account.id)}/validate`, { profileId: otherProfile })).statusCode).toBe(404);
      const revealed = await post(`${accountUrl(account.id)}/reveal`, { type: 'stoken' });
      expect(revealed.json()).toEqual({ accountId: '12345', mid: 'fixture-mid', type: 'stoken', value: secret });
      expect((await post(`${accountUrl(account.id)}/validate`, { profileId: originalProfile })).json().account.capabilities.wish).toMatchObject({ status: 'authkey_verified', profileId: originalProfile, code: 'history_not_checked' });
      const stored = await communityRepository(connection).get('a', account.id);
      expect(stored.encrypted_value).not.toMatch(/fixture-private|fixture-mid|authkey/);
      await app.close(); connection = await openConnection(config); app = await openApp();
      expect((await post(`${accountUrl(account.id)}/reveal`, { type: 'ltoken' })).json().value).toBe(`ltoken:${secret}`);
      expect((await post(`${accountUrl(account.id)}/validate`, {})).statusCode).toBe(200);
      expect(new Set(calls.map((call) => call.device)).size).toBe(1);
      expect(calls.some((call) => /createQR|queryQR|getGachaLog/.test(call.path))).toBe(false);
      const beforeExport = calls.length;
      expect((await post(`${accountUrl(account.id)}/export-credentials`, {}, b)).statusCode).toBe(404);
      expect((await post(`${accountUrl(account.id)}/export-credentials`, {}, admin)).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `${accountUrl(account.id)}/export-credentials`, payload: {}, headers: { origin, cookie: a.cookie } })).statusCode).toBe(403);
      const exported = await post(`${accountUrl(account.id)}/export-credentials`, {});
      expect(exported.headers['cache-control']).toBe('no-store');
      expect(exported.json()).toEqual({ credentials: { accountId: '12345', mid: 'fixture-mid', stoken: secret, ltoken: `ltoken:${secret}`, cookieToken: `cookie:${secret}` } });
      expect(calls.length).toBe(beforeExport);
      expect((await post('/api/community/accounts', { input: JSON.stringify(exported.json().credentials) }, b)).statusCode).toBe(201);
      expect(logs).not.toMatch(/fixture-private|fixture-mid|identity_code|cookie_token=/);
    });
    it('preserves the old set on failed replacement, marks expired validation safely, stops at challenges and unlinks without deleting history', async () => {
      const account = await create(), repository = communityRepository(connection), original = await repository.get('a', account.id);
      mode = 'invalid';
      expect((await post(`${accountUrl(account.id)}/credentials`, { input: input('bad-candidate') })).statusCode).toBe(422);
      expect((await repository.get('a', account.id)).encrypted_value).toBe(original.encrypted_value);
      expect((await get(accountUrl(account.id))).json().account.capabilities.identity.status).toBe('verified');
      expect((await post(`${accountUrl(account.id)}/validate`, {})).statusCode).toBe(422);
      expect((await get(accountUrl(account.id))).json().account.capabilities.lastValidation.status).toBe('invalid');
      mode = 'challenge'; const beforeChallenge = calls.length;
      expect((await post(`${accountUrl(account.id)}/credentials`, { input: input(newSecret) })).json().error.code).toBe('MIYOUSHE_VERIFICATION_REQUIRED');
      expect(calls.length - beforeChallenge).toBe(1);
      mode = 'network'; const failed = await post(`${accountUrl(account.id)}/validate`, {});
      expect(failed.statusCode).toBe(502); expect(failed.body).not.toContain(secret);
      mode = 'good';
      expect((await post(`${accountUrl(account.id)}/credentials`, { input: input(newSecret) })).statusCode).toBe(200);
      expect((await repository.get('a', account.id)).credential_id).not.toBe(original.credential_id);
      await expect(repository.failure('a', account.id, original.credential_id!, '{}', true)).rejects.toMatchObject({ code: 'CREDENTIALS_CHANGED' });
      expect((await get(accountUrl(account.id))).json().account.capabilities.identity.status).toBe('verified');
      expect((await post(`${accountUrl(account.id)}/credentials`, { input: 'stuid=999;mid=fixture-mid;stoken=wrong-owner' })).statusCode).toBe(409);
      expect((await post(`${accountUrl(account.id)}/reveal`, { type: 'stoken' })).json().value).toBe(newSecret);
      for (const [owner, profileId] of [['a', originalProfile], ['b', otherProfile]]) await connection.executor.execute(sql`
        INSERT INTO sync_jobs (id, owner_id, profile_id, status, created_at) VALUES (${`job-${owner}`}, ${owner}, ${profileId}, 'running', '2026-10-27')`);
      expect((await post(`${accountUrl(account.id)}/unlink`, {})).statusCode).toBe(204);
      expect((await get(accountUrl(account.id))).statusCode).toBe(404);
      expect((await post(`${accountUrl(account.id)}/reveal`, { type: 'stoken' })).statusCode).toBe(404);
      expect(await repositories(connection).records.count('a', originalProfile)).toBe(1);
      expect((await repositories(connection).profiles.get('a', originalProfile))?.community_account_id).toBeNull();
      const jobs = await connection.executor.query<{ id: string; status: string }>(sql`SELECT id, status FROM sync_jobs ORDER BY id`);
      expect(jobs).toEqual([{ id: 'job-a', status: 'cancelled' }, { id: 'job-b', status: 'running' }]);
      expect(await connection.executor.query(sql`SELECT id FROM credentials WHERE owner_id='a'`)).toEqual([]);
      expect(logs).not.toContain(secret); expect(logs).not.toContain(newSecret);
    });
    it('accepts LToken-only and Cookie Token-only identities without claiming wish readiness, and rolls back binding conflicts', async () => {
      const account = await create('ltuid=12345;ltoken=web-only');
      expect(account.capabilities).toMatchObject({ identity: { status: 'verified' }, roles: { status: 'missing' }, wish: { status: 'missing', code: 'stoken_required' } });
      expect(account.profiles).toEqual([]);
      expect((await post(`${accountUrl(account.id)}/reveal`, { type: 'stoken' })).statusCode).toBe(404);
      const updated = await post(`${accountUrl(account.id)}/credentials`, { input: 'account_id=12345;cookie_token=cookie-only' });
      expect(updated.statusCode).toBe(200); expect(updated.json().account.capabilities.wish.status).toBe('missing');
      expect((await post(`${accountUrl(account.id)}/validate`, { profileId: originalProfile })).json().account.capabilities.wish.status).toBe('missing');
      expect(calls.some((call) => call.path.endsWith('genAuthKey'))).toBe(false);
      expect((await post(`${accountUrl(account.id)}/credentials`, { input: 'stuid=12345;stoken=missing-mid' })).json().error.code).toBe('STOKEN_MID_REQUIRED');
      const previous = await communityRepository(connection).get('a', account.id);
      await repositories(connection).profiles.create('a', { game: 'hk4e', uid: '111111111', timezone: 8 });
      expect((await post(`${accountUrl(account.id)}/credentials`, { input: input(newSecret) })).json().error.code).toBe('PROFILE_BINDING_CONFLICT');
      expect((await communityRepository(connection).get('a', account.id)).encrypted_value).toBe(previous.encrypted_value);
      expect((await post('/api/community/accounts', { input: 'stuid=1;ltuid=2;stoken=private' })).statusCode).toBe(400);
    });
    it('detaches revoked roles on a fresh authoritative role list while preserving the imported history', async () => {
      const account = await create(); mode = 'no-roles';
      const result = await post(`${accountUrl(account.id)}/validate`, {});
      expect(result.statusCode).toBe(200); expect(result.json().account.profiles).toEqual([]);
      expect((await repositories(connection).profiles.get('a', originalProfile))?.community_account_id).toBeNull();
      expect(await repositories(connection).records.count('a', originalProfile)).toBe(1);
      expect((await post(`${accountUrl(account.id)}/validate`, { profileId: originalProfile })).statusCode).toBe(404);
    });
    it('serializes in-flight operations and prevents a late validation from resurrecting a deleted account', async () => {
      const account = await create();
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; }), resumed = new Promise<void>((resolve) => { release = resolve; });
      gate = async () => { entered(); await resumed; };
      const pending = post(`${accountUrl(account.id)}/credentials`, { input: input(newSecret) }).then((response) => response);
      await waiting;
      expect((await post(`${accountUrl(account.id)}/unlink`, {})).json().error.code).toBe('COMMUNITY_BUSY');
      expect((await post(`${accountUrl(account.id)}/reveal`, { type: 'stoken' })).statusCode).toBe(409);
      await communityRepository(connection).remove('a', account.id);
      release();
      expect((await pending).statusCode).toBe(404);
      expect((await get('/api/community/accounts')).json().accounts).toEqual([]);
      expect(await repositories(connection).records.count('a', originalProfile)).toBe(1);
    });
  });
}
