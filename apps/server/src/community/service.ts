import { randomUUID } from 'node:crypto';
import type { CapabilityResult, CommunityAccount, CommunityCapabilities, CredentialKind } from '@gacha/contracts';
import { CommunityError, communityRepository, repositories, type DatabaseConnection, type StoredCommunity } from '@gacha/db';
import { createDevice, MiyousheClient, parseCredentials, ProbeError, type DeviceContext, type GameRole, type ManualCredentials } from '@gacha/providers';
import { ApiError } from '../auth/security.js';
import { CredentialVault } from './vault.js';

export type CommunityClient = Pick<MiyousheClient, 'getLToken' | 'verifyLToken' | 'getCookieToken' | 'listRoles' | 'generateAuthKey'>;
export interface CommunityOptions { client?: (device: DeviceContext) => CommunityClient }
interface Bundle extends ManualCredentials { version: 1; device: DeviceContext }
const kinds: CredentialKind[] = ['stoken', 'ltoken', 'cookieToken'];
const missing = (): CapabilityResult => ({ status: 'missing', checkedAt: null });
function capabilities(): CommunityCapabilities {
  return { identity: missing(), roles: missing(), wish: missing(), tokens: { stoken: missing(), ltoken: missing(), cookieToken: missing() }, lastValidation: missing() };
}
export function communityService(connection: DatabaseConnection, masterKey: Buffer, options: CommunityOptions = {}, now = Date.now) {
  const repo = communityRepository(connection), vault = new CredentialVault(masterKey), busy = new Set<string>();
  async function operation<T>(owner: string, action: () => Promise<T>) {
    if (busy.has(owner)) throw new ApiError(409, 'COMMUNITY_BUSY');
    busy.add(owner); try { return await action(); } finally { busy.delete(owner); }
  }
  function unpack(owner: string, row: StoredCommunity): Bundle {
    if (!row.encrypted_value || !row.credential_id || row.key_version !== 1) throw new ApiError(500, 'CREDENTIAL_DECRYPT_FAILED');
    return vault.open<Bundle>(row.encrypted_value, owner, row.id, row.credential_id);
  }
  async function publicAccount(owner: string, id: string): Promise<CommunityAccount> {
    const row = await repo.get(owner, id), caps = JSON.parse(row.capabilities_json) as CommunityCapabilities;
    return { id: row.id, provider: 'cn', accountId: row.account_id, capabilities: caps,
      credentials: kinds.map((type) => ({ type, present: caps.tokens[type].status !== 'missing', maskedValue: caps.tokens[type].status === 'missing' ? null : '••••••••' })),
      profiles: await repo.profiles(owner, id) };
  }
  async function check(input: ManualCredentials, device: DeviceContext) {
    const client = options.client?.(device) ?? new MiyousheClient({ device }), caps = capabilities();
    const timestamp = new Date(now()).toISOString();
    const verified = (): CapabilityResult => ({ status: 'verified', checkedAt: timestamp });
    const bundle: Bundle = { version: 1, accountId: input.accountId, device };
    let roles: GameRole[] | undefined;
    if (input.stoken) {
      if (!input.mid) throw new ApiError(400, 'STOKEN_MID_REQUIRED');
      const credentials = { accountId: input.accountId, mid: input.mid, stoken: input.stoken };
      bundle.cookieToken = await client.getCookieToken(credentials); bundle.stoken = input.stoken; bundle.mid = input.mid;
      caps.tokens.stoken = verified(); caps.tokens.cookieToken = verified();
      try {
        const ltoken = await client.getLToken(credentials), identity = await client.verifyLToken(input.accountId, ltoken);
        if (identity.mid !== input.mid) throw new ProbeError('role_mismatch', 'verifyLtoken');
        bundle.ltoken = ltoken; caps.tokens.ltoken = verified();
      } catch (error) {
        if (!(error instanceof ProbeError) || ['verification_required', 'cancelled', 'role_mismatch'].includes(error.code)) throw error;
        // Optional acquisition failed: do not save any unverified supplied LToken.
        caps.tokens.ltoken = { status: 'missing', checkedAt: timestamp, code: error.code };
      }
      caps.identity = verified();
    } else {
      if (input.ltoken) {
        const identity = await client.verifyLToken(input.accountId, input.ltoken);
        if (input.mid && input.mid !== identity.mid) throw new ProbeError('role_mismatch', 'verifyLtoken');
        bundle.mid = identity.mid; bundle.ltoken = input.ltoken; caps.tokens.ltoken = verified(); caps.identity = verified();
      }
      if (input.cookieToken) { bundle.cookieToken = input.cookieToken; }
    }
    if (bundle.cookieToken) {
      roles = await client.listRoles(input.accountId, bundle.cookieToken);
      if (roles.length > 32 || roles.some((role) => role.gameBiz !== 'hk4e_cn' || !['cn_gf01', 'cn_qd01'].includes(role.region) || !/^[1-9]\d{0,19}$/.test(role.uid)) || new Set(roles.map((role) => `${role.uid}:${role.region}`)).size !== roles.length) throw new ProbeError('protocol', 'roles');
      caps.tokens.cookieToken = verified(); caps.identity = verified(); caps.roles = verified();
    }
    if (caps.identity.status !== 'verified') throw new ApiError(400, 'NO_VERIFIABLE_CREDENTIAL');
    caps.wish = { status: bundle.stoken ? 'unverified' : 'missing', checkedAt: null, code: bundle.stoken ? 'authkey_not_checked' : 'stoken_required' };
    caps.lastValidation = verified();
    parseCredentials(JSON.stringify(bundle));
    return { bundle, caps, roles, client };
  }
  async function persist(owner: string, id: string, checked: Awaited<ReturnType<typeof check>>, revision: string | null) {
    const credentialId = randomUUID();
    await repo.save(owner, { id, accountId: checked.bundle.accountId, mid: checked.bundle.mid ?? null, capabilitiesJson: JSON.stringify(checked.caps),
      credentialId, encryptedValue: vault.seal(checked.bundle, owner, id, credentialId), expectedRevision: revision,
      ...(checked.roles === undefined ? {} : { roles: checked.roles }) });
    return publicAccount(owner, id);
  }
  return {
    close: () => vault.destroy(),
    get: publicAccount,
    list: async (owner: string) => {
      const result: CommunityAccount[] = [];
      for (const row of await repo.list(owner)) result.push(await publicAccount(owner, row.id));
      return result;
    },
    import: (owner: string, input: string, id?: string) => operation(owner, async () => {
      const existing = id ? await repo.get(owner, id) : undefined;
      const parsed = parseCredentials(input);
      if (existing && existing.account_id !== parsed.accountId) throw new CommunityError('COMMUNITY_IDENTITY_MISMATCH');
      const device = existing ? unpack(owner, existing).device : createDevice();
      return persist(owner, id ?? randomUUID(), await check(parsed, device), existing?.credential_id ?? null);
    }),
    validate: (owner: string, id: string, profileId?: string) => operation(owner, async () => {
      const existing = await repo.get(owner, id), original = unpack(owner, existing);
      const profile = profileId ? await repositories(connection).profiles.get(owner, profileId) : undefined;
      if (profileId && (!profile || profile.community_account_id !== id)) throw new CommunityError('PROFILE_NOT_BOUND');
      try {
        const checked = await check(original, original.device);
        if (profile) {
          if (!checked.bundle.stoken || !checked.bundle.mid) checked.caps.wish = { status: 'missing', checkedAt: new Date(now()).toISOString(), code: 'stoken_required', profileId: profile.id };
          else {
            const role = checked.roles?.find((role) => role.uid === profile.uid && role.region === profile.region);
            if (!role) throw new ProbeError('role_mismatch', 'authkey');
            await checked.client.generateAuthKey({ accountId: checked.bundle.accountId, mid: checked.bundle.mid, stoken: checked.bundle.stoken }, role);
            checked.caps.wish = { status: 'authkey_verified', checkedAt: new Date(now()).toISOString(), profileId: profile.id, code: 'history_not_checked' };
          }
        }
        return await persist(owner, id, checked, existing.credential_id!);
      } catch (error) {
        if (error instanceof ProbeError) {
          const caps = JSON.parse(existing.capabilities_json) as CommunityCapabilities, invalid = ['auth_invalid', 'expired', 'role_mismatch'].includes(error.code);
          const failure: CapabilityResult = { status: invalid ? 'invalid' : error.code === 'verification_required' ? 'verification_required' : 'error', checkedAt: new Date(now()).toISOString(), code: error.code };
          caps.lastValidation = failure;
          if (invalid || error.code === 'verification_required') { caps.identity = failure; caps.roles = failure; caps.wish = failure; for (const type of kinds) if (caps.tokens[type].status !== 'missing') caps.tokens[type] = failure; }
          await repo.failure(owner, id, existing.credential_id!, JSON.stringify(caps), invalid);
        }
        throw error;
      }
    }),
    reveal: (owner: string, id: string, type: CredentialKind) => operation(owner, async () => {
      const row = await repo.get(owner, id), bundle = unpack(owner, row), value = bundle[type];
      if (!value) throw new ApiError(404, 'CREDENTIAL_NOT_AVAILABLE');
      return { accountId: row.account_id, mid: bundle.mid ?? null, type, value };
    }),
    unlink: (owner: string, id: string) => operation(owner, async () => { await repo.remove(owner, id); }),
  };
}
