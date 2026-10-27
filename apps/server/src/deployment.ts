import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindInstallation, openConnection, PersistenceError, repositories, type DatabaseConfig, type DatabaseConnection } from '@gacha/db';
import { parse, stringify } from 'smol-toml';

export class StartupError extends Error {
  constructor(readonly code: string) { super(`Startup failed: ${code}. See docs/deployment.md.`); this.name = 'StartupError'; }
}

export interface RuntimeConfig {
  configFile: string;
  dataDirectory: string;
  host: string;
  port: number;
  publicUrl: string;
  userTimezone: string;
  database: DatabaseConfig;
  sqlitePath?: string;
  adminUsername: 'admin';
  adminPassword: string;
  /** Legacy key file, read only when upgrading an older configuration. */
  keyFile: string;
  keyText?: string;
}

interface DeploymentOptions { dataDirectory?: string; env?: Record<string, string | undefined> }
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
function section(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new StartupError('INVALID_CONFIG');
  return value;
}
function resolvePath(base: string, value: string) { return isAbsolute(value) ? value : resolve(base, value); }

export function parseConfiguration(source: string, file: string, dataDirectory: string, env: Record<string, string | undefined>): RuntimeConfig {
  let raw;
  try { raw = parse(source); } catch { throw new StartupError('INVALID_TOML'); }
  const server = section(raw.server), database = section(raw.database);
  const admin = section(raw.admin), security = section(raw.security);
  const host = string(env.HOST ?? server.host ?? '127.0.0.1');
  const port = Number(env.PORT ?? server.port ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StartupError('INVALID_PORT');
  let publicUrl: URL;
  try { publicUrl = new URL(string(env.PUBLIC_URL ?? server.public_url ?? `http://127.0.0.1:${port}`)); }
  catch { throw new StartupError('INVALID_PUBLIC_URL'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) throw new StartupError('INVALID_PUBLIC_URL');
  publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, '') + '/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(publicUrl.pathname)) throw new StartupError('INVALID_PUBLIC_URL');
  const userTimezone = string(env.USER_TIMEZONE ?? server.user_timezone ?? 'Asia/Shanghai');
  try { new Intl.DateTimeFormat('en', { timeZone: userTimezone }); } catch { throw new StartupError('INVALID_TIMEZONE'); }
  const adminPassword = string(admin.password ?? randomBytes(24).toString('base64url'));
  if (adminPassword.length < 8 || adminPassword.length > 1024) throw new StartupError('INVALID_ADMIN_PASSWORD');
  const driver = env.DATABASE_DRIVER ?? database.driver ?? 'sqlite';
  let connection: DatabaseConfig;
  const sqlitePath = driver === 'sqlite' ? string(database.sqlite_path ?? './gacha.sqlite') : undefined;
  if (driver === 'sqlite') connection = { driver, filename: resolvePath(dirname(file), sqlitePath!) };
  else if (driver === 'postgres') {
    const url = string(env.DATABASE_URL ?? database.url);
    try { if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) throw new Error(); }
    catch { throw new StartupError('INVALID_DATABASE_URL'); }
    connection = { driver, url };
  } else throw new StartupError('INVALID_DATABASE_DRIVER');
  const keyFile = resolvePath(dirname(file), string(security.credential_key_file ?? './credential-key'));
  if (connection.driver === 'sqlite' && [file, keyFile].includes(connection.filename)) throw new StartupError('OVERLAPPING_PATHS');
  if (security.credential_key === undefined && keyFile === file) throw new StartupError('OVERLAPPING_PATHS');
  return { configFile: file, dataDirectory, host, port, publicUrl: publicUrl.href, userTimezone,
    database: connection, ...(sqlitePath === undefined ? {} : { sqlitePath }), adminUsername: 'admin', adminPassword, keyFile,
    ...(security.credential_key === undefined ? {} : { keyText: string(security.credential_key) }) };
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new StartupError('FILE_READ_FAILED'); }
}

function configurationDocument(config: RuntimeConfig, keyText: string) {
  return stringify({
    server: { host: config.host, port: config.port, public_url: config.publicUrl, user_timezone: config.userTimezone },
    database: config.database.driver === 'sqlite'
      ? { driver: 'sqlite', sqlite_path: config.sqlitePath ?? config.database.filename }
      : { driver: 'postgres', url: config.database.url },
    admin: { username: 'admin', password: config.adminPassword },
    security: { credential_key: keyText.trim() },
  });
}

export async function initializeDeployment(options: DeploymentOptions = {}) {
  const env = options.env ?? process.env;
  const dataDirectory = resolvePath(projectRoot, options.dataDirectory ?? env.GRV_DATA_DIR ?? './data');
  const configFile = resolvePath(projectRoot, env.GRV_CONFIG ?? resolve(dataDirectory, 'config.toml'));
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  const source = await readOptional(configFile);
  // Environment variables seed a new configuration. Existing files are authoritative.
  // Legacy releases did not persist Docker overrides; consume those once during upgrade.
  let legacy = false;
  if (source !== undefined) {
    try { legacy = section(parse(source).security).credential_key_file !== undefined; }
    catch { throw new StartupError('INVALID_TOML'); }
  }
  const config = parseConfiguration(source ?? '', configFile, dataDirectory, source === undefined || legacy ? env : {});
  let keyText = config.keyText ?? await readOptional(config.keyFile);
  if (keyText === undefined) keyText = `v1:${randomBytes(32).toString('hex')}`;
  if (!/^v1:[a-f0-9]{64}\n?$/.test(keyText)) throw new StartupError('INVALID_KEY_FILE');
  const key = Buffer.from(keyText.trim().slice(3), 'hex');
  const keyFingerprint = createHash('sha256').update(key).digest('hex');
  const adminFingerprint = createHmac('sha256', key).update(`admin\0${config.adminPassword}`).digest('hex');
  // Save defaults before connecting: a connection failure can be fixed by editing TOML.
  const normalized = configurationDocument(config, keyText);
  if (source !== normalized) {
    const temporary = `${configFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, normalized, { mode: 0o600, flag: 'wx' });
      await rename(temporary, configFile);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  let connection: DatabaseConnection | undefined;
  try {
    if (config.database.driver === 'sqlite') await mkdir(dirname(config.database.filename), { recursive: true, mode: 0o700 });
    try { connection = await openConnection(config.database); } catch { throw new StartupError('DATABASE_UNAVAILABLE'); }
    const before = await connection.inspect();
    // Binding checks encrypted credentials after migrations; setup-only databases
    // can safely adopt the configured key without discarding users or records.
    await connection.migrate();
    const adminSessionVersion = await bindInstallation(connection, {
      installationId: before.state?.installation_id ?? randomUUID(), keyFingerprint, adminFingerprint,
    });
    return { config, credentialKey: key, adminSessionVersion, connection, repositories: repositories(connection) };
  } catch (error) {
    key.fill(0);
    if (connection) await connection.close().catch(() => undefined);
    if (error instanceof PersistenceError && error.code === 'KEY_MISMATCH') throw new StartupError('KEY_MISMATCH');
    if (error instanceof StartupError) throw error;
    throw new StartupError('INITIALIZATION_FAILED');
  }
}
