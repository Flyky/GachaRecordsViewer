import { describe, expect, it } from 'vitest';
import { GameCheckinClient, MiyousheClient, parseWishLink, type Transport } from '../src/index.js';
const link = (authkey: string) => `https://webstatic.mihoyo.com/wish/index.html?auth_appid=webview_gacha&authkey=${authkey}&game_biz=hk4e_cn#/log`;
describe('wish links and game check-in protocol', () => {
  it('preserves raw base64 plus signs, decodes once and rejects arbitrary/ambiguous/non-Genshin links', () => {
    expect(parseWishLink(link('a+b%2Fc%3D')).authkey).toBe('a+b/c=');
    expect(parseWishLink(link('a%252Bb')).authkey).toBe('a%2Bb');
    for (const invalid of [link('a') + '&authkey=b', link('a').replace('webstatic.mihoyo.com', 'evil.example'), link('a').replace('https:', 'http:'),
      link('a').replace('hk4e_cn', 'nap_cn'), link('a').replace('webview_gacha', 'csc'), link('a').replace('webstatic.mihoyo.com', 'webstatic.mihoyo.com.evil.example')]) {
      // Put duplicate query data before the fragment when testing duplicate AuthKey rejection.
      const value = invalid === link('a') + '&authkey=b' ? link('a').replace('#/log', '&authkey=b#/log') : invalid;
      expect(() => parseWishLink(value)).toThrow();
    }
  });
  it('routes overseas links to a fixed upstream and validates UID consistently across a page', async () => {
    const calls: URL[] = [];
    const client = new MiyousheClient({ transport: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ retcode: 0, data: { list: [{ uid: '612345678', id: '1234', item_id: '11301', gacha_type: '301', time: '2026-10-28 12:00:00' }] } }));
    } });
    const parsed = parseWishLink('https://webstatic-sea.hoyoverse.com/test?auth_appid=webview_gacha&authkey=private-test&game_biz=hk4e_global');
    expect((await client.getLinkedWishPage(parsed, '301')).uid).toBe('612345678');
    expect(calls[0]!.origin).toBe('https://public-operation-hk4e-sg.hoyoverse.com');
    expect(calls[0]!.pathname).toBe('/gacha_info/api/getGachaLog');
    await expect(client.getLinkedWishPage(parsed, '301', '0', '812345678')).rejects.toMatchObject({ code: 'role_mismatch' });
  });
  it('uses per-game activities and detects already-signed and challenge responses without solving them', async () => {
    const calls: { url: URL; headers: Headers; body: Record<string, string> | null }[] = [];
    let mode = 'good';
    const transport: Transport = async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) as Record<string, string> : null });
      if (mode === 'already') return new Response(JSON.stringify({ retcode: -5003, data: null }));
      return new Response(JSON.stringify({ retcode: 0, data: mode === 'challenge' ? { success: 1, gt: 'private-challenge' } : { success: 0 } }));
    };
    const client = new GameCheckinClient({ transport }), session = { accountId: '12345', cookieToken: 'synthetic-cookie' };
    for (const gameBiz of ['hk4e_cn', 'hkrpg_cn', 'nap_cn'] as const) await client.sign(session, { gameBiz, uid: '123456789', region: 'prod_gf_cn', nickname: null });
    expect(calls.map((call) => call.body!.act_id)).toEqual(['e202311201442471', 'e202304121516551', 'e202406242138391']);
    expect(calls[0]!.headers.get('x-rpc-signgame')).toBe('hk4e');
    expect(calls[2]!.headers.get('x-rpc-signgame')).toBe('zzz');
    expect(calls[2]!.url.href).toBe('https://api-takumi.mihoyo.com/event/luna/zzz/sign');
    mode = 'already'; expect(await client.sign(session, { gameBiz: 'hk4e_cn', uid: '123456789', region: 'cn_gf01', nickname: null })).toBe(true);
    mode = 'challenge'; await expect(client.sign(session, { gameBiz: 'hk4e_cn', uid: '123456789', region: 'cn_gf01', nickname: null })).rejects.toMatchObject({ code: 'verification_required' });
    expect(calls).toHaveLength(5);
  });
});
