import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { communityRepository, openConnection, repositories, type DatabaseConfig, type DatabaseConnection } from '@gacha/db';
import { MiyousheClient, type Transport } from '@gacha/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/security.js';

type Session = { cookie: string; 'x-csrf-token': string };
const origin = 'https://qr.example.test', token = 'fixture-private-stoken', mid = 'fixture-private-mid';
for (const driver of ['sqlite', 'postgres'] as const) {
  describe.skipIf(driver === 'postgres' && !process.env.TEST_DATABASE_URL)(`R13 ${driver} QR authorization`, () => {
    let connection: DatabaseConnection, config: DatabaseConfig, cleanup: () => Promise<void>, app: Awaited<ReturnType<typeof buildApp>>;
    let a: Session, b: Session, second: Session, time: number, state: string, mode: string, identity: string, secret: string, logs: string;
    let gate: ((path: string) => Promise<void>) | undefined;
    const key = randomBytes(32), calls: { path: string; device: string | null }[] = [];
    const transport: Transport = async (url, init) => {
      calls.push({ path: url.pathname, device: new Headers(init.headers).get('x-rpc-device_id') });
      await gate?.(url.pathname);
      if (mode === 'network') throw new Error(token);
      if (mode === 'challenge') return new Response(JSON.stringify({ retcode: 1034, message: token, data: {} }));
      let data: unknown;
      if (url.pathname.endsWith('createQRLogin')) data = { ticket: 'fixture-private-ticket', url: `https://user.mihoyo.com/qr?ticket=fixture-private-ticket&expire=${Math.floor((time + 180000) / 1000)}` };
      else if (url.pathname.endsWith('queryQRLoginStatus')) data = { status: state, tokens: [{ token_type: 1, token: secret }], user_info: { aid: identity, mid } };
      else if (url.pathname.endsWith('getCookieAccountInfoBySToken')) data = { uid: identity, cookie_token: 'fixture-private-cookie' };
      else if (url.pathname.endsWith('getLTokenBySToken')) data = { ltoken: 'fixture-private-ltoken' };
      else if (url.pathname.endsWith('verifyLtoken')) data = { user_info: { aid: identity, mid } };
      else if (url.pathname.endsWith('getUserGameRolesByCookie')) data = { list: [{ game_biz: 'hk4e_cn', game_uid: '111111111', region: 'cn_gf01' }] };
      else throw new Error('Unexpected upstream endpoint');
      return new Response(JSON.stringify({ retcode: 0, data }));
    };
    const openApp = () => buildApp({ database: connection,
      logger: { stream: new Writable({ write(chunk, _encoding, callback) { logs += String(chunk); callback(); } }) },
      auth: { connection, credentialKey: key, publicUrl: origin, adminPassword: 'fixture-admin', adminSessionVersion: 'fixture-version', now: () => time },
      community: { client: (device, signal) => new MiyousheClient({ device, transport, ...(signal ? { signal } : {}) }),
        qr: { client: (device, signal) => new MiyousheClient({ device, transport, signal }) } },
    });
    const post = (url: string, payload: object = {}, session: Session = a) => app.inject({ method: 'POST', url, payload, headers: { origin, ...session } });
    const get = (url: string, session: Session = a) => app.inject({ url, headers: { cookie: session.cookie } });
    const path = (id: string) => `/api/community/qr/${id}`;
    const create = async (communityAccountId?: string) => {
      const response = await post('/api/community/qr', communityAccountId ? { communityAccountId } : {});
      expect(response.statusCode).toBe(201); return response.json().session.id as string;
    };
    const poll = (id: string) => { time += 2100; return post(`${path(id)}/poll`); };
    const reveal = (id: string) => post(`/api/community/accounts/${id}/reveal`, { type: 'stoken' });
    beforeEach(async () => {
      time = Date.now(); state = 'Init'; mode = ''; identity = '12345'; secret = token; logs = ''; gate = undefined; calls.length = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => time);
      if (driver === 'sqlite') {
        const fixture = await temporaryDirectory(); cleanup = fixture.cleanup; config = { driver, filename: join(fixture.directory, 'qr.sqlite') };
      } else {
        const fixture = await temporaryPostgres(); cleanup = fixture.cleanup; config = { driver, url: fixture.url };
      }
      connection = await openConnection(config); await connection.migrate();
      const passwordHash = await hashPassword('12345678');
      for (const id of ['a', 'b']) await repositories(connection).users.create({ id, username: `qr_${id}`, passwordHash });
      app = await openApp();
      const login = async (username: string) => {
        const response = await post('/api/auth/login', { username, password: '12345678' }, { cookie: '', 'x-csrf-token': '' });
        expect(response.statusCode).toBe(200);
        return { cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string };
      };
      a = await login('qr_a'); b = await login('qr_b'); second = await login('qr_a');
    });
    afterEach(async () => { await app?.close(); await cleanup?.(); vi.restoreAllMocks(); });

    it('bounds polling, preserves device context, consumes confirmation once and reuses encrypted authorization after restart', async () => {
      const created = await post('/api/community/qr'); expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store'); expect(created.json().qrUrl).toContain('https://user.mihoyo.com/');
      const id = created.json().session.id as string;
      expect((await post(`${path(id)}/poll`)).json().session.status).toBe('waiting'); expect(calls).toHaveLength(1);
      expect((await poll(id)).json().session.status).toBe('waiting');
      state = 'Scanned'; expect((await poll(id)).json().session.status).toBe('scanned');
      state = 'Init'; expect((await poll(id)).json().session.status).toBe('scanned');
      state = 'Confirmed'; const confirmed = await poll(id);
      expect(confirmed.json().session.status).toBe('confirmed'); expect(confirmed.body).not.toMatch(/fixture-private|qrUrl|encrypted/);
      const accountId = confirmed.json().session.communityAccountId as string, beforeRepeat = calls.length;
      expect((await poll(id)).json().session.communityAccountId).toBe(accountId); expect(calls.length).toBe(beforeRepeat);
      expect((await post(`${path(id)}/cancel`)).statusCode).toBe(409);
      expect((await reveal(accountId)).json().value).toBe(token);
      expect((await communityRepository(connection).get('a', accountId)).encrypted_value).not.toContain('fixture-private');
      expect(new Set(calls.map((call) => call.device)).size).toBe(1);
      expect(calls.some((call) => /genAuthKey|getGachaLog/.test(call.path))).toBe(false);
      await app.close(); connection = await openConnection(config); app = await openApp();
      expect((await get(path(id))).statusCode).toBe(404); expect((await reveal(accountId)).json().value).toBe(token);
      expect(logs).not.toMatch(/fixture-private|qrUrl|encrypted_value/);
    });
    it('binds tickets to the owner and original login session, enforces CSRF and reserves one active QR per owner', async () => {
      const id = await create(), beforeForeign = calls.length;
      for (const session of [b, second]) {
        expect((await get(path(id), session)).statusCode).toBe(404);
        expect((await post(`${path(id)}/poll`, {}, session)).statusCode).toBe(404);
        expect((await post(`${path(id)}/cancel`, {}, session)).statusCode).toBe(404);
      }
      expect((await app.inject({ method: 'POST', url: `${path(id)}/cancel`, payload: {}, headers: { origin, cookie: a.cookie } })).statusCode).toBe(403);
      expect((await post('/api/community/qr', { ownerId: 'b' })).statusCode).toBe(400);
      expect((await post('/api/community/qr')).json().error.code).toBe('QR_ALREADY_ACTIVE');
      expect(calls.length).toBe(beforeForeign);
      expect((await post(`${path(id)}/cancel`)).json().session.status).toBe('cancelled');
      expect((await post(`${path(id)}/cancel`)).json().session.status).toBe('cancelled');
      expect((await poll(id)).json().session.status).toBe('cancelled');
      expect((await post('/api/community/qr', { communityAccountId: 'foreign-or-missing' })).statusCode).toBe(404);
      await create();
    });
    it.each(['cancel', 'expire', 'logout'] as const)('discards credentials received after %s while authorization is in flight', async (action) => {
      const id = await create(); state = 'Confirmed';
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; }), resumed = new Promise<void>((resolve) => { release = resolve; });
      gate = async (path) => { if (path.endsWith('getCookieAccountInfoBySToken')) { entered(); await resumed; } };
      const pending = poll(id).then((response) => response); await waiting;
      expect((await get(path(id))).json().session.status).toBe('confirming');
      if (action === 'cancel') expect((await post(`${path(id)}/cancel`)).json().session.status).toBe('cancelled');
      if (action === 'expire') { time += 180000; expect((await get(path(id))).json().session.status).toBe('expired'); }
      if (action === 'logout') expect((await post('/api/auth/logout')).statusCode).toBe(204);
      release(); const response = await pending;
      expect(response.json().session.status).toBe(action === 'cancel' ? 'cancelled' : action === 'expire' ? 'expired' : 'failed');
      if (action === 'logout') expect(response.json().session.code).toBe('QR_SESSION_INVALID');
      expect(await communityRepository(connection).list('a')).toEqual([]);
    });
    it('serializes simultaneous polls and discards a late upstream confirmation after cancellation', async () => {
      const id = await create(); state = 'Confirmed';
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; }), resumed = new Promise<void>((resolve) => { release = resolve; });
      gate = async (path) => { if (path.endsWith('queryQRLoginStatus')) { entered(); await resumed; } };
      const pending = poll(id).then((response) => response); await waiting;
      expect((await poll(id)).json().session.status).toBe('waiting');
      expect(calls.filter((call) => call.path.endsWith('queryQRLoginStatus'))).toHaveLength(1);
      await post(`${path(id)}/cancel`); release();
      expect((await pending).json().session.status).toBe('cancelled');
      expect(await communityRepository(connection).list('a')).toEqual([]);
    });
    it('reauthorizes the selected identity and rejects identity changes or stale target revisions without overwriting tokens', async () => {
      let id = await create(); state = 'Confirmed';
      const accountId = (await poll(id)).json().session.communityAccountId as string;
      const profileId = (await communityRepository(connection).profiles('a', accountId))[0]!.id;
      secret = 'fixture-private-new'; id = await create(accountId);
      expect((await poll(id)).json().session.status).toBe('confirmed'); expect((await reveal(accountId)).json().value).toBe(secret);
      expect((await communityRepository(connection).profiles('a', accountId))[0]?.id).toBe(profileId);
      id = await create(accountId); identity = '99999';
      expect((await poll(id)).json().session.code).toBe('COMMUNITY_IDENTITY_MISMATCH');
      expect((await reveal(accountId)).json().value).toBe(secret);
      identity = '12345'; id = await create(accountId);
      expect((await post(`/api/community/accounts/${accountId}/credentials`, { input: `stuid=12345;mid=${mid};stoken=fixture-private-manual` })).statusCode).toBe(200);
      expect((await poll(id)).json().session.code).toBe('CREDENTIALS_CHANGED');
      expect((await reveal(accountId)).json().value).toBe('fixture-private-manual');
    });
    it('returns safe terminal failures and allows a fresh ticket instead of retrying challenges or consumed confirmation', async () => {
      mode = 'challenge'; expect((await post('/api/community/qr')).json().error.code).toBe('MIYOUSHE_VERIFICATION_REQUIRED');
      for (const [nextState, nextMode, expected] of [['Init', 'challenge', 'verification_required'], ['Init', 'network', 'failed'], ['Expired', '', 'expired'], ['Cancelled', '', 'cancelled'], ['Unexpected', '', 'failed']]) {
        mode = ''; const id = await create(); state = nextState!; mode = nextMode!;
        const result = await poll(id); expect(result.json().session.status).toBe(expected); expect(result.body).not.toContain('fixture-private');
        const count = calls.length; await poll(id); expect(calls.length).toBe(count);
      }
      expect(logs).not.toMatch(/fixture-private|qrUrl/);
    });
    it('expires idle tickets, caps total upstream polling and removes terminal sessions after retention', async () => {
      const id = await create();
      for (let i = 0; i < 92; i++) await poll(id);
      expect((await get(path(id))).json().session.status).toBe('expired');
      expect(calls.filter((call) => call.path.endsWith('queryQRLoginStatus')).length).toBeLessThanOrEqual(90);
      time += 300001; expect((await get(path(id))).statusCode).toBe(404);
      await create();
    });
  });
}
