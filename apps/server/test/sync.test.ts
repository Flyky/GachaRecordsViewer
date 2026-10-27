import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { SyncJob, SyncPool } from '@gacha/contracts';
import { openConnection, repositories, syncRepository, type DatabaseConfig, type DatabaseConnection } from '@gacha/db';
import { MiyousheClient, type Transport } from '@gacha/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/security.js';
type Session = { cookie: string; 'x-csrf-token': string };
const origin = 'https://sync.example.test', secret = 'fixture-private-token';
const record = (suffix: number) => ({ uid: '111111111', id: `90071992547409930${suffix.toString().padStart(2, '0')}`, item_id: '',
  time: '2026-10-27 12:00:00', gacha_type: suffix % 2 ? '301' : '400', name: '冷刃', item_type: '武器', rank_type: '3', count: '1' });
for (const driver of ['sqlite', 'postgres'] as const) {
  describe.skipIf(driver === 'postgres' && !process.env.TEST_DATABASE_URL)(`R14 ${driver} sync`, () => {
    let app: Awaited<ReturnType<typeof buildApp>>, connection: DatabaseConnection, config: DatabaseConfig, cleanup: () => Promise<void>;
    let a: Session, b: Session, profileId: string, accountId: string, mode: string, hits: number, logs: string;
    let rows: ReturnType<typeof record>[], gate: (() => Promise<void>) | undefined;
    const key = randomBytes(32), requests: string[] = [];
    const transport: Transport = async (url) => {
      requests.push(url.pathname);
      let data: unknown;
      if (url.pathname.endsWith('getCookieAccountInfoBySToken')) {
        if (mode === 'always503') return new Response('{}', { status: 503 });
        if (mode === 'token-invalid') return new Response(JSON.stringify({ retcode: -100, message: secret, data: {} }));
        data = { uid: '12345', cookie_token: 'fixture-private-cookie' };
      } else if (url.pathname.endsWith('getLTokenBySToken')) data = { ltoken: 'fixture-private-ltoken' };
      else if (url.pathname.endsWith('verifyLtoken')) data = { user_info: { aid: '12345', mid: 'fixture-mid' } };
      else if (url.pathname.endsWith('getUserGameRolesByCookie')) data = { list: mode === 'no-role' ? [] : [{ game_biz: 'hk4e_cn', game_uid: '111111111', region: 'cn_gf01' }] };
      else if (url.pathname.endsWith('genAuthKey')) data = { authkey: 'fixture-private-authkey', sign_type: 2, authkey_ver: 1 };
      else if (url.pathname.endsWith('getGachaLog')) {
        await gate?.(); hits++;
        if (mode === 'recover' && hits === 1) return new Response('{}', { status: 503 });
        if (mode === 'recover' && hits === 2) return new Response(JSON.stringify({ retcode: -101, message: secret, data: {} }));
        if (mode === 'auth-still-invalid') return new Response(JSON.stringify({ retcode: -101, data: {} }));
        if (mode === 'challenge') return new Response(JSON.stringify({ retcode: 1034, message: secret, data: {} }));
        const pool = url.searchParams.get('gacha_type'), cursor = url.searchParams.get('end_id');
        if (mode === 'partial' && pool === '302') return new Response(JSON.stringify({ retcode: -999, message: secret, data: {} }));
        const start = cursor === '0' ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
        data = { list: pool === '301' ? rows.slice(start, start + 2).map((row) => mode === 'wrong-uid' ? { ...row, uid: '999' } : mode === 'unknown-item' ? { ...row, name: '不存在的物品' } : row) : [] };
      } else throw new Error('Unexpected endpoint');
      return new Response(JSON.stringify({ retcode: 0, data }));
    };
    const openApp = () => buildApp({ database: connection,
      logger: { stream: new Writable({ write(chunk, _encoding, callback) { logs += String(chunk); callback(); } }) },
      auth: { connection, publicUrl: origin, credentialKey: key, adminPassword: 'fixture-admin', adminSessionVersion: 'fixture-version' },
      community: { client: (device) => new MiyousheClient({ device, transport }), sync: {
        client: (device, signal) => new MiyousheClient({ device, transport, signal }), wait: async () => {},
      } },
    });
    const post = (url: string, payload: object = {}, session: Session = a) => app.inject({ method: 'POST', url, payload, headers: { origin, ...session } });
    const get = (url: string, session: Session = a) => app.inject({ url, headers: { cookie: session.cookie } });
    const create = async (pools: SyncPool[] = ['301'], mode = 'incremental') => {
      const response = await post(`/api/profiles/${profileId}/sync`, { pools, mode }); expect(response.statusCode).toBe(202); return response.json().job as SyncJob;
    };
    async function finished(id: string) {
      for (let i = 0; i < 1500; i++) {
        const response = await get(`/api/sync/jobs/${id}`); expect(response.statusCode).toBe(200);
        const job = response.json().job as SyncJob;
        if (!['queued', 'running', 'retrying'].includes(job.status)) return job;
        await delay(5);
      }
      throw new Error('Synthetic job did not finish');
    }
    beforeEach(async () => {
      mode = ''; hits = 0; logs = ''; rows = [record(3), record(2), record(1)]; gate = undefined; requests.length = 0;
      if (driver === 'sqlite') { const fixture = await temporaryDirectory(); cleanup = fixture.cleanup; config = { driver, filename: join(fixture.directory, 'sync.sqlite') }; }
      else { const fixture = await temporaryPostgres(); cleanup = fixture.cleanup; config = { driver, url: fixture.url }; }
      connection = await openConnection(config); await connection.migrate(); const passwordHash = await hashPassword('12345678');
      for (const id of ['a', 'b']) await repositories(connection).users.create({ id, username: `sync_${id}`, passwordHash });
      app = await openApp();
      const login = async (username: string) => {
        const response = await post('/api/auth/login', { username, password: '12345678' }, { cookie: '', 'x-csrf-token': '' }); expect(response.statusCode).toBe(200);
        return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string };
      };
      a = await login('sync_a'); b = await login('sync_b');
      const imported = await post('/api/community/accounts', { input: `stuid=12345;mid=fixture-mid;stoken=${secret}` }); expect(imported.statusCode).toBe(201);
      accountId = imported.json().account.id as string; profileId = imported.json().account.profiles[0].id as string;
    });
    afterEach(async () => { await app?.close(); await cleanup?.(); });
    it('merges full and incremental pages without loss, preserves old records and exports standard UIGF', async () => {
      await repositories(connection).records.insertBatch('a', profileId, [{ id: '5', itemId: '11301', gachaType: '301', pityGroup: '301', timeLocal: '2025-01-01 00:00:00', timeUtc: '2024-12-31T16:00:00.000Z', source: 'uigf' }]);
      const first = await finished((await create()).id); expect(first.status).toBe('completed'); expect(first.pools[0]).toMatchObject({ inserted: 3, pages: 3, stopReason: 'upstream_end' });
      rows.unshift(record(4)); const second = await finished((await create()).id);
      expect(second.pools[0]).toMatchObject({ inserted: 1, duplicates: 1, pages: 1, stopReason: 'checkpoint' });
      const third = await finished((await create(['301'], 'full')).id); expect(third.pools[0]).toMatchObject({ inserted: 0, duplicates: 4, stopReason: 'upstream_end' });
      expect(await repositories(connection).records.count('a', profileId)).toBe(5);
      const { uigfRepository } = await import('@gacha/db'), { encodeUigf } = await import('@gacha/uigf');
      const exported = encodeUigf([await uigfRepository(connection).export('a', profileId)]);
      expect(exported.hk4e?.[0]?.list).toHaveLength(5); expect(JSON.stringify(exported)).not.toContain('fixture-private');
      expect(JSON.stringify(third)).not.toMatch(/fixture-private|credentialId|device|cursor/); expect(logs).not.toMatch(/fixture-private|authkey=/);
    });
    it('keeps successful pools and retries only failed pools as a new owned job', async () => {
      mode = 'partial'; const original = await finished((await create(['301', '302'])).id);
      expect(original.status).toBe('partial'); expect(original.pools.map((pool) => pool.status)).toEqual(['completed', 'failed']);
      mode = ''; const retry = await post(`/api/sync/jobs/${original.id}/retry`); expect(retry.statusCode).toBe(202);
      const retried = await finished(retry.json().job.id as string); expect(retried.status).toBe('completed'); expect(retried.retryOf).toBe(original.id);
      expect(retried.pools.map((pool) => pool.pool)).toEqual(['302']); expect(await repositories(connection).records.count('a', profileId)).toBe(3);
    });
    it('bounds transient retries and renews an expired history AuthKey once', async () => {
      mode = 'recover'; const job = await finished((await create()).id);
      expect(job.status).toBe('completed'); expect(job.pools[0]).toMatchObject({ retries: 1, authKeyRenewals: 1, inserted: 3 });
      expect(requests.filter((path) => path.endsWith('genAuthKey'))).toHaveLength(2);
      mode = 'auth-still-invalid'; const beforeKeys = requests.filter((path) => path.endsWith('genAuthKey')).length;
      expect((await finished((await create()).id)).status).toBe('failed');
      expect(requests.filter((path) => path.endsWith('genAuthKey')).length - beforeKeys).toBe(2);
      mode = 'always503'; const beforeCookies = requests.filter((path) => path.endsWith('getCookieAccountInfoBySToken')).length;
      expect((await finished((await create()).id)).status).toBe('failed');
      expect(requests.filter((path) => path.endsWith('getCookieAccountInfoBySToken')).length - beforeCookies).toBe(3);
    });
    it('stops invalid credentials, missing roles, mismatched history and challenges without fallback', async () => {
      for (const [nextMode, code] of [['token-invalid', 'MIYOUSHE_AUTH_INVALID'], ['no-role', 'MIYOUSHE_ROLE_MISMATCH'], ['wrong-uid', 'MIYOUSHE_ROLE_MISMATCH'], ['challenge', 'MIYOUSHE_VERIFICATION_REQUIRED']]) {
        mode = nextMode!; const job = await finished((await create(['301', '302'])).id);
        expect(job.status).toBe('failed'); expect(job.failureCode).toBe(code); expect(job.pools.every((pool) => pool.status === 'failed')).toBe(true);
      }
      expect(await repositories(connection).records.count('a', profileId)).toBe(0);
    });
    it('rejects owner/CSRF violations and simultaneous jobs, cancels late results and permits retry after restart recovery', async () => {
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; }), resumed = new Promise<void>((resolve) => { release = resolve; });
      gate = async () => { entered(); await resumed; };
      const job = await create(); await waiting;
      expect((await post(`/api/profiles/${profileId}/sync`)).json().error.code).toBe('SYNC_ALREADY_ACTIVE');
      expect((await post(`/api/profiles/${profileId}/sync`, {}, b)).statusCode).toBe(404);
      for (const action of ['', '/retry', '/cancel']) expect((await (action ? post(`/api/sync/jobs/${job.id}${action}`, {}, b) : get(`/api/sync/jobs/${job.id}`, b))).statusCode).toBe(404);
      expect((await get('/api/sync/jobs', b)).json().jobs).toEqual([]);
      expect((await app.inject({ method: 'POST', url: `/api/sync/jobs/${job.id}/cancel`, payload: {}, headers: { origin, cookie: a.cookie } })).statusCode).toBe(403);
      expect((await post(`/api/sync/jobs/${job.id}/cancel`)).json().job.status).toBe('cancelled'); release(); gate = undefined;
      await app.close();
      connection = await openConnection(config);
      expect(await repositories(connection).records.count('a', profileId)).toBe(0);
      await connection.executor.execute(sql`UPDATE sync_jobs SET status='running' WHERE id=${job.id}`);
      app = await openApp(); expect((await get(`/api/sync/jobs/${job.id}`)).json().job).toMatchObject({ status: 'interrupted', failureCode: 'SERVER_RESTARTED' });
      const retry = await post(`/api/sync/jobs/${job.id}/retry`); expect(retry.statusCode).toBe(202); expect((await finished(retry.json().job.id as string)).status).toBe('completed');
    });
    it.each(['replace', 'unlink'] as const)('rejects an in-flight page after credential %s', async (action) => {
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; }), resumed = new Promise<void>((resolve) => { release = resolve; });
      gate = async () => { entered(); await resumed; };
      const job = await create(); await waiting;
      const response = action === 'unlink' ? await post(`/api/community/accounts/${accountId}/unlink`)
        : await post(`/api/community/accounts/${accountId}/credentials`, { input: 'stuid=12345;mid=fixture-mid;stoken=fixture-private-new' });
      expect(response.statusCode).toBe(action === 'unlink' ? 204 : 200); release(); gate = undefined;
      const result = await finished(job.id); expect(result.status).toBe(action === 'unlink' ? 'cancelled' : 'failed');
      expect(await repositories(connection).records.count('a', profileId)).toBe(0);
    });
    it('rolls back a conflicting page instead of overwriting history or inserting its other rows', async () => {
      await repositories(connection).records.insertBatch('a', profileId, [{ id: record(3).id, itemId: '11401', gachaType: '301', pityGroup: '301', timeLocal: record(3).time, timeUtc: '2026-10-27T04:00:00.000Z', source: 'uigf' }]);
      const job = await finished((await create(['301', '200'])).id); expect(job.status).toBe('partial'); expect(job.pools[0]?.code).toBe('RECORD_CONFLICT');
      expect(await repositories(connection).records.count('a', profileId)).toBe(1);
      expect((await syncRepository(connection).get('a', job.id)).failure_code).toBe('RECORD_CONFLICT');
      mode = 'unknown-item'; const unknown = await finished((await create(['301', '200'])).id);
      expect(unknown.pools[0]?.code).toBe('ITEM_ID_UNRESOLVED'); expect(unknown.pools[1]?.status).toBe('completed');
      expect(await repositories(connection).records.count('a', profileId)).toBe(1);
    });
  });
}
