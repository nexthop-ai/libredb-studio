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
 * Server-side storage provider interface (PostgreSQL-backed).
 */
export interface ServerStorageProvider {
  /** Create tables if they don't exist */
  initialize(): Promise<void>;
  /**
   * Get a user's data merged with the db connections they can access.
   *
   * Returns the `data` blob from the `app_user` table plus the connections
   * whose `user_group` matches one of the `groups` supplied by the identity
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
  /**
   * Replace the entire set of db connections — rows whose `id` is not in the
   * payload are deleted, others are upserted. Admin-only at the API layer.
   */
  setDbConnections(connections: DatabaseConnection[]): Promise<void>;
  /** Delete a single db connection by id; returns true if a row was removed. Admin-only. */
  deleteDbConnection(id: string): Promise<boolean>;
  /**
   * Atomically replace a single top-level collection in the user's data blob
   * (avoids the read-modify-write race of full-blob updates).
   */
  setUserDataCollection(
    userId: string,
    collection: StorageCollection,
    data: unknown
  ): Promise<void>;
  /** Atomically merge multiple collections into the user's data blob (used for migration) */
  mergeUserData(userId: string, data: Partial<StorageData>): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
  /** Cleanup resources */
  close(): Promise<void>;
}

/** Storage config returned by /api/storage/config */
export interface StorageConfigResponse {
  provider: 'local' | 'postgres';
  serverMode: boolean;
}

/** Event dispatched on storage mutations */
export interface StorageChangeDetail {
  collection: StorageCollection;
  data: unknown;
}
