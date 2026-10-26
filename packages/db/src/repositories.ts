import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PersistenceError, type DatabaseConnection, type InstallationState, type SqlExecutor } from './types.js';

export interface UserRow {
  id: string; username: string; password_hash: string; is_initial_password: number; session_version: number; created_at: string;
}
export interface ProfileRow {
  id: string; owner_id: string; game: string; uid: string; region: string; timezone: number;
  lang: string | null; community_account_id: string | null; history_status: string; data_version: number;
}
export interface RecordInput {
  id: string; itemId: string; gachaType: string; pityGroup: string; timeLocal: string; timeUtc: string;
  name?: string; itemType?: string; rank?: number; source: string;
}

export function repositories(connection: DatabaseConnection) {
  const query = connection.executor.query;
  return {
    sessions: {
      async create(input: { idHash: string; kind: 'admin' | 'user'; ownerId?: string; authVersion: string; expiresAt: string }) {
        await connection.executor.execute(sql`INSERT INTO sessions (id_hash, kind, owner_id, auth_version, expires_at)
          VALUES (${input.idHash}, ${input.kind}, ${input.ownerId ?? null}, ${input.authVersion}, ${input.expiresAt})`);
      },
      async get(idHash: string) {
        return (await query<{ id_hash: string; kind: string; owner_id: string | null; auth_version: string; expires_at: string }>(sql`SELECT * FROM sessions WHERE id_hash=${idHash}`))[0];
      },
    },
    users: {
      async create(input: { id?: string; username: string; passwordHash: string }) {
        const id = input.id ?? randomUUID();
        const username = input.username.trim().toLowerCase();
        return (await query<UserRow>(sql`INSERT INTO users (id, username, password_hash, created_at)
          VALUES (${id}, ${username}, ${input.passwordHash}, ${new Date().toISOString()}) RETURNING *`))[0]!;
      },
      async findByUsername(username: string) {
        return (await query<UserRow>(sql`SELECT * FROM users WHERE username=${username.trim().toLowerCase()}`))[0];
      },
    },
    profiles: {
      async create(ownerId: string, input: { id?: string; game: string; uid: string; region?: string; timezone: number; lang?: string }) {
        return (await query<ProfileRow>(sql`INSERT INTO game_profiles (id, owner_id, game, uid, region, timezone, lang)
          VALUES (${input.id ?? randomUUID()}, ${ownerId}, ${input.game}, ${input.uid}, ${input.region ?? 'unknown'}, ${input.timezone}, ${input.lang ?? null}) RETURNING *`))[0]!;
      },
      get: (ownerId: string, profileId: string) => ownedProfile(connection.executor, ownerId, profileId),
      list: (ownerId: string) => query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE owner_id=${ownerId} ORDER BY id`),
    },
    records: {
      async insertBatch(ownerId: string, profileId: string, records: RecordInput[]) {
        return connection.transaction(async (tx) => {
          if (!await ownedProfile(tx, ownerId, profileId)) throw new PersistenceError('OWNER_MISMATCH');
          for (const record of records) {
            await tx.execute(sql`INSERT INTO gacha_records (owner_id, profile_id, record_id, item_id, gacha_type, pity_group, time_local, time_utc, name, item_type, rank, source)
              VALUES (${ownerId}, ${profileId}, ${record.id}, ${record.itemId}, ${record.gachaType}, ${record.pityGroup}, ${record.timeLocal}, ${record.timeUtc}, ${record.name ?? null}, ${record.itemType ?? null}, ${record.rank ?? null}, ${record.source})`);
          }
          if (records.length) await tx.execute(sql`UPDATE game_profiles SET data_version=data_version+1 WHERE owner_id=${ownerId} AND id=${profileId}`);
        });
      },
      async count(ownerId: string, profileId: string) {
        const rows = await query<{ count: number | string }>(sql`SELECT count(*) AS count FROM gacha_records WHERE owner_id=${ownerId} AND profile_id=${profileId}`);
        return Number(rows[0]!.count);
      },
    },
  };
}

async function ownedProfile(executor: SqlExecutor, ownerId: string, profileId: string) {
  return (await executor.query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE owner_id=${ownerId} AND id=${profileId}`))[0];
}

export async function bindInstallation(connection: DatabaseConnection, input: {
  installationId: string; keyFingerprint: string; adminFingerprint: string;
}) {
  return connection.transaction(async (tx) => {
    if (connection.kind === 'postgres') await tx.execute(sql`SELECT pg_advisory_xact_lock(72403004)`);
    const existing = (await tx.query<InstallationState>(sql`SELECT * FROM app_state WHERE id='primary'`))[0];
    if (existing && existing.installation_id !== input.installationId) throw new PersistenceError('INSTALLATION_MISMATCH');
    if (existing && existing.key_fingerprint !== input.keyFingerprint) throw new PersistenceError('KEY_MISMATCH');
    if (existing?.admin_fingerprint === input.adminFingerprint) return existing.admin_session_version;
    const version = randomUUID();
    if (existing) {
      await tx.execute(sql`UPDATE app_state SET admin_fingerprint=${input.adminFingerprint}, admin_session_version=${version} WHERE id='primary'`);
      await tx.execute(sql`DELETE FROM sessions WHERE kind='admin'`);
    } else {
      await tx.execute(sql`INSERT INTO app_state (id, installation_id, key_fingerprint, admin_fingerprint, admin_session_version)
        VALUES ('primary', ${input.installationId}, ${input.keyFingerprint}, ${input.adminFingerprint}, ${version})`);
    }
    return version;
  });
}
