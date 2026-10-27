import { MiyousheClient, object, type Credentials, type Transport } from './client.js';
import { ProbeError, upstreamError } from './errors.js';
import { cookieHeader, createDevice, protocol, signDs, sortedQuery, type DeviceContext } from './protocol.js';

export const CHECKIN_GAMES = {
  hk4e_cn: { name: '原神', actId: 'e202311201442471', base: 'https://api-takumi.mihoyo.com/event/luna/hk4e', signgame: 'hk4e' },
  hkrpg_cn: { name: '星穹铁道', actId: 'e202304121516551', base: 'https://api-takumi.mihoyo.com/event/luna/hkrpg', signgame: 'hkrpg' },
  nap_cn: { name: '绝区零', actId: 'e202406242138391', base: 'https://api-takumi.mihoyo.com/event/luna/zzz', signgame: 'zzz' },
} as const;
export type CheckinGameBiz = keyof typeof CHECKIN_GAMES;
export interface CheckinRole { gameBiz: CheckinGameBiz; uid: string; region: string; nickname: string | null }
export interface CheckinSession { accountId: string; cookieToken: string; mid?: string; ltoken?: string }
export interface CheckinClientOptions { transport?: Transport; device?: DeviceContext; timeoutMs?: number; signal?: AbortSignal }

export class GameCheckinClient {
  private readonly transport: Transport;
  private readonly device: DeviceContext;
  private readonly identity: MiyousheClient;
  constructor(private readonly options: CheckinClientOptions = {}) {
    this.transport = options.transport ?? fetch; this.device = options.device ?? createDevice();
    this.identity = new MiyousheClient(options);
  }
  getCookieToken(credentials: Credentials) { return this.identity.getCookieToken(credentials); }
  private async request(url: URL, session: CheckinSession, game?: CheckinGameBiz, body?: Record<string, string>) {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10000);
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    const cookie: Record<string, string> = { account_id: session.accountId, cookie_token: session.cookieToken };
    if (session.ltoken) Object.assign(cookie, { ltuid: session.accountId, ltoken: session.ltoken });
    if (session.mid) cookie.mid = session.mid;
    const bodyText = body ? JSON.stringify(body) : '';
    url.searchParams.sort();
    const headers: Record<string, string> = { 'content-type': 'application/json', cookie: cookieHeader(cookie),
      'user-agent': `Mozilla/5.0 miHoYoBBS/${protocol.appVersion}`, 'x-rpc-app_version': protocol.appVersion, 'x-rpc-client_type': body ? '2' : '5',
      'x-rpc-device_id': this.device.id, 'x-rpc-device_fp': this.device.fingerprint, 'x-requested-with': 'com.mihoyo.hyperion',
      origin: 'https://act.mihoyo.com', referer: 'https://webstatic.mihoyo.com/',
      ds: signDs('v2', game ? protocol.x6Salt : protocol.x4Salt, bodyText, sortedQuery(Object.fromEntries(url.searchParams))) };
    if (game && CHECKIN_GAMES[game].signgame) headers['x-rpc-signgame'] = CHECKIN_GAMES[game].signgame;
    let response: Response, value: Record<string, unknown>;
    try {
      response = await this.transport(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: bodyText } : {}), signal, redirect: 'error' });
      if (response.headers.has('x-rpc-aigis')) throw new ProbeError('verification_required', 'checkin');
      if (!response.ok) throw new ProbeError('upstream', 'checkin', response.status);
      value = object(await response.json(), 'checkin');
    } catch (error) {
      if (error instanceof ProbeError) throw error;
      throw new ProbeError(this.options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network', 'checkin');
    }
    if (value.retcode === -5003) return { already: true, data: {} };
    if (typeof value.retcode !== 'number') throw new ProbeError('protocol', 'checkin');
    if (value.retcode !== 0) throw upstreamError('checkin', value.retcode);
    const data = object(value.data, 'checkin');
    if (data.success === 1 || data.gt || data.challenge || typeof data.risk_code === 'number' && data.risk_code !== 0) throw new ProbeError('verification_required', 'checkin');
    return { already: false, data };
  }
  async listRoles(session: CheckinSession): Promise<CheckinRole[]> {
    const { data } = await this.request(new URL('https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie'), session);
    if (!Array.isArray(data.list) || data.list.length > 128) throw new ProbeError('protocol', 'checkin_roles');
    const seen = new Set<string>();
    return data.list.map((row) => object(row, 'checkin_roles')).filter((row) => Object.hasOwn(CHECKIN_GAMES, String(row.game_biz))).map((row) => {
      if (typeof row.game_uid !== 'string' && !(typeof row.game_uid === 'number' && Number.isSafeInteger(row.game_uid))) throw new ProbeError('protocol', 'checkin_roles');
      const uid = String(row.game_uid), region = String(row.region), gameBiz = row.game_biz as CheckinGameBiz, key = `${gameBiz}:${region}:${uid}`;
      if (!/^[1-9]\d{0,19}$/.test(uid) || !/^[a-z0-9_]{2,40}$/.test(region) || seen.has(key)) throw new ProbeError('protocol', 'checkin_roles');
      seen.add(key);
      return { gameBiz, uid, region, nickname: typeof row.nickname === 'string' ? row.nickname.slice(0, 100) : null };
    });
  }
  async status(session: CheckinSession, role: CheckinRole) {
    const game = CHECKIN_GAMES[role.gameBiz], url = new URL(`${game.base}/info`);
    url.search = new URLSearchParams({ lang: 'zh-cn', act_id: game.actId, uid: role.uid, region: role.region }).toString();
    const { data } = await this.request(url, session, role.gameBiz);
    if (typeof data.is_sign !== 'boolean') throw new ProbeError('protocol', 'checkin_info');
    return { signed: data.is_sign, firstBind: data.first_bind === true };
  }
  async sign(session: CheckinSession, role: CheckinRole) {
    const game = CHECKIN_GAMES[role.gameBiz];
    return (await this.request(new URL(`${game.base}/sign`), session, role.gameBiz, { lang: 'zh-cn', act_id: game.actId, uid: role.uid, region: role.region })).already;
  }
}
