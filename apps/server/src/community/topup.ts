import { randomUUID } from 'node:crypto';
import type { TopupCatalog, TopupMethod, TopupOrder, TopupQuote } from '@gacha/contracts';
import { paymentRepository, type DatabaseConnection, type PaymentRow } from '@gacha/db';
import { GenshinTopupClient, type DeviceContext, type RechargePayment, type RechargeSession } from '@gacha/providers';
import type { communityService } from './service.js';
import { CredentialVault } from './vault.js';
import { ApiError } from '../auth/security.js';
import { operationCode } from '../tasks.js';

type Client = Pick<GenshinTopupClient, 'roles' | 'getCookieToken' | 'catalog' | 'createBusinessOrder' | 'paymentCode' | 'status'>;
export interface TopupOptions { client?: (device: DeviceContext, signal: AbortSignal) => Client }
interface PrivateOrder { revision: string; payment: RechargePayment }
export function topupService(connection: DatabaseConnection, key: Buffer, community: ReturnType<typeof communityService>, options: TopupOptions = {}, now = Date.now) {
  const repo = paymentRepository(connection), vault = new CredentialVault(key), quotes = new Map<string, { owner: string; revision: string; quote: TopupQuote }>();
  const running = new Set<string>(), controllers = new Set<AbortController>(), tasks = new Set<Promise<unknown>>(); let closed = false;
  const timestamp = () => new Date(now()).toISOString();
  function run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closed) throw new ApiError(503, 'TOPUP_UNAVAILABLE');
    if (controllers.size >= 32) throw new ApiError(429, 'TOPUP_BUSY');
    const controller = new AbortController(); controllers.add(controller);
    const task = work(controller.signal); tasks.add(task);
    return task.finally(() => { controllers.delete(controller); tasks.delete(task); });
  }
  async function prepare(owner: string, account: string, signal: AbortSignal) {
    const saved = await community.storedCredentials(owner, account), client = options.client?.(saved.device, signal) ?? new GenshinTopupClient({ device: saved.device, signal, now });
    async function check<T>(work: () => Promise<T>) {
      signal.throwIfAborted(); if ((await community.target(owner, account)).revision !== saved.revision) throw new ApiError(409, 'CREDENTIALS_CHANGED');
      const result = await work(); signal.throwIfAborted();
      if ((await community.target(owner, account)).revision !== saved.revision) throw new ApiError(409, 'CREDENTIALS_CHANGED'); return result;
    }
    let cookieToken = saved.credentials.cookieToken;
    const { accountId, stoken, mid, ltoken } = saved.credentials;
    if (!cookieToken && stoken && mid) cookieToken = await check(() => client.getCookieToken({ accountId, stoken, mid }));
    if (!cookieToken) throw new ApiError(422, 'COOKIE_TOKEN_REQUIRED');
    const session: RechargeSession = { accountId, cookieToken, ...(mid ? { mid } : {}), ...(ltoken ? { ltoken } : {}) };
    return { client, session, revision: saved.revision, check };
  }
  async function catalog(owner: string, account: string, uid: string | undefined, signal: AbortSignal) {
    const context = await prepare(owner, account, signal), roles = await context.check(() => context.client.roles(context.session));
    const role = uid ? roles.find((entry) => entry.uid === uid) : roles[0];
    if (uid && !role) throw new ApiError(422, 'TOPUP_ROLE_NOT_AVAILABLE');
    const data = role ? await context.check(() => context.client.catalog(context.session, role)) : { goods: [], methods: [] };
    return { context, role, catalog: { roles, uid: role?.uid ?? null, ...data } satisfies TopupCatalog };
  }
  const seal = (owner: string, id: string, value: PrivateOrder) => vault.seal(value, owner, `topup:${id}`, id);
  const open = (owner: string, row: PaymentRow) => row.encrypted_value ? vault.open<PrivateOrder>(row.encrypted_value, owner, `topup:${row.id}`, row.id) : null;
  async function publicOrder(owner: string, row: PaymentRow): Promise<TopupOrder> {
    const order: TopupOrder = { ...JSON.parse(row.public_json) as TopupOrder, status: row.status as TopupOrder['status'], qrUrl: null, updatedAt: row.updated_at };
    if (order.status === 'creating' && !running.has(order.id)) {
      order.status = 'unknown'; order.code = 'TOPUP_RESULT_UNKNOWN';
      await repo.save(owner, order.id, order.status, order, row.encrypted_value, timestamp());
    }
    if (order.status === 'pending' && order.expiresAt !== null && order.expiresAt > now()) {
      const saved = open(owner, row);
      if (saved && (await community.target(owner, order.communityAccountId).catch(() => null))?.revision === saved.revision) order.qrUrl = saved.payment.qrUrl;
    }
    return order;
  }
  async function find(owner: string, id: string) { const row = await repo.get(owner, id); if (!row) throw new ApiError(404, 'TOPUP_ORDER_NOT_FOUND'); return row; }
  return {
    catalog: (owner: string, account: string, uid?: string) => run(async (signal) => (await catalog(owner, account, uid, signal)).catalog),
    quote: (owner: string, input: { communityAccountId: string; uid: string; goodsId: string; method: TopupMethod }) => run(async (signal): Promise<TopupQuote> => {
      const result = await catalog(owner, input.communityAccountId, input.uid, signal);
      const goods = result.catalog.goods.find((entry) => entry.id === input.goodsId);
      if (!goods?.available || !result.role) throw new ApiError(422, 'TOPUP_GOODS_NOT_AVAILABLE');
      if (!result.catalog.methods.includes(input.method)) throw new ApiError(422, 'TOPUP_METHOD_NOT_AVAILABLE');
      for (const [id, value] of quotes) if (value.quote.expiresAt <= now() || value.owner === owner) quotes.delete(id);
      if (quotes.size >= 128) throw new ApiError(429, 'TOPUP_BUSY');
      const quote: TopupQuote = { id: randomUUID(), communityAccountId: input.communityAccountId, accountId: result.context.session.accountId,
        role: result.role, goods, method: input.method, expiresAt: now() + 5 * 60000 };
      quotes.set(quote.id, { owner, revision: result.context.revision, quote }); return quote;
    }),
    create: (owner: string, quoteId: string, requestId: string) => run(async (signal): Promise<TopupOrder> => {
      const previous = await repo.get(owner, requestId); if (previous) return publicOrder(owner, previous);
      const candidate = quotes.get(quoteId);
      if (!candidate || candidate.owner !== owner || candidate.quote.expiresAt <= now()) throw new ApiError(409, 'TOPUP_QUOTE_EXPIRED');
      const { quote, revision } = candidate, result = await catalog(owner, quote.communityAccountId, quote.role.uid, signal);
      const goods = result.catalog.goods.find((entry) => entry.id === quote.goods.id);
      if (result.context.revision !== revision) throw new ApiError(409, 'CREDENTIALS_CHANGED');
      if (!result.role || !goods?.available || goods.name !== quote.goods.name || goods.amount !== quote.goods.amount || goods.tier !== quote.goods.tier || goods.currency !== quote.goods.currency || !result.catalog.methods.includes(quote.method)) throw new ApiError(409, 'TOPUP_QUOTE_CHANGED');
      const order: TopupOrder = { id: requestId, communityAccountId: quote.communityAccountId, accountId: quote.accountId, uid: quote.role.uid, region: 'cn_gf01',
        goodsId: goods.id, goodsName: goods.name, amount: goods.amount, currency: 'CNY', method: quote.method, status: 'creating',
        createdAt: timestamp(), updatedAt: timestamp(), orderNo: null, qrUrl: null, expiresAt: null, code: null };
      const reserved = await repo.reserve(owner, requestId, order, order.createdAt);
      if (reserved === 'busy') throw new ApiError(409, 'TOPUP_PENDING_ORDER');
      if (reserved === 'existing') return publicOrder(owner, await find(owner, requestId));
      running.add(order.id); quotes.delete(quoteId); let payment: RechargePayment | undefined;
      const save = async () => { order.updatedAt = timestamp(); await repo.save(owner, order.id, order.status, { ...order, qrUrl: null }, payment ? seal(owner, order.id, { revision, payment }) : null, order.updatedAt); };
      try {
        payment = await result.context.check(() => result.context.client.createBusinessOrder(result.context.session, result.role!, goods));
        order.orderNo = payment.orderNo; await save();
        payment = await result.context.check(() => result.context.client.paymentCode(result.context.session, payment!, quote.method));
        order.status = 'pending'; order.expiresAt = payment.expiresAt; await save();
      } catch (error) {
        order.status = operationCode(error) === 'MIYOUSHE_VERIFICATION_REQUIRED' ? 'verification_required' : 'unknown';
        order.code = operationCode(error); await save();
      } finally { running.delete(order.id); }
      return publicOrder(owner, await find(owner, order.id));
    }),
    list: (owner: string) => run(async () => Promise.all((await repo.list(owner)).map((row) => publicOrder(owner, row)))),
    check: (owner: string, id: string) => run(async (signal): Promise<TopupOrder> => {
      const row = await find(owner, id), order = await publicOrder(owner, row);
      if (running.has(id)) return order;
      const privateOrder = open(owner, row);
      if (!privateOrder || ['paid', 'archived'].includes(order.status)) return order;
      const context = await prepare(owner, order.communityAccountId, signal);
      if (context.revision !== privateOrder.revision) throw new ApiError(409, 'CREDENTIALS_CHANGED');
      const paid = await context.check(() => context.client.status(context.session, { uid: order.uid, region: 'cn_gf01', nickname: '' }, privateOrder.payment));
      if (paid) { order.status = 'paid'; order.qrUrl = null; order.code = null; order.updatedAt = timestamp(); await repo.save(owner, id, order.status, order, null, order.updatedAt); }
      return order;
    }),
    archive: (owner: string, id: string) => run(async (): Promise<TopupOrder> => {
      if (running.has(id)) throw new ApiError(409, 'TOPUP_BUSY');
      const order = await publicOrder(owner, await find(owner, id));
      if (order.status === 'paid') return order;
      order.status = 'archived'; order.qrUrl = null; order.code = null; order.updatedAt = timestamp();
      await repo.save(owner, id, order.status, order, null, order.updatedAt); return order;
    }),
    close: async () => { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...tasks]); quotes.clear(); vault.destroy(); },
  };
}
