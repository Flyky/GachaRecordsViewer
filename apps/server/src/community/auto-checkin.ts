import { randomInt, randomUUID } from 'node:crypto';
import { AUTO_CHECKIN_MIN_MINUTE as MIN, AUTO_CHECKIN_MAX_MINUTE as MAX, AUTO_CHECKIN_STEP_MINUTE as STEP,
  type AutoCheckinInput, type AutoCheckinSettings, type AutoCheckinRun, type CheckinJob } from '@gacha/contracts';
import { autoCheckinRepository, type DatabaseConnection } from '@gacha/db';
import { ApiError } from '../auth/security.js';
import { activeOperation, operationCode } from '../tasks.js';
import type { checkinService } from './checkin.js';

export interface AutoCheckinOptions { random?: (min: number, maxExclusive: number) => number; start?: boolean }
type State = AutoCheckinSettings & { version: 1 };
type Executor = Pick<ReturnType<typeof checkinService>, 'get' | 'create' | 'cancel'>;
const DAY = 86400000, day = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const midnight = (date: string) => Date.parse(`${date}T00:00:00+08:00`);
const iso = (at: number) => new Date(at).toISOString();
const defaults = (): State => ({ version: 1, enabled: false, startMinute: MIN, endMinute: MAX, timezone: 'Asia/Shanghai', nextRunAt: null, lastRun: null, updatedAt: null });
export function validAutoCheckinRange(input: AutoCheckinInput) {
  return typeof input.enabled === 'boolean' && Number.isInteger(input.startMinute) && Number.isInteger(input.endMinute)
    && input.startMinute >= MIN && input.endMinute <= MAX && input.startMinute < input.endMinute
    && (input.startMinute - MIN) % STEP === 0 && (input.endMinute - MIN) % STEP === 0;
}
function parse(raw: string | undefined): State {
  if (raw === undefined) return defaults();
  try {
    const value = JSON.parse(raw) as State;
    const date = (input: unknown) => input === null || typeof input === 'string' && Number.isFinite(Date.parse(input));
    if (value.version !== 1 || !validAutoCheckinRange(value) || value.timezone !== 'Asia/Shanghai' || !date(value.nextRunAt) || !date(value.updatedAt)) throw new Error();
    if (value.lastRun !== null) {
      const run = value.lastRun;
      if (!run || !/^\d{4}-\d{2}-\d{2}$/.test(run.day) || typeof run.scheduledFor !== 'string' || !date(run.scheduledFor)
        || run.day !== day(Date.parse(run.scheduledFor)) || typeof run.jobId !== 'string' || !date(run.startedAt) || !date(run.finishedAt)
        || !['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'skipped', 'interrupted'].includes(run.status)
        || ![run.signed, run.alreadySigned, run.failed].every((number) => Number.isInteger(number) && number >= 0 && number <= 512)) throw new Error();
    }
    return value;
  } catch { return defaults(); }
}
function publicState(value: State): AutoCheckinSettings {
  return structuredClone({ enabled: value.enabled, startMinute: value.startMinute, endMinute: value.endMinute, timezone: value.timezone,
    nextRunAt: value.nextRunAt, lastRun: value.lastRun, updatedAt: value.updatedAt });
}

export function autoCheckinService(connection: DatabaseConnection, checkin: Executor, options: AutoCheckinOptions = {}, now = Date.now) {
  const repo = autoCheckinRepository(connection), random = options.random ?? randomInt;
  let chain = Promise.resolve(), closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  function serial<T>(action: () => Promise<T>) {
    const result = chain.then(action); chain = result.then(() => undefined, () => undefined); return result;
  }
  function plan(state: State) {
    const at = now(), today = day(at);
    let date = state.lastRun && state.lastRun.day >= today ? day(midnight(state.lastRun.day) + DAY) : today;
    let low = Math.max(midnight(date) + state.startMinute * 60000, Math.ceil(at / 1000) * 1000);
    let high = midnight(date) + state.endMinute * 60000;
    if (low >= high) { date = day(midnight(date) + DAY); low = midnight(date) + state.startMinute * 60000; high = midnight(date) + state.endMinute * 60000; }
    const seconds = random(low / 1000, high / 1000);
    if (!Number.isInteger(seconds) || seconds * 1000 < low || seconds * 1000 >= high) throw new Error('Invalid random time');
    return iso(seconds * 1000);
  }
  async function write(owner: string, raw: string | undefined, state: State) {
    if (!await repo.replace(owner, raw, JSON.stringify(state))) throw new ApiError(409, 'AUTO_CHECKIN_BUSY');
  }
  const summary = (run: AutoCheckinRun, job: CheckinJob): AutoCheckinRun => ({ ...run, status: job.code === 'AUTO_CHECKIN_WINDOW_MISSED' ? 'skipped' : job.status,
    startedAt: job.createdAt, finishedAt: job.finishedAt, code: job.code ?? job.results.find((row) => row.status === 'failed' || row.status === 'verification_required')?.code ?? null,
    signed: job.results.filter((row) => row.status === 'signed').length, alreadySigned: job.results.filter((row) => row.status === 'already_signed').length,
    failed: job.results.filter((row) => row.status === 'failed' || row.status === 'verification_required').length });
  async function reconcile(owner: string, state: State) {
    const run = state.lastRun; if (!run || !['queued', 'running'].includes(run.status)) return;
    const job = checkin.get(owner);
    state.lastRun = job?.id === run.jobId ? summary(run, job) : { ...run, status: 'interrupted', finishedAt: iso(now()), code: 'AUTO_CHECKIN_INTERRUPTED' };
  }
  async function tickOwner(owner: string, raw: string) {
    const state = parse(raw), before = JSON.stringify(state);
    await reconcile(owner, state);
    if (state.enabled) {
      const planned = state.nextRunAt ? Date.parse(state.nextRunAt) : NaN, today = day(now());
      if (!Number.isFinite(planned)) state.nextRunAt = plan(state);
      else if (planned <= now()) {
        const scheduledDay = day(planned), end = midnight(scheduledDay) + state.endMinute * 60000;
        const ongoing = checkin.get(owner);
        if (state.lastRun && state.lastRun.day >= scheduledDay) state.nextRunAt = plan(state);
        else if (scheduledDay !== today || now() > end) {
          state.lastRun = { day: scheduledDay, scheduledFor: iso(planned), jobId: randomUUID(), startedAt: null, finishedAt: iso(now()), status: 'skipped', code: 'AUTO_CHECKIN_WINDOW_MISSED', signed: 0, alreadySigned: 0, failed: 0 };
          state.nextRunAt = plan(state);
        } else if (!closed && (!ongoing || !activeOperation(ongoing))) {
          const run: AutoCheckinRun = { day: scheduledDay, scheduledFor: iso(planned), jobId: randomUUID(), startedAt: null, finishedAt: null, status: 'queued', code: null, signed: 0, alreadySigned: 0, failed: 0 };
          state.lastRun = run; state.nextRunAt = plan(state);
          await write(owner, raw, state); // Claim before any upstream action. Never retry a claimed day blindly.
          const claimed = JSON.stringify(state);
          if (closed) return;
          try {
            if (now() > end || day(now()) !== scheduledDay) { run.status = 'skipped'; run.finishedAt = iso(now()); run.code = 'AUTO_CHECKIN_WINDOW_MISSED'; }
            else state.lastRun = summary(run, checkin.create(owner, run.jobId, end));
          } catch (error) { run.status = 'failed'; run.finishedAt = iso(now()); run.code = operationCode(error); }
          await write(owner, claimed, state); return;
        }
      }
    }
    if (JSON.stringify(state) !== before) await write(owner, raw, state);
  }
  const tick = () => serial(async () => {
    if (closed) return 30000;
    const rows = await repo.list(); let delay = 30000;
    for (const row of rows) {
      try { await tickOwner(row.owner_id, row.payload_json); } catch { /* Retry persistence on the next tick; an unpersisted claim never starts a job. */ }
      const state = parse(await repo.load(row.owner_id));
      if (state.enabled && state.nextRunAt) delay = Math.min(delay, Math.max(1000, Date.parse(state.nextRunAt) - now()));
    }
    return delay;
  });
  function arm(delay = 0) {
    if (closed || options.start === false) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick().catch(() => 30000).then(arm); }, delay); timer.unref();
  }
  arm();
  return {
    tick,
    get: (owner: string) => serial(async () => publicState(parse(await repo.load(owner)))),
    save: (owner: string, input: AutoCheckinInput) => serial(async () => {
      if (closed) throw new ApiError(503, 'OPERATION_UNAVAILABLE');
      if (!validAutoCheckinRange(input)) throw new ApiError(400, 'AUTO_CHECKIN_RANGE_INVALID');
      const raw = await repo.load(owner), state = parse(raw);
      await reconcile(owner, state);
      const changed = state.enabled !== input.enabled || state.startMinute !== input.startMinute || state.endMinute !== input.endMinute;
      Object.assign(state, input); state.updatedAt = iso(now());
      if (changed) state.nextRunAt = input.enabled ? plan(state) : null;
      await write(owner, raw, state);
      if (!input.enabled && state.lastRun && checkin.get(owner)?.id === state.lastRun.jobId) checkin.cancel(owner);
      arm(); return publicState(state);
    }),
    finished: (owner: string, job: CheckinJob) => serial(async () => {
      if (closed) return;
      const raw = await repo.load(owner), state = parse(raw);
      if (state.lastRun?.jobId === job.id) { state.lastRun = summary(state.lastRun, job); await write(owner, raw, state); }
    }),
    close: async () => { closed = true; if (timer) clearTimeout(timer); await chain; },
  };
}
