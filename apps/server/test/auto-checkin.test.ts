import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AutoCheckinInput, CheckinJob } from '@gacha/contracts';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { initializeDeployment } from '../src/deployment.js';
import { autoCheckinService, validAutoCheckinRange } from '../src/community/auto-checkin.js';
import { checkinService } from '../src/community/checkin.js';
import type { communityService } from '../src/community/service.js';

let fixture: Awaited<ReturnType<typeof temporaryDirectory>>, deployment: Awaited<ReturnType<typeof initializeDeployment>>;
let current: number, service: ReturnType<typeof autoCheckinService>;
const jobs = new Map<string, CheckinJob>();
const create = vi.fn((owner: string, id = 'manual-job'): CheckinJob => {
  const job: CheckinJob = { id, status: 'running', createdAt: new Date(current).toISOString(), updatedAt: new Date(current).toISOString(), finishedAt: null, code: null,
    results: [], accountsCompleted: 0, accountsTotal: 0 };
  jobs.set(owner, job); return structuredClone(job);
});
const cancel = vi.fn((owner: string) => { const job = jobs.get(owner)!; job.status = 'cancelled'; return structuredClone(job); });
const executor = { create, cancel, get: (owner: string) => jobs.has(owner) ? structuredClone(jobs.get(owner)!) : null };
const open = (random = (low: number, _high: number) => low, start = false) => autoCheckinService(deployment.connection, executor, { random, start }, () => current);
const input: AutoCheckinInput = { enabled: true, startMinute: 90, endMinute: 1350 };
beforeEach(async () => {
  current = Date.parse('2026-11-03T00:00:00+08:00'); jobs.clear(); create.mockClear(); cancel.mockClear();
  fixture = await temporaryDirectory(); deployment = await initializeDeployment({ dataDirectory: fixture.directory, env: {} });
  for (const id of ['a', 'b']) await deployment.repositories.users.create({ id, username: `auto_${id}`, passwordHash: 'synthetic-unused-hash' });
  service = open();
});
afterEach(async () => { await service.close(); await deployment.connection.close(); deployment.credentialKey.fill(0); await fixture.cleanup(); vi.useRealTimers(); });

it('defaults off for each owner and validates bounds, ordering and ten-minute steps', async () => {
  expect(await service.get('a')).toMatchObject({ enabled: false, startMinute: 90, endMinute: 1350, timezone: 'Asia/Shanghai', nextRunAt: null });
  await service.tick(); expect(create).not.toHaveBeenCalled();
  for (const change of [{ startMinute: 80 }, { endMinute: 1360 }, { startMinute: 95 }, { startMinute: 800, endMinute: 400 }]) {
    expect(validAutoCheckinRange({ ...input, ...change })).toBe(false);
    await expect(service.save('a', { ...input, ...change })).rejects.toMatchObject({ code: 'AUTO_CHECKIN_RANGE_INVALID' });
  }
  expect(validAutoCheckinRange({ ...input, startMinute: 90, endMinute: 90 })).toBe(false);
  await service.save('a', { ...input, enabled: false, startMinute: 100, endMinute: 1340 });
  expect((await service.get('a')).nextRunAt).toBeNull(); expect((await service.get('b')).startMinute).toBe(90);
});

it('persists one random plan per day, executes only its owner, and preserves the completed summary on restart', async () => {
  await service.close(); service = open((low, high) => low + Math.floor((high - low) / 2));
  const saved = await service.save('a', { ...input, startMinute: 120, endMinute: 180 });
  expect(saved.nextRunAt).toBe('2026-11-02T18:30:00.000Z'); // 02:30 Beijing, independently of the host timezone.
  expect((await service.save('a', { ...input, startMinute: 120, endMinute: 180 })).nextRunAt).toBe(saved.nextRunAt);
  current = Date.parse(saved.nextRunAt!); await service.tick();
  expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0]![0]).toBe('a');
  const job = jobs.get('a')!; job.status = 'completed'; job.finishedAt = new Date(current + 1000).toISOString();
  job.results.push({ communityAccountId: 'account-a', accountId: '12345', game: 'hk4e_cn', uid: '123456789', region: 'cn_gf01', nickname: null, status: 'signed', code: null });
  await service.finished('a', job);
  const result = await service.get('a'); expect(result.lastRun).toMatchObject({ status: 'completed', signed: 1, day: '2026-11-03' });
  expect(result.nextRunAt).toBe('2026-11-03T18:30:00.000Z');
  await service.close(); jobs.clear(); service = open(); await service.tick();
  expect(await service.get('a')).toEqual(result); expect(create).toHaveBeenCalledTimes(1);
});

it('recovers an overdue unclaimed plan only within the selected window and skips missed windows', async () => {
  const saved = await service.save('a', { ...input, startMinute: 90, endMinute: 120 });
  await service.close(); current = Date.parse(saved.nextRunAt!) + 5 * 60000; service = open();
  await service.tick(); expect(create).toHaveBeenCalledTimes(1);
  await service.save('b', { ...input, startMinute: 90, endMinute: 120 });
  current = Date.parse('2026-11-03T02:01:00+08:00'); await service.tick();
  expect(create).toHaveBeenCalledTimes(1);
  expect((await service.get('b')).lastRun).toMatchObject({ status: 'skipped', code: 'AUTO_CHECKIN_WINDOW_MISSED' });
  expect((await service.get('b')).nextRunAt).toBe('2026-11-03T17:30:00.000Z');
});

it('samples from the remaining interval when enabled late and schedules tomorrow after the end', async () => {
  current = Date.parse('2026-11-03T10:00:00+08:00');
  expect((await service.save('a', input)).nextRunAt).toBe(new Date(current).toISOString());
  current = Date.parse('2026-11-03T22:30:01+08:00');
  expect((await service.save('b', input)).nextRunAt).toBe('2026-11-03T17:30:00.000Z');
});

it('does not repeat a claimed day after interruption, disable/enable or range changes', async () => {
  const saved = await service.save('a', input); current = Date.parse(saved.nextRunAt!); await service.tick();
  await service.save('a', { ...input, enabled: false }); expect(cancel).toHaveBeenCalledTimes(1);
  await service.save('a', input); await service.tick(); expect(create).toHaveBeenCalledTimes(1);
  await service.save('a', { ...input, startMinute: 120, endMinute: 180 });
  await service.close(); jobs.clear(); service = open(); await service.tick();
  expect(create).toHaveBeenCalledTimes(1);
  expect((await service.get('a')).nextRunAt).toBe('2026-11-03T18:00:00.000Z');
  // A separately claimed running task without an in-memory worker is recorded as interrupted.
  const savedB = await service.save('b', input); current = Date.parse(savedB.nextRunAt!); await service.tick();
  await service.close(); jobs.clear(); service = open(); await service.tick();
  expect((await service.get('b')).lastRun).toMatchObject({ status: 'interrupted', code: 'AUTO_CHECKIN_INTERRUPTED' });
});

it('waits for a manual task without cancelling it and does not execute after disabling', async () => {
  const saved = await service.save('a', input); current = Date.parse(saved.nextRunAt!);
  create('a'); create.mockClear(); await service.tick(); expect(create).not.toHaveBeenCalled();
  expect((await service.get('a')).lastRun).toBeNull();
  jobs.get('a')!.status = 'completed'; current += 1000; await service.tick(); expect(create).toHaveBeenCalledTimes(1);
  await service.save('b', input); create('b'); cancel.mockClear(); await service.save('b', { ...input, enabled: false });
  expect(cancel).not.toHaveBeenCalled();
  const count = create.mock.calls.length; current += 2 * 86400000; await service.tick();
  expect(create.mock.calls.length).toBe(count);
});

it('atomically claims a day when two workers read the same plan', async () => {
  const saved = await service.save('a', input); current = Date.parse(saved.nextRunAt!);
  const other = open();
  try { await Promise.all([service.tick(), other.tick()]); expect(create).toHaveBeenCalledTimes(1); }
  finally { await other.close(); }
});

it('runs from the server timer without a browser and stops waking after close', async () => {
  vi.useFakeTimers(); await service.close(); current = Date.parse('2026-11-03T01:29:40+08:00'); service = open(undefined, true);
  await service.save('a', { ...input, endMinute: 100 }); await vi.advanceTimersByTimeAsync(0);
  expect(create).not.toHaveBeenCalled(); current += 20000; await vi.advanceTimersByTimeAsync(20000);
  expect(create).toHaveBeenCalledTimes(1);
  await service.close(); current += 86400000; await vi.advanceTimersByTimeAsync(86400000);
  expect(create).toHaveBeenCalledTimes(1);
});

it('does not start an automatic batch outside its window after waiting in the shared queue', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const list = vi.fn(async (_owner: string) => { await gate; return []; });
  const worker = checkinService({ list } as unknown as ReturnType<typeof communityService>, {}, () => current);
  try {
    worker.create('manual'); worker.create('auto', 'synthetic-auto-id', current + 1000);
    current += 2000; release();
    await expect.poll(() => worker.get('auto')?.status, { interval: 5 }).toBe('failed');
    expect(worker.get('auto')?.code).toBe('AUTO_CHECKIN_WINDOW_MISSED'); expect(list.mock.calls).toEqual([['manual']]);
  } finally { release(); await worker.close(); }
});
