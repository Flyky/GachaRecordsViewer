import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameCheckinClient, MiyousheClient, type Transport } from '@gacha/providers';
import { repositories, uigfRepository } from '@gacha/db';
import { decodeUigf } from '@gacha/uigf';
import type { CheckinJob, WishLinkJob } from '@gacha/contracts';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { pull, sample } from '../../../packages/uigf/test/fixtures.js';
import { buildApp } from '../src/app.js';
import { initializeDeployment } from '../src/deployment.js';
import { hashPassword } from '../src/auth/security.js';
type Session = { cookie: string; 'x-csrf-token': string };
const prefix = '/gacha/api', origin = 'https://operations.example.test';
const url = 'https://webstatic.mihoyo.com/wish?auth_appid=webview_gacha&authkey=synthetic-private-authkey&game_biz=hk4e_cn';
describe('owned check-in batches and wish-link import', () => {
  let directory: Awaited<ReturnType<typeof temporaryDirectory>>, deployment: Awaited<ReturnType<typeof initializeDeployment>>, app: Awaited<ReturnType<typeof buildApp>>;
  let a: Session, b: Session, admin: Session, logs: string, signCalls: string[], signed: Set<string>, mode: 'good' | 'challenge' | 'uncertain' | 'expired';
  let pageGate: Promise<void> | undefined, onPage: (() => void) | undefined;
  const response = (data: unknown, retcode = 0) => new Response(JSON.stringify({ retcode, data }));
  const transport: Transport = async (upstream, init) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    const cookie = new Headers(init.headers).get('cookie') ?? '', accountId = /account_id=(\d+)/.exec(cookie)?.[1];
    if (upstream.pathname.endsWith('getCookieAccountInfoBySToken')) {
      const id = upstream.searchParams.get('stoken')!.replace('s-', ''); return response({ uid: id, cookie_token: `cookie-${id}` });
    }
    if (upstream.pathname.endsWith('getUserGameRolesByCookie')) return response({ list: accountId === '12345' ? [
      { game_biz: 'hk4e_cn', game_uid: '123456789', region: 'cn_gf01' }, { game_biz: 'hk4e_cn', game_uid: '523456789', region: 'cn_qd01' },
      { game_biz: 'hkrpg_cn', game_uid: '100000001', region: 'prod_gf_cn' }, { game_biz: 'nap_cn', game_uid: '100000002', region: 'prod_gf_cn' },
      { game_biz: 'bh3_cn', game_uid: '100000003', region: 'android01' },
    ] : accountId === '12346' ? [{ game_biz: 'hkrpg_cn', game_uid: '100000004', region: 'prod_gf_cn' }] : [] });
    if (upstream.pathname.endsWith('/info')) return response({ is_sign: signed.has(upstream.searchParams.get('uid')!), first_bind: false });
    if (upstream.pathname.endsWith('/sign')) {
      signCalls.push(body.uid!);
      if (mode === 'challenge' && body.uid === '523456789') return response({ success: 1, gt: 'private-challenge', challenge: 'private-challenge' });
      signed.add(body.uid!);
      if (mode === 'uncertain') throw new Error('synthetic lost POST response');
      return response({ success: 0 });
    }
    if (upstream.pathname.endsWith('/getGachaLog')) {
      if (mode === 'expired') return response(null, -3501);
      if (upstream.searchParams.get('gacha_type') !== '301' || upstream.searchParams.get('end_id') !== '0') return response({ list: [] });
      onPage?.(); if (pageGate) await pageGate;
      return response({ list: [{ uid: '123456789', id: '9007199254740993002', item_id: '', name: '迪卢克', item_type: '角色', rank_type: '5', count: '1', gacha_type: '400', time: '2026-10-28 12:00:01' },
        { uid: '123456789', id: '9007199254740993001', item_id: '11301', name: '冷刃', item_type: '武器', rank_type: '3', count: '1', gacha_type: '301', time: '2026-10-28 12:00:00' }] });
    }
    throw new Error('Unexpected synthetic endpoint');
  };
  const post = (path: string, payload: object, session = a) => app.inject({ method: 'POST', url: `${prefix}${path}`, payload, headers: { origin, ...session } });
  const get = (path: string, session = a) => app.inject({ url: `${prefix}${path}`, headers: { cookie: session.cookie } });
  async function finished<T extends CheckinJob | WishLinkJob>(path: string, session = a) {
    let job!: T;
    await expect.poll(async () => { job = (await get(`${path}/job`, session)).json().job as T; return job && !['queued', 'running'].includes(job.status); }, { timeout: 5000, interval: 10 }).toBe(true);
    return job;
  }
  beforeEach(async () => {
    directory = await temporaryDirectory(); logs = ''; signed = new Set(); signCalls = []; mode = 'good'; pageGate = undefined; onPage = undefined;
    deployment = await initializeDeployment({ dataDirectory: directory.directory, env: { PUBLIC_URL: `${origin}/gacha/` } });
    const passwordHash = await hashPassword('12345678');
    for (const id of ['a', 'b']) await deployment.repositories.users.create({ id, username: `operations_${id}`, passwordHash });
    app = await buildApp({ database: deployment.connection, logger: { stream: new Writable({ write(chunk, _encoding, callback) { logs += String(chunk); callback(); } }) },
      auth: { connection: deployment.connection, credentialKey: deployment.credentialKey, publicUrl: deployment.config.publicUrl, adminPassword: deployment.config.adminPassword, adminSessionVersion: deployment.adminSessionVersion },
      community: { client: () => ({ getCookieToken: async (credential) => `cookie-${credential.accountId}`, getLToken: async (credential) => `l-${credential.accountId}`,
        verifyLToken: async (accountId) => ({ accountId, mid: `m-${accountId}` }), listRoles: async () => [], generateAuthKey: async () => 'unused' }),
        checkin: { client: (device, signal) => new GameCheckinClient({ device, signal, transport }), wait: async () => undefined } },
      wishLink: { client: (signal) => new MiyousheClient({ signal, transport }), wait: async () => undefined },
    });
    const login = async (kind: string, username: string, password: string) => {
      const res = await app.inject({ method: 'POST', url: `${prefix}/${kind}/login`, payload: { username, password }, headers: { origin } });
      expect(res.statusCode).toBe(200); return { cookie: String(res.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': res.json().csrfToken as string };
    };
    a = await login('auth', 'operations_a', '12345678'); b = await login('auth', 'operations_b', '12345678'); admin = await login('admin', 'admin', deployment.config.adminPassword);
    for (const [session, accountId] of [[a, '12345'], [a, '12346'], [b, '99999']] as const) {
      expect((await post('/community/accounts', { input: JSON.stringify({ accountId, mid: `m-${accountId}`, stoken: `s-${accountId}` }) }, session)).statusCode).toBe(201);
    }
  });
  afterEach(async () => { await app?.close(); deployment?.credentialKey.fill(0); await directory.cleanup(); });

  it('signs all three supported games and multiple roles/accounts, isolates owners and skips repeated daily submissions', async () => {
    expect((await post('/community/checkin/jobs', {}, admin)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${prefix}/community/checkin/jobs`, payload: {}, headers: { origin, cookie: a.cookie } })).statusCode).toBe(403);
    expect((await post('/community/checkin/jobs', {})).statusCode).toBe(202);
    const job = await finished<CheckinJob>('/community/checkin');
    expect(job.status).toBe('completed'); expect(job.accountsTotal).toBe(2); expect(job.results).toHaveLength(5);
    expect(new Set(job.results.map((row) => row.game))).toEqual(new Set(['hk4e_cn', 'hkrpg_cn', 'nap_cn']));
    expect(job.results.every((row) => row.status === 'signed')).toBe(true);
    expect((await get('/community/checkin/job', b)).json().job).toBeNull();
    expect((await post('/community/checkin/job/cancel', {}, b)).statusCode).toBe(404);
    expect((await post('/community/checkin/jobs', {})).statusCode).toBe(202);
    expect((await finished<CheckinJob>('/community/checkin')).results.every((row) => row.status === 'already_signed')).toBe(true);
    expect(signCalls).toHaveLength(5); expect(logs).not.toMatch(/cookie-12345|s-12345|private-challenge/);
  });
  it('reports human verification without retries and recovers a lost sign response by checking status', async () => {
    mode = 'challenge'; await post('/community/checkin/jobs', {});
    const first = await finished<CheckinJob>('/community/checkin');
    expect(first.status).toBe('partial'); expect(first.results.find((row) => row.uid === '523456789')!.status).toBe('verification_required');
    expect(signCalls.filter((uid) => uid === '523456789')).toHaveLength(1);
    mode = 'uncertain'; await post('/community/checkin/jobs', {});
    const next = await finished<CheckinJob>('/community/checkin');
    expect(next.status).toBe('completed'); expect(next.results.find((row) => row.uid === '523456789')!.status).toBe('signed');
    expect(signCalls.filter((uid) => uid === '523456789')).toHaveLength(2);
  });
  it('imports without Miyoushe binding, merges existing UIGF history, deduplicates and keeps secrets out of responses/logs', async () => {
    const input = decodeUigf(sample('v4.1', [pull('9007199254740993000', { time: '2025-01-01 12:00:00' })]));
    const repo = uigfRepository(deployment.connection); await repo.import('a', input, [0], await repo.preview('a', input), 'synthetic');
    expect((await post('/wish-link/jobs', { url: url.replace('webstatic.mihoyo.com', 'evil.example'), region: 'cn_gf01' })).statusCode).toBe(400);
    expect((await post('/wish-link/jobs', { url, region: 'os_asia' })).statusCode).toBe(400);
    expect((await post('/wish-link/jobs', { url, region: 'cn_gf01' })).statusCode).toBe(202);
    const first = await finished<WishLinkJob>('/wish-link');
    expect(first.status).toBe('completed'); expect(first.uid).toBe('123456789'); expect(first.pools.reduce((sum, pool) => sum + pool.inserted, 0)).toBe(2);
    expect(await repositories(deployment.connection).records.count('a', first.profileId!)).toBe(3);
    expect((await get('/wish-link/job', b)).json().job).toBeNull(); expect(JSON.stringify(first)).not.toContain('authkey');
    await post('/wish-link/jobs', { url, region: 'cn_gf01' }); const again = await finished<WishLinkJob>('/wish-link');
    expect(again.pools.reduce((sum, pool) => sum + pool.inserted, 0)).toBe(0); expect(again.pools.reduce((sum, pool) => sum + pool.duplicates, 0)).toBe(2);
    expect((await get(`/profiles/${first.profileId}/records`)).json().total).toBe(3);
    expect(logs).not.toContain('synthetic-private-authkey');
  });
  it('rejects expired links and discards cancelled late pages without touching another owner', async () => {
    mode = 'expired'; await post('/wish-link/jobs', { url, region: 'cn_gf01' });
    const expired = await finished<WishLinkJob>('/wish-link'); expect(expired.status).toBe('failed'); expect(expired.pools[0]!.code).toBe('MIYOUSHE_EXPIRED');
    mode = 'good'; let release!: () => void;
    pageGate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { onPage = resolve; });
    await post('/wish-link/jobs', { url, region: 'cn_gf01' }); await started;
    try { expect((await post('/wish-link/jobs', { url, region: 'cn_gf01' })).statusCode).toBe(409); await post('/wish-link/job/cancel', {}); }
    finally { release(); }
    expect((await finished<WishLinkJob>('/wish-link')).status).toBe('cancelled');
    expect((await get('/profiles')).json().profiles).toHaveLength(0); expect((await get('/profiles', b)).json().profiles).toHaveLength(0);
  });
});
