import { ProbeError, upstreamError } from './errors.js';
import { cookieHeader, createDevice, protocol, signDs, sortedQuery, type DeviceContext } from './protocol.js';

const passport = 'https://passport-api.mihoyo.com';
const endpoints = {
  createQr: `${passport}/account/ma-cn-passport/app/createQRLogin`,
  queryQr: `${passport}/account/ma-cn-passport/app/queryQRLoginStatus`,
  ltoken: `${passport}/account/auth/api/getLTokenBySToken`,
  cookieToken: `${passport}/account/auth/api/getCookieAccountInfoBySToken`,
  roles: 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie',
  authkey: 'https://api-takumi.mihoyo.com/binding/api/genAuthKey',
  history: 'https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog',
} as const;

type Endpoint = keyof typeof endpoints;
export type Transport = (url: URL, init: RequestInit) => Promise<Response>;

export interface Credentials {
  accountId: string;
  mid: string;
  stoken: string;
}

export interface QrTicket {
  ticket: string;
  url: string;
  expiresAt: number;
}

export type QrState =
  | { status: 'waiting' | 'scanned' }
  | { status: 'confirmed'; credentials: Credentials };

export interface GameRole {
  uid: string;
  region: string;
  gameBiz: 'hk4e_cn';
}

export interface HistoryPage {
  count: number;
  nextId: string | null;
}

export function object(value: unknown, stage: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProbeError('protocol', stage);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, stage: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n;]/.test(value)) {
    throw new ProbeError('protocol', stage);
  }
  return value;
}

function identifier(value: unknown, stage: string): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== 'string' || !/^\d+$/.test(result)) throw new ProbeError('protocol', stage);
  return result;
}

interface ClientOptions {
  transport?: Transport;
  device?: DeviceContext;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class MiyousheClient {
  private readonly transport: Transport;
  private readonly device: DeviceContext;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: ClientOptions = {}) {
    this.transport = options.transport ?? fetch;
    this.device = options.device ?? createDevice();
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.signal = options.signal;
  }

  private headers(body: string, query: string, mode: 'qr' | 'normal' | 'authkey') {
    const headers: Record<string, string> = {
      'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/${protocol.appVersion}`,
      'x-rpc-app_version': protocol.appVersion,
      'x-rpc-client_type': '5',
      'x-rpc-device_id': this.device.id,
      'x-rpc-device_fp': this.device.fingerprint,
      'x-requested-with': 'com.mihoyo.hyperion',
      referer: 'https://webstatic.mihoyo.com',
      'content-type': 'application/json',
      ds: signDs(mode === 'authkey' ? 'v1' : 'v2', mode === 'authkey' ? protocol.lk2Salt : protocol.x4Salt, body, query),
    };
    if (mode === 'qr') {
      Object.assign(headers, {
        'user-agent': `Mozilla/5.0 miHoYoBBS/${protocol.appVersion} Capture/2.2.0`,
        accept: '*/*',
        'accept-language': 'zh-cn',
        'x-rpc-client_type': '3',
        'x-rpc-app_id': protocol.appId,
        'x-rpc-sdk_version': protocol.appVersion,
        'x-rpc-account_version': protocol.appVersion,
        'x-rpc-game_biz': 'bbs_cn',
        'x-rpc-device_name': this.device.name,
        'x-rpc-device_model': this.device.model,
      });
    }
    return headers;
  }

  private async request(
    endpoint: Endpoint,
    options: {
      body?: Record<string, unknown>;
      query?: Record<string, string>;
      cookie?: Record<string, string>;
      mode?: 'qr' | 'normal' | 'authkey';
      clientType?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(endpoints[endpoint]);
    const query = options.query ?? {};
    for (const key of Object.keys(query).sort()) url.searchParams.set(key, query[key]!);
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    const headers = endpoint === 'history'
      ? { 'user-agent': `GachaRecordsViewer R02` } as Record<string, string>
      : this.headers(body, sortedQuery(query), options.mode ?? 'normal');
    if (options.cookie) headers.cookie = cookieHeader(options.cookie);
    if (options.clientType) headers['x-rpc-client_type'] = options.clientType;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
    if (this.signal?.aborted) throw new ProbeError('cancelled', endpoint);

    let result: unknown;
    try {
      const response = await this.transport(url, {
        method: options.body === undefined ? 'GET' : 'POST',
        headers,
        ...(options.body === undefined ? {} : { body }),
        redirect: 'error',
        signal,
      });
      if (response.headers.has('x-rpc-aigis')) throw new ProbeError('verification_required', endpoint);
      if (!response.ok) throw new ProbeError('upstream', endpoint, response.status);
      try {
        result = await response.json();
      } catch {
        if (signal.aborted) throw new ProbeError(timeout.aborted ? 'timeout' : 'cancelled', endpoint);
        throw new ProbeError('protocol', endpoint);
      }
    } catch (error) {
      if (error instanceof ProbeError) throw error;
      throw new ProbeError(this.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network', endpoint);
    }

    const envelope = object(result, endpoint);
    if (typeof envelope.retcode !== 'number') throw new ProbeError('protocol', endpoint);
    if (envelope.retcode !== 0) throw upstreamError(endpoint, envelope.retcode);
    const data = object(envelope.data, endpoint);
    if (data.need_realperson === true || objectOrNull(data.realname_info)?.required === true) {
      throw new ProbeError('verification_required', endpoint);
    }
    return data;
  }

  async createQr(): Promise<QrTicket> {
    const data = await this.request('createQr', { body: {}, mode: 'qr' });
    const ticket = text(data.ticket, 'createQr');
    let url: URL;
    try { url = new URL(text(data.url, 'createQr')); }
    catch { throw new ProbeError('protocol', 'createQr'); }
    if (url.protocol !== 'https:' || url.username || url.password ||
      !['user.mihoyo.com', 'user.miyoushe.com', 'account.mihoyo.com'].includes(url.hostname)) {
      throw new ProbeError('protocol', 'createQr');
    }
    const expiry = Number(url.searchParams.get('expire')) * 1000;
    const expiresAt = Number.isFinite(expiry) && expiry > 0
      ? Math.min(Date.now() + 180000, expiry) : Date.now() + 180000;
    if (expiresAt <= Date.now()) throw new ProbeError('expired', 'createQr');
    return { ticket, url: url.href, expiresAt };
  }

  async queryQr(ticket: QrTicket): Promise<QrState> {
    if (Date.now() >= ticket.expiresAt) throw new ProbeError('expired', 'queryQr');
    const data = await this.request('queryQr', { body: { ticket: ticket.ticket }, mode: 'qr' });
    if (Date.now() >= ticket.expiresAt) throw new ProbeError('expired', 'queryQr');
    if (data.status === 'Init' || data.status === 'Created') return { status: 'waiting' };
    if (data.status === 'Scanned') return { status: 'scanned' };
    if (data.status === 'Expired') throw new ProbeError('expired', 'queryQr');
    if (data.status === 'Cancelled') throw new ProbeError('cancelled', 'queryQr');
    if (data.status !== 'Confirmed' || !Array.isArray(data.tokens)) throw new ProbeError('protocol', 'queryQr');
    const token = data.tokens.map((value: unknown) => object(value, 'queryQr')).find((value) => value.token_type === 1);
    const user = object(data.user_info, 'queryQr');
    return { status: 'confirmed', credentials: {
      accountId: identifier(user.aid, 'queryQr'),
      mid: text(user.mid, 'queryQr'),
      stoken: text(token?.token, 'queryQr'),
    } };
  }

  private sessionCookie(credentials: Credentials) {
    return {
      stuid: identifier(credentials.accountId, 'credentials'),
      stoken: text(credentials.stoken, 'credentials'),
      mid: text(credentials.mid, 'credentials'),
    };
  }

  async getLToken(credentials: Credentials): Promise<void> {
    const data = await this.request('ltoken', {
      query: { stoken: credentials.stoken }, cookie: this.sessionCookie(credentials),
    });
    text(data.ltoken, 'ltoken');
  }

  async getCookieToken(credentials: Credentials): Promise<string> {
    const data = await this.request('cookieToken', {
      query: { stoken: credentials.stoken }, cookie: this.sessionCookie(credentials), clientType: '2',
    });
    if (identifier(data.uid, 'cookieToken') !== credentials.accountId) throw new ProbeError('role_mismatch', 'cookieToken');
    return text(data.cookie_token, 'cookieToken');
  }

  async getRoles(credentials: Credentials, cookieToken: string): Promise<GameRole[]> {
    const data = await this.request('roles', { cookie: { account_id: credentials.accountId, cookie_token: cookieToken } });
    if (!Array.isArray(data.list)) throw new ProbeError('protocol', 'roles');
    return data.list.map((value: unknown) => object(value, 'roles'))
      .filter((role) => role.game_biz === 'hk4e_cn')
      .map((role) => {
        if (role.region !== 'cn_gf01' && role.region !== 'cn_qd01') throw new ProbeError('protocol', 'roles');
        return { uid: identifier(role.game_uid, 'roles'), region: role.region, gameBiz: 'hk4e_cn' as const };
      });
  }

  async generateAuthKey(credentials: Credentials, role: GameRole): Promise<string> {
    const data = await this.request('authkey', {
      body: { auth_appid: 'webview_gacha', game_biz: role.gameBiz, game_uid: role.uid, region: role.region },
      cookie: this.sessionCookie(credentials), mode: 'authkey',
    });
    if (data.sign_type !== 2 || data.authkey_ver !== 1) throw new ProbeError('protocol', 'authkey');
    return text(data.authkey, 'authkey');
  }

  async getHistoryPage(authkey: string, role: GameRole, pool: string, endId = '0'): Promise<HistoryPage> {
    if (!['100', '200', '301', '302', '500'].includes(pool)) throw new ProbeError('protocol', 'history');
    const data = await this.request('history', { query: {
      lang: 'zh-cn', auth_appid: 'webview_gacha', authkey, authkey_ver: '1', sign_type: '2',
      gacha_type: pool, size: '5', end_id: endId,
    } });
    if (!Array.isArray(data.list) || data.list.length > 5) throw new ProbeError('protocol', 'history');
    let previous = endId;
    for (const value of data.list as unknown[]) {
      const row = object(value, 'history');
      if (identifier(row.uid, 'history') !== role.uid) throw new ProbeError('role_mismatch', 'history');
      const id = identifier(row.id, 'history');
      if (previous !== '0' && BigInt(id) >= BigInt(previous)) throw new ProbeError('protocol', 'history');
      const rawPool = text(row.gacha_type, 'history');
      if ((pool === '301' ? rawPool !== '301' && rawPool !== '400' : rawPool !== pool)) {
        throw new ProbeError('role_mismatch', 'history');
      }
      previous = id;
    }
    return { count: data.list.length, nextId: data.list.length === 0 ? null : previous };
  }
}

function objectOrNull(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
