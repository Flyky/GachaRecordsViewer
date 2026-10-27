import { randomUUID } from 'node:crypto';
import type { MiyousheQrSession } from '@gacha/contracts';
import { CommunityError } from '@gacha/db';
import { createDevice, MiyousheClient, ProbeError, type DeviceContext, type QrTicket } from '@gacha/providers';
import { ApiError } from '../auth/security.js';
import type { communityService, CommunityTarget } from './service.js';

export interface QrOptions {
  client?: (device: DeviceContext, signal: AbortSignal) => Pick<MiyousheClient, 'createQr' | 'queryQr'>;
}
interface Entry {
  id: string; owner: string; sessionHash: string; status: MiyousheQrSession['status']; expiresAt: number;
  device: DeviceContext; controller: AbortController; ticket?: QrTicket; target?: CommunityTarget;
  nextPoll: number; polls: number; inFlight: boolean; committing: boolean; finishedAt?: number;
  communityAccountId?: string; code?: string;
}
const active = (entry: Entry) => ['creating', 'waiting', 'scanned', 'confirming'].includes(entry.status);
const interval = 2000, lifetime = 180000, retention = 300000, maxPolls = 90, capacity = 128;
export function qrService(community: ReturnType<typeof communityService>, options: QrOptions = {}, now = Date.now) {
  const entries = new Map<string, Entry>();
  let closed = false;
  function finish(entry: Entry, status: Entry['status'], code?: string) {
    entry.status = status; entry.finishedAt = now(); delete entry.ticket;
    if (code) entry.code = code;
    entry.controller.abort();
  }
  function cleanup() {
    for (const [id, entry] of entries) {
      if (active(entry) && !entry.committing && now() >= entry.expiresAt) finish(entry, 'expired', 'QR_EXPIRED');
      if (entry.finishedAt !== undefined && now() - entry.finishedAt >= retention) entries.delete(id);
    }
  }
  const timer = setInterval(cleanup, 5000); timer.unref();
  function view(entry: Entry): MiyousheQrSession {
    return { id: entry.id, status: entry.status, expiresAt: new Date(entry.expiresAt).toISOString(),
      pollAfterMs: active(entry) ? Math.max(entry.inFlight ? interval : 0, entry.nextPoll - now(), 0) : 0,
      ...(entry.communityAccountId ? { communityAccountId: entry.communityAccountId } : {}), ...(entry.code ? { code: entry.code } : {}) };
  }
  function owned(owner: string, sessionHash: string, id: string) {
    cleanup(); const entry = entries.get(id);
    if (!entry || entry.owner !== owner || entry.sessionHash !== sessionHash) throw new ApiError(404, 'QR_NOT_FOUND');
    return entry;
  }
  function assertLive(entry: Entry) {
    if (closed || !active(entry)) throw new ApiError(409, 'QR_NO_LONGER_ACTIVE');
    if (now() >= entry.expiresAt) throw new ApiError(410, 'QR_EXPIRED');
  }
  function failed(entry: Entry, error: unknown) {
    if (!active(entry)) return;
    const code = error instanceof ProbeError ? `MIYOUSHE_${error.code.toUpperCase()}`
      : error instanceof ApiError || error instanceof CommunityError ? error.code : 'QR_FAILED';
    finish(entry, code === 'QR_EXPIRED' || code === 'MIYOUSHE_EXPIRED' ? 'expired'
      : code === 'MIYOUSHE_CANCELLED' ? 'cancelled' : code === 'MIYOUSHE_VERIFICATION_REQUIRED' ? 'verification_required' : 'failed', code);
  }
  const client = (entry: Entry) => options.client?.(entry.device, entry.controller.signal)
    ?? new MiyousheClient({ device: entry.device, signal: entry.controller.signal });
  return {
    close() { closed = true; clearInterval(timer); for (const entry of entries.values()) entry.controller.abort(); entries.clear(); },
    async create(owner: string, sessionHash: string, communityAccountId?: string) {
      if (closed) throw new ApiError(503, 'QR_UNAVAILABLE');
      cleanup();
      if ([...entries.values()].some((entry) => entry.owner === owner && active(entry))) throw new ApiError(409, 'QR_ALREADY_ACTIVE');
      if (entries.size >= capacity) throw new ApiError(503, 'QR_CAPACITY');
      const entry: Entry = { id: randomUUID(), owner, sessionHash, status: 'creating', expiresAt: now() + lifetime,
        device: createDevice(), controller: new AbortController(), nextPoll: 0, polls: 0, inFlight: true, committing: false };
      entries.set(entry.id, entry);
      try {
        if (communityAccountId) entry.target = await community.target(owner, communityAccountId);
        assertLive(entry);
        const ticket = await client(entry).createQr();
        assertLive(entry);
        if (!Number.isFinite(ticket.expiresAt)) throw new ProbeError('protocol', 'createQr');
        entry.expiresAt = Math.min(entry.expiresAt, ticket.expiresAt);
        assertLive(entry);
        entry.ticket = ticket; entry.status = 'waiting'; entry.nextPoll = now() + interval; entry.inFlight = false;
        return { session: view(entry), qrUrl: ticket.url };
      } catch (error) { entries.delete(entry.id); entry.controller.abort(); throw error; }
    },
    get(owner: string, sessionHash: string, id: string) { return { session: view(owned(owner, sessionHash, id)) }; },
    cancel(owner: string, sessionHash: string, id: string) {
      const entry = owned(owner, sessionHash, id);
      if (entry.committing && active(entry)) throw new ApiError(409, 'QR_COMMITTING');
      if (entry.status === 'confirmed') throw new ApiError(409, 'QR_ALREADY_CONFIRMED');
      if (active(entry)) finish(entry, 'cancelled', 'QR_CANCELLED');
      return { session: view(entry) };
    },
    async poll(owner: string, sessionHash: string, id: string) {
      const entry = owned(owner, sessionHash, id);
      if (!active(entry) || entry.inFlight || now() < entry.nextPoll) return { session: view(entry) };
      if (!entry.ticket || entry.polls >= maxPolls) { finish(entry, 'expired', 'QR_POLL_LIMIT'); return { session: view(entry) }; }
      entry.inFlight = true; entry.polls++; entry.nextPoll = now() + interval;
      try {
        const state = await client(entry).queryQr(entry.ticket);
        assertLive(entry);
        if (state.status !== 'confirmed') {
          // A delayed Init response must not regress a previously scanned session.
          if (entry.status !== 'scanned' || state.status === 'scanned') entry.status = state.status;
        } else {
          delete entry.ticket; entry.status = 'confirming';
          const account = await community.authorize(owner, state.credentials, entry.device, {
            sessionHash, now, claim: () => { assertLive(entry); entry.committing = true; },
          }, entry.target, entry.controller.signal);
          entry.communityAccountId = account.id; finish(entry, 'confirmed');
        }
      } catch (error) { failed(entry, error); }
      finally { entry.inFlight = false; }
      return { session: view(entry) };
    },
  };
}
