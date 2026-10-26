import type { SQL } from 'drizzle-orm';

export type DatabaseConfig = { driver: 'sqlite'; filename: string } | { driver: 'postgres'; url: string };
export interface SqlExecutor {
  query<T>(statement: SQL): Promise<T[]>;
  execute(statement: SQL): Promise<void>;
}
export interface InstallationState {
  installation_id: string;
  key_fingerprint: string;
  admin_fingerprint: string;
  admin_session_version: string;
}
export interface DatabaseConnection {
  kind: 'sqlite' | 'postgres';
  executor: SqlExecutor;
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  inspect(): Promise<{ hasTables: boolean; state: InstallationState | undefined }>;
  migrate(): Promise<void>;
  probe(): Promise<void>;
  close(): Promise<void>;
}
export class PersistenceError extends Error {
  constructor(readonly code: 'OWNER_MISMATCH' | 'INSTALLATION_MISMATCH' | 'KEY_MISMATCH' | 'USERNAME_TAKEN') {
    super(code);
    this.name = 'PersistenceError';
  }
}
