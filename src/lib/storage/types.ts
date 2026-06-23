import type {
  DatabaseConnection,
  QueryHistoryItem,
  SavedQuery,
  SchemaSnapshot,
  SavedChartConfig,
} from '../types';
import type { AuditEvent } from '../audit';
import type { MaskingConfig } from '../data-masking';
import type { ThresholdConfig } from '../monitoring-thresholds';

/**
 * All persistable collections and their data types.
 * Maps 1:1 with localStorage keys (minus the `libredb_` prefix).
 */
export interface StorageData {
  connections: DatabaseConnection[];
  history: QueryHistoryItem[];
  saved_queries: SavedQuery[];
  schema_snapshots: SchemaSnapshot[];
  saved_charts: SavedChartConfig[];
  active_connection_id: string | null;
  audit_log: AuditEvent[];
  masking_config: MaskingConfig;
  threshold_config: ThresholdConfig[];
}

/** Collection names that can be synced to server storage */
export type StorageCollection = keyof StorageData;

/** All persistable collection names */
export const STORAGE_COLLECTIONS: StorageCollection[] = [
  'connections',
  'history',
  'saved_queries',
  'schema_snapshots',
  'saved_charts',
  'active_connection_id',
  'audit_log',
  'masking_config',
  'threshold_config',
];

/**
 * Server-side storage provider interface.
 * Implements the Strategy Pattern — SQLite and PostgreSQL both implement this.
 */
export interface ServerStorageProvider {
  /** Create tables if they don't exist */
  initialize(): Promise<void>;
  /**
   * Get a user's data merged with the db connections they can access.
   *
   * Returns the `data` blob from the `app_user` table plus the connections
   * whose `group` matches one of the `groups` supplied by the identity
   * provider (Okta), plus ungrouped connections which are visible to all.
   * `userId` is the `app_user.id` surrogate key. The result is a
   * `Partial<StorageData>`.
   */
  getUserData(userId: string, groups?: string[]): Promise<Partial<StorageData>>;
  /**
   * Create or update a user row for `email`, persisting their `role`; returns
   * the user's `id`. Existing rows have their `role` refreshed. Group
   * membership is not stored — it is resolved from the session on demand.
   */
  upsertUser(email: string, role: 'admin' | 'user'): Promise<string>;
  /** Look up a user by email; returns the user's `id`, or `null` if not found */
  userExists(
    email: string
  ): Promise<string | null>;
  /**
   * Whether the user is an admin — true if their stored `role` is `admin`, or
   * if their email is in the `ADMIN_USERS` env list.
   */
  isAdmin(userId: string): Promise<boolean>;
  /** Upsert db connections (each carries its own `group` string) into the `db_connection` table */
  setDbConnections(connections: DatabaseConnection[]): Promise<void>;
  /** Set a user's `data` blob in the `user` table (keyed by `user.id`) */
  setUserData(userId: string, data: StorageData): Promise<void>;
  // /** Merge multiple collections (used for migration) */
  // mergeData(userId: string, data: Partial<StorageData>): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
  /** Cleanup resources */
  close(): Promise<void>;
}

/** Storage config returned by /api/storage/config */
export interface StorageConfigResponse {
  provider: 'local' | 'sqlite' | 'postgres';
  serverMode: boolean;
}

/** Event dispatched on storage mutations */
export interface StorageChangeDetail {
  collection: StorageCollection;
  data: unknown;
}
