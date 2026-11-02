import { sql } from 'drizzle-orm';
import type { DatabaseConnection } from './types.js';

// Owner-specific settings reuse the existing snapshot table. A compare-and-swap
// claims a day before enqueueing its external operation, including across restarts.
export function autoCheckinRepository(connection: DatabaseConnection) {
  const key = (owner: string) => `auto-checkin:${owner}`;
  return {
    async load(owner: string) {
      return (await connection.executor.query<{ payload_json: string }>(sql`SELECT payload_json FROM shared_snapshots WHERE key=${key(owner)}`))[0]?.payload_json;
    },
    async list() {
      return connection.executor.query<{ owner_id: string; payload_json: string }>(sql`SELECT u.id AS owner_id,s.payload_json FROM shared_snapshots s JOIN users u ON s.key=('auto-checkin:' || u.id)`);
    },
    async replace(owner: string, expected: string | undefined, payload: string) {
      return connection.transaction(async (tx) => {
        const rows = expected === undefined
          ? await tx.query<{ key: string }>(sql`INSERT INTO shared_snapshots (key,payload_json) VALUES (${key(owner)},${payload}) ON CONFLICT (key) DO NOTHING RETURNING key`)
          : await tx.query<{ key: string }>(sql`UPDATE shared_snapshots SET payload_json=${payload} WHERE key=${key(owner)} AND payload_json=${expected} RETURNING key`);
        return rows.length === 1;
      });
    },
  };
}
