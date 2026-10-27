import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { ApiError } from '../auth/security.js';

export class CredentialVault {
  private readonly key: Buffer;
  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('Invalid credential key');
    this.key = createHmac('sha256', masterKey).update('miyoushe-credential-encryption-v1').digest();
  }
  private aad(owner: string, account: string, revision: string) { return Buffer.from(JSON.stringify(['miyoushe_bundle', 1, owner, account, revision])); }
  seal(value: unknown, owner: string, account: string, revision: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(owner, account, revision));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') });
  }
  open<T>(envelope: string, owner: string, account: string, revision: string): T {
    try {
      if (envelope.length > 100000) throw new Error();
      const value = JSON.parse(envelope) as { v: number; iv: string; tag: string; data: string };
      const iv = Buffer.from(value.iv, 'base64url'), tag = Buffer.from(value.tag, 'base64url');
      if (value.v !== 1 || iv.length !== 12 || tag.length !== 16 || typeof value.data !== 'string') throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(this.aad(owner, account, revision)); cipher.setAuthTag(tag);
      const plain = Buffer.concat([cipher.update(Buffer.from(value.data, 'base64url')), cipher.final()]);
      try { return JSON.parse(plain.toString('utf8')) as T; } finally { plain.fill(0); }
    } catch { throw new ApiError(500, 'CREDENTIAL_DECRYPT_FAILED'); }
  }
  destroy() { this.key.fill(0); }
}
