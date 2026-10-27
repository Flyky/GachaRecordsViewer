import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { CommunityAccount } from '@gacha/contracts';
import type { DatabaseConnection, SqlExecutor } from './types.js';
import type { ProfileRow } from './repositories.js';

export class CommunityError extends Error { constructor(readonly code: string) { super(code); } }
export interface StoredCommunity {
  id: string; account_id: string; mid: string | null; capabilities_json: string;
  credential_id: string | null; encrypted_value: string | null; key_version: number | null;
}
export interface CredentialAuthorization {
  sessionHash: string; now: () => number; claim: () => void;
}
export function communityRepository(connection: DatabaseConnection) {
  const owned = async (tx: SqlExecutor, owner: string, id: string) => (await tx.query<StoredCommunity>(sql`
    SELECT a.id, a.account_id, a.mid, a.capabilities_json, c.id AS credential_id, c.encrypted_value, c.key_version
    FROM community_accounts a LEFT JOIN credentials c ON c.owner_id=a.owner_id AND c.community_account_id=a.id AND c.type='miyoushe_bundle'
    WHERE a.owner_id=${owner} AND a.id=${id} AND a.provider='cn'`))[0];
  const transaction = <T>(owner: string, work: (tx: SqlExecutor) => Promise<T>) => connection.transaction(async (tx) => {
    if (connection.kind === 'postgres') await tx.execute(sql`SELECT pg_advisory_xact_lock(72407001, hashtext(${owner}))`);
    return work(tx);
  });
  async function requireOwned(tx: SqlExecutor, owner: string, id: string, revision?: string) {
    const row = await owned(tx, owner, id);
    if (!row) throw new CommunityError('COMMUNITY_NOT_FOUND');
    if (revision !== undefined && row.credential_id !== revision) throw new CommunityError('CREDENTIALS_CHANGED');
    return row;
  }
  return {
    get: (owner: string, id: string) => transaction(owner, async (tx) => requireOwned(tx, owner, id)),
    list: (owner: string) => transaction(owner, async (tx) => tx.query<{ id: string }>(sql`SELECT id FROM community_accounts WHERE owner_id=${owner} AND provider='cn' ORDER BY id`)),
    profiles: (owner: string, id: string): Promise<CommunityAccount['profiles']> => transaction(owner, async (tx) => {
      await requireOwned(tx, owner, id);
      return tx.query<CommunityAccount['profiles'][number]>(sql`SELECT id, uid, region, timezone FROM game_profiles WHERE owner_id=${owner} AND community_account_id=${id} AND game='hk4e' ORDER BY uid, region`);
    }),
    save: (owner: string, input: { id: string; accountId: string; mid: string | null; capabilitiesJson: string;
      credentialId: string; encryptedValue: string; expectedRevision: string | null; roles?: { uid: string; region: string }[]; authorization?: CredentialAuthorization }) => transaction(owner, async (tx) => {
      if (input.authorization) {
        // Hold session/user row locks until commit so logout/password reset cannot race this save.
        const lock = connection.kind === 'postgres' ? sql`FOR SHARE OF s, u` : sql``;
        const session = (await tx.query<{ expires_at: string; auth_version: string; session_version: number }>(sql`
          SELECT s.expires_at, s.auth_version, u.session_version FROM sessions s JOIN users u ON u.id=s.owner_id
          WHERE s.id_hash=${input.authorization.sessionHash} AND s.owner_id=${owner} AND s.kind='user' ${lock}`))[0];
        if (!session || session.auth_version !== String(session.session_version) || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= input.authorization.now()) throw new CommunityError('QR_SESSION_INVALID');
        input.authorization.claim();
      }
      if (input.expectedRevision !== null) {
        const existing = await requireOwned(tx, owner, input.id, input.expectedRevision);
        if (existing.account_id !== input.accountId) throw new CommunityError('COMMUNITY_IDENTITY_MISMATCH');
        await tx.execute(sql`UPDATE community_accounts SET mid=${input.mid}, capabilities_json=${input.capabilitiesJson} WHERE owner_id=${owner} AND id=${input.id}`);
      } else {
        if ((await tx.query(sql`SELECT id FROM community_accounts WHERE owner_id=${owner} AND provider='cn' AND account_id=${input.accountId}`)).length) throw new CommunityError('COMMUNITY_EXISTS');
        await tx.execute(sql`INSERT INTO community_accounts (id, owner_id, provider, account_id, mid, capabilities_json) VALUES (${input.id}, ${owner}, 'cn', ${input.accountId}, ${input.mid}, ${input.capabilitiesJson})`);
      }
      if (input.roles !== undefined) {
        const bound = await tx.query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE owner_id=${owner} AND community_account_id=${input.id}`);
        for (const profile of bound) if (!input.roles.some((role) => profile.game === 'hk4e' && role.uid === profile.uid && role.region === profile.region)) {
          await tx.execute(sql`UPDATE game_profiles SET community_account_id=NULL, data_version=data_version+1 WHERE owner_id=${owner} AND id=${profile.id}`);
          await tx.execute(sql`UPDATE sync_jobs SET status='cancelled', failure_code='ROLE_UNBOUND' WHERE owner_id=${owner} AND profile_id=${profile.id} AND status IN ('queued','running','retrying')`);
        }
        for (const role of input.roles) {
          const matches = await tx.query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE owner_id=${owner} AND game='hk4e' AND uid=${role.uid} AND (region=${role.region} OR region='unknown')`);
          if (matches.length > 1) throw new CommunityError('PROFILE_BINDING_CONFLICT');
          const profile = matches[0];
          if (profile) {
            if (profile.community_account_id && profile.community_account_id !== input.id) throw new CommunityError('PROFILE_BOUND_ELSEWHERE');
            if (profile.timezone !== 8) throw new CommunityError('PROFILE_TIMEZONE_CONFLICT');
            if (profile.region !== role.region || profile.community_account_id !== input.id) await tx.execute(sql`
              UPDATE game_profiles SET region=${role.region}, community_account_id=${input.id}, data_version=data_version+1 WHERE owner_id=${owner} AND id=${profile.id}`);
          } else await tx.execute(sql`INSERT INTO game_profiles (id, owner_id, game, uid, region, timezone, lang, community_account_id)
            VALUES (${randomUUID()}, ${owner}, 'hk4e', ${role.uid}, ${role.region}, 8, 'zh-cn', ${input.id})`);
        }
      }
      await tx.execute(sql`DELETE FROM credentials WHERE owner_id=${owner} AND community_account_id=${input.id}`);
      await tx.execute(sql`INSERT INTO credentials (id, owner_id, community_account_id, type, encrypted_value, key_version, status)
        VALUES (${input.credentialId}, ${owner}, ${input.id}, 'miyoushe_bundle', ${input.encryptedValue}, 1, 'verified')`);
      input.authorization?.claim();
    }),
    failure: (owner: string, id: string, revision: string, capabilitiesJson: string, invalid: boolean) => transaction(owner, async (tx) => {
      await requireOwned(tx, owner, id, revision);
      await tx.execute(sql`UPDATE community_accounts SET capabilities_json=${capabilitiesJson} WHERE owner_id=${owner} AND id=${id}`);
      if (invalid) await tx.execute(sql`UPDATE credentials SET status='invalid' WHERE owner_id=${owner} AND community_account_id=${id}`);
    }),
    remove: (owner: string, id: string) => transaction(owner, async (tx) => {
      await requireOwned(tx, owner, id);
      await tx.execute(sql`UPDATE sync_jobs SET status='cancelled', failure_code='ACCOUNT_UNLINKED' WHERE owner_id=${owner} AND status IN ('queued','running','retrying')
        AND profile_id IN (SELECT id FROM game_profiles WHERE owner_id=${owner} AND community_account_id=${id})`);
      await tx.execute(sql`UPDATE game_profiles SET community_account_id=NULL, data_version=data_version+1 WHERE owner_id=${owner} AND community_account_id=${id}`);
      await tx.execute(sql`DELETE FROM credentials WHERE owner_id=${owner} AND community_account_id=${id}`);
      await tx.execute(sql`DELETE FROM community_accounts WHERE owner_id=${owner} AND id=${id}`);
    }),
  };
}
