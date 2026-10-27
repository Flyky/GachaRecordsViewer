import { ProbeError } from './errors.js';

export interface ParsedWishLink { authkey: string; overseas: boolean; region: string | null }
const cnHosts = ['webstatic.mihoyo.com', 'act.mihoyo.com', 'hk4e-api.mihoyo.com', 'public-operation-hk4e.mihoyo.com'];
const osHosts = ['webstatic-sea.mihoyo.com', 'webstatic-sea.hoyoverse.com', 'webstatic.hoyoverse.com', 'act.hoyoverse.com', 'gs.hoyoverse.com', 'hk4e-api-os.mihoyo.com', 'hk4e-api-os.hoyoverse.com', 'public-operation-hk4e-sg.hoyoverse.com'];
export function parseWishLink(input: string): ParsedWishLink {
  const invalid = () => { throw new ProbeError('protocol', 'wish_link'); };
  if (!input.trim() || input.length > 32768 || /[\r\n\0]/.test(input.trim())) return invalid();
  let url: URL;
  try { url = new URL(input.trim().replace(/&amp;/g, '&')); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || ![...cnHosts, ...osHosts].includes(url.hostname)) return invalid();
  const fields = url.searchParams;
  for (const key of ['authkey', 'auth_appid', 'authkey_ver', 'sign_type', 'game_biz', 'region']) if (fields.getAll(key).length > 1) return invalid();
  if (fields.get('auth_appid') !== 'webview_gacha' || fields.has('authkey_ver') && fields.get('authkey_ver') !== '1'
    || fields.has('sign_type') && fields.get('sign_type') !== '2') return invalid();
  const biz = fields.get('game_biz');
  if (biz && !['hk4e_cn', 'hk4e_global'].includes(biz)) return invalid();
  const region = fields.get('region');
  if (region && !['cn_gf01', 'cn_qd01', 'os_usa', 'os_euro', 'os_asia', 'os_cht'].includes(region)) return invalid();
  const overseas = osHosts.includes(url.hostname) || biz === 'hk4e_global' || region?.startsWith('os_') === true;
  if (overseas && (biz === 'hk4e_cn' || region?.startsWith('cn_'))) return invalid();
  // Decode percent escapes once, preserving literal '+' in unescaped base64 AuthKeys.
  const raw = /(?:^|&)authkey=([^&]*)/.exec(url.search.slice(1))?.[1];
  let authkey: string;
  try { authkey = decodeURIComponent(raw ?? ''); } catch { return invalid(); }
  if (authkey.length < 1 || authkey.length > 16000 || !/^[\x21-\x7e]+$/.test(authkey)) return invalid();
  return { authkey, overseas, region };
}
