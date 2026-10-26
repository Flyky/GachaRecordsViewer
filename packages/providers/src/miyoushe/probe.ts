import { setTimeout as delay } from 'node:timers/promises';
import type { MiyousheClient, QrTicket } from './client.js';
import { ProbeError } from './errors.js';

export type ProbeClient = Pick<MiyousheClient,
  'createQr' | 'queryQr' | 'getLToken' | 'getCookieToken' | 'getRoles' | 'generateAuthKey' | 'getHistoryPage'>;

export type ProbeEvent =
  | { stage: 'qr'; status: 'waiting' | 'scanned' | 'confirmed' }
  | { stage: 'ltoken'; available: boolean; failure?: ReturnType<ProbeError['toJSON']> }
  | { stage: 'roles'; roles: { uid: string; region: string }[] }
  | { stage: 'history'; page: number; count: number };

export interface ProbeOptions {
  uid?: string;
  region?: 'cn_gf01' | 'cn_qd01';
  pool?: string;
  pages?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  onQr: (ticket: QrTicket) => Promise<void>;
  onEvent?: (event: ProbeEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function maskId(value: string): string {
  return value.length <= 4 ? '****' : `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/** A bounded read-only probe. Returned events and summary never contain credentials. */
export async function runProbe(client: ProbeClient, options: ProbeOptions) {
  const pool = options.pool ?? '301';
  const pages = options.pages ?? 2;
  const maxWaitMs = options.maxWaitMs ?? 180000;
  if (!['100', '200', '301', '302', '500'].includes(pool) || ![1, 2].includes(pages) ||
    !Number.isInteger(maxWaitMs) || maxWaitMs < 1000 || maxWaitMs > 180000 ||
    (options.uid !== undefined && !/^\d{5,12}$/.test(options.uid)) ||
    (options.region !== undefined && !['cn_gf01', 'cn_qd01'].includes(options.region))) {
    throw new ProbeError('protocol', 'options');
  }

  const sleep = async (ms: number) => {
    if (options.signal?.aborted) throw new ProbeError('cancelled', 'probe');
    try {
      if (options.sleep) await options.sleep(ms);
      else await delay(ms, undefined, options.signal ? { signal: options.signal } : undefined);
    } catch {
      throw new ProbeError('cancelled', 'probe');
    }
    if (options.signal?.aborted) throw new ProbeError('cancelled', 'probe');
  };

  if (options.signal?.aborted) throw new ProbeError('cancelled', 'probe');
  const ticket = await client.createQr();
  const deadline = Math.min(ticket.expiresAt, Date.now() + maxWaitMs);
  await options.onQr(ticket);
  let credentials;
  let lastState;
  while (!credentials) {
    if (Date.now() >= deadline) throw new ProbeError('expired', 'queryQr');
    if (options.signal?.aborted) throw new ProbeError('cancelled', 'queryQr');
    const state = await client.queryQr(ticket);
    if (Date.now() >= deadline) throw new ProbeError('expired', 'queryQr');
    if (state.status !== lastState) options.onEvent?.({ stage: 'qr', status: state.status });
    lastState = state.status;
    if (state.status === 'confirmed') credentials = state.credentials;
    else await sleep(Math.min(2000, Math.max(1, deadline - Date.now())));
  }

  await sleep(350);
  let ltoken = false;
  try {
    await client.getLToken(credentials);
    ltoken = true;
    options.onEvent?.({ stage: 'ltoken', available: true });
  } catch (error) {
    if (!(error instanceof ProbeError) || error.code === 'cancelled') throw error;
    options.onEvent?.({ stage: 'ltoken', available: false, failure: error.toJSON() });
    // An official challenge is not retried or worked around through another endpoint.
    if (error.code === 'verification_required') throw error;
  }

  await sleep(350);
  const cookieToken = await client.getCookieToken(credentials);
  await sleep(350);
  const roles = await client.getRoles(credentials, cookieToken);
  options.onEvent?.({ stage: 'roles', roles: roles.map((role) => ({ uid: maskId(role.uid), region: role.region })) });
  const candidates = options.region ? roles.filter((candidate) => candidate.region === options.region) : roles;
  const role = options.uid === undefined && candidates.length === 1
    ? candidates[0] : candidates.find((candidate) => candidate.uid === options.uid);
  if (!role) throw new ProbeError(options.uid ? 'role_mismatch' : 'role_required', 'roles');

  await sleep(350);
  const authkey = await client.generateAuthKey(credentials, role);
  let cursor = '0';
  let recordCount = 0;
  let pagesRead = 0;
  let reachedEnd = false;
  for (let page = 1; page <= pages; page++) {
    await sleep(1000);
    const result = await client.getHistoryPage(authkey, role, pool, cursor);
    pagesRead++;
    recordCount += result.count;
    options.onEvent?.({ stage: 'history', page, count: result.count });
    if (result.nextId === null) { reachedEnd = true; break; }
    if (result.nextId === cursor) throw new ProbeError('protocol', 'history');
    cursor = result.nextId;
  }

  return {
    result: 'sample_verified' as const,
    game: role.gameBiz,
    region: role.region,
    uid: maskId(role.uid),
    pool,
    pagesRead,
    recordCount,
    reachedEnd,
    credentials: { stoken: true, ltoken, cookieToken: true },
    persisted: false,
  };
}
