export const APP_NAME = 'GachaRecordsViewer';

/** Process liveness only; storage and upstream capability checks come later. */
export interface HealthResponse {
  status: 'ok';
  service: typeof APP_NAME;
}

export interface LocalUser {
  id: string;
  username: string;
  isInitialPassword: boolean;
  createdAt: string;
}

export interface UserSessionResponse { user: LocalUser; csrfToken: string }
export interface AdminSessionResponse { admin: { username: 'admin' }; csrfToken: string }
export interface AdminUsersResponse { users: LocalUser[] }
export interface AccountPasswordResponse { user: LocalUser; initialPassword: '12345678' }
export interface ApiErrorResponse { error: { code: string } }

export interface ImportProfileReport {
  index: number; uid: string; timezone: number; lang: string | null;
  targetProfileId: string | null; dataVersion: number | null;
  total: number; inserted: number; duplicates: number; enriched: number;
  conflicts: number; conflictDetails: { id: string; fields: string[] }[];
  blockers: string[]; metadataWarnings: number; metadataIncomplete: number; metadataConflicts: number;
  firstTime: string | null; lastTime: string | null;
}
export interface ImportPreviewResponse {
  version: 'v4.0' | 'v4.1' | 'v4.2'; fileHash: string; previewToken: string; expiresAt: number;
  profiles: ImportProfileReport[]; skippedBlocks: string[]; warnings: string[];
}
export interface ImportResultResponse { batchId: string; profiles: ImportProfileReport[]; skippedBlocks: string[] }
export interface GameProfileSummary {
  id: string; uid: string; game: 'hk4e'; region: string; timezone: number; lang: string | null;
  historyStatus: string; dataVersion: number; recordCount: number;
  firstTime: string | null; lastTime: string | null; metadataIncomplete: number;
}
export interface ProfilesResponse { profiles: GameProfileSummary[] }

export const RECORD_POOLS = ['100', '200', '301', '302', '500'] as const;
export type RecordPool = typeof RECORD_POOLS[number];
export const RECORD_PAGE_SIZES = [20, 50, 100, 200] as const;
export interface RecordFilters {
  from?: string; to?: string; pools?: RecordPool[]; itemTypes?: ('character' | 'weapon')[];
  ranks?: (3 | 4 | 5)[]; name?: string; order?: 'asc' | 'desc';
}
export interface RecordPageRequest extends RecordFilters { page?: number; pageSize?: typeof RECORD_PAGE_SIZES[number] }
export interface RecordListItem {
  id: string; itemId: string; time: string; name: string | null; itemType: 'character' | 'weapon' | null;
  rank: 3 | 4 | 5 | null; gachaType: string; pool: RecordPool; groupOrdinal: number;
  metadataStatus: 'complete' | 'incomplete' | 'conflict';
  pity: { count: number | null; status: 'exact' | 'partial-history' | 'unknown-rarity'; reasons: ('unknown-start' | 'known-gap' | 'unknown-rarity')[] };
}
export interface RecordPageResponse {
  profileId: string; uid: string; timezone: number; historyCount: number; total: number;
  page: number; pageSize: number; pageCount: number; records: RecordListItem[];
  totalsByPool: Partial<Record<RecordPool, number>>; metadataIncomplete: boolean;
}

export interface AnalysisMetadata { incompleteRecords: number; conflictRecords: number; unknownRankRecords: number }
export interface AnalysisContext { profileId: string; uid: string; timezone: number; dataVersion: number; dictionaryVersion: string; historyCount: number; metadataIssues: AnalysisMetadata }
export interface ItemStatistic { itemId: string; name: string | null; quantity: number }
export interface ItemAnalysisResponse extends AnalysisContext {
  itemType: 'character' | 'weapon'; order: 'asc' | 'desc'; selectedTypeCount: number; otherTypeCount: number;
  groups: { rank: 3 | 4 | 5; total: number; items: ItemStatistic[] }[];
  unclassified: { total: number; items: (ItemStatistic & { reasons: ('unknown-type' | 'unknown-rank' | 'conflicting-metadata' | 'unsupported-combination')[] })[] };
}
export interface MonthlyCounts { total: number; fiveStars: number; standard: number; characterEvent: number; weaponEvent: number }
export interface MonthlyAnalysisResponse extends AnalysisContext {
  months: (MonthlyCounts & { month: string })[]; totals: MonthlyCounts; fiveStarCountsIncomplete: boolean;
}
export interface DailyAnalysisResponse extends AnalysisContext {
  year: number; pool: RecordPool | null; calendarTimeZone: 'Asia/Shanghai'; availableYears: number[];
  days: { date: string; count: number }[]; total: number; maxDailyCount: number; hasRecords: boolean;
}

export type CredentialKind = 'stoken' | 'ltoken' | 'cookieToken';
export interface CapabilityResult {
  status: 'verified' | 'unverified' | 'missing' | 'invalid' | 'verification_required' | 'error' | 'authkey_verified';
  checkedAt: string | null; code?: string;
}
export interface CommunityCapabilities {
  identity: CapabilityResult; roles: CapabilityResult; wish: CapabilityResult & { profileId?: string };
  tokens: Record<CredentialKind, CapabilityResult>;
  lastValidation: CapabilityResult;
}
export interface CommunityAccount {
  id: string; provider: 'cn'; accountId: string; capabilities: CommunityCapabilities;
  credentials: { type: CredentialKind; present: boolean; maskedValue: string | null }[];
  profiles: { id: string; uid: string; region: string; timezone: number }[];
}
export interface CommunityAccountsResponse { accounts: CommunityAccount[] }
export interface CredentialRevealResponse { accountId: string; mid: string | null; type: CredentialKind; value: string }
export interface ImportableCredentials { accountId: string; mid?: string; stoken?: string; ltoken?: string; cookieToken?: string }
export interface CredentialExportResponse { credentials: ImportableCredentials }
export interface DictionaryStatus {
  source: string; version: string; count: number; updatedAt: string;
  storage: 'builtin' | 'database'; updating: boolean; cacheWarning: boolean;
}

export interface MiyousheQrSession {
  id: string;
  status: 'creating' | 'waiting' | 'scanned' | 'confirming' | 'confirmed' | 'cancelled' | 'expired' | 'verification_required' | 'failed';
  expiresAt: string; pollAfterMs: number; communityAccountId?: string; code?: string;
}
export interface MiyousheQrResponse { session: MiyousheQrSession }
export interface MiyousheQrCreateResponse extends MiyousheQrResponse { qrUrl: string }

export type SyncPool = '100' | '200' | '301' | '302' | '500';
export interface SyncPoolProgress {
  pool: SyncPool; status: 'queued' | 'running' | 'retrying' | 'completed' | 'failed';
  pages: number; fetched: number; inserted: number; duplicates: number; enriched: number; retries: number; authKeyRenewals: number;
  code: string | null; stopReason: 'upstream_end' | 'checkpoint' | null;
}
export interface SyncJob {
  id: string; profileId: string; status: 'queued' | 'running' | 'retrying' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  mode: 'incremental' | 'full'; createdAt: string; updatedAt: string; finishedAt: string | null; retryOf: string | null;
  failureCode: string | null; pools: SyncPoolProgress[];
}
export interface SyncJobResponse { job: SyncJob }
export interface SyncJobsResponse { jobs: SyncJob[] }
