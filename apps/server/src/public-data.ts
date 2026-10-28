import { isIP } from 'node:net';
import type { DataSourceSettings } from '@gacha/contracts';
import { snapshotRepository, type DatabaseConnection } from '@gacha/db';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './auth/security.js';

export function normalizeGithubProxy(input: string) {
  const value = input.trim(); if (!value) return '';
  try {
    const url = new URL(value);
    if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /\.(localhost|local|internal)$/.test(url.hostname)) throw new Error();
    return url.href.replace(/\/+$/, '') + '/';
  } catch { throw new ApiError(400, 'DATA_PROXY_INVALID'); }
}

export async function dataSourceService(connection: DatabaseConnection, now = Date.now) {
  const repo = snapshotRepository(connection);
  let current: DataSourceSettings = { githubProxy: '', updatedAt: null }, busy = false;
  try {
    const saved = await repo.load('data-source-settings') as DataSourceSettings | undefined;
    if (saved && typeof saved.githubProxy === 'string' && typeof saved.updatedAt === 'string' && Number.isFinite(Date.parse(saved.updatedAt))) {
      current = { githubProxy: normalizeGithubProxy(saved.githubProxy), updatedAt: saved.updatedAt };
    }
  } catch { /* An unavailable setting must not prevent startup with direct access. */ }
  return {
    status: (): DataSourceSettings => ({ ...current }),
    proxy: () => current.githubProxy,
    save: async (input: string) => {
      const githubProxy = normalizeGithubProxy(input);
      if (busy) throw new ApiError(409, 'DATA_PROXY_BUSY'); busy = true;
      try {
        const candidate = { githubProxy, updatedAt: new Date(now()).toISOString() };
        await repo.save('data-source-settings', candidate); current = candidate; return { ...current };
      } finally { busy = false; }
    },
  };
}

export function registerDataSources(app: FastifyInstance, service: Awaited<ReturnType<typeof dataSourceService>>) {
  app.get('/api/admin/data-sources', { onRequest: app.authenticateAdmin }, async () => service.status());
  app.post<{ Body: { githubProxy: string } }>('/api/admin/data-sources', {
    onRequest: app.authenticateAdmin, bodyLimit: 4096,
    schema: { body: { type: 'object', required: ['githubProxy'], additionalProperties: false, properties: { githubProxy: { type: 'string', maxLength: 2048 } } } },
  }, async (request) => service.save(request.body.githubProxy));
}

// Only fixed public upstreams call this helper. No cookies, tokens or caller headers are forwarded.
export async function requestPublicData<T>(url: string, read: (response: Response) => Promise<T>, options: {
  fetch: typeof globalThis.fetch; signal: AbortSignal; proxy?: string | undefined; proxyUrl?: string; directTimeoutMs?: number; proxyOnly?: boolean;
}) {
  const attempt = async (target: string, signal: AbortSignal) => {
    const response = await options.fetch(target, { signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'GachaRecordsViewer' } });
    try {
      if (!response.ok || !response.body) throw new Error('Public data unavailable');
      return await read(response);
    } catch (error) { await response.body?.cancel().catch(() => undefined); throw error; }
  };
  if (options.proxyOnly) {
    const upstream = options.proxyUrl ?? url, parsed = new URL(upstream);
    if (!options.proxy) throw new ApiError(400, 'DATA_PROXY_REQUIRED');
    if (parsed.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com', 'github.com'].includes(parsed.hostname)) throw new Error('Unsupported public source');
    options.signal.throwIfAborted(); return attempt(options.proxy + upstream, options.signal);
  }
  const direct = new AbortController();
  try { return await attempt(url, AbortSignal.any([options.signal, direct.signal, AbortSignal.timeout(options.directTimeoutMs ?? 8000)])); }
  finally { direct.abort(); }
}
