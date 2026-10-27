import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { CredentialVault } from '../src/community/vault.js';

it('encrypts with a fresh nonce and restores under the same key after restart; rejects tampering and swapped rows', () => {
  const key = randomBytes(32), vault = new CredentialVault(key), payload = { stoken: 'fixture-private-value', device: { id: 'device' } };
  const first = vault.seal(payload, 'owner', 'account', 'revision'), second = vault.seal(payload, 'owner', 'account', 'revision');
  expect(first).not.toBe(second); expect(first).not.toContain(payload.stoken);
  vault.destroy();
  const reopened = new CredentialVault(key);
  expect(reopened.open(first, 'owner', 'account', 'revision')).toEqual(payload);
  for (const binding of [['other', 'account', 'revision'], ['owner', 'other', 'revision'], ['owner', 'account', 'other']] as const) {
    expect(() => reopened.open(first, binding[0], binding[1], binding[2])).toThrow('CREDENTIAL_DECRYPT_FAILED');
  }
  const envelope = JSON.parse(first); envelope.data = Buffer.from('tampered').toString('base64url');
  expect(() => reopened.open(JSON.stringify(envelope), 'owner', 'account', 'revision')).toThrow('CREDENTIAL_DECRYPT_FAILED');
  const wrong = new CredentialVault(randomBytes(32));
  expect(() => wrong.open(first, 'owner', 'account', 'revision')).toThrow('CREDENTIAL_DECRYPT_FAILED');
  wrong.destroy(); reopened.destroy(); key.fill(0);
});
