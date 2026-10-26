import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/better-sqlite3';
import { migrate as sqliteMigrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import { migrate as pgMigrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import type { DatabaseConfig, DatabaseConnection, InstallationState, SqlExecutor } from './types.js';

export async function openConnection(config: DatabaseConfig): Promise<DatabaseConnection> {
  if (config.driver === 'sqlite') {
    const client = new BetterSqlite3(config.filename, { timeout: 5000 });
    try { client.pragma('foreign_keys = ON'); client.pragma('journal_mode = WAL'); }
    catch (error) { client.close(); throw error; }
    const db = sqliteDrizzle(client);
    const direct: SqlExecutor = {
      query: async <T>(statement: SQL) => db.all(statement) as T[],
      execute: async (statement) => { db.run(statement); },
    };
    let tail: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      const result = tail.then(work);
      tail = result.catch(() => undefined);
      return result;
    };
    const executor: SqlExecutor = {
      query: <T>(statement: SQL) => enqueue(() => direct.query<T>(statement)),
      execute: (statement) => enqueue(() => direct.execute(statement)),
    };
    return {
      kind: 'sqlite', executor,
      transaction: (work) => enqueue(async () => {
        client.exec('BEGIN IMMEDIATE');
        try { const result = await work(direct); client.exec('COMMIT'); return result; }
        catch (error) { client.exec('ROLLBACK'); throw error; }
      }),
      inspect: async () => inspect(executor, sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'`),
      migrate: () => enqueue(async () => { sqliteMigrate(db, { migrationsFolder: migrationFolder('sqlite') }); }),
      probe: async () => { await executor.query(sql`SELECT 1`); },
      close: () => enqueue(async () => { client.close(); }),
    };
  }

  const pool = new Pool({ connectionString: config.url, max: 4, connectionTimeoutMillis: 5000, options: '-c search_path=public' });
  let ending: Promise<void> | undefined;
  pool.on('error', () => { /* Readiness and the next operation report failure without logging credentials. */ });
  const db = pgDrizzle(pool);
  const executor: SqlExecutor = {
    query: async <T>(statement: SQL) => (await db.execute(statement)).rows as T[],
    execute: async (statement) => { await db.execute(statement); },
  };
  try { await executor.query(sql`SELECT 1`); }
  catch (error) { await pool.end(); throw error; }
  return {
    kind: 'postgres', executor,
    transaction: async (work) => {
      const client = await pool.connect();
      const transactionDb = pgDrizzle(client);
      const tx: SqlExecutor = {
        query: async <T>(statement: SQL) => (await transactionDb.execute(statement)).rows as T[],
        execute: async (statement) => { await transactionDb.execute(statement); },
      };
      try { await client.query('BEGIN'); const result = await work(tx); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    inspect: async () => inspect(executor, sql`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`),
    migrate: async () => {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(72403003)');
        await pgMigrate(pgDrizzle(client), { migrationsFolder: migrationFolder('postgres') });
      } finally {
        try { await client.query('SELECT pg_advisory_unlock(72403003)'); } finally { client.release(); }
      }
    },
    probe: async () => { await executor.query(sql`SELECT 1`); },
    close: () => ending ??= pool.end(),
  };
}

function migrationFolder(kind: string) {
  return fileURLToPath(new URL(`../migrations/${kind}/`, import.meta.url));
}

async function inspect(executor: SqlExecutor, statement: Parameters<SqlExecutor['query']>[0]) {
  const tables = await executor.query<{ name: string }>(statement);
  const state = tables.some((table) => table.name === 'app_state')
    ? (await executor.query<InstallationState>(sql`SELECT * FROM app_state WHERE id='primary'`))[0] : undefined;
  return { hasTables: tables.length > 0, state };
}
