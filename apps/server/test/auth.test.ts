import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { temporaryDirectory } from '../../../packages/db/test/helpers.js';
import { buildApp } from '../src/app.js';
import { digest } from '../src/auth/security.js';
import { initializeDeployment } from '../src/deployment.js';

const origin = 'https://gacha.example.test';
type Session = { cookie: string; csrfToken: string };
let fixture: Awaited<ReturnType<typeof temporaryDirectory>>;
let deployment: Awaited<ReturnType<typeof initializeDeployment>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let time: number;
async function openApp() {
  deployment = await initializeDeployment({ dataDirectory: fixture.directory, env: {} });
  app = await buildApp({ database: deployment.connection, auth: {
    connection: deployment.connection, adminPassword: deployment.config.adminPassword,
    adminSessionVersion: deployment.adminSessionVersion, credentialKey: deployment.credentialKey,
    publicUrl: origin, now: () => time,
  } });
}
beforeEach(async () => { fixture = await temporaryDirectory(); time = Date.now(); await openApp(); });
afterEach(async () => { await app?.close(); deployment?.credentialKey.fill(0); await fixture.cleanup(); });
function post(url: string, payload: Record<string, unknown>, session?: Session) {
  return app.inject({ method: 'POST', url, payload, headers: {
    origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
  } });
}
async function login(kind: 'user' | 'admin', username: string, password: string): Promise<Session> {
  const response = await post(`/api/${kind === 'user' ? 'auth' : 'admin'}/login`, { username, password });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  const cookie = Array.isArray(header) ? header[0]! : header!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict');
  return { cookie: cookie.split(';')[0]!, csrfToken: response.json().csrfToken };
}
const adminLogin = () => login('admin', 'admin', deployment.config.adminPassword);
const me = (session: Session, kind = 'auth') => app.inject({ url: `/api/${kind}/me`, headers: { cookie: session.cookie } });
async function create(admin: Session, username = 'friend') {
  const response = await post('/api/admin/users', { username }, admin);
  expect(response.statusCode).toBe(201); return response.json().user as { id: string; username: string; isInitialPassword: boolean };
}

describe('R04 authentication boundaries', () => {
  it('creates normalized accounts, hashes passwords and stores only session digests; initial password is usable', async () => {
    const admin = await adminLogin();
    const user = await create(admin, ' Friend ');
    expect(user).toMatchObject({ username: 'friend', isInitialPassword: true });
    const stored = await deployment.repositories.users.findById(user.id);
    expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
    const session = await login('user', 'FRIEND', '12345678');
    const token = session.cookie.split('=')[1]!;
    expect(await deployment.repositories.sessions.get(token)).toBeUndefined();
    expect((await deployment.repositories.sessions.get(digest(token)))?.owner_id).toBe(user.id);
    const current = await me(session);
    expect(current.statusCode).toBe(200);
    expect(current.json().user.isInitialPassword).toBe(true);
    expect(current.headers['cache-control']).toBe('no-store');
    expect(current.body).not.toMatch(/password_hash|session_version|12345678/);
    expect((await post('/api/admin/users', { username: 'FRIEND' }, admin)).statusCode).toBe(409);
    expect((await post('/api/admin/users', { username: 'Admin' }, admin)).statusCode).toBe(400);
    const users = await app.inject({ url: '/api/admin/users', headers: { cookie: admin.cookie } });
    expect(users.json().users).toHaveLength(1); expect(users.body).not.toContain('password_hash');
    expect((await post('/api/auth/register', { username: 'public', password: '12345678' })).statusCode).toBe(404);
  });

  it('requires the correct role, allowed Origin and session-bound CSRF token', async () => {
    const admin = await adminLogin(); const user = await create(admin);
    const session = await login('user', 'friend', '12345678');
    expect((await app.inject('/api/admin/users')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/users', headers: { cookie: session.cookie } })).statusCode).toBe(401);
    expect((await me(admin)).statusCode).toBe(401);
    expect((await post(`/api/admin/users/${user.id}/reset-password`, {}, session)).statusCode).toBe(401);
    for (const badOrigin of [undefined, 'https://attacker.example', 'null']) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'friend', password: '12345678' },
        headers: badOrigin ? { origin: badOrigin } : {} });
      expect(response.statusCode).toBe(403);
    }
    const noCsrf = await app.inject({ method: 'POST', url: '/api/admin/users', payload: { username: 'other' }, headers: { origin, cookie: admin.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await post('/api/admin/users', { username: 'other' }, { ...admin, csrfToken: session.csrfToken })).statusCode).toBe(403);
    expect((await me(admin, 'admin')).statusCode).toBe(200);
  });

  it('changes only the current account, requires its password, and revokes every old user session', async () => {
    const admin = await adminLogin(); await create(admin); const other = await create(admin, 'another');
    const first = await login('user', 'friend', '12345678');
    const second = await login('user', 'friend', '12345678');
    const another = await login('user', 'another', '12345678');
    expect((await post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'new-password' }, first)).statusCode).toBe(401);
    expect((await post('/api/auth/password', { currentPassword: '12345678', newPassword: 'new-password', userId: other.id }, first)).statusCode).toBe(400);
    expect((await post('/api/auth/password', { currentPassword: '12345678', newPassword: 'new-password' }, first)).statusCode).toBe(204);
    expect((await me(first)).statusCode).toBe(401); expect((await me(second)).statusCode).toBe(401);
    expect((await me(another)).statusCode).toBe(200);
    expect((await post('/api/auth/login', { username: 'friend', password: '12345678' })).statusCode).toBe(401);
    const changed = await login('user', 'friend', 'new-password');
    expect((await me(changed)).json().user.isInitialPassword).toBe(false);
    await post('/api/auth/password', { currentPassword: 'new-password', newPassword: '12345678' }, changed);
    expect((await me(await login('user', 'friend', '12345678'))).json().user.isInitialPassword).toBe(true);
  });

  it('resets to the initial password and invalidates old sessions; logout deletes the active session', async () => {
    const admin = await adminLogin(); const user = await create(admin);
    const first = await login('user', 'friend', '12345678');
    await post('/api/auth/password', { currentPassword: '12345678', newPassword: 'new-password' }, first);
    const changed = await login('user', 'friend', 'new-password');
    const reset = await post(`/api/admin/users/${user.id}/reset-password`, {}, admin);
    expect(reset.json()).toMatchObject({ initialPassword: '12345678', user: { isInitialPassword: true } });
    expect((await me(changed)).statusCode).toBe(401);
    const current = await login('user', 'friend', '12345678');
    expect((await post('/api/auth/logout', {}, current)).statusCode).toBe(204);
    expect((await me(current)).statusCode).toBe(401);
    expect((await post('/api/admin/users/not-an-account/reset-password', {}, admin)).statusCode).toBe(404);
    expect((await post('/api/admin/logout', {}, admin)).statusCode).toBe(204);
    expect((await me(admin, 'admin')).statusCode).toBe(401);
  });

  it('retains sessions across restart but revokes administrators when the configured password changes', async () => {
    const admin = await adminLogin(); await create(admin);
    const user = await login('user', 'friend', '12345678');
    await app.close(); await openApp();
    expect((await me(admin, 'admin')).statusCode).toBe(200);
    expect((await me(user)).json().csrfToken).toBe(user.csrfToken);
    const oldPassword = deployment.config.adminPassword;
    await app.close();
    const config = parse(await readFile(deployment.config.configFile, 'utf8'));
    (config.admin as Record<string, unknown>).password = 'changed-admin-password';
    await writeFile(deployment.config.configFile, stringify(config)); await openApp();
    expect((await me(admin, 'admin')).statusCode).toBe(401);
    expect((await me(user)).statusCode).toBe(200);
    expect((await post('/api/admin/login', { username: 'admin', password: oldPassword })).statusCode).toBe(401);
    expect((await me(await adminLogin(), 'admin')).statusCode).toBe(200);
  });

  it('expires sessions and limits repeated login attempts even with spoofed forwarded IPs', async () => {
    const admin = await adminLogin(); await create(admin);
    const user = await login('user', 'friend', '12345678');
    time += 8 * 3600_000;
    expect((await me(admin, 'admin')).statusCode).toBe(401);
    expect((await me(user)).statusCode).toBe(200);
    time += 7 * 24 * 3600_000;
    expect((await me(user)).statusCode).toBe(401);
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'friend', password: 'wrong' }, headers: { origin, 'x-forwarded-for': `192.0.2.${i}` } });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await post('/api/auth/login', { username: 'friend', password: '12345678' });
    expect(blocked.statusCode).toBe(429); expect(blocked.headers['retry-after']).toBeDefined();
    time += 15 * 60_000;
    expect((await me(await login('user', 'friend', '12345678'))).statusCode).toBe(200);
  });
});
