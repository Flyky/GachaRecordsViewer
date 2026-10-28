import type { MetadataSnapshot } from '@gacha/uigf';
import { sql } from 'drizzle-orm';
import type { DatabaseConnection } from './types.js';

export function metadataRepository(connection: DatabaseConnection) {
  return {
    load: () => connection.transaction(async (tx): Promise<unknown | undefined> => {
      const rows = await tx.query<{ item_id: string; item_type: string; rank: number; names_json: string; source_version: string }>(sql`SELECT * FROM item_metadata WHERE game='hk4e' ORDER BY item_id`);
      if (!rows.length) return undefined;
      if (rows.some((row) => row.source_version !== rows[0]!.source_version)) throw new Error('Inconsistent dictionary cache');
      return { schemaVersion: 1, game: 'hk4e', source: JSON.parse(rows[0]!.source_version) as unknown,
        items: rows.map((row) => ({ id: row.item_id, itemType: row.item_type, rank: row.rank, names: JSON.parse(row.names_json) as unknown })) };
    }),
    save: (snapshot: MetadataSnapshot) => connection.transaction(async (tx) => {
      if (connection.kind === 'postgres') await tx.execute(sql`SELECT pg_advisory_xact_lock(72417001)`);
      await tx.execute(sql`DELETE FROM item_metadata WHERE game='hk4e'`);
      const source = JSON.stringify(snapshot.source);
      for (let offset = 0; offset < snapshot.items.length; offset += 100) {
        const values = snapshot.items.slice(offset, offset + 100).map((item) => sql`('hk4e',${item.id},${item.itemType},${item.rank},${JSON.stringify(item.names)},${source})`);
        await tx.execute(sql`INSERT INTO item_metadata (game,item_id,item_type,rank,names_json,source_version) VALUES ${sql.join(values, sql`, `)}`);
      }
    }),
  };
}

export function snapshotRepository(connection: DatabaseConnection) {
  return {
    load: async (key: string): Promise<unknown | undefined> => {
      const rows = await connection.executor.query<{ payload_json: string }>(sql`SELECT payload_json FROM shared_snapshots WHERE key=${key}`);
      return rows[0] ? JSON.parse(rows[0].payload_json) as unknown : undefined;
    },
    save: (key: string, snapshot: unknown) => connection.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO shared_snapshots (key,payload_json) VALUES (${key},${JSON.stringify(snapshot)})
        ON CONFLICT (key) DO UPDATE SET payload_json=excluded.payload_json`);
    }),
  };
}
