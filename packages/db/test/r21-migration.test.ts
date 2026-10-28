import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { openConnection } from '../src/connection.js';
import { repositories } from '../src/repositories.js';
import { sql, temporaryDirectory } from './helpers.js';

it('upgrades an R20 SQLite database additively and preserves existing users and wish history', async () => {
  const fixture = await temporaryDirectory(); let connection: Awaited<ReturnType<typeof openConnection>> | undefined;
  try {
    const folder = join(fixture.directory, 'old-migrations'), filename = join(fixture.directory, 'upgrade.sqlite');
    await mkdir(join(folder, 'meta'), { recursive: true });
    const source = fileURLToPath(new URL('../migrations/sqlite/', import.meta.url));
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx < 2);
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    const client = new BetterSqlite3(filename);
    try { migrate(drizzle(client), { migrationsFolder: folder }); } finally { client.close(); }
    connection = await openConnection({ driver: 'sqlite', filename });
    const repo = repositories(connection), user = await repo.users.create({ username: 'upgrade_user', passwordHash: 'synthetic-hash' });
    const profile = await repo.profiles.create(user.id, { game: 'hk4e', uid: '123456789', timezone: 8 });
    await repo.records.insertBatch(user.id, profile.id, [{ id: '9007199254740993001', itemId: '11301', gachaType: '301', pityGroup: '301', timeLocal: '2026-10-28 12:00:00', timeUtc: '2026-10-28T04:00:00.000Z', source: 'synthetic' }]);
    await connection.migrate(); await connection.migrate();
    expect(await repo.users.findById(user.id)).toBeTruthy();
    expect(await connection.executor.query(sql`SELECT record_id FROM gacha_records`)).toHaveLength(1);
    expect(await connection.executor.query(sql`SELECT * FROM shared_snapshots`)).toEqual([]);
    expect(await connection.executor.query(sql`SELECT * FROM payment_orders`)).toEqual([]);
  } finally { await connection?.close(); await fixture.cleanup(); }
});
