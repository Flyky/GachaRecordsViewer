import { ProbeError } from './errors.js';

export interface ManualCredentials { accountId: string; mid?: string; stoken?: string; ltoken?: string; cookieToken?: string }
const aliases = {
  accountId: ['accountId', 'account_id', 'account_id_v2', 'stuid', 'stuid_v2', 'ltuid', 'ltuid_v2'],
  mid: ['mid'], stoken: ['stoken', 'stoken_v2'], ltoken: ['ltoken', 'ltoken_v2'], cookieToken: ['cookieToken', 'cookie_token', 'cookie_token_v2'],
} as const;
export function parseCredentials(input: string): ManualCredentials {
  const invalid = () => { throw new ProbeError('protocol', 'credential_input'); };
  if (!input.trim() || input.length > 24000) return invalid();
  const entries = new Map<string, string>();
  const put = (key: string, value: unknown) => {
    if (!Object.values(aliases).some((names) => (names as readonly string[]).includes(key))) return;
    if (value === '') return;
    if (typeof value === 'number' && Number.isSafeInteger(value) && (aliases.accountId as readonly string[]).includes(key)) value = String(value);
    if (typeof value !== 'string' || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value) || value.includes(';')) return invalid();
    if (entries.has(key) && entries.get(key) !== value) return invalid();
    entries.set(key, value);
  };
  const source = input.trim().replace(/^Cookie:\s*/i, '');
  if (source.startsWith('{')) {
    let object: unknown;
    try { object = JSON.parse(source); } catch { return invalid(); }
    if (!object || typeof object !== 'object' || Array.isArray(object)) return invalid();
    for (const [key, value] of Object.entries(object)) put(key, value);
  } else {
    for (const part of source.split(';')) {
      if (!part.trim()) continue;
      const separator = part.indexOf('='); if (separator < 1) return invalid();
      put(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }
  const normalized: Partial<ManualCredentials> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const values = names.flatMap((name) => entries.has(name) ? [entries.get(name)!] : []).map((value) => {
      if (field !== 'accountId') return value;
      if (!/^\d{1,20}$/.test(value)) return invalid();
      return value.replace(/^0+(?=\d)/, '');
    });
    if (new Set(values).size > 1) return invalid();
    if (values[0]) Object.assign(normalized, { [field]: values[0] });
  }
  if (!normalized.accountId || normalized.accountId === '0' || !normalized.stoken && !normalized.ltoken && !normalized.cookieToken || normalized.mid && normalized.mid.length > 256) return invalid();
  return normalized as ManualCredentials;
}
