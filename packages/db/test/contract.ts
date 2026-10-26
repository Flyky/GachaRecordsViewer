import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindInstallation, repositories } from '../src/repositories.js';
import type { DatabaseConnection } from '../src/types.js';

export function repositoryContract(name: string, create: () => Promise<{ connection: DatabaseConnection; cleanup: () => Promise<void>; reopen: () => Promise<DatabaseConnection> }>) {
  describe(name, () => {
    let fixture: Awaited<ReturnType<typeof create>>;
    let connection: DatabaseConnection;
    beforeAll(async () => { fixture = await create(); connection = fixture.connection; await connection.migrate(); }, 30000);
    afterAll(async () => { if (connection) await connection.close(); if (fixture) await fixture.cleanup(); }, 30000);
    const pair = async () => {
      const repo = repositories(connection);
      const a = await repo.users.create({ username: `a_${randomUUID()}`, passwordHash: 'fixture-password-hash' });
      const b = await repo.users.create({ username: `b_${randomUUID()}`, passwordHash: 'fixture-password-hash' });
      return { repo, a, b };
    };
    const record = (id: string) => ({ id, itemId: '10001', gachaType: '301', pityGroup: '301',
      timeLocal: '2026-10-26 12:00:00', timeUtc: '2026-10-26T04:00:00.000Z', rank: 5, source: 'fixture' });

    it('applies migrations repeatedly without changing persisted rows', async () => {
      const { repo, a } = await pair(); await connection.migrate();
      expect((await repo.users.findByUsername(a.username))?.id).toBe(a.id);
    });
    it('enforces normalized username uniqueness and valid user foreign keys', async () => {
      const { repo, a } = await pair();
      await expect(repo.users.create({ username: ` ${a.username.toUpperCase()} `, passwordHash: 'fixture' })).rejects.toThrow();
      await expect(repo.profiles.create('missing-user', { game: 'hk4e', uid: '100000001', timezone: 8 })).rejects.toThrow();
    });
    it('isolates the same UID by owner and rejects duplicate profile identities', async () => {
      const { repo, a, b } = await pair();
      const input = { game: 'hk4e', uid: '100000001', timezone: 8 };
      const profile = await repo.profiles.create(a.id, input);
      await repo.profiles.create(b.id, input);
      expect(await repo.profiles.get(b.id, profile.id)).toBeUndefined();
      expect(await repo.profiles.list(a.id)).toHaveLength(1);
      await expect(repo.profiles.create(a.id, input)).rejects.toThrow();
    });
    it('protects profile, credential and job ownership in the database itself', async () => {
      const { repo, a, b } = await pair();
      const profile = await repo.profiles.create(a.id, { game: 'hk4e', uid: '100000001', timezone: 8 });
      await expect(connection.executor.execute(sql`INSERT INTO gacha_records (owner_id, profile_id, record_id, item_id, gacha_type, pity_group, time_local, time_utc, source)
        VALUES (${b.id}, ${profile.id}, '123', '10001', '301', '301', '2026-10-26 12:00:00', '2026-10-26T04:00:00.000Z', 'fixture')`)).rejects.toThrow();
      await expect(connection.executor.execute(sql`INSERT INTO sync_jobs (id,owner_id,profile_id,status,created_at) VALUES (${randomUUID()},${b.id},${profile.id},'pending','fixture')`)).rejects.toThrow();
      const communityId = randomUUID();
      await connection.executor.execute(sql`INSERT INTO community_accounts (id,owner_id,provider,account_id) VALUES (${communityId},${a.id},'cn','123456')`);
      await expect(connection.executor.execute(sql`INSERT INTO credentials (id,owner_id,community_account_id,type,encrypted_value) VALUES (${randomUUID()},${b.id},${communityId},'stoken','fixture-ciphertext')`)).rejects.toThrow();
      const other = await repo.profiles.create(b.id, { game: 'hk4e', uid: '100000002', timezone: 8 });
      await expect(connection.executor.execute(sql`UPDATE game_profiles SET community_account_id=${communityId} WHERE id=${other.id}`)).rejects.toThrow();
    });
    it('preserves long string IDs and rolls an entire batch back on conflicts', async () => {
      const { repo, a, b } = await pair();
      const profile = await repo.profiles.create(a.id, { game: 'hk4e', uid: '100000001', timezone: 8 });
      await repo.records.insertBatch(a.id, profile.id, [record('1900000000000000001')]);
      const rows = await connection.executor.query<{ record_id: string }>(sql`SELECT record_id FROM gacha_records WHERE profile_id=${profile.id}`);
      expect(rows[0]?.record_id).toBe('1900000000000000001');
      await expect(repo.records.insertBatch(a.id, profile.id, [record('1900000000000000002'), record('1900000000000000001')])).rejects.toThrow();
      expect(await repo.records.count(a.id, profile.id)).toBe(1);
      expect(await repo.records.count(b.id, profile.id)).toBe(0);
      await expect(repo.records.insertBatch(b.id, profile.id, [record('1900000000000000003')])).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
      expect((await repo.profiles.get(a.id, profile.id))?.data_version).toBe(1);
    });
    it('enforces timezone, rank and session subject checks', async () => {
      const { repo, a } = await pair();
      await expect(repo.profiles.create(a.id, { game: 'hk4e', uid: '100000001', timezone: 30 })).rejects.toThrow();
      const profile = await repo.profiles.create(a.id, { game: 'hk4e', uid: '100000001', timezone: 8 });
      await expect(repo.records.insertBatch(a.id, profile.id, [{ ...record('123'), rank: 6 }])).rejects.toThrow();
      await expect(repo.sessions.create({ idHash: randomUUID(), kind: 'user', authVersion: '1', expiresAt: 'fixture' })).rejects.toThrow();
      await expect(repo.sessions.create({ idHash: randomUUID(), kind: 'admin', ownerId: a.id, authVersion: '1', expiresAt: 'fixture' })).rejects.toThrow();
    });
    it('keeps unrelated concurrent writes outside a rolled-back transaction', async () => {
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const rolledBackName = `rollback_${randomUUID()}`;
      const transaction = connection.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO users (id,username,password_hash,created_at) VALUES (${randomUUID()},${rolledBackName},'fixture','fixture')`);
        entered(); await gate; throw new Error('Intentional rollback');
      });
      // Attach the rejection handler before releasing the transaction.
      const rejected = expect(transaction).rejects.toThrow('Intentional rollback');
      await inside;
      const unrelated = repositories(connection).users.create({ username: `concurrent_${randomUUID()}`, passwordHash: 'fixture' });
      release(); await rejected;
      const retained = await unrelated;
      expect(await repositories(connection).users.findByUsername(rolledBackName)).toBeUndefined();
      expect((await repositories(connection).users.findByUsername(retained.username))?.id).toBe(retained.id);
    });
    it('cascades deletion through owned records, sessions, jobs and credentials without affecting another owner', async () => {
      const { repo, a, b } = await pair();
      const profile = await repo.profiles.create(a.id, { game: 'hk4e', uid: '100000001', timezone: 8 });
      const retained = await repo.profiles.create(b.id, { game: 'hk4e', uid: '100000001', timezone: 8 });
      const communityId = randomUUID();
      await connection.executor.execute(sql`INSERT INTO community_accounts (id,owner_id,provider,account_id) VALUES (${communityId},${a.id},'cn','123456')`);
      await connection.executor.execute(sql`UPDATE game_profiles SET community_account_id=${communityId} WHERE id=${profile.id}`);
      await connection.executor.execute(sql`INSERT INTO credentials (id,owner_id,community_account_id,type,encrypted_value) VALUES (${randomUUID()},${a.id},${communityId},'stoken','fixture-ciphertext')`);
      await connection.executor.execute(sql`INSERT INTO sync_jobs (id,owner_id,profile_id,status,created_at) VALUES (${randomUUID()},${a.id},${profile.id},'pending','fixture')`);
      await repo.records.insertBatch(a.id, profile.id, [record('123')]);
      await repo.sessions.create({ idHash: randomUUID(), kind: 'user', ownerId: a.id, authVersion: '1', expiresAt: 'fixture' });
      await connection.executor.execute(sql`DELETE FROM users WHERE id=${a.id}`);
      expect(await repo.profiles.get(b.id, retained.id)).toBeDefined();
      for (const name of ['game_profiles', 'gacha_records', 'sessions', 'sync_jobs', 'community_accounts', 'credentials']) {
        expect(await connection.executor.query(sql`SELECT owner_id FROM ${sql.identifier(name)} WHERE owner_id=${a.id}`)).toHaveLength(0);
      }
    });
    it('persists installation binding and revokes only admin sessions on config password change', async () => {
      const input = { installationId: randomUUID(), keyFingerprint: 'fixture-key', adminFingerprint: 'fixture-admin-a' };
      const version = await bindInstallation(connection, input);
      expect(await bindInstallation(connection, input)).toBe(version);
      const { repo, a } = await pair();
      const admin = randomUUID(), user = randomUUID();
      await repo.sessions.create({ idHash: admin, kind: 'admin', authVersion: version, expiresAt: 'fixture' });
      await repo.sessions.create({ idHash: user, kind: 'user', ownerId: a.id, authVersion: '1', expiresAt: 'fixture' });
      expect(await bindInstallation(connection, { ...input, adminFingerprint: 'fixture-admin-b' })).not.toBe(version);
      expect(await repo.sessions.get(admin)).toBeUndefined();
      expect(await repo.sessions.get(user)).toBeDefined();
      await expect(bindInstallation(connection, { ...input, keyFingerprint: 'wrong' })).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
      await expect(bindInstallation(connection, { ...input, installationId: randomUUID() })).rejects.toMatchObject({ code: 'INSTALLATION_MISMATCH' });
    });
    it('retains rows across closing and reopening the real driver', async () => {
      const { a } = await pair(); await connection.close(); connection = await fixture.reopen(); await connection.migrate();
      expect((await repositories(connection).users.findByUsername(a.username))?.id).toBe(a.id);
      await connection.probe();
    });
  });
}
