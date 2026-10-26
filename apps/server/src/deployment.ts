import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindInstallation, openConnection, repositories, type DatabaseConfig, type DatabaseConnection } from '@gacha/db';
import { parse, stringify } from 'smol-toml';

export class StartupError extends Error {
  constructor(readonly code: string) { super(`Startup failed: ${code}. See docs/deployment.md.`); this.name = 'StartupError'; }
}

export interface RuntimeConfig {
  configFile: string;
  dataDirectory: string;
  installationId: string;
  host: string;
  port: number;
  publicUrl: string;
  userTimezone: string;
  database: DatabaseConfig;
  adminUsername: 'admin';
  adminPassword: string;
  keyFile: string;
}

interface DeploymentOptions { dataDirectory?: string; env?: Record<string, string | undefined> }
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

function table(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StartupError('INVALID_CONFIG');
  return value as Record<string, unknown>;
}
function string(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new StartupError('INVALID_CONFIG');
  return value;
}
function resolvePath(base: string, value: string) { return isAbsolute(value) ? value : resolve(base, value); }

export function parseConfiguration(source: string, file: string, dataDirectory: string, env: Record<string, string | undefined>): RuntimeConfig {
  let raw;
  try { raw = parse(source); } catch { throw new StartupError('INVALID_TOML'); }
  const known = { installation: ['id'], server: ['host', 'port', 'public_url', 'user_timezone'],
    database: ['driver', 'sqlite_path', 'url'], admin: ['username', 'password'], security: ['credential_key_file'] };
  for (const key of Object.keys(raw)) if (!Object.hasOwn(known, key)) throw new StartupError('UNKNOWN_CONFIG_FIELD');
  for (const [section, fields] of Object.entries(known)) {
    const values = table(raw[section]);
    for (const key of Object.keys(values)) if (!fields.includes(key)) throw new StartupError('UNKNOWN_CONFIG_FIELD');
  }
  const installation = table(raw.installation), server = table(raw.server), database = table(raw.database);
  const admin = table(raw.admin), security = table(raw.security);
  const installationId = string(installation.id);
  if (!/^[a-f0-9-]{36}$/i.test(installationId)) throw new StartupError('INVALID_INSTALLATION_ID');
  const host = string(env.HOST ?? server.host);
  const portInput = env.PORT ?? server.port;
  if ((typeof portInput !== 'number' && typeof portInput !== 'string') || !/^\d+$/.test(String(portInput))) throw new StartupError('INVALID_PORT');
  const port = Number(portInput);
  if (port < 1 || port > 65535) throw new StartupError('INVALID_PORT');
  let publicUrl: URL;
  try { publicUrl = new URL(string(env.PUBLIC_URL ?? server.public_url)); }
  catch { throw new StartupError('INVALID_PUBLIC_URL'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) throw new StartupError('INVALID_PUBLIC_URL');
  const userTimezone = string(env.USER_TIMEZONE ?? server.user_timezone);
  try { new Intl.DateTimeFormat('en', { timeZone: userTimezone }); } catch { throw new StartupError('INVALID_TIMEZONE'); }
  if (admin.username !== 'admin') throw new StartupError('INVALID_ADMIN_USERNAME');
  const adminPassword = string(admin.password);
  if (adminPassword.length < 8) throw new StartupError('ADMIN_PASSWORD_TOO_SHORT');
  const driver = env.DATABASE_DRIVER ?? database.driver;
  let connection: DatabaseConfig;
  if (driver === 'sqlite') {
    const filename = resolvePath(dirname(file), string(database.sqlite_path));
    connection = { driver, filename };
  } else if (driver === 'postgres') {
    const url = string(env.DATABASE_URL ?? database.url);
    try { if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) throw new Error(); }
    catch { throw new StartupError('INVALID_DATABASE_URL'); }
    connection = { driver, url };
  } else throw new StartupError('INVALID_DATABASE_DRIVER');
  const keyFile = resolvePath(dirname(file), string(security.credential_key_file));
  if (keyFile === file || (connection.driver === 'sqlite' && [file, keyFile].includes(connection.filename))) throw new StartupError('OVERLAPPING_PATHS');
  const reserved = [resolve(dataDirectory, 'installation.json'), resolve(dataDirectory, '.bootstrap.lock')];
  if ([file, keyFile, ...(connection.driver === 'sqlite' ? [connection.filename] : [])].some((path) => reserved.includes(path))) throw new StartupError('OVERLAPPING_PATHS');
  return { configFile: file, dataDirectory, installationId, host, port, publicUrl: publicUrl.href,
    userTimezone, database: connection, adminUsername: 'admin', adminPassword, keyFile };
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new StartupError('FILE_READ_FAILED'); }
}

/** Publish once without replacing an existing file, including on another startup process. */
async function publish(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, file);
  } finally { await unlink(temporary).catch(() => undefined); }
}

function defaults() {
  return stringify({
    installation: { id: randomUUID() },
    server: { host: '127.0.0.1', port: 3000, public_url: 'http://127.0.0.1:3000', user_timezone: 'Asia/Shanghai' },
    database: { driver: 'sqlite', sqlite_path: './gacha.sqlite' },
    admin: { username: 'admin', password: randomBytes(24).toString('base64url') },
    security: { credential_key_file: './credential-key' },
  });
}

export async function initializeDeployment(options: DeploymentOptions = {}) {
  const env = options.env ?? process.env;
  const dataDirectory = resolvePath(projectRoot, options.dataDirectory ?? env.GRV_DATA_DIR ?? './data');
  const configFile = resolvePath(projectRoot, env.GRV_CONFIG ?? resolve(dataDirectory, 'config.toml'));
  const markerFile = resolve(dataDirectory, 'installation.json');
  const lockFile = resolve(dataDirectory, '.bootstrap.lock');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch { throw new StartupError('BOOTSTRAP_LOCKED'); }
  let connection: DatabaseConnection | undefined;
  try {
    const source = await readOptional(configFile);
    if (source === undefined && (await readdir(dataDirectory)).some((name) => name !== '.bootstrap.lock')) throw new StartupError('CONFIG_MISSING');
    const pendingSource = source ?? defaults();
    const config = parseConfiguration(pendingSource, configFile, dataDirectory, env);
    const markerText = await readOptional(markerFile);
    let marker: Record<string, unknown> | undefined;
    if (markerText !== undefined) {
      try { marker = table(JSON.parse(markerText)); } catch { throw new StartupError('INVALID_INSTALLATION_MARKER'); }
    }
    let keyText = await readOptional(config.keyFile);
    if (marker && (keyText === undefined || source === undefined)) throw new StartupError('KEY_OR_CONFIG_MISSING');
    if (config.database.driver === 'sqlite') {
      if (marker && await readOptionalDatabaseExists(config.database.filename) === false) throw new StartupError('DATABASE_STATE_MISSING');
      await mkdir(dirname(config.database.filename), { recursive: true, mode: 0o700 });
    }
    try { connection = await openConnection(config.database); } catch { throw new StartupError('DATABASE_UNAVAILABLE'); }
    const before = await connection.inspect();
    if (source === undefined && before.hasTables) throw new StartupError('CONFIG_MISSING');
    if (marker && !before.state) throw new StartupError('DATABASE_STATE_MISSING');
    if (before.hasTables && !before.state) throw new StartupError('UNRECOGNIZED_DATABASE');
    if (before.state && keyText === undefined) throw new StartupError('KEY_MISSING');
    if (keyText === undefined) keyText = `v1:${randomBytes(32).toString('hex')}\n`;
    if (!/^v1:[a-f0-9]{64}\n?$/.test(keyText)) throw new StartupError('INVALID_KEY_FILE');
    const key = Buffer.from(keyText.trim().slice(3), 'hex');
    const keyFingerprint = createHash('sha256').update(key).digest('hex');
    const adminFingerprint = createHmac('sha256', key).update(`admin\0${config.adminPassword}`).digest('hex');
    if (marker && (marker.installationId !== config.installationId || marker.keyFingerprint !== keyFingerprint)) throw new StartupError('INSTALLATION_MARKER_MISMATCH');
    if (before.state?.installation_id !== undefined && before.state.installation_id !== config.installationId) throw new StartupError('INSTALLATION_MISMATCH');
    if (before.state?.key_fingerprint !== undefined && before.state.key_fingerprint !== keyFingerprint) throw new StartupError('KEY_MISMATCH');
    if (source === undefined) await publish(configFile, pendingSource);
    if (await readOptional(config.keyFile) === undefined) await publish(config.keyFile, keyText);
    await connection.migrate();
    const adminSessionVersion = await bindInstallation(connection, { installationId: config.installationId, keyFingerprint, adminFingerprint });
    if (marker === undefined) await publish(markerFile, JSON.stringify({ version: 1, installationId: config.installationId, keyFingerprint }) + '\n');
    return { config, credentialKey: key, adminSessionVersion, connection, repositories: repositories(connection) };
  } catch (error) {
    if (connection) await connection.close().catch(() => undefined);
    if (error instanceof StartupError) throw error;
    throw new StartupError('INITIALIZATION_FAILED');
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

async function readOptionalDatabaseExists(file: string) {
  try { const handle = await open(file, 'r'); await handle.close(); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new StartupError('FILE_READ_FAILED'); }
}
