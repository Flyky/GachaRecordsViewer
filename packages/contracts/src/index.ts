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
