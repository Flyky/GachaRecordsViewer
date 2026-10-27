import { describe, expect, it } from 'vitest';
import { MiyousheClient, parseCredentials, ProbeError, type Transport } from '../src/index.js';
import { signDs, protocol } from '../src/miyoushe/protocol.js';

describe('R12 manual credentials and identity', () => {
  it('normalizes consistent aliases without truncating token values or keeping unrelated cookies', () => {
    expect(parseCredentials('Cookie: stuid_v2=00123; account_id=123; stoken_v2=v2_abc==; mid=abc; ltoken=; login_ticket=discard-me;'))
      .toEqual({ accountId: '123', stoken: 'v2_abc==', mid: 'abc' });
    expect(parseCredentials(JSON.stringify({ ltuid_v2: 123, ltoken_v2: 'ltoken', mid: 'mid', arbitrary: { token: 'ignored' } })))
      .toEqual({ accountId: '123', ltoken: 'ltoken', mid: 'mid' });
  });
  it.each(['stuid=1;ltuid=2;stoken=private', 'stuid=1;stoken=a;stoken=b', 'stuid=1;stoken=a;stoken_v2=b',
    'stuid=1;stoken=private\r\nX-Header:bad', 'stuid=1;stoken=token value', 'stuid=1;stoken=令牌',
    'stoken=private', 'stuid=0;ltoken=private', 'stuid=1', '{broken', JSON.stringify({ accountId: Number.MAX_SAFE_INTEGER + 1, ltoken: 'private' })])('rejects ambiguous or malformed input without reflecting it (%#)', (input) => {
    try { parseCredentials(input); throw new Error('accepted invalid input'); }
    catch (error) { expect(error).toBeInstanceOf(ProbeError); expect(String(error)).not.toContain('private'); }
  });
  it('projects only verified identity, checks mismatches and follows the reference form signing input', async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const transport: Transport = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ retcode: 0, data: { need_realperson: false, user_info: { aid: '123', mid: 'm123', realname: 'do-not-return', identity_code: 'private' } } }));
    };
    const client = new MiyousheClient({ transport });
    expect(await client.verifyLToken('123', 'fixture-ltoken')).toEqual({ accountId: '123', mid: 'm123' });
    const request = requests[0]!, headers = new Headers(request.init.headers), ds = headers.get('ds')!;
    const [time, nonce] = ds.split(',');
    expect(request.url.href).toBe('https://passport-api-v4.mihoyo.com/account/ma-cn-session/web/verifyLtoken');
    expect(request.init.body).toBe(JSON.stringify({ ltoken: 'fixture-ltoken' }));
    expect(headers.get('cookie')).toBe('ltoken=fixture-ltoken;ltuid=123;');
    expect(ds).toBe(signDs('v2', protocol.x4Salt, 'ltoken=fixture-ltoken', '', Number(time), nonce));
    await expect(client.verifyLToken('456', 'fixture-ltoken')).rejects.toMatchObject({ code: 'role_mismatch' });
  });
});
