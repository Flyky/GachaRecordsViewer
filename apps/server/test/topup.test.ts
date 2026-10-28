import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bindInstallation, type PaymentRow } from '@gacha/db';
import { ProbeError, type RechargeGoods } from '@gacha/providers';
import { temporaryDirectory, sql } from '../../../packages/db/test/helpers.js';
import { initializeDeployment } from '../src/deployment.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/security.js';

const origin = 'https://topup.example.test', prefix = '/gacha/api/community/topup';
type Session = { cookie: string; 'x-csrf-token': string };
let fixture: Awaited<ReturnType<typeof temporaryDirectory>>, deployment: Awaited<ReturnType<typeof initializeDeployment>>, app: Awaited<ReturnType<typeof buildApp>>;
let a: Session, b: Session, account: string, time: number, creates: number, codes: number, paid: boolean, mode: 'good' | 'lost-create' | 'lost-code', amount: number;
let createGate: Promise<void> | undefined;
const goods = (): RechargeGoods => ({ id: 'test_goods', name: '合成充值商品', amount, currency: 'CNY', tier: 'Tier_5', available: true, description: '' });
const open = async () => {
  deployment = await initializeDeployment({ dataDirectory: fixture.directory, env: {} });
  app = await buildApp({ database: deployment.connection, auth: { connection: deployment.connection, credentialKey: deployment.credentialKey,
    adminPassword: deployment.config.adminPassword, adminSessionVersion: deployment.adminSessionVersion, publicUrl: `${origin}/gacha/`, now: () => time }, community: {
    client: () => ({ getCookieToken: async () => 'private-cookie', getLToken: async () => 'private-ltoken', verifyLToken: async () => ({ accountId: '12345', mid: 'synthetic-mid' }),
      listRoles: async () => [{ uid: '123456789', region: 'cn_gf01', gameBiz: 'hk4e_cn' }], generateAuthKey: async () => 'unused' }),
    topup: { client: () => ({ getCookieToken: async () => 'private-cookie', roles: async () => [{ uid: '123456789', region: 'cn_gf01', nickname: '合成角色' }],
      catalog: async () => ({ goods: [goods()], methods: ['alipay', 'wechatpay'] }),
      createBusinessOrder: async () => { creates++; if (mode === 'lost-create') throw new ProbeError('network', 'topup'); if (createGate) await createGate; return { orderNo: '9007199254740993001', jwt: 'synthetic-private-payment-jwt', qrUrl: null, expiresAt: null }; },
      paymentCode: async (_session, payment) => { codes++; if (mode === 'lost-code') throw new ProbeError('network', 'topup'); return { ...payment, qrUrl: 'https://qr.alipay.com/synthetic-private-qr', expiresAt: time + 300000 }; },
      status: async () => paid,
    }) },
  } });
};
const post = (path: string, body: object, session = a) => app.inject({ method: 'POST', url: path, payload: body, headers: { origin, ...session } });
const list = (session = a) => app.inject({ url: `${prefix}/orders`, headers: session });
const quote = async () => {
  const response = await post(`${prefix}/quote`, { communityAccountId: account, uid: '123456789', goodsId: 'test_goods', method: 'alipay' });
  expect(response.statusCode).toBe(200); return response.json();
};
const create = (quoteId: string, requestId = randomUUID()) => post(`${prefix}/orders`, { quoteId, requestId });
beforeEach(async () => {
  time = Date.now(); creates = 0; codes = 0; paid = false; mode = 'good'; amount = 3000; createGate = undefined; fixture = await temporaryDirectory(); await open();
  const passwordHash = await hashPassword('12345678');
  for (const id of ['a', 'b']) await deployment.repositories.users.create({ id, username: `topup_${id}`, passwordHash });
  for (const id of ['a', 'b']) {
    const login = await post('/gacha/api/auth/login', { username: `topup_${id}`, password: '12345678' }, {} as Session);
    const session = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
    if (id === 'a') a = session; else b = session;
  }
  const response = await post('/gacha/api/community/accounts', { input: JSON.stringify({ accountId: '12345', cookieToken: 'synthetic-private-cookie' }) });
  expect(response.statusCode).toBe(201); account = response.json().account.id;
});
afterEach(async () => { await app?.close(); deployment?.credentialKey.fill(0); await fixture?.cleanup(); });

it('requires own credentials and CSRF, refuses supplied amounts and prevents channel/foreign role selection', async () => {
  expect((await app.inject(`${prefix}/orders`)).statusCode).toBe(401);
  expect((await post(`${prefix}/catalog`, { communityAccountId: account }, b)).statusCode).toBe(404);
  expect((await post(`${prefix}/catalog`, { communityAccountId: account }, { cookie: a.cookie } as Session)).statusCode).toBe(403);
  expect((await post(`${prefix}/catalog`, { communityAccountId: account, uid: '523456789' })).statusCode).toBe(422);
  expect((await post(`${prefix}/quote`, { communityAccountId: account, uid: '123456789', goodsId: 'test_goods', method: 'alipay', amount: 1 })).statusCode).toBe(400);
  expect(creates).toBe(0);
});
it('creates once per confirmation, persists encrypted payment data and restores pending codes after restart', async () => {
  const preview = await quote(), requestId = randomUUID();
  const first = await create(preview.id, requestId); expect(first.statusCode).toBe(200); expect(first.json().order.status).toBe('pending');
  expect((await create(preview.id, requestId)).json().order.id).toBe(requestId); expect(creates).toBe(1); expect(codes).toBe(1);
  const rows = await deployment.connection.executor.query<PaymentRow>(sql`SELECT * FROM payment_orders`);
  expect(rows[0]!.encrypted_value).toBeTruthy(); expect(JSON.stringify(rows)).not.toMatch(/synthetic-private-payment-jwt|synthetic-private-qr|synthetic-private-cookie/);
  expect((await list(b)).json().orders).toEqual([]);
  expect((await post(`${prefix}/orders/${requestId}/check`, {}, b)).statusCode).toBe(404);
  await app.close(); deployment.credentialKey.fill(0); await open();
  const restored = (await list()).json().orders[0]; expect(restored).toMatchObject({ id: requestId, status: 'pending', qrUrl: 'https://qr.alipay.com/synthetic-private-qr' });
  expect(JSON.stringify(restored)).not.toContain('synthetic-private-payment-jwt');
  paid = true; expect((await post(`${prefix}/orders/${requestId}/check`, {})).json().order).toMatchObject({ status: 'paid', qrUrl: null });
  expect((await deployment.connection.executor.query<PaymentRow>(sql`SELECT * FROM payment_orders`))[0]!.encrypted_value).toBeNull();
});
it('retains an uncertain mutation without retrying and blocks a second order until explicit local archive', async () => {
  mode = 'lost-create'; const preview = await quote(), requestId = randomUUID();
  expect((await create(preview.id, requestId)).json().order.status).toBe('unknown');
  expect((await create(preview.id, requestId)).json().order.status).toBe('unknown'); expect(creates).toBe(1);
  const next = await quote(); expect((await create(next.id)).json().error.code).toBe('TOPUP_PENDING_ORDER'); expect(creates).toBe(1);
  expect((await post(`${prefix}/orders/${requestId}/archive`, {})).json().order.status).toBe('archived');
  mode = 'good'; const fresh = await quote(); expect((await create(fresh.id)).json().order.status).toBe('pending'); expect(creates).toBe(2);
});
it('rejects stale prices and expiry before ordering, then recovers a lost cashier response using read-only order checks', async () => {
  const first = await quote(); amount = 6000; expect((await create(first.id)).json().error.code).toBe('TOPUP_QUOTE_CHANGED'); expect(creates).toBe(0);
  const second = await quote(); time += 300001; expect((await create(second.id)).json().error.code).toBe('TOPUP_QUOTE_EXPIRED'); expect(creates).toBe(0);
  const third = await quote(); mode = 'lost-code'; const response = await create(third.id); expect(response.json().order.status).toBe('unknown');
  paid = true; expect((await post(`${prefix}/orders/${response.json().order.id}/check`, {})).json().order.status).toBe('paid'); expect(creates).toBe(1); expect(codes).toBe(1);
});
it('prevents key rebinding when payment secrets remain even after community credentials are removed', async () => {
  const preview = await quote(); await create(preview.id);
  await deployment.connection.executor.execute(sql`DELETE FROM credentials`);
  const [state] = await deployment.connection.executor.query<{ installation_id: string; admin_fingerprint: string }>(sql`SELECT * FROM app_state`);
  await expect(bindInstallation(deployment.connection, { installationId: state!.installation_id, adminFingerprint: state!.admin_fingerprint, keyFingerprint: 'different-key' })).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
});
async function administrator() {
  const login = await post('/gacha/api/admin/login', { username: 'admin', password: deployment.config.adminPassword }, {} as Session);
  return { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
}
it('persists administrator visibility and blocks disabled top-up APIs while retaining order check and archive access', async () => {
  const admin = await administrator();
  const setting = '/gacha/api/admin/features/genshin-topup';
  expect((await app.inject({ url: '/gacha/api/features', headers: a })).json().genshinTopup).toBe(true);
  expect((await app.inject('/gacha/api/features')).statusCode).toBe(401);
  expect((await post(setting, { enabled: false }, a)).statusCode).toBe(401);
  expect((await post(setting, { enabled: false }, { cookie: admin.cookie } as Session)).statusCode).toBe(403);
  expect((await post(setting, { enabled: 'false' }, admin)).statusCode).toBe(400);
  const first = await quote(), order = (await create(first.id)).json().order;
  const second = await quote();
  expect((await post(setting, { enabled: false }, admin)).json().genshinTopup).toBe(false);
  expect((await post(`${prefix}/catalog`, { communityAccountId: account })).json().error.code).toBe('TOPUP_DISABLED');
  expect((await post(`${prefix}/quote`, { communityAccountId: account, uid: '123456789', goodsId: 'test_goods', method: 'alipay' })).json().error.code).toBe('TOPUP_DISABLED');
  expect((await create(second.id)).json().error.code).toBe('TOPUP_DISABLED'); expect(creates).toBe(1);
  expect((await post(`${prefix}/orders/${order.id}/check`, {})).json().order.status).toBe('pending');
  expect((await post(`${prefix}/orders/${order.id}/archive`, {})).json().order.status).toBe('archived');
  await app.close(); deployment.credentialKey.fill(0); await open();
  expect((await app.inject({ url: '/gacha/api/features', headers: a })).json().genshinTopup).toBe(false);
  expect((await post(setting, { enabled: true }, admin)).json().genshinTopup).toBe(true);
  expect((await post(`${prefix}/catalog`, { communityAccountId: account })).statusCode).toBe(200);
});
it('does not start a cashier request when the administrator disables an order already in flight', async () => {
  const admin = await administrator(), preview = await quote(); let release!: () => void;
  createGate = new Promise<void>((resolve) => { release = resolve; });
  const request = Promise.resolve(create(preview.id));
  try {
    await expect.poll(() => creates, { timeout: 3000, interval: 10 }).toBe(1);
    expect((await post('/gacha/api/admin/features/genshin-topup', { enabled: false }, admin)).statusCode).toBe(200);
  } finally { release(); }
  const result = await request;
  expect(result.json().order).toMatchObject({ status: 'unknown', code: 'TOPUP_DISABLED' }); expect(codes).toBe(0);
});
