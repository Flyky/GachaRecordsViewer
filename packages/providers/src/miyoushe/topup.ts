import { createHmac } from 'node:crypto';
import { MiyousheClient, object, type Credentials, type Transport } from './client.js';
import { GameCheckinClient, type CheckinSession } from './checkin.js';
import { createDevice, cookieHeader, type DeviceContext } from './protocol.js';
import { ProbeError, upstreamError } from './errors.js';

export type PayMethod = 'alipay' | 'wechatpay';
export interface RechargeRole { uid: string; region: 'cn_gf01'; nickname: string }
export interface RechargeGoods { id: string; name: string; amount: number; currency: 'CNY'; tier: string; available: boolean; description: string }
export type RechargeSession = CheckinSession;
export interface RechargePayment { orderNo: string; jwt: string; qrUrl: string | null; expiresAt: number | null }
interface Options { transport?: Transport; device?: DeviceContext; timeoutMs?: number; signal?: AbortSignal; now?: () => number }
const base = 'https://topup-api-sdk.mihoyo.com/hk4e_cn', cashier = 'https://api-payment.mihoyo.com/plutus/api/v2';
const identifier = (value: unknown) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new ProbeError('protocol', 'topup'); return value; };
const text = (value: unknown, max = 2048) => { if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) throw new ProbeError('protocol', 'topup'); return value; };
function checkQr(value: unknown) {
  const input = text(value, 16000); let url: URL;
  try { url = new URL(input); } catch { throw new ProbeError('protocol', 'topup_qr'); }
  if (url.username || url.password || url.port || !(url.protocol === 'weixin:' && url.hostname === 'wxpay'
    || url.protocol === 'https:' && (['qr.alipay.com', 'pay.mihoyo.com', 'mhy.link'].includes(url.hostname)))) throw new ProbeError('protocol', 'topup_qr');
  return url.href;
}
/** Official CN top-up web 2.58.0 protocol. Never retries a mutation or follows returned URLs. */
export class GenshinTopupClient {
  private readonly transport: Transport;
  private readonly device: DeviceContext;
  constructor(private readonly options: Options = {}) { this.transport = options.transport ?? fetch; this.device = options.device ?? createDevice(); }
  getCookieToken(credentials: Credentials) { return new MiyousheClient(this.options).getCookieToken(credentials); }
  async roles(session: RechargeSession): Promise<RechargeRole[]> {
    const roles = await new GameCheckinClient({ ...this.options, device: this.device }).listRoles(session);
    return roles.filter((role) => role.gameBiz === 'hk4e_cn' && role.region === 'cn_gf01').map((role) => ({ uid: role.uid, region: 'cn_gf01', nickname: role.nickname ?? `UID ${role.uid}` }));
  }
  private async request(url: URL, session: RechargeSession, body?: unknown, jwt?: string) {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15000), signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      Origin: 'https://pay.mihoyo.com', Referer: 'https://pay.mihoyo.com/ys/index.html', 'x-rpc-client_type': '4', 'x-rpc-trade_type': '3',
      'x-rpc-device_id': this.device.id, 'x-rpc-device_fp': this.device.fingerprint, 'x-rpc-game_biz': 'hk4e_cn', 'x-rpc-language': 'zh-cn', 'x-rpc-combo_version': '2.58.0',
      'x-rpc-routing-account': session.accountId, 'x-rpc-routing-biz': 'hk4e_cn' };
    if (jwt) Object.assign(headers, { 'x-rpc-payment_token': text(jwt, 16000), 'x-rpc-app_id': 'cvyu94rfjfgg', 'x-rpc-payment_version': '2.58.0', 'x-rpc-lifecycle_id': this.device.id });
    else headers.Cookie = cookieHeader({ account_id: session.accountId, cookie_token: session.cookieToken, ...(session.mid ? { account_mid_v2: session.mid } : {}) });
    try {
      const response = await this.transport(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error' });
      if (response.headers.has('x-rpc-aigis')) throw new ProbeError('verification_required', 'topup');
      if (!response.ok) throw new ProbeError('upstream', 'topup', response.status);
      if (!response.body) throw new ProbeError('protocol', 'topup');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > 2 * 1024 * 1024) throw new ProbeError('protocol', 'topup'); chunks.push(result.value); } }
      catch (error) { await reader.cancel().catch(() => undefined); throw error; } finally { reader.releaseLock(); }
      const envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'topup');
      if (typeof envelope.retcode !== 'number') throw new ProbeError('protocol', 'topup');
      if (envelope.retcode !== 0) throw upstreamError('topup', envelope.retcode);
      const data = object(envelope.data, 'topup');
      if (data.need_verify || data.need_realperson || data.risk_code) throw new ProbeError('verification_required', 'topup');
      return data;
    } catch (error) {
      if (error instanceof ProbeError) throw error;
      throw new ProbeError(this.options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : error instanceof SyntaxError ? 'protocol' : 'network', 'topup');
    }
  }
  async catalog(session: RechargeSession, role: RechargeRole): Promise<{ goods: RechargeGoods[]; methods: PayMethod[] }> {
    const config = await this.request(new URL(`${base}/mdk/tally/tally/getTallyProfile`), session, { game: 'hk4e_cn', released_flag: true, condi: { cashier_mode: 'payment-cn', currency_by_ip: false } });
    if (config.top_up_toggle !== true || object(config.maintenance_info ?? {}, 'topup').maintenance_ongoing === true) throw new ProbeError('upstream', 'topup_closed');
    if (!Array.isArray(config.regions) || !config.regions.some((value) => object(value, 'topup').region === role.region)) throw new ProbeError('role_mismatch', 'topup');
    const methods = [...new Set((Array.isArray(config.pay_plat_toggle) ? config.pay_plat_toggle : []).map((value) => object(value, 'topup'))
      .filter((value) => value.toggle === true && ['alipay', 'wechatpay'].includes(String(value.pay_type))).map((value) => value.pay_type as PayMethod))];
    const url = new URL(`${base}/mm-backpack/v1/listGoodsWeb`); url.search = new URLSearchParams({ biz: 'hk4e_cn', region: role.region }).toString();
    const data = await this.request(url, session);
    if (!Array.isArray(data.goods_list) || data.goods_list.length > 256) throw new ProbeError('protocol', 'topup_goods');
    const goods = data.goods_list.map((value): RechargeGoods => {
      const item = object(value, 'topup_goods'), price = object(item.price, 'topup_goods');
      if (price.currency !== 'CNY' || !Number.isSafeInteger(price.amount) || Number(price.amount) <= 0 || Number(price.amount) > 10000000) throw new ProbeError('protocol', 'topup_goods');
      const count = Number(object(item.virtual_currency ?? {}, 'topup_goods').count ?? 0);
      const name = `${Number.isSafeInteger(count) && count > 0 ? count : ''}${text(item.goods_name)}`;
      return { id: identifier(item.goods_id), name, amount: Number(price.amount), currency: 'CNY', tier: identifier(String(price.tier)),
        available: item.purchase_eligible === true, description: typeof item.goods_desc === 'string' ? item.goods_desc.replace(/<[^>]*>/g, '').slice(0, 2048) : '' };
    });
    if (new Set(goods.map((item) => item.id)).size !== goods.length) throw new ProbeError('protocol', 'topup_goods');
    return { goods, methods };
  }
  async createBusinessOrder(session: RechargeSession, role: RechargeRole, goods: RechargeGoods): Promise<RechargePayment> {
    const order: Record<string, string | number> = { account: session.accountId, region: role.region, uid: role.uid, delivery_url: '', device: this.device.id,
      channel_id: 1, client_ip: '', client_type: 4, game: 'hk4e_cn', amount: goods.amount, goods_num: 1, currency: 'CNY', pay_plat: 'payment-cn',
      goods_id: goods.id, goods_title: goods.name, price_tier: goods.tier };
    const sign = createHmac('sha256', '6bdc3982c25f3f3c38668a32d287d16b').update(Object.keys(order).sort().map((key) => order[key] ? String(order[key]) : '').join('')).digest('hex');
    const data = await this.request(new URL(`${base}/mdk/atropos/api/createOrder`), session, { cashier_mode: 'payment-cn', special_info: 'topup_center',
      order: { ...order, goods_plat: JSON.stringify({ enabled: true }) }, sign });
    if (String(data.account) !== session.accountId || String(data.goods_id) !== goods.id || Number(data.amount) !== goods.amount || data.currency !== 'CNY') throw new ProbeError('protocol', 'topup_order');
    return { orderNo: identifier(data.order_no), jwt: text(data.session_cookie, 16000), qrUrl: null, expiresAt: null };
  }
  async paymentCode(session: RechargeSession, payment: RechargePayment, method: PayMethod): Promise<RechargePayment> {
    const url = new URL(`${cashier}/listPayPlat`); url.searchParams.set('disable_market', 'true');
    const data = await this.request(url, session, undefined, payment.jwt);
    if (!Array.isArray(data.pay_plats)) throw new ProbeError('protocol', 'topup_methods');
    const plat = data.pay_plats.map((value) => object(value, 'topup_methods')).find((value) => value.pay_type === method);
    if (!plat) throw new ProbeError('upstream', 'topup_method_unavailable');
    let code: Record<string, unknown>, qr: string;
    if (plat.use_official_qrcode === true) {
      code = await this.request(new URL(`${cashier}/checkout`), session, { payment: { pay_plat: plat.pay_plat, pay_type: method,
        market_id: plat.market_id, real_cashier_id: plat.real_cashier_id, use_official_qrcode: true } }, payment.jwt);
      qr = checkQr(code.url);
    } else {
      const meta = { showCode: '', lang: 'zh-cn', cashier_type: 'h5', pay_plats: [{ pay_plat: plat.pay_plat, pay_type: method,
        market_id: plat.market_id, real_cashier_id: plat.real_cashier_id, id: object(plat.merchant_info ?? {}, 'topup').official_account_id,
        merchant_id: object(plat.merchant_info ?? {}, 'topup').merchant_id }], pay_env: '4', game_biz: 'hk4e_cn', sdk_version: '2.58.0', lifecycle_id: this.device.id };
      code = await this.request(new URL(`${cashier}/token`), session, { meta: Buffer.from(JSON.stringify(meta)).toString('base64') }, payment.jwt);
      const token = text(code.token, 16000), output = new URL('https://pay.mihoyo.com/hk4e_cn/t/payment/platform/checkout-order/index.html');
      output.searchParams.set('token', token); output.searchParams.set('from', method);
      if (method === 'wechatpay') output.searchParams.set('wxapp_id', String(object(plat.merchant_info ?? {}, 'topup').official_account_id ?? ''));
      qr = checkQr(output.href);
    }
    const seconds = Number(code.expire), duration = Number(code.duration), now = (this.options.now ?? Date.now)();
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= now / 1000) throw new ProbeError('expired', 'topup_qr');
    const expiresAt = Number.isFinite(seconds) && seconds > now / 1000 ? seconds * 1000 : Number.isFinite(duration) && duration > 0 ? now + duration * 1000 : now + 300000;
    return { ...payment, qrUrl: qr, expiresAt: Math.min(expiresAt, now + 15 * 60000) };
  }
  async status(session: RechargeSession, role: RechargeRole, payment: RechargePayment): Promise<boolean> {
    const url = new URL(`${base}/mdk/atropos/api/checkOrder`); url.search = new URLSearchParams({ uid: role.uid, region: role.region, order_no: payment.orderNo, game: 'hk4e_cn' }).toString();
    const data = await this.request(url, session);
    if (String(data.order_no) !== payment.orderNo || !Number.isInteger(data.status)) throw new ProbeError('protocol', 'topup_status');
    return [3, 900].includes(Number(data.status));
  }
}
