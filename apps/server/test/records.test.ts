import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { RecordPageResponse } from '@gacha/contracts';
import { openConnection, repositories, uigfRepository, type DatabaseConnection } from '@gacha/db';
import { decodeUigf } from '@gacha/uigf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/security.js';
import { queryFixture, recordId } from './records-fixture.js';

for (const driver of ['sqlite', 'postgres'] as const) {
  describe.skipIf(driver === 'postgres' && !process.env.TEST_DATABASE_URL)(`R09 ${driver} query API`, () => {
    let connection: DatabaseConnection, app: Awaited<ReturnType<typeof buildApp>>, cleanup: () => Promise<void>;
    const key = randomBytes(32), origin = 'https://records.example.test';
    let a: string, b: string, profileId: string, secondaryId: string, emptyId: string, otherId: string;
    beforeAll(async () => {
      if (driver === 'sqlite') {
        const fixture = await temporaryDirectory(); cleanup = fixture.cleanup;
        connection = await openConnection({ driver, filename: join(fixture.directory, 'records.sqlite') });
      } else {
        const fixture = await temporaryPostgres(); cleanup = fixture.cleanup;
        connection = await openConnection({ driver, url: fixture.url });
      }
      await connection.migrate();
      const passwordHash = await hashPassword('12345678');
      for (const id of ['alpha', 'beta']) await repositories(connection).users.create({ id, username: `r09_${id}`, passwordHash });
      const repository = uigfRepository(connection), input = decodeUigf(queryFixture());
      const imported = await repository.import('alpha', input, [0, 1, 2], await repository.preview('alpha', input), 'synthetic');
      [profileId, secondaryId, emptyId] = imported.profiles.map((profile) => profile.targetProfileId!) as [string, string, string];
      const other = queryFixture(); other.hk4e = [other.hk4e![0]!]; other.hk4e[0]!.list = other.hk4e[0]!.list.slice(0, 1);
      const otherInput = decodeUigf(other);
      otherId = (await repository.import('beta', otherInput, [0], await repository.preview('beta', otherInput), 'synthetic')).profiles[0]!.targetProfileId!;
      app = await buildApp({ database: connection, auth: { connection, credentialKey: key, publicUrl: origin, adminPassword: 'Synthetic-admin-only', adminSessionVersion: 'synthetic' } });
      async function login(username: string) {
        const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password: '12345678' } });
        expect(response.statusCode).toBe(200); return String(response.headers['set-cookie']).split(';')[0]!;
      }
      a = await login('r09_alpha'); b = await login('r09_beta');
    });
    afterAll(async () => { await app?.close(); key.fill(0); await cleanup?.(); });
    const get = (query: Record<string, string> = {}, id = profileId, cookie = a) => app.inject({
      url: `/api/profiles/${encodeURIComponent(id)}/records?${new URLSearchParams(query)}`, headers: { cookie },
    });
    it('filters combined values literally and preserves full-history counters including unknown/conflicting rarity', async () => {
      const all = await get({ pageSize: '200', order: 'asc' }); expect(all.statusCode).toBe(200);
      const history = all.json<RecordPageResponse>();
      expect(history).toMatchObject({ total: 40, historyCount: 40, timezone: 8, totalsByPool: { '301': 30, '200': 4, '302': 3, '500': 2, '100': 1 } });
      expect(all.headers['cache-control']).toBe('no-store');
      const filtered = (await get({ pools: '301', itemTypes: 'weapon', ranks: '4', name: '%_', from: '2026-10-27 12:00:00', to: '2026-10-27 12:00:00', order: 'desc' })).json<RecordPageResponse>();
      expect(filtered.total).toBe(1); expect(filtered.records[0]).toMatchObject({ id: recordId(10), groupOrdinal: 10, pity: { count: 6, status: 'exact' }, gachaType: '400' });
      const first = history.records.find((record) => record.id === recordId(1))!;
      expect(first.pity).toMatchObject({ count: 1, status: 'partial-history' });
      for (const index of [20, 21, 22, 25]) expect(history.records.find((record) => record.id === recordId(index))!.pity).toMatchObject({ count: null, status: 'unknown-rarity' });
      expect(history.records.find((record) => record.id === recordId(22))).toMatchObject({ rank: null, metadataStatus: 'conflict' });
      expect(history.records.find((record) => record.id === recordId(26))!.pity).toMatchObject({ count: 1, status: 'exact' });
      const combined = (await get({ pools: '301,200', itemTypes: 'character,weapon', ranks: '3,4,5', pageSize: '200' })).json<RecordPageResponse>();
      expect(combined.total).toBe(31); // 34 matching pools minus three unknown/conflicting ranks.
      expect((await get({ name: "%' OR 1=1--" })).json<RecordPageResponse>().total).toBe(0);
      expect((await get({ from: '2026-10-27 12:00:00', to: '2026-10-27 12:00:00' })).json<RecordPageResponse>().total).toBe(36);
    });
    it('returns stable pages in either direction, clamps page boundaries and rejects malformed filters', async () => {
      const all = (await get({ order: 'asc', pageSize: '200' })).json<RecordPageResponse>();
      const first = (await get({ order: 'asc', page: '1' })).json<RecordPageResponse>();
      const last = (await get({ order: 'asc', page: '2' })).json<RecordPageResponse>();
      expect([...first.records, ...last.records]).toEqual(all.records);
      expect((await get({ pageSize: '200' })).json<RecordPageResponse>().records).toEqual([...all.records].reverse());
      expect((await get({ page: '99999999' })).json<RecordPageResponse>()).toMatchObject({ page: 2, pageCount: 2, total: 40 });
      expect((await get({ pools: '100', ranks: '5' })).json<RecordPageResponse>()).toMatchObject({ page: 1, pageCount: 0, total: 0, records: [] });
      for (const query of [{ page: '0' }, { page: '1.5' }, { pageSize: '21' }, { pools: '400' }, { pools: '301,301' }, { ranks: '6' }, { itemTypes: 'other' }, { order: 'bad' }, { from: '2026-02-29 00:00:00' }, { from: '2026-10-28 00:00:00', to: '2026-10-27 00:00:00' }, { ownerId: 'beta' }]) {
        expect((await get(query)).statusCode).toBe(400);
      }
      expect(all.records.filter((record) => record.pool === '301').slice(0, 3).map((record) => record.id)).toEqual([recordId(1), recordId(2), recordId(3)]);
    });
    it('isolates users/profiles, handles empty and non-local timezones and recomputes backfilled history', async () => {
      expect((await app.inject(`/api/profiles/${profileId}/records?pools=bad`)).statusCode).toBe(401);
      expect((await get({}, profileId, b)).statusCode).toBe(404);
      expect((await get({}, otherId, a)).statusCode).toBe(404);
      expect((await get({}, 'not-a-profile')).statusCode).toBe(404);
      expect((await get({}, otherId, b)).json<RecordPageResponse>().historyCount).toBe(1);
      expect((await get({}, emptyId)).json<RecordPageResponse>()).toMatchObject({ historyCount: 0, total: 0, page: 1, records: [] });
      expect((await get({ from: '2024-01-01 00:30:00', to: '2024-01-01 00:30:00' }, secondaryId)).json<RecordPageResponse>()).toMatchObject({ timezone: -5, total: 1 });
      const earlier = queryFixture(); earlier.hk4e = [earlier.hk4e![0]!];
      earlier.hk4e[0]!.list = [{ ...earlier.hk4e[0]!.list[0]!, id: recordId(0), time: '2026-01-01 00:00:00' }];
      const input = decodeUigf(earlier), repository = uigfRepository(connection);
      await repository.import('alpha', input, [0], await repository.preview('alpha', input), 'synthetic-backfill');
      const row = (await get({ name: '%_' })).json<RecordPageResponse>().records[0]!;
      expect(row).toMatchObject({ id: recordId(10), groupOrdinal: 11, pity: { count: 6, status: 'exact' } });
    });
  });
}
