import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { temporaryDirectory, temporaryPostgres } from '../../../packages/db/test/helpers.js';
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

describe('persistent deployment initialization', () => {
  it('defaults to SQLite and preserves generated secrets, users and the session epoch on restart', async () => {
    const first = await start();
    expect(first.config.database.driver).toBe('sqlite');
    expect(first.config.adminUsername).toBe('admin');
    expect(first.config.adminPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.credentialKey.length).toBe(32);
    const config = await readFile(first.config.configFile, 'utf8');
    const key = await readFile(first.config.keyFile, 'utf8');
    const user = await first.repositories.users.create({ username: 'Friend', passwordHash: 'fixture-hash' });
    await stop(first);
    const second = await start();
    expect(await readFile(second.config.configFile, 'utf8')).toBe(config);
    expect(await readFile(second.config.keyFile, 'utf8')).toBe(key);
    expect(second.adminSessionVersion).toBe(first.adminSessionVersion);
    expect(second.credentialKey.equals(first.credentialKey)).toBe(true);
    expect((await second.repositories.users.findByUsername('friend'))?.id).toBe(user.id);
  });

  it('revokes existing admin sessions after a config password change while retaining user sessions', async () => {
    const first = await start();
    const user = await first.repositories.users.create({ username: 'friend', passwordHash: 'fixture-hash' });
    await first.repositories.sessions.create({ idHash: 'admin-session', kind: 'admin', authVersion: first.adminSessionVersion, expiresAt: 'fixture' });
    await first.repositories.sessions.create({ idHash: 'user-session', kind: 'user', ownerId: user.id, authVersion: '1', expiresAt: 'fixture' });
    const key = Buffer.from(first.credentialKey);
    await stop(first);
    await edit(first, (config) => { (config.admin as Record<string, unknown>).password = 'changed-fixture-password'; });
    const second = await start();
    expect(second.adminSessionVersion).not.toBe(first.adminSessionVersion);
    expect(second.credentialKey.equals(key)).toBe(true);
    expect(await second.repositories.sessions.get('admin-session')).toBeUndefined();
    expect(await second.repositories.sessions.get('user-session')).toBeDefined();
  });

  it.each(['config', 'key', 'database'] as const)('fails closed when a previously initialized %s is missing', async (missing) => {
    const first = await start(); await stop(first);
    if (first.config.database.driver !== 'sqlite') throw new Error('Expected SQLite');
    const file = missing === 'config' ? first.config.configFile : missing === 'key' ? first.config.keyFile : first.config.database.filename;
    await unlink(file);
    await expect(start()).rejects.toMatchObject({ code: missing === 'config' ? 'CONFIG_MISSING' : missing === 'key' ? 'KEY_OR_CONFIG_MISSING' : 'DATABASE_STATE_MISSING' });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects replacement keys, installation IDs and switching to an empty database', async () => {
    const first = await start(); await stop(first);
    const key = await readFile(first.config.keyFile, 'utf8');
    await writeFile(first.config.keyFile, `v1:${'ab'.repeat(32)}\n`);
    await expect(start()).rejects.toMatchObject({ code: 'INSTALLATION_MARKER_MISMATCH' });
    await writeFile(first.config.keyFile, key);
    const original = await readFile(first.config.configFile, 'utf8');
    await edit(first, (config) => { (config.installation as Record<string, unknown>).id = randomUUID(); });
    await expect(start()).rejects.toMatchObject({ code: 'INSTALLATION_MARKER_MISMATCH' });
    await writeFile(first.config.configFile, original);
    await edit(first, (config) => { (config.database as Record<string, unknown>).sqlite_path = './other.sqlite'; });
    await expect(start()).rejects.toMatchObject({ code: 'DATABASE_STATE_MISSING' });
  });

  it('does not steal another initializer lock or generate config when initialization is locked', async () => {
    const lock = join(directory.directory, '.bootstrap.lock');
    await writeFile(lock, 'fixture-lock');
    await expect(start()).rejects.toMatchObject({ code: 'BOOTSTRAP_LOCKED' });
    expect(await readFile(lock, 'utf8')).toBe('fixture-lock');
    await expect(readFile(join(directory.directory, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies validated environment overrides without silently selecting PostgreSQL from a URL', async () => {
    const first = await start({ PORT: '3105', HOST: '0.0.0.0', PUBLIC_URL: 'https://example.test', USER_TIMEZONE: 'UTC', DATABASE_URL: 'postgres://unused:secret@invalid/db' });
    expect(first.config).toMatchObject({ port: 3105, host: '0.0.0.0', publicUrl: 'https://example.test/', userTimezone: 'UTC', database: { driver: 'sqlite' } });
    const source = await readFile(first.config.configFile, 'utf8');
    for (const env of [{ PORT: '0' }, { PORT: '1.5' }, { DATABASE_DRIVER: 'mysql' }, { DATABASE_DRIVER: 'postgres', DATABASE_URL: 'http://secret:private@invalid/' }, { USER_TIMEZONE: 'invalid/timezone' }, { PUBLIC_URL: 'https://secret:private@example.test/' }]) {
      expect(() => parseConfiguration(source, first.config.configFile, directory.directory, env)).toThrow(/^Startup failed:/);
      try { parseConfiguration(source, first.config.configFile, directory.directory, env); } catch (error) { expect(String(error)).not.toMatch(/secret|private/); }
    }
    expect(() => parseConfiguration(source + '\n[unknown]\nvalue = 1\n', first.config.configFile, directory.directory, {})).toThrow('UNKNOWN_CONFIG_FIELD');
    expect(() => parseConfiguration('invalid = [', first.config.configFile, directory.directory, {})).toThrow('INVALID_TOML');
    await stop(first);
    await edit(first, (config) => { (config.security as Record<string, unknown>).credential_key_file = './config.toml'; });
    await expect(start()).rejects.toMatchObject({ code: 'OVERLAPPING_PATHS' });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('deployment with real PostgreSQL', () => {
  it('initializes and restarts against the configured server and rejects switching to another empty database', async () => {
    const postgres = await temporaryPostgres();
    const empty = await temporaryPostgres();
    try {
      const env = { DATABASE_DRIVER: 'postgres', DATABASE_URL: postgres.url };
      const first = await start(env);
      expect(first.connection.kind).toBe('postgres');
      const user = await first.repositories.users.create({ username: 'pg-friend', passwordHash: 'fixture-hash' });
      const profile = await first.repositories.profiles.create(user.id, { game: 'hk4e', uid: '100000001', timezone: 8 });
      await first.repositories.records.insertBatch(user.id, profile.id, [{ id: '1900000000000000001', itemId: '10001', gachaType: '301', pityGroup: '301', timeLocal: '2026-10-26 12:00:00', timeUtc: '2026-10-26T04:00:00.000Z', source: 'fixture' }]);
      await stop(first);
      const second = await start(env);
      expect(second.adminSessionVersion).toBe(first.adminSessionVersion);
      expect(second.config.adminPassword).toBe(first.config.adminPassword);
      expect(await second.repositories.records.count(user.id, profile.id)).toBe(1);
      await stop(second);
      await expect(start({ ...env, DATABASE_URL: empty.url })).rejects.toMatchObject({ code: 'DATABASE_STATE_MISSING' });
    } finally {
      await Promise.all(deployments.splice(0).map((deployment) => deployment.connection.close()));
      await postgres.cleanup(); await empty.cleanup();
    }
  }, 30000);
});
