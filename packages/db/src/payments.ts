import { sql } from 'drizzle-orm';
import type { DatabaseConnection } from './types.js';

export interface PaymentRow { id: string; owner_id: string; status: string; public_json: string; encrypted_value: string | null; created_at: string; updated_at: string }
export function paymentRepository(connection: DatabaseConnection) {
  return {
    list: (owner: string) => connection.executor.query<PaymentRow>(sql`SELECT * FROM payment_orders WHERE owner_id=${owner} ORDER BY created_at DESC,id DESC LIMIT 20`),
    get: async (owner: string, id: string) => (await connection.executor.query<PaymentRow>(sql`SELECT * FROM payment_orders WHERE owner_id=${owner} AND id=${id}`))[0],
    reserve: (owner: string, id: string, value: unknown, timestamp: string) => connection.transaction(async (tx) => {
      if (connection.kind === 'postgres') await tx.execute(sql`SELECT pg_advisory_xact_lock(72421001,hashtext(${owner}))`);
      const previous = (await tx.query<PaymentRow>(sql`SELECT * FROM payment_orders WHERE owner_id=${owner} AND id=${id}`))[0];
      if (previous) return 'existing' as const;
      if ((await tx.query(sql`SELECT id FROM payment_orders WHERE owner_id=${owner} AND status IN ('creating','pending','unknown','verification_required') LIMIT 1`)).length) return 'busy' as const;
      await tx.execute(sql`INSERT INTO payment_orders (id,owner_id,status,public_json,created_at,updated_at) VALUES (${id},${owner},'creating',${JSON.stringify(value)},${timestamp},${timestamp})`);
      return 'reserved' as const;
    }),
    save: (owner: string, id: string, status: string, value: unknown, encrypted: string | null, timestamp: string) => connection.executor.execute(sql`
      UPDATE payment_orders SET status=${status},public_json=${JSON.stringify(value)},encrypted_value=${encrypted},updated_at=${timestamp} WHERE owner_id=${owner} AND id=${id}`),
  };
}
