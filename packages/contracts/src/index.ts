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
