import { afterEach, describe, expect, it, vi } from 'vitest';
import { MiyousheClient, type Credentials, type Transport } from '../src/miyoushe/client.js';
import { ProbeError } from '../src/miyoushe/errors.js';
import { maskId, runProbe, type ProbeEvent } from '../src/miyoushe/probe.js';
import { signDs, sortedQuery } from '../src/miyoushe/protocol.js';

const secret = 'fixture-private-stoken';
const credentials: Credentials = { accountId: '123456789', mid: 'fixture-mid', stoken: secret };
const role = { uid: '100000001', region: 'cn_gf01', gameBiz: 'hk4e_cn' as const };
const qrData = () => ({ ticket: 'fixture-ticket', url: 'https://user.mihoyo.com/login-platform/mobile.html?tk=fixture-ticket' });
const confirmation = () => ({
  status: 'Confirmed',
  tokens: [{ token_type: 2, token: 'not-a-stoken' }, { token_type: 1, token: secret }],
  user_info: { aid: credentials.accountId, mid: credentials.mid, mobile: 'not-to-be-logged' },
});
const record = (id: string, uid = role.uid, gachaType = '301') => ({ id, uid, gacha_type: gachaType });

interface Reply {
  data?: unknown;
  retcode?: number;
  http?: number;
  headers?: HeadersInit;
  raw?: string;
}

function setup(replies: Reply[]) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const transport: Transport = async (url, init) => {
    requests.push({ url: new URL(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected request');
    return new Response(reply.raw ?? JSON.stringify({
      retcode: reply.retcode ?? 0,
      message: `untrusted ${secret}`,
      data: reply.data ?? {},
    }), { status: reply.http ?? 200, headers: reply.headers ?? {} });
  };
  return { client: new MiyousheClient({ transport }), requests };
}

async function safeFailure(promise: Promise<unknown>) {
  try { await promise; throw new Error('Expected failure'); }
  catch (error) {
    expect(error).toBeInstanceOf(ProbeError);
    if (!(error instanceof ProbeError)) throw error;
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    expect(error.cause).toBeUndefined();
    return error.toJSON();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('DS protocol and QR transport', () => {
  it('matches independently calculated V1 and V2 signature vectors', () => {
    expect(signDs('v1', 'fixture-salt', 'ignored', 'ignored', 1700000000, 'abcdef'))
      .toBe('1700000000,abcdef,2a9f89a6f6aab279722514ce5c7f875a');
    expect(signDs('v2', 'fixture-salt', '{"ticket":"fixture"}', 'a=1&b=2', 1700000000, '123456'))
      .toBe('1700000000,123456,50e0d90cb8bb8839badd00c7de6cd803');
    expect(sortedQuery({ b: '2', a: '1' })).toBe('a=1&b=2');
  });

  it('posts an empty object with stable device context and never follows redirects', async () => {
    const { client, requests } = setup([{ data: qrData() }, { data: { status: 'Created' } }]);
    const ticket = await client.createQr();
    expect(await client.queryQr(ticket)).toEqual({ status: 'waiting' });
    expect(requests[0]?.url.pathname).toBe('/account/ma-cn-passport/app/createQRLogin');
    expect(requests[0]?.init.body).toBe('{}');
    expect(requests[0]?.init.redirect).toBe('error');
    const first = new Headers(requests[0]?.init.headers);
    const second = new Headers(requests[1]?.init.headers);
    expect(first.get('x-rpc-client_type')).toBe('3');
    expect(first.get('x-rpc-device_id')).toBe(second.get('x-rpc-device_id'));
    expect(first.get('ds')).toMatch(/^\d+,\d{6},[a-f0-9]{32}$/);
    expect(first.get('cookie')).toBeNull();
    expect(first.get('user-agent')).toContain('miHoYoBBS/2.115.0');
  });

  it.each(['http://user.mihoyo.com/qr', 'https://attacker.example/qr', 'https://user.mihoyo.com.attacker.example/qr', 'https://user:password@user.mihoyo.com/qr'])(
    'rejects untrusted QR destinations: %s', async (url) => {
      const { client } = setup([{ data: { ...qrData(), url } }]);
      expect(await safeFailure(client.createQr())).toMatchObject({ code: 'protocol', stage: 'createQr' });
    },
  );

  it.each(['Init', 'Created', 'Scanned'])(
    'normalizes QR status %s', async (status) => {
      const { client } = setup([{ data: { status } }]);
      expect(await client.queryQr({ ...qrData(), expiresAt: Date.now() + 60000 }))
        .toEqual({ status: status === 'Scanned' ? 'scanned' : 'waiting' });
    },
  );

  it('selects the SToken by token_type and drops unrelated personal response fields', async () => {
    const { client } = setup([{ data: confirmation() }]);
    expect(await client.queryQr({ ...qrData(), expiresAt: Date.now() + 60000 }))
      .toEqual({ status: 'confirmed', credentials });
  });

  it.each([
    { ...confirmation(), tokens: [{ token_type: 2, token: secret }] },
    { ...confirmation(), user_info: { aid: credentials.accountId } },
    { ...confirmation(), tokens: [{ token_type: 1, token: 'bad\r\nCookie: injected' }] },
    { status: 'unknown-future-status' },
  ])('rejects incomplete or invalid confirmed payloads', async (data) => {
    const { client } = setup([{ data }]);
    expect(await safeFailure(client.queryQr({ ...qrData(), expiresAt: Date.now() + 60000 })))
      .toMatchObject({ code: 'protocol' });
  });

  it('does not query an already expired ticket', async () => {
    const { client, requests } = setup([]);
    expect(await safeFailure(client.queryQr({ ...qrData(), expiresAt: Date.now() - 1 })))
      .toMatchObject({ code: 'expired' });
    expect(requests).toHaveLength(0);
  });
});

describe('safe failures', () => {
  it.each([
    [-3501, 'expired'], [-106, 'expired'], [-3505, 'cancelled'],
    [1034, 'verification_required'], [10035, 'verification_required'],
    [-100, 'auth_invalid'], [-999999, 'upstream'],
  ])('maps retcode %s without reflecting its message', async (retcode, code) => {
    const { client } = setup([{ retcode }]);
    expect(await safeFailure(client.createQr())).toEqual({ code, stage: 'createQr', upstreamCode: retcode });
  });

  it('stops on an official challenge header without exposing the challenge', async () => {
    const { client } = setup([{ headers: { 'x-rpc-aigis': `challenge-${secret}` } }]);
    expect(await safeFailure(client.createQr())).toEqual({ code: 'verification_required', stage: 'createQr' });
  });

  it.each([{ raw: '<html>invalid</html>' }, { raw: '{}' }, { http: 503 }])(
    'safely reports invalid JSON, envelopes and HTTP errors', async (reply) => {
      const { client } = setup([reply]);
      expect((await safeFailure(client.createQr())).stage).toBe('createQr');
    },
  );

  it('does not retain the URL or raw exception on network failure', async () => {
    const client = new MiyousheClient({ transport: async () => { throw new Error(`https://example.com?stoken=${secret}`); } });
    expect(await safeFailure(client.createQr())).toEqual({ code: 'network', stage: 'createQr' });
  });

  it('times out transport requests and redacts the original failure', async () => {
    const client = new MiyousheClient({ timeoutMs: 10, transport: async (_url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    }) });
    expect(await safeFailure(client.createQr())).toEqual({ code: 'timeout', stage: 'createQr' });
  });

  it('aborts an in-flight request without exposing the abort reason', async () => {
    const controller = new AbortController();
    const client = new MiyousheClient({ signal: controller.signal, transport: async (_url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    }) });
    const result = safeFailure(client.createQr());
    controller.abort(secret);
    expect(await result).toEqual({ code: 'cancelled', stage: 'createQr' });
  });
});

describe('identity, role and history boundaries', () => {
  it('requires matching account identity when exchanging cookie token', async () => {
    const { client } = setup([{ data: { uid: '987654321', cookie_token: 'private-cookie' } }]);
    expect(await safeFailure(client.getCookieToken(credentials))).toMatchObject({ code: 'role_mismatch' });
  });

  it('filters other games while preserving the bound Genshin region and UID', async () => {
    const { client, requests } = setup([{ data: { list: [
      { game_biz: 'hkrpg_cn', game_uid: 'other-game' },
      { game_biz: 'hk4e_cn', game_uid: role.uid, region: role.region },
    ] } }]);
    expect(await client.getRoles(credentials, 'private-cookie')).toEqual([role]);
    expect(new Headers(requests[0]?.init.headers).get('cookie')).toBe('account_id=123456789;cookie_token=private-cookie;');
  });

  it('requests a role-bound webview_gacha key with V1 DS', async () => {
    const { client, requests } = setup([{ data: { authkey: 'private-authkey', sign_type: 2, authkey_ver: 1 } }]);
    expect(await client.generateAuthKey(credentials, role)).toBe('private-authkey');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      auth_appid: 'webview_gacha', game_biz: 'hk4e_cn', game_uid: role.uid, region: role.region,
    });
    expect(new Headers(requests[0]?.init.headers).get('ds')).toMatch(/^\d+,[a-f0-9]{6},[a-f0-9]{32}$/);
  });

  it('keeps 19-digit cursors exact and accepts original 400 under group 301', async () => {
    const { client, requests } = setup([{ data: { list: [record('1900000000000000001', role.uid, '400')] } }]);
    expect(await client.getHistoryPage('private-authkey', role, '301', '1900000000000000002'))
      .toEqual({ count: 1, nextId: '1900000000000000001' });
    expect(requests[0]?.url.searchParams.get('end_id')).toBe('1900000000000000002');
    expect(requests[0]?.url.searchParams.get('size')).toBe('5');
    expect(new Headers(requests[0]?.init.headers).get('cookie')).toBeNull();
    expect(new Headers(requests[0]?.init.headers).get('ds')).toBeNull();
  });

  it.each([
    [record('1900000000000000001', '100000002')],
    [record('1900000000000000001', role.uid, '302')],
    [record('1900000000000000001'), record('1900000000000000001')],
    [record('1900000000000000001'), record('1900000000000000002')],
    [record('1900000000000000001'), { id: 1900000000000000000, uid: role.uid, gacha_type: '301' }],
    Array.from({ length: 6 }, (_, index) => record(String(100 - index))),
  ].map((list) => ({ list })))('rejects mismatched roles, pool, repeated IDs, unsafe IDs or oversized pages', async ({ list }) => {
    const { client } = setup([{ data: { list } }]);
    expect((await safeFailure(client.getHistoryPage('private-authkey', role, '301'))).stage).toBe('history');
  });
});

describe('bounded probe orchestration', () => {
  function scenario(options: { ltokenCode?: number; roles?: unknown[] } = {}) {
    return setup([
      { data: qrData() }, { data: { status: 'Created' } }, { data: { status: 'Scanned' } },
      { data: confirmation() },
      { data: { ltoken: 'private-ltoken' }, ...(options.ltokenCode === undefined ? {} : { retcode: options.ltokenCode }) },
      { data: { uid: credentials.accountId, cookie_token: 'private-cookie' } },
      { data: { list: options.roles ?? [{ game_biz: role.gameBiz, game_uid: role.uid, region: role.region }] } },
      { data: { authkey: 'private-authkey', sign_type: 2, authkey_ver: 1 } },
      { data: { list: [record('1900000000000000002'), record('1900000000000000001')] } },
      { data: { list: [] } },
    ]);
  }

  it('runs the read-only chain, stops at two pages and exposes only redacted summary', async () => {
    const { client, requests } = scenario();
    const events: ProbeEvent[] = [];
    const summary = await runProbe(client, { onQr: async () => undefined, sleep: async () => undefined, onEvent: (event) => events.push(event) });
    expect(summary).toEqual({
      result: 'sample_verified', game: 'hk4e_cn', region: 'cn_gf01', uid: '10***01', pool: '301',
      pagesRead: 2, recordCount: 2, reachedEnd: true,
      credentials: { stoken: true, ltoken: true, cookieToken: true }, persisted: false,
    });
    expect(events.filter((event) => event.stage === 'qr').map((event) => event.status))
      .toEqual(['waiting', 'scanned', 'confirmed']);
    const output = JSON.stringify({ events, summary });
    for (const value of [secret, 'private-ltoken', 'private-cookie', 'private-authkey', credentials.mid, role.uid, 'fixture-ticket', 'not-to-be-logged']) {
      expect(output).not.toContain(value);
    }
    expect(requests).toHaveLength(10);
  });

  it('does not request a second page when only one was selected', async () => {
    const { client, requests } = scenario();
    const summary = await runProbe(client, { pages: 1, onQr: async () => undefined, sleep: async () => undefined });
    expect(summary.pagesRead).toBe(1);
    expect(requests).toHaveLength(9);
  });

  it('reports unavailable LToken without falsely claiming it is verified', async () => {
    const { client } = scenario({ ltokenCode: -999 });
    const summary = await runProbe(client, { onQr: async () => undefined, sleep: async () => undefined });
    expect(summary.credentials.ltoken).toBe(false);
  });

  it('stops on a verification challenge rather than trying other token endpoints', async () => {
    const { client, requests } = scenario({ ltokenCode: 1034 });
    expect(await safeFailure(runProbe(client, { onQr: async () => undefined, sleep: async () => undefined })))
      .toMatchObject({ code: 'verification_required' });
    expect(requests).toHaveLength(5);
  });

  it('requires an explicit bound role when there are multiple Genshin profiles', async () => {
    const { client, requests } = scenario({ roles: [
      { game_biz: role.gameBiz, game_uid: role.uid, region: role.region },
      { game_biz: role.gameBiz, game_uid: '100000002', region: role.region },
    ] });
    expect(await safeFailure(runProbe(client, { onQr: async () => undefined, sleep: async () => undefined })))
      .toMatchObject({ code: 'role_required' });
    expect(requests).toHaveLength(7);
  });

  it('does not request an AuthKey for a UID absent from bound roles', async () => {
    const { client, requests } = scenario();
    expect(await safeFailure(runProbe(client, { uid: '100000009', onQr: async () => undefined, sleep: async () => undefined })))
      .toMatchObject({ code: 'role_mismatch' });
    expect(requests).toHaveLength(7);
  });

  it('selects a unique bound role by the explicitly chosen region', async () => {
    const { client } = scenario({ roles: [
      { game_biz: role.gameBiz, game_uid: role.uid, region: role.region },
      { game_biz: role.gameBiz, game_uid: '500000001', region: 'cn_qd01' },
    ] });
    const summary = await runProbe(client, { region: 'cn_gf01', onQr: async () => undefined, sleep: async () => undefined });
    expect(summary.uid).toBe('10***01');
    expect(summary.region).toBe('cn_gf01');
  });

  it('honors a local QR deadline without infinite polling', async () => {
    let time = 1700000000000;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    const { client, requests } = setup([{ data: qrData() }, { data: { status: 'Created' } }]);
    expect(await safeFailure(runProbe(client, {
      maxWaitMs: 1000, onQr: async () => undefined, sleep: async (ms) => { time += ms; },
    }))).toMatchObject({ code: 'expired', stage: 'queryQr' });
    expect(requests).toHaveLength(2);
  });

  it('cancels a waiting QR before issuing further requests', async () => {
    const controller = new AbortController();
    const { client, requests } = setup([{ data: qrData() }, { data: { status: 'Created' } }]);
    expect(await safeFailure(runProbe(client, {
      signal: controller.signal, onQr: async () => undefined, sleep: async () => { controller.abort(); },
    }))).toMatchObject({ code: 'cancelled' });
    expect(requests).toHaveLength(2);
  });

  it('validates bounds before contacting the upstream', async () => {
    const { client, requests } = setup([]);
    expect(await safeFailure(runProbe(client, { pages: 3, onQr: async () => undefined })))
      .toMatchObject({ code: 'protocol', stage: 'options' });
    expect(requests).toHaveLength(0);
    expect(maskId('123')).toBe('****');
  });
});
