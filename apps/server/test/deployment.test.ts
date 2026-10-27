import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
import { initializeDeployment, parseConfiguration } from '../src/deployment.js';

type Deployment = Awaited<ReturnType<typeof initializeDeployment>>;
let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
const deployments: Deployment[] = [];
beforeEach(async () => { directory = await temporaryDirectory(); });
afterEach(async () => {
  await Promise.all(deployments.splice(0).map(async (deployment) => {
    deployment.credentialKey.fill(0); await deployment.connection.close();
  }));
  await directory.cleanup();
});
async function start(env: Record<string, string | undefined> = {}) {
  const deployment = await initializeDeployment({ dataDirectory: directory.directory, env });
  deployments.push(deployment); return deployment;
}
async function stop(deployment: Deployment) {
  await deployment.connection.close();
  deployments.splice(deployments.indexOf(deployment), 1);
}
async function edit(deployment: Deployment, modify: (config: Record<string, unknown>) => void) {
  const config = parse(await readFile(deployment.config.configFile, 'utf8'));
  modify(config); await writeFile(deployment.config.configFile, stringify(config));
}

describe('simple file-based deployment', () => {
  it('creates one config and SQLite, then preserves credentials, users and session epoch', async () => {
    const first = await start();
    const config = await readFile(first.config.configFile, 'utf8');
    expect(first.config.database.driver).toBe('sqlite');
    expect(first.config.adminPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(parse(config).security).toHaveProperty('credential_key');
    expect(await readdir(directory.directory)).not.toContain('installation.json');
    expect(await readdir(directory.directory)).not.toContain('credential-key');
    const user = await first.repositories.users.create({ username: 'friend', passwordHash: 'fixture-hash' });
    await stop(first);
    const second = await start();
    expect(await readFile(second.config.configFile, 'utf8')).toBe(config);
    expect(second.credentialKey.equals(first.credentialKey)).toBe(true);
    expect(second.adminSessionVersion).toBe(first.adminSessionVersion);
    expect((await second.repositories.users.findByUsername('friend'))?.id).toBe(user.id);
  });

  it('seeds env once, then accepts config edits despite stale environment overrides', async () => {
    const env = { PORT: '3105', PUBLIC_URL: 'https://example.test/gacha/' };
    const first = await start(env);
    expect(first.config.publicUrl).toBe('https://example.test/gacha/');
    await stop(first);
    await edit(first, (config) => { (config.server as Record<string, unknown>).port = 3200; });
    const second = await start(env);
    expect(second.config.port).toBe(3200);
    expect(second.config.publicUrl).toBe('https://example.test/gacha/');
  });

  it('ignores legacy markers and locks, and initializes a newly selected empty database', async () => {
    const first = await start(); await stop(first);
    await writeFile(join(directory.directory, 'installation.json'), '{"legacy":true}');
    await writeFile(join(directory.directory, '.bootstrap.lock'), 'old-lock');
    await edit(first, (config) => { (config.database as Record<string, unknown>).sqlite_path = './other.sqlite'; });
    const second = await start();
    expect(second.config.database).toMatchObject({ driver: 'sqlite', filename: join(directory.directory, 'other.sqlite') });
    expect((await second.connection.inspect()).state).toBeDefined();
  });

  it('upgrades the old external key without changing its value or active sessions', async () => {
    const first = await start(); await stop(first);
    const key = first.credentialKey.toString('hex');
    await writeFile(first.config.keyFile, `v1:${key}\n`);
    await edit(first, (config) => { config.security = { credential_key_file: './credential-key' }; config.installation = { id: 'old-id' }; });
    const second = await start();
    expect(second.credentialKey.equals(first.credentialKey)).toBe(true);
    expect(second.adminSessionVersion).toBe(first.adminSessionVersion);
    expect(parse(await readFile(second.config.configFile, 'utf8')).security).toHaveProperty('credential_key', `v1:${key}`);
    // The old external key is retained, so a missing config can still use it.
    await stop(second); await unlink(second.config.configFile);
    expect((await start()).credentialKey.equals(first.credentialKey)).toBe(true);
  });

  it('applies defaults to partial config and retains essential value checks', async () => {
    await writeFile(join(directory.directory, 'config.toml'), '[server]\nport = 3101\n[extra]\nvalue = true\n');
    const first = await start();
    expect(first.config.port).toBe(3101);
    expect(first.config.publicUrl).toBe('http://127.0.0.1:3101/');
    await stop(first);
    const source = await readFile(first.config.configFile, 'utf8');
    for (const env of [{ PORT: '0' }, { PORT: '1.5' }, { DATABASE_DRIVER: 'mysql' }, { USER_TIMEZONE: 'invalid/timezone' }, { PUBLIC_URL: 'https://secret:private@example.test/' }]) {
      expect(() => parseConfiguration(source, first.config.configFile, directory.directory, env)).toThrow();
    }
    expect(() => parseConfiguration('invalid = [', first.config.configFile, directory.directory, {})).toThrow('INVALID_TOML');
  });

  it('adopts a changed key when no credentials exist, preserving accounts and history and invalidating sessions', async () => {
    const first = await start();
    const user = await first.repositories.users.create({ username: 'friend', passwordHash: 'fixture-hash' });
    const profile = await first.repositories.profiles.create(user.id, { game: 'hk4e', uid: '100000001', timezone: 8 });
    await first.repositories.records.insertBatch(user.id, profile.id, [{ id: '1001', itemId: '10001', gachaType: '301', pityGroup: '301', timeLocal: '2026-10-26 12:00:00', timeUtc: '2026-10-26T04:00:00.000Z', source: 'fixture' }]);
    await first.repositories.sessions.create({ idHash: 'old-admin', kind: 'admin', authVersion: first.adminSessionVersion, expiresAt: 'fixture' });
    await first.repositories.sessions.create({ idHash: 'old-user', kind: 'user', ownerId: user.id, authVersion: '1', expiresAt: 'fixture' });
    await stop(first);
    await edit(first, (config) => { (config.security as Record<string, unknown>).credential_key = `v1:${'ab'.repeat(32)}`; });
    const second = await start();
    expect(second.credentialKey.toString('hex')).toBe('ab'.repeat(32));
    expect(second.adminSessionVersion).not.toBe(first.adminSessionVersion);
    expect((await second.repositories.users.findByUsername('friend'))?.id).toBe(user.id);
    expect(await second.repositories.records.count(user.id, profile.id)).toBe(1);
    expect(await second.repositories.sessions.get('old-user')).toBeUndefined();
    expect(await second.repositories.sessions.get('old-admin')).toBeUndefined();
    await stop(second);
    expect((await start()).adminSessionVersion).toBe(second.adminSessionVersion);
  });

  it('preserves encrypted credentials and rejects a different key only when they exist', async () => {
    const first = await start();
    const user = await first.repositories.users.create({ username: 'friend', passwordHash: 'fixture-hash' });
    await first.connection.executor.execute(sql`INSERT INTO community_accounts (id,owner_id,provider,account_id) VALUES ('community',${user.id},'cn','fixture-account')`);
    await first.connection.executor.execute(sql`INSERT INTO credentials (id,owner_id,community_account_id,type,encrypted_value) VALUES ('credential',${user.id},'community','stoken','fixture-ciphertext')`);
    const configSource = await readFile(first.config.configFile, 'utf8');
    const state = (await first.connection.inspect()).state;
    await stop(first);
    await edit(first, (config) => { (config.security as Record<string, unknown>).credential_key = `v1:${'ab'.repeat(32)}`; });
    await expect(start()).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    await writeFile(first.config.configFile, configSource);
    const second = await start();
    expect((await second.connection.inspect()).state).toEqual(state);
    expect(await second.connection.executor.query(sql`SELECT encrypted_value FROM credentials`)).toEqual([{ encrypted_value: 'fixture-ciphertext' }]);
  });

  it('changing admin password revokes admin sessions while preserving user sessions', async () => {
    const first = await start();
    const user = await first.repositories.users.create({ username: 'friend', passwordHash: 'fixture-hash' });
    await first.repositories.sessions.create({ idHash: 'admin-session', kind: 'admin', authVersion: first.adminSessionVersion, expiresAt: 'fixture' });
    await first.repositories.sessions.create({ idHash: 'user-session', kind: 'user', ownerId: user.id, authVersion: '1', expiresAt: 'fixture' });
    await stop(first);
    await edit(first, (config) => { (config.admin as Record<string, unknown>).password = 'changed-fixture-password'; });
    const second = await start();
    expect(second.adminSessionVersion).not.toBe(first.adminSessionVersion);
    expect(await second.repositories.sessions.get('admin-session')).toBeUndefined();
    expect(await second.repositories.sessions.get('user-session')).toBeDefined();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL configuration changes', () => {
  it('allows SQLite -> empty PostgreSQL using the existing config and data directory', async () => {
    const postgres = await temporaryPostgres();
    try {
      const first = await start(); await stop(first);
      await edit(first, (config) => { config.database = { driver: 'postgres', url: postgres.url }; });
      const second = await start();
      expect(second.connection.kind).toBe('postgres');
      expect((await second.connection.inspect()).state).toBeDefined();
      expect(second.credentialKey.equals(first.credentialKey)).toBe(true);
      await stop(second);
    } finally { await postgres.cleanup(); }
  }, 30000);
});
