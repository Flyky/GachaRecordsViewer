import { join } from 'node:path';
import { decodeUigf, encodeUigf, type DecodedUigf } from '@gacha/uigf';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeHistory, genshinMetadata } from '../../gacha-core/src/index.js';
import { longId, pull, sample } from '../../uigf/test/fixtures.js';
import { openConnection, repositories, uigfRepository, type DatabaseConnection } from '../src/index.js';
import { temporaryDirectory, temporaryPostgres } from './helpers.js';

for (const driver of ['sqlite', 'postgres'] as const) {
  describe.skipIf(driver === 'postgres' && !process.env.TEST_DATABASE_URL)(`UIGF ${driver} contract`, () => {
    let connection: DatabaseConnection, cleanup: () => Promise<void>;
    let repo: ReturnType<typeof uigfRepository>;
    beforeEach(async () => {
      if (driver === 'sqlite') {
        const fixture = await temporaryDirectory(); cleanup = fixture.cleanup;
        connection = await openConnection({ driver, filename: join(fixture.directory, 'uigf.sqlite') });
      } else {
        const fixture = await temporaryPostgres(); cleanup = fixture.cleanup;
        connection = await openConnection({ driver, url: fixture.url });
      }
      await connection.migrate(); repo = uigfRepository(connection);
      for (const owner of ['a', 'b', 'c']) await repositories(connection).users.create({ id: owner, username: owner, passwordHash: 'test-only' });
    });
    afterEach(async () => { await connection?.close(); await cleanup?.(); });
    const save = async (input: DecodedUigf, owner = 'a', indexes = input.profiles.map((profile) => profile.index)) =>
      repo.import(owner, input, indexes, await repo.preview(owner, input), 'synthetic-hash');

    it('previews without writes, selects UIDs, deduplicates/enriches, isolates owners and round-trips all supported versions', async () => {
      const document = sample('v4.1', [pull(), pull(longId)]);
      document.hk4e!.push({ uid: '223456789', timezone: -5, list: [] });
      const input = decodeUigf(document), preview = await repo.preview('a', input);
      expect(preview[0]).toMatchObject({ inserted: 1, duplicates: 1, targetProfileId: null });
      expect(await repo.list('a')).toEqual([]);
      const result = await save(input, 'a', [0]); const id = result.profiles[0]!.targetProfileId!;
      expect(await repo.list('a')).toHaveLength(1);
      expect((await save(input, 'a', [0])).profiles[0]).toMatchObject({ inserted: 0, dataVersion: 1 });
      expect((await save(input, 'b', [0])).profiles[0]!.targetProfileId).not.toBe(id);
      await expect(repo.export('b', id)).rejects.toThrow('PROFILE_NOT_FOUND');
      const unlabeled = sample('v4.1', [pull(longId, { name: 'Unlabeled name' })]);
      delete unlabeled.hk4e![0]!.lang;
      const otherId = (await save(decodeUigf(unlabeled), 'b')).profiles[0]!.targetProfileId!;
      expect(encodeUigf([await repo.export('b', otherId)]).hk4e![0]!.lang).toBeUndefined();
      const enriched = decodeUigf(sample('v4.0', [pull(`0${longId}`, { name: '冷刃', rank_type: '3', item_type: '武器', count: '1' })]));
      expect((await save(enriched)).profiles[0]).toMatchObject({ inserted: 0, enriched: 1, dataVersion: 2 });
      expect((await repo.export('a', id)).records[0]!.id).toBe(longId);
      await save(input, 'a', [1]);
      const empty = (await repo.list('a')).find((profile) => profile.uid === '223456789')!;
      for (const version of ['v4.0', 'v4.1', 'v4.2'] as const) {
        const exported = encodeUigf([await repo.export('a', id), await repo.export('a', empty.id)], version);
        const imported = await save(decodeUigf(exported), 'c');
        expect(encodeUigf([await repo.export('c', imported.profiles[0]!.targetProfileId!), await repo.export('c', imported.profiles[1]!.targetProfileId!)], version).hk4e).toEqual(exported.hk4e);
      }
      expect(await repo.list('a')).toEqual(expect.arrayContaining([expect.objectContaining({ recordCount: 1, metadataIncomplete: 0 }), expect.objectContaining({ recordCount: 0 })]));
    });
    it('rolls back selected conflicts, rejects stale previews and serializes concurrent imports; backfill recalculates order/pity', async () => {
      const initial = decodeUigf(sample('v4.1', [pull(longId, { item_id: '10000016', rank_type: '5' })]));
      const states = await repo.preview('a', initial);
      const race = await Promise.allSettled([repo.import('a', initial, [0], states, 'hash'), repo.import('a', initial, [0], states, 'hash')]);
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(race.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'PREVIEW_STALE' } });
      const id = (await repo.list('a'))[0]!.id;
      const conflicted = sample('v4.1', [pull(longId)]);
      conflicted.hk4e!.push({ uid: '223456789', timezone: 8, list: [pull('1')] });
      await expect(save(decodeUigf(conflicted), 'a', [1, 0])).rejects.toThrow('IMPORT_CONFLICT');
      expect(await repo.list('a')).toHaveLength(1);
      expect(await connection.executor.query(sql`SELECT id FROM import_batches`)).toHaveLength(1);
      const timezone = sample(); timezone.hk4e![0]!.timezone = 9;
      expect((await repo.preview('a', decodeUigf(timezone)))[0]!.blockers).toContain('TIMEZONE_CONFLICT');
      const earlier = decodeUigf(sample('v4.1', [pull('9007199254740993000', { time: '2025-12-31 12:00:00' })]));
      const oldPreview = await repo.preview('a', earlier);
      await save(earlier);
      await expect(repo.import('a', earlier, [0], oldPreview, 'hash')).rejects.toThrow('PREVIEW_STALE');
      const saved = await repo.export('a', id);
      const history = analyzeHistory(saved.records.map((record) => ({ id: record.id, itemId: record.itemId, gachaType: record.gachaType, time: record.timeLocal })), { timezone: saved.timezone, catalog: genshinMetadata });
      expect(history.records.at(-1)).toMatchObject({ id: longId, groupOrdinal: 2, pity: { count: 2 } });
      const warnings = await save(decodeUigf(sample('v4.1', [pull(longId, { item_id: '10000016', rank_type: '4' })])));
      expect(warnings.profiles[0]).toMatchObject({ metadataWarnings: 1, enriched: 0, dataVersion: 2 });
      expect((await repo.export('a', id)).records.find((record) => record.id === longId)!.rank).toBe(5);
    });
  });
}
