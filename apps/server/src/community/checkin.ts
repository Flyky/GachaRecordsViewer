import { randomUUID } from 'node:crypto';
import type { CheckinJob, CheckinResult } from '@gacha/contracts';
import { GameCheckinClient, ProbeError, type CheckinSession, type DeviceContext } from '@gacha/providers';
import { ApiError } from '../auth/security.js';
import { operationCode, ownedTaskQueue, requestPacer, type PaceOptions } from '../tasks.js';
import type { communityService } from './service.js';

type Client = Pick<GameCheckinClient, 'getCookieToken' | 'listRoles' | 'status' | 'sign'>;
export interface CheckinOptions extends PaceOptions { client?: (device: DeviceContext, signal: AbortSignal) => Client }
export function checkinService(community: ReturnType<typeof communityService>, options: CheckinOptions = {}, now = Date.now) {
  const pace = requestPacer(options), timestamp = () => new Date(now()).toISOString();
  const tasks = ownedTaskQueue<CheckinJob, true>(async (owner, job, _payload, signal) => {
    const accounts = await community.list(owner); job.accountsTotal = accounts.length;
    if (!accounts.length) throw new ApiError(422, 'NO_COMMUNITY_ACCOUNTS');
    const started = Date.now();
    for (const account of accounts) {
      signal.throwIfAborted();
      if (Date.now() - started > 1800000 || job.results.length >= 512) throw new ApiError(422, 'OPERATION_LIMIT');
      const first = job.results.length;
      try {
        const saved = await community.storedCredentials(owner, account.id);
        const client = options.client?.(saved.device, signal) ?? new GameCheckinClient({ device: saved.device, signal });
        async function request<T>(action: () => Promise<T>) {
          signal.throwIfAborted();
          if (Date.now() - started > 1800000 || job.results.length > 512) throw new ApiError(422, 'OPERATION_LIMIT');
          await pace(signal);
          if ((await community.target(owner, account.id)).revision !== saved.revision) throw new ApiError(409, 'CREDENTIALS_CHANGED');
          signal.throwIfAborted();
          const result = await action(); signal.throwIfAborted(); return result;
        }
        let cookieToken = saved.credentials.cookieToken;
        const { stoken, mid, accountId, ltoken } = saved.credentials;
        if (stoken && mid) cookieToken = await request(() => client.getCookieToken({ accountId, stoken, mid }));
        if (!cookieToken) throw new ApiError(422, 'COOKIE_TOKEN_REQUIRED');
        const session: CheckinSession = { accountId, cookieToken, ...(mid ? { mid } : {}), ...(ltoken ? { ltoken } : {}) };
        const roles = await request(() => client.listRoles(session));
        if (!roles.length) job.results.push({ communityAccountId: account.id, accountId, game: null, uid: null, region: null, nickname: null, status: 'no_roles', code: null });
        for (const role of roles) {
          if (job.results.length >= 512) throw new ApiError(422, 'OPERATION_LIMIT');
          const row: CheckinResult = { communityAccountId: account.id, accountId, game: role.gameBiz, uid: role.uid, region: role.region, nickname: role.nickname, status: 'pending', code: null };
          job.results.push(row); job.updatedAt = timestamp();
          try {
            const info = await request(() => client.status(session, role));
            if (info.signed) { row.status = 'already_signed'; continue; }
            if (info.firstBind) throw new ApiError(422, 'CHECKIN_FIRST_BIND');
            let already = false;
            try { already = await request(() => client.sign(session, role)); }
            catch (error) {
              // A timed-out POST may have reached the server. Read status once; never blindly repeat it.
              if (!(error instanceof ProbeError) || !['network', 'timeout'].includes(error.code)) throw error;
              const after = await request(() => client.status(session, role)).catch(() => null);
              if (!after?.signed) throw error;
              row.status = 'signed'; continue;
            }
            const after = await request(() => client.status(session, role));
            if (!after.signed) throw new ApiError(502, 'CHECKIN_NOT_CONFIRMED');
            row.status = already ? 'already_signed' : 'signed';
          } catch (error) {
            signal.throwIfAborted();
            row.status = error instanceof ProbeError && error.code === 'verification_required' ? 'verification_required' : 'failed'; row.code = operationCode(error);
          } finally { job.updatedAt = timestamp(); }
        }
      } catch (error) {
        signal.throwIfAborted();
        job.results.push({ communityAccountId: account.id, accountId: account.accountId, game: null, uid: null, region: null, nickname: null,
          status: error instanceof ProbeError && error.code === 'verification_required' ? 'verification_required' : 'failed', code: operationCode(error) });
      } finally {
        job.accountsCompleted++; job.updatedAt = timestamp();
        if (job.results.length === first && !signal.aborted) job.code = 'CHECKIN_NO_RESULT';
      }
    }
    job.status = job.results.some((row) => row.status === 'failed' || row.status === 'verification_required') ? 'partial' : 'completed';
  }, now);
  return {
    create(owner: string) {
      const at = timestamp();
      return tasks.create(owner, { id: randomUUID(), status: 'queued', createdAt: at, updatedAt: at, finishedAt: null, code: null,
        results: [], accountsCompleted: 0, accountsTotal: 0 }, true);
    },
    get: tasks.get, cancel: tasks.cancel, close: tasks.close,
  };
}
