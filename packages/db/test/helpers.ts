import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const testRoot = fileURLToPath(new URL('../../../test-results/', import.meta.url));
export async function temporaryDirectory() {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'r03-'));
  return { directory, cleanup: async () => {
    if (dirname(resolve(directory)) !== resolve(testRoot)) throw new Error('Invalid test cleanup path');
    await rm(directory, { recursive: true, force: true });
  } };
}

/** Creates and later removes only a uniquely named database owned by this test run. */
export async function temporaryPostgres() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required for real PostgreSQL tests.');
  const name = `grv_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(base); url.pathname = `/${name}`;
  return { url: url.href, cleanup: async () => {
    if (!/^grv_test_[a-f0-9]{32}$/.test(name)) throw new Error('Invalid test database cleanup target');
    try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await admin.end(); }
  } };
}
