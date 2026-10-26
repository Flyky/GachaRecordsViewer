import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const appState = sqliteTable('app_state', {
  id: text('id').primaryKey(), installationId: text('installation_id').notNull(),
  keyFingerprint: text('key_fingerprint').notNull(), adminFingerprint: text('admin_fingerprint').notNull(),
  adminSessionVersion: text('admin_session_version').notNull(),
}, (t) => [check('app_state_singleton', sql`${t.id} = 'primary'`)]);

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(), isInitialPassword: integer('is_initial_password').notNull().default(1),
  sessionVersion: integer('session_version').notNull().default(1), createdAt: text('created_at').notNull(),
}, (t) => [unique('users_username_unique').on(t.username),
  check('users_initial_boolean', sql`${t.isInitialPassword} IN (0, 1)`),
  check('users_session_version_positive', sql`${t.sessionVersion} > 0`)]);

export const sessions = sqliteTable('sessions', {
  idHash: text('id_hash').primaryKey(), kind: text('kind').notNull(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  authVersion: text('auth_version').notNull(), expiresAt: text('expires_at').notNull(),
}, (t) => [index('sessions_owner_idx').on(t.ownerId), check('sessions_subject_valid',
  sql`(${t.kind} = 'admin' AND ${t.ownerId} IS NULL) OR (${t.kind} = 'user' AND ${t.ownerId} IS NOT NULL)`)]);

export const communityAccounts = sqliteTable('community_accounts', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), accountId: text('account_id').notNull(), mid: text('mid'),
  nickname: text('nickname'), capabilitiesJson: text('capabilities_json').notNull().default('{}'),
}, (t) => [unique('community_owner_id_unique').on(t.ownerId, t.id),
  unique('community_identity_unique').on(t.ownerId, t.provider, t.accountId),
  check('community_provider_valid', sql`${t.provider} IN ('cn', 'os')`)]);

export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(),
  communityAccountId: text('community_account_id').notNull(), type: text('type').notNull(),
  encryptedValue: text('encrypted_value').notNull(), keyVersion: integer('key_version').notNull().default(1),
  status: text('status').notNull().default('unverified'),
}, (t) => [unique('credentials_account_type_unique').on(t.ownerId, t.communityAccountId, t.type),
  foreignKey({ columns: [t.ownerId, t.communityAccountId], foreignColumns: [communityAccounts.ownerId, communityAccounts.id] }).onDelete('cascade')]);

export const gameProfiles = sqliteTable('game_profiles', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  game: text('game').notNull(), uid: text('uid').notNull(), region: text('region').notNull().default('unknown'),
  timezone: integer('timezone').notNull(), lang: text('lang'), communityAccountId: text('community_account_id'),
  historyStatus: text('history_status').notNull().default('unknown'), dataVersion: integer('data_version').notNull().default(0),
}, (t) => [unique('profiles_owner_id_unique').on(t.ownerId, t.id),
  unique('profiles_identity_unique').on(t.ownerId, t.game, t.uid, t.region),
  check('profiles_timezone_valid', sql`${t.timezone} BETWEEN -12 AND 14`),
  check('profiles_game_valid', sql`${t.game} IN ('hk4e', 'hkrpg', 'nap')`),
  foreignKey({ columns: [t.ownerId, t.communityAccountId], foreignColumns: [communityAccounts.ownerId, communityAccounts.id] })]);

export const gachaRecords = sqliteTable('gacha_records', {
  ownerId: text('owner_id').notNull(), profileId: text('profile_id').notNull(), recordId: text('record_id').notNull(),
  itemId: text('item_id').notNull(), gachaType: text('gacha_type').notNull(), pityGroup: text('pity_group').notNull(),
  timeLocal: text('time_local').notNull(), timeUtc: text('time_utc').notNull(),
  name: text('name'), itemType: text('item_type'), rank: integer('rank'), source: text('source').notNull(),
}, (t) => [primaryKey({ columns: [t.profileId, t.recordId] }),
  foreignKey({ columns: [t.ownerId, t.profileId], foreignColumns: [gameProfiles.ownerId, gameProfiles.id] }).onDelete('cascade'),
  index('records_owner_profile_time_idx').on(t.ownerId, t.profileId, t.timeUtc),
  index('records_owner_pool_idx').on(t.ownerId, t.profileId, t.pityGroup),
  check('records_rank_valid', sql`${t.rank} IS NULL OR ${t.rank} IN (3, 4, 5)`)]);

export const importBatches = sqliteTable('import_batches', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  fileHash: text('file_hash').notNull(), status: text('status').notNull(), resultJson: text('result_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
}, (t) => [index('imports_owner_idx').on(t.ownerId)]);

export const syncJobs = sqliteTable('sync_jobs', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(), profileId: text('profile_id').notNull(),
  status: text('status').notNull(), progressJson: text('progress_json').notNull().default('{}'),
  failureCode: text('failure_code'), createdAt: text('created_at').notNull(),
}, (t) => [foreignKey({ columns: [t.ownerId, t.profileId], foreignColumns: [gameProfiles.ownerId, gameProfiles.id] }).onDelete('cascade'),
  index('jobs_owner_profile_idx').on(t.ownerId, t.profileId)]);

export const itemMetadata = sqliteTable('item_metadata', {
  game: text('game').notNull(), itemId: text('item_id').notNull(), itemType: text('item_type'), rank: integer('rank'),
  namesJson: text('names_json').notNull().default('{}'), sourceVersion: text('source_version').notNull(),
}, (t) => [primaryKey({ columns: [t.game, t.itemId] }),
  check('metadata_rank_valid', sql`${t.rank} IS NULL OR ${t.rank} IN (3, 4, 5)`)]);
