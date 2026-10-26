import { createHash, timingSafeEqual } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) {
    super(code); this.name = 'ApiError';
  }
}

export const INITIAL_PASSWORD = '12345678' as const;
export function hashPassword(password: string) {
  return hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
export async function verifyPassword(encoded: string, password: string) {
  try { return await verify(encoded, password); } catch { return false; }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
}

/** Fixed windows, bounded memory, and no raw usernames retained. Single-process deployment. */
export class AuthLimiter {
  private readonly entries = new Map<string, { count: number; until: number }>();
  constructor(private readonly now: () => number) {}

  consume(ip: string, subject: string) {
    const now = this.now(), window = 15 * 60_000;
    for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key);
    for (const [key, limit] of [[`ip:${ip}`, 20], [`subject:${digest(subject)}`, 10]] as const) {
      let entry = this.entries.get(key);
      if (!entry) {
        if (this.entries.size >= 2048) throw new ApiError(429, 'RATE_LIMITED', 900);
        entry = { count: 0, until: now + window }; this.entries.set(key, entry);
      }
      if (entry.count >= limit) throw new ApiError(429, 'RATE_LIMITED', Math.ceil((entry.until - now) / 1000));
      entry.count++;
    }
  }
}
