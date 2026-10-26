import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

/** Protocol parameters from TeyvatGuide 72c3f37; see THIRD_PARTY_NOTICES.md. */
export const protocol = {
  appVersion: '2.115.0',
  appId: 'bll8iq97cem8',
  x4Salt: 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs',
  lk2Salt: 'b99b74d9023a6511231be2c7209b6fdb',
};

export interface DeviceContext {
  id: string;
  fingerprint: string;
  name: string;
  model: string;
}

export function createDevice(): DeviceContext {
  return {
    id: randomUUID(),
    fingerprint: '0000000000000',
    name: randomBytes(6).toString('hex').toUpperCase(),
    model: randomBytes(3).toString('hex').toUpperCase(),
  };
}

/** MD5 is required by the upstream DS protocol, not used for password storage. */
export function signDs(
  kind: 'v1' | 'v2',
  salt: string,
  body = '',
  query = '',
  time = Math.floor(Date.now() / 1000),
  nonce = kind === 'v1' ? randomBytes(3).toString('hex') : String(randomInt(100000, 200001)),
): string {
  const base = `salt=${salt}&t=${time}&r=${nonce}`;
  const input = kind === 'v1' ? base : `${base}&b=${body}&q=${query}`;
  return `${time},${nonce},${createHash('md5').update(input).digest('hex')}`;
}

export function sortedQuery(params: Record<string, string>): string {
  return Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
}

export function cookieHeader(params: Record<string, string>): string {
  return Object.keys(params).sort().map((key) => `${key}=${params[key]};`).join('');
}
