import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DailyAnalysisResponse, ItemAnalysisResponse, LuckAnalysisResponse, MonthlyAnalysisResponse } from '@gacha/contracts';
import { openConnection, repositories, uigfRepository, type DatabaseConnection } from '@gacha/db';
import { decodeUigf } from '@gacha/uigf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/security.js';
import { analysisFixture } from './analysis-fixture.js';

for (const driver of ['sqlite', 'postgres'] as const) {
  describe.skipIf(driver === 'postgres' && !process.env.TEST_DATABASE_URL)(`R10 ${driver} analysis API`, () => {
    let connection: DatabaseConnection, app: Awaited<ReturnType<typeof buildApp>>, cleanup: () => Promise<void>;
    const key = randomBytes(32), origin = 'https://analysis.example.test';
    let a: string, b: string, primary: string, secondary: string, empty: string;
    beforeAll(async () => {
      if (driver === 'sqlite') {
        const fixture = await temporaryDirectory(); cleanup = fixture.cleanup;
        connection = await openConnection({ driver, filename: join(fixture.directory, 'analysis.sqlite') });
      } else {
        const fixture = await temporaryPostgres(); cleanup = fixture.cleanup;
        connection = await openConnection({ driver, url: fixture.url });
      }
      await connection.migrate();
      const passwordHash = await hashPassword('12345678');
      for (const id of ['a', 'b']) await repositories(connection).users.create({ id, username: `r10_${id}`, passwordHash });
      const repository = uigfRepository(connection), input = decodeUigf(analysisFixture());
      const saved = await repository.import('a', input, [0, 1, 2], await repository.preview('a', input), 'synthetic');
      [primary, secondary, empty] = saved.profiles.map((profile) => profile.targetProfileId!) as [string, string, string];
      app = await buildApp({ database: connection, auth: { connection, credentialKey: key, publicUrl: origin,
        adminPassword: 'Synthetic-admin-only', adminSessionVersion: 'synthetic', now: () => Date.parse('2026-12-31T16:30:00Z') } });
      for (const name of ['a', 'b']) {
        const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: `r10_${name}`, password: '12345678' } });
        expect(response.statusCode).toBe(200);
        if (name === 'a') a = String(response.headers['set-cookie']).split(';')[0]!; else b = String(response.headers['set-cookie']).split(';')[0]!;
      }
    });
    afterAll(async () => { await app?.close(); key.fill(0); await cleanup?.(); });
    const get = (kind: string, query: Record<string, string> = {}, id = primary, cookie = a) => app.inject({
      url: `/api/profiles/${id}/analysis/${kind}?${new URLSearchParams(query)}`, headers: { cookie },
    });
    it('reconciles item ID groups, monthly series and leap-day calendars with complete and incomplete metadata', async () => {
      const response = await get('items'); expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      const items = response.json<ItemAnalysisResponse>();
      expect(items).toMatchObject({ historyCount: 9, dataVersion: 1, itemType: 'character', order: 'desc', selectedTypeCount: 4, otherTypeCount: 3, unclassified: { total: 2 } });
      expect(items.groups.map((group) => [group.rank, group.total, group.items.length])).toEqual([[5, 2, 1], [4, 2, 1]]);
      expect(items.groups[0]!.items[0]!.itemId).toBe('10000016');
      const weapons = (await get('items', { itemType: 'weapon', order: 'asc' })).json<ItemAnalysisResponse>();
      expect(weapons.groups.map((group) => [group.rank, group.total])).toEqual([[5, 1], [4, 1], [3, 1]]);
      const monthly = (await get('monthly')).json<MonthlyAnalysisResponse>();
      expect(monthly.months).toHaveLength(14);
      expect(monthly.months[1]).toEqual({ month: '2024-01', total: 0, fiveStars: 0, standard: 0, characterEvent: 0, weaponEvent: 0 });
      expect(monthly.months[2]).toEqual({ month: '2024-02', total: 5, fiveStars: 2, standard: 1, characterEvent: 2, weaponEvent: 1 });
      expect(monthly.totals).toEqual({ total: 9, fiveStars: 3, standard: 1, characterEvent: 3, weaponEvent: 3 });
      expect(monthly.fiveStarCountsIncomplete).toBe(true);
      const daily = (await get('daily', { year: '2024' })).json<DailyAnalysisResponse>();
      expect(daily).toMatchObject({ historyCount: 9, total: 5, maxDailyCount: 5, hasRecords: true, pool: null, availableYears: [2027, 2025, 2024, 2023] });
      expect(daily.days).toHaveLength(366); expect(daily.days.find((day) => day.date === '2024-02-29')?.count).toBe(5);
      expect((await get('daily', { year: '2024', pool: '301' })).json<DailyAnalysisResponse>().total).toBe(2);
      expect((await get('daily', { year: '2024', pool: '' })).json<DailyAnalysisResponse>().total).toBe(5);
      for (const kind of ['items', 'monthly', 'daily']) expect((await get(kind)).body).not.toMatch(/password_hash|owner_id|metadata_json|credential/);
    });
    it('uses Shanghai current year independently of game timezone, handles empty histories and prevents scope/filter injection', async () => {
      const daily = (await get('daily', {}, secondary)).json<DailyAnalysisResponse>();
      expect(daily).toMatchObject({ year: 2027, timezone: -5, calendarTimeZone: 'Asia/Shanghai', total: 0, maxDailyCount: 0, hasRecords: false });
      expect((await get('daily', { year: '2026' }, secondary)).json<DailyAnalysisResponse>().days.find((day) => day.date === '2026-12-31')?.count).toBe(1);
      expect((await get('monthly', {}, empty)).json<MonthlyAnalysisResponse>()).toMatchObject({ historyCount: 0, months: [], totals: { total: 0, fiveStars: 0 } });
      expect((await get('items', { itemType: 'weapon' }, empty)).json<ItemAnalysisResponse>().groups.map((group) => group.items)).toEqual([[], [], []]);
      const calendar = (await get('daily', { year: '2024' }, empty)).json<DailyAnalysisResponse>();
      expect(calendar.days).toHaveLength(366); expect(calendar.days.every((day) => day.count === 0)).toBe(true);
      for (const kind of ['items', 'monthly', 'daily', 'luck']) {
        expect((await app.inject(`/api/profiles/${primary}/analysis/${kind}`)).statusCode).toBe(401);
        expect((await get(kind, {}, primary, b)).statusCode).toBe(404);
        expect((await get(kind, {}, 'not-a-profile')).statusCode).toBe(404);
        expect((await get(kind, { name: '查询页条件不得注入分析' })).statusCode).toBe(400);
        expect((await get(kind, { ownerId: 'b' })).statusCode).toBe(400);
      }
      for (const query of [{ year: '0' }, { year: '10000' }, { year: '2024.5' }, { pool: '400' }, { pool: '301,302' }]) expect((await get('daily', query)).statusCode).toBe(400);
      expect((await get('items', { itemType: 'other' })).statusCode).toBe(400);
      expect((await get('items', { order: 'bad' })).statusCode).toBe(400);
    });
    it('exposes full-history luck metrics with matching context, null empty samples and no private fields', async () => {
      const response = await get('luck'); expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      const luck = response.json<LuckAnalysisResponse>(), monthly = (await get('monthly')).json<MonthlyAnalysisResponse>();
      expect(luck).toMatchObject({ profileId: primary, uid: monthly.uid, dataVersion: monthly.dataVersion,
        dictionaryVersion: monthly.dictionaryVersion, historyCount: monthly.historyCount, metadataIssues: monthly.metadataIssues });
      expect(luck.pools.map((entry) => entry.pool)).toEqual(['301', '302', '200', '500']);
      expect(luck.pools.find((entry) => entry.pool === '301')).toMatchObject({ fiveStars: 1, completeIntervals: 0, averageFiveStarPulls: null });
      expect(luck.character).toMatchObject({ smallAttempts: 0, smallWinRate: null, averageUpPulls: null });
      expect((await get('luck', {}, empty)).json<LuckAnalysisResponse>().pools.every((entry) => entry.totalPulls === 0 && entry.averageFiveStarPulls === null)).toBe(true);
      expect(response.body).not.toMatch(/password_hash|owner_id|metadata_json|credential/);
    });
    it('reflects backfilled history and its data version without leaking additional snapshot fields into exports', async () => {
      const document = analysisFixture(); document.hk4e = [document.hk4e![0]!];
      document.hk4e[0]!.list = [{ ...document.hk4e[0]!.list[0]!, id: '9007199254740993000', time: '2023-11-01 00:00:00' }];
      const input = decodeUigf(document), repository = uigfRepository(connection);
      await repository.import('a', input, [0], await repository.preview('a', input), 'synthetic-backfill');
      const monthly = (await get('monthly')).json<MonthlyAnalysisResponse>();
      expect(monthly).toMatchObject({ historyCount: 10, dataVersion: 2, totals: { total: 10, fiveStars: 4 } });
      expect(monthly.months[0]!.month).toBe('2023-11');
      expect((await get('items')).json<ItemAnalysisResponse>().groups[0]!.total).toBe(3);
      expect((await get('daily', { year: '2023' })).json<DailyAnalysisResponse>().total).toBe(2);
      const exported = await app.inject({ url: `/api/uigf/export/${primary}`, headers: { cookie: a } });
      expect(exported.statusCode).toBe(200); expect(exported.json().hk4e[0].list).toHaveLength(10);
      expect(exported.body).not.toMatch(/dataVersion|profileId|owner_id/);
    });
  });
}
