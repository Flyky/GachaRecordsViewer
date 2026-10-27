import { setTimeout as delay } from 'node:timers/promises';
import type { OperationJob } from '@gacha/contracts';
import { CommunityError, ImportError, SyncError } from '@gacha/db';
import { ProbeError } from '@gacha/providers';
import { ApiError } from './auth/security.js';

export const activeOperation = (job: OperationJob) => job.status === 'queued' || job.status === 'running';
export function operationCode(error: unknown) {
  if (error instanceof ProbeError) return `MIYOUSHE_${error.code.toUpperCase()}`;
  if (error instanceof ApiError || error instanceof ImportError || error instanceof SyncError || error instanceof CommunityError) return error.code;
  return 'OPERATION_FAILED';
}
export interface PaceOptions { wait?: (ms: number, signal: AbortSignal) => Promise<void> }
export function requestPacer(options: PaceOptions = {}) {
  let next = 0;
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const now = Date.now(), wait = Math.max(0, next - now); next = Math.max(now, next) + 1000;
    await (options.wait ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(wait, signal);
    signal.throwIfAborted();
  };
}

/** Bounded owner-scoped FIFO; private payloads never enter the public job or persistence. */
export function ownedTaskQueue<T extends OperationJob, P>(run: (owner: string, job: T, payload: P, signal: AbortSignal) => Promise<void>, now = Date.now) {
  type Entry = { owner: string; job: T; payload: P | undefined; controller: AbortController };
  const entries = new Map<string, Entry>(), queue: Entry[] = [];
  let running: Promise<void> | undefined, closed = false;
  const touch = (job: T) => { job.updatedAt = new Date(now()).toISOString(); };
  async function drain() {
    while (queue.length && !closed) {
      const entry = queue.shift()!;
      if (!activeOperation(entry.job) || entry.payload === undefined) continue;
      entry.job.status = 'running'; touch(entry.job);
      try {
        await run(entry.owner, entry.job, entry.payload, entry.controller.signal);
        if (entry.controller.signal.aborted) entry.job.status = 'cancelled';
        else if (entry.job.status === 'running') entry.job.status = 'completed';
      } catch (error) {
        entry.job.status = entry.controller.signal.aborted ? 'cancelled' : 'failed';
        entry.job.code = entry.controller.signal.aborted ? 'OPERATION_CANCELLED' : operationCode(error);
      } finally {
        entry.payload = undefined; touch(entry.job); entry.job.finishedAt = entry.job.updatedAt;
      }
    }
  }
  const kick = () => { running ??= drain().finally(() => { running = undefined; if (queue.length && !closed) kick(); }); };
  return {
    create(owner: string, job: T, payload: P) {
      if (closed) throw new ApiError(503, 'OPERATION_UNAVAILABLE');
      const previous = entries.get(owner);
      if (previous && activeOperation(previous.job)) throw new ApiError(409, 'OPERATION_BUSY');
      if ([...entries.values()].filter((entry) => activeOperation(entry.job)).length >= 16) throw new ApiError(429, 'OPERATION_QUEUE_FULL');
      for (const [key, entry] of entries) if (!activeOperation(entry.job) && now() - Date.parse(entry.job.updatedAt) > 86400000) entries.delete(key);
      if (!entries.has(owner) && entries.size >= 128) {
        const oldest = [...entries.values()].find((entry) => !activeOperation(entry.job));
        if (oldest) entries.delete(oldest.owner);
      }
      const entry = { owner, job, payload, controller: new AbortController() }; entries.set(owner, entry); queue.push(entry); kick();
      return structuredClone(job);
    },
    get(owner: string) { const entry = entries.get(owner); return entry ? structuredClone(entry.job) : null; },
    cancel(owner: string) {
      const entry = entries.get(owner);
      if (!entry) throw new ApiError(404, 'OPERATION_NOT_FOUND');
      if (activeOperation(entry.job)) {
        entry.controller.abort();
        if (entry.job.status === 'queued') { entry.job.status = 'cancelled'; entry.payload = undefined; touch(entry.job); entry.job.finishedAt = entry.job.updatedAt; }
      }
      return structuredClone(entry.job);
    },
    async close() {
      closed = true;
      for (const entry of entries.values()) { entry.controller.abort(); if (entry.job.status === 'queued') entry.payload = undefined; }
      queue.length = 0; await running;
    },
  };
}
