import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { openConnection } from '../src/connection.js';
import { repositories } from '../src/repositories.js';
import { sql, temporaryDirectory } from './helpers.js';

it('upgrades the previous SQLite schema preserving all history, metadata, settings and foreign keys', async () => {
  const fixture = await temporaryDirectory(); let connection: Awaited<ReturnType<typeof openConnection>> | undefined;
  try {
    const source = fileURLToPath(new URL('../migrations/sqlite/', import.meta.url)), folder = join(fixture.directory, 'old'), filename = join(fixture.directory, 'upgrade.sqlite');
    await mkdir(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx < 3);
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    const client = new BetterSqlite3(filename);
    try { migrate(drizzle(client), { migrationsFolder: folder }); } finally { client.close(); }
    connection = await openConnection({ driver: 'sqlite', filename }); const repo = repositories(connection);
    const user = await repo.users.create({ username: 'preserve_history', passwordHash: 'synthetic' });
    const profile = await repo.profiles.create(user.id, { game: 'hk4e', uid: '123456789', timezone: 8 });
    await repo.records.insertBatch(user.id, profile.id, [{ id: '9007199254740993001', itemId: '11301', gachaType: '301', pityGroup: '301', timeLocal: '2026-11-04 12:00:00', timeUtc: '2026-11-04T04:00:00.000Z', name: '原始名称', itemType: 'weapon', rank: 3, source: 'uigf' }]);
    await connection.executor.execute(sql`UPDATE gacha_records SET metadata_json=${JSON.stringify({ name: '原始名称', lang: 'zh-cn', rank_type: '3', item_type: '武器' })}`);
    await connection.executor.execute(sql`INSERT INTO shared_snapshots (key,payload_json) VALUES ('synthetic-setting','{"enabled":true}')`);
    const before = await connection.executor.query(sql`SELECT * FROM gacha_records`);
    await connection.migrate(); await connection.migrate();
    expect(await connection.executor.query(sql`SELECT * FROM gacha_records`)).toEqual(before);
    expect(await connection.executor.query(sql`SELECT * FROM shared_snapshots`)).toEqual([{ key: 'synthetic-setting', payload_json: '{"enabled":true}' }]);
    await repo.records.insertBatch(user.id, profile.id, [{ id: '9007199254740993002', itemId: null, gachaType: '301', pityGroup: '301', timeLocal: '2026-11-04 12:00:01', timeUtc: '2026-11-04T04:00:01.000Z', source: 'miyoushe' }]);
    expect(await repo.records.count(user.id, profile.id)).toBe(2);
    expect(await connection.executor.query(sql`PRAGMA foreign_key_check`)).toEqual([]);
    const indexes = await connection.executor.query<{ name: string }>(sql`PRAGMA index_list('gacha_records')`);
    expect(indexes.map((entry) => entry.name)).toEqual(expect.arrayContaining(['records_owner_profile_time_idx', 'records_owner_pool_idx']));
    await connection.executor.execute(sql`DELETE FROM game_profiles WHERE id=${profile.id}`);
    expect(await repo.records.count(user.id, profile.id)).toBe(0);
  } finally { await connection?.close(); await fixture.cleanup(); }
});
