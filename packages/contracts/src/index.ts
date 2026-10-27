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
