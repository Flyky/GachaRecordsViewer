import { createHmac, randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { AccountPasswordResponse, AdminSessionResponse, AdminUsersResponse, LocalUser, UserSessionResponse } from '@gacha/contracts';
import { PersistenceError, repositories, type DatabaseConnection, type UserRow } from '@gacha/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, AuthLimiter, digest, equalSecret, hashPassword, INITIAL_PASSWORD, verifyPassword } from './security.js';

type Kind = 'admin' | 'user';
interface SessionPrincipal {
  kind: Kind;
  sessionHash: string;
  csrfToken: string;
  authVersion: string;
  user: LocalUser | null;
}
declare module 'fastify' {
  interface FastifyRequest { principal: SessionPrincipal | null }
  interface FastifyInstance {
    authenticateUser(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    authenticateAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export interface AuthOptions {
  connection: DatabaseConnection;
  adminPassword: string;
  adminSessionVersion: string;
  credentialKey: Buffer;
  publicUrl: string;
  development?: boolean;
  now?: () => number;
}

const publicUser = (user: UserRow): LocalUser => ({
  id: user.id, username: user.username, isInitialPassword: user.is_initial_password === 1, createdAt: user.created_at,
});
const credentialSchema = {
  type: 'object', required: ['username', 'password'], additionalProperties: false,
  properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 1024 } },
};

export async function registerAuth(app: FastifyInstance, options: AuthOptions) {
  await app.register(cookie);
  app.decorateRequest('principal', null);
  const repo = repositories(options.connection);
  const now = options.now ?? Date.now;
  const limiter = new AuthLimiter(now);
  const secure = new URL(options.publicUrl).protocol === 'https:';
  const basePath = new URL(options.publicUrl).pathname.replace(/\/+$/, '') + '/';
  const apiPrefix = `${basePath}api/`;
  const origins = new Set([new URL(options.publicUrl).origin]);
  if (options.development) {
    origins.add('http://127.0.0.1:5173'); origins.add('http://localhost:5173');
  }
  const csrfKey = createHmac('sha256', options.credentialKey).update('local-auth-csrf-v1').digest();
  app.addHook('onClose', async () => { csrfKey.fill(0); });
  const adminHash = await hashPassword(options.adminPassword);
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  const cookieName = (kind: Kind) => `${secure ? basePath === '/' ? '__Host-' : '__Secure-' : ''}grv_${kind}`;
  const cookieOptions = { path: basePath, httpOnly: true, sameSite: 'strict' as const, secure };
  const tokenCsrf = (kind: Kind, token: string) => createHmac('sha256', csrfKey).update(`${kind}\0${token}`).digest('base64url');
  const clearCookie = (reply: FastifyReply, kind: Kind) => reply.clearCookie(cookieName(kind), cookieOptions);

  // These hooks also apply to future authenticated modules on this application instance.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith(apiPrefix)) reply.header('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.url.startsWith(apiPrefix)) return;
    if (!origins.has(request.headers.origin ?? '') || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, 'ORIGIN_REJECTED');
    }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED');
  });

  const authenticate = (kind: Kind) => async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[cookieName(kind)];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, 'UNAUTHENTICATED');
    const sessionHash = digest(token);
    const session = await repo.sessions.get(sessionHash);
    if (!session || session.kind !== kind || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= now()) {
      if (session?.kind === kind) await repo.sessions.remove(sessionHash);
      clearCookie(reply, kind); throw new ApiError(401, 'UNAUTHENTICATED');
    }
    const user = kind === 'user' && session.owner_id ? await repo.users.findById(session.owner_id) : undefined;
    const validVersion = kind === 'user'
      ? user && String(user.session_version) === session.auth_version
      : session.auth_version === options.adminSessionVersion && session.auth_version === await repo.sessions.adminVersion();
    if (!validVersion) {
      await repo.sessions.remove(sessionHash); clearCookie(reply, kind); throw new ApiError(401, 'UNAUTHENTICATED');
    }
    const csrfToken = tokenCsrf(kind, token);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const provided = request.headers['x-csrf-token'];
      if (typeof provided !== 'string' || !equalSecret(provided, csrfToken)) throw new ApiError(403, 'CSRF_REJECTED');
    }
    request.principal = { kind, sessionHash, csrfToken, authVersion: session.auth_version, user: user ? publicUser(user) : null };
  };
  const requireUser = authenticate('user'), requireAdmin = authenticate('admin');
  app.decorate('authenticateUser', requireUser); app.decorate('authenticateAdmin', requireAdmin);

  async function issue(request: FastifyRequest, reply: FastifyReply, kind: Kind, user?: UserRow) {
    const previous = request.cookies[cookieName(kind)];
    if (previous && /^[A-Za-z0-9_-]{43}$/.test(previous)) await repo.sessions.remove(digest(previous));
    await repo.sessions.removeExpired(new Date(now()).toISOString());
    const token = randomBytes(32).toString('base64url');
    const ttl = kind === 'admin' ? 8 * 3600 : 7 * 24 * 3600;
    await repo.sessions.create({ idHash: digest(token), kind, ...(user ? { ownerId: user.id } : {}),
      authVersion: user ? String(user.session_version) : options.adminSessionVersion, expiresAt: new Date(now() + ttl * 1000).toISOString() });
    reply.setCookie(cookieName(kind), token, { ...cookieOptions, maxAge: ttl });
    return tokenCsrf(kind, token);
  }

  for (const kind of ['user', 'admin'] as const) {
    const prefix = kind === 'user' ? '/api/auth' : '/api/admin';
    const guard = kind === 'user' ? requireUser : requireAdmin;
    app.post<{ Body: { username: string; password: string } }>(`${prefix}/login`, { bodyLimit: 8192, schema: { body: credentialSchema } }, async (request, reply) => {
      const username = request.body.username.trim().toLowerCase();
      limiter.consume(request.ip, `login:${kind}:${username}`);
      const user = kind === 'user' ? await repo.users.findByUsername(username) : undefined;
      const encoded = kind === 'admin' && username === 'admin' ? adminHash : user?.password_hash ?? dummyHash;
      const verified = await verifyPassword(encoded, request.body.password);
      if (!verified || (kind === 'user' ? !user || username === 'admin' : username !== 'admin')) throw new ApiError(401, 'INVALID_CREDENTIALS');
      if (kind === 'admin' && await repo.sessions.adminVersion() !== options.adminSessionVersion) throw new ApiError(401, 'INVALID_CREDENTIALS');
      const csrfToken = await issue(request, reply, kind, user);
      return kind === 'user' ? { user: publicUser(user!), csrfToken } satisfies UserSessionResponse
        : { admin: { username: 'admin' }, csrfToken } satisfies AdminSessionResponse;
    });
    app.get(`${prefix}/me`, { preHandler: guard }, async (request) => kind === 'user'
      ? { user: request.principal!.user!, csrfToken: request.principal!.csrfToken } satisfies UserSessionResponse
      : { admin: { username: 'admin' }, csrfToken: request.principal!.csrfToken } satisfies AdminSessionResponse);
    app.post(`${prefix}/logout`, { preHandler: guard }, async (request, reply) => {
      await repo.sessions.remove(request.principal!.sessionHash); clearCookie(reply, kind); return reply.code(204).send();
    });
  }

  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', {
    preHandler: requireUser, bodyLimit: 8192,
    schema: { body: { type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false,
      properties: { currentPassword: { type: 'string', minLength: 1, maxLength: 1024 }, newPassword: { type: 'string', minLength: 8, maxLength: 128 } } } },
  }, async (request, reply) => {
    const user = await repo.users.findById(request.principal!.user!.id);
    if (!user || String(user.session_version) !== request.principal!.authVersion) throw new ApiError(401, 'UNAUTHENTICATED');
    limiter.consume(request.ip, `password:${user.id}`);
    if (!await verifyPassword(user.password_hash, request.body.currentPassword)) throw new ApiError(401, 'INVALID_CREDENTIALS');
    const changed = await repo.users.setPassword(user.id, { passwordHash: await hashPassword(request.body.newPassword),
      isInitialPassword: request.body.newPassword === INITIAL_PASSWORD, expectedVersion: user.session_version });
    if (!changed) throw new ApiError(409, 'SESSION_CHANGED');
    clearCookie(reply, 'user'); return reply.code(204).send();
  });

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({ users: (await repo.users.list()).map(publicUser) } satisfies AdminUsersResponse));
  app.post<{ Body: { username: string } }>('/api/admin/users', { preHandler: requireAdmin, bodyLimit: 1024,
    schema: { body: { type: 'object', required: ['username'], additionalProperties: false,
      properties: { username: { type: 'string', minLength: 3, maxLength: 64 } } } },
  }, async (request, reply) => {
    const username = request.body.username.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) || username === 'admin') throw new ApiError(400, 'INVALID_USERNAME');
    try {
      const user = await repo.users.create({ username, passwordHash: await hashPassword(INITIAL_PASSWORD) });
      return reply.code(201).send({ user: publicUser(user), initialPassword: INITIAL_PASSWORD } satisfies AccountPasswordResponse);
    } catch (error) {
      if (error instanceof PersistenceError && error.code === 'USERNAME_TAKEN') throw new ApiError(409, 'USERNAME_TAKEN');
      throw error;
    }
  });
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-password', { preHandler: requireAdmin,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } },
      body: { type: 'object', additionalProperties: false } },
  }, async (request) => {
    const user = await repo.users.setPassword(request.params.id, { passwordHash: await hashPassword(INITIAL_PASSWORD), isInitialPassword: true });
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND');
    return { user: publicUser(user), initialPassword: INITIAL_PASSWORD } satisfies AccountPasswordResponse;
  });
}
