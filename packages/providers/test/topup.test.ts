import { expect, it } from 'vitest';
import { GenshinTopupClient } from '../src/miyoushe/topup.js';
import { ProbeError } from '../src/miyoushe/errors.js';
import type { Transport } from '../src/miyoushe/client.js';
const session = { accountId: '12345', cookieToken: 'synthetic-private-cookie' }, role = { uid: '123456789', region: 'cn_gf01' as const, nickname: '合成角色' };
const goods = { id: 'synthetic_goods', name: '合成商品', amount: 3000, currency: 'CNY' as const, tier: 'Tier_5', available: true, description: '' };
const response = (data: unknown) => new Response(JSON.stringify({ retcode: 0, data }));
const payment = { orderNo: '1234567890123456789', jwt: 'synthetic-private-jwt', qrUrl: null, expiresAt: null };
it('reads live goods, creates one signed business order, obtains a native code and confirms matching official order status', async () => {
  const calls: string[] = [];
  const transport: Transport = async (url, init) => {
    calls.push(url.pathname); const headers = new Headers(init.headers);
    if (url.pathname.endsWith('getUserGameRolesByCookie')) return response({ list: [
      { game_biz: 'hk4e_cn', game_uid: role.uid, region: 'cn_gf01', nickname: role.nickname },
      { game_biz: 'hk4e_cn', game_uid: '523456789', region: 'cn_qd01' },
      { game_biz: 'hkrpg_cn', game_uid: '123456780', region: 'prod_gf_cn' },
    ] });
    if (url.pathname.endsWith('getTallyProfile')) return response({ top_up_toggle: true, regions: [{ region: 'cn_gf01' }], pay_plat_toggle: [{ toggle: true, pay_type: 'alipay' }, { toggle: true, pay_type: 'wechatpay' }] });
    if (url.pathname.endsWith('listGoodsWeb')) return response({ goods_list: [{ goods_id: goods.id, goods_name: goods.name, goods_desc: '<b>说明</b>', purchase_eligible: true, price: { amount: 3000, currency: 'CNY', tier: goods.tier } }] });
    if (url.pathname.endsWith('createOrder')) {
      const body = JSON.parse(String(init.body)); expect(body.sign).toMatch(/^[a-f0-9]{64}$/);
      expect(body.order).toMatchObject({ amount: 3000, account: '12345', uid: role.uid, region: role.region, pay_plat: 'payment-cn' });
      expect(headers.get('cookie')).toContain(session.cookieToken);
      return response({ account: '12345', goods_id: goods.id, amount: '3000', currency: 'CNY', order_no: payment.orderNo, session_cookie: payment.jwt });
    }
    if (url.pathname.includes('/plutus/')) {
      expect(headers.get('cookie')).toBeNull(); expect(headers.get('x-rpc-payment_token')).toBe(payment.jwt);
      if (url.pathname.endsWith('listPayPlat')) return response({ pay_plats: [{ pay_plat: 'wechatpay', pay_type: 'wechatpay', use_official_qrcode: true }] });
      return response({ url: 'weixin://wxpay/bizpayurl?pr=synthetic', duration: 300 });
    }
    if (url.pathname.endsWith('checkOrder')) return response({ order_no: payment.orderNo, status: 3 });
    throw new Error('Unexpected endpoint');
  };
  const client = new GenshinTopupClient({ transport, now: () => 1000000 });
  expect(await client.roles(session)).toEqual([role]);
  const catalog = await client.catalog(session, role); expect(catalog.methods).toEqual(['alipay', 'wechatpay']); expect(catalog.goods[0]).toMatchObject({ ...goods, description: '说明' });
  const created = await client.createBusinessOrder(session, role, goods), qr = await client.paymentCode(session, created, 'wechatpay');
  expect(qr).toMatchObject({ qrUrl: 'weixin://wxpay/bizpayurl?pr=synthetic', expiresAt: 1300000 });
  expect(await client.status(session, role, qr)).toBe(true); expect(calls.filter((value) => value.endsWith('createOrder'))).toHaveLength(1);
});
it('supports the current official hosted QR token path without exposing the payment JWT', async () => {
  const client = new GenshinTopupClient({ transport: async (url, init) => {
    if (url.pathname.endsWith('listPayPlat')) return response({ pay_plats: [{ pay_plat: 'alipay', pay_type: 'alipay', use_official_qrcode: false, merchant_info: {} }] });
    expect(url.pathname).toBe('/plutus/api/v2/token'); const meta = JSON.parse(Buffer.from(JSON.parse(String(init.body)).meta, 'base64').toString());
    expect(meta.pay_plats).toHaveLength(1); expect(meta.pay_plats[0].pay_type).toBe('alipay'); return response({ token: 'synthetic-code-token', duration: 300 });
  } });
  const result = await client.paymentCode(session, payment, 'alipay'); expect(result.qrUrl).toContain('https://pay.mihoyo.com/hk4e_cn/t/payment/platform/checkout-order/index.html?token=synthetic-code-token');
  expect(result.qrUrl).not.toContain(payment.jwt);
});
it('never retries timed-out mutations or executes returned verification and foreign URLs', async () => {
  let calls = 0; const client = new GenshinTopupClient({ transport: async () => { calls++; throw new Error('synthetic lost response'); } });
  await expect(client.createBusinessOrder(session, role, goods)).rejects.toBeInstanceOf(ProbeError); expect(calls).toBe(1);
  for (const data of [{ need_verify: true }, { url: 'https://evil.example/pay', duration: 300 }]) {
    const invalid = new GenshinTopupClient({ transport: async (url) => url.pathname.endsWith('listPayPlat') ? response({ pay_plats: [{ pay_type: 'alipay', use_official_qrcode: true }] }) : response(data) });
    await expect(invalid.paymentCode(session, payment, 'alipay')).rejects.toBeInstanceOf(ProbeError);
  }
});
