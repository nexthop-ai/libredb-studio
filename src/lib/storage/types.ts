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

/** An access group that gates which db connections a user can reach */
export interface StorageGroup {
  id: string;
  name: string;
  /** Members of this group are admin users */
  isAdmin: boolean;
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
   * Returns the `data` blob from the `user` table plus the connections the
   * user can reach via their group memberships (`user_group_mapping` →
   * `group` → `db_connection`), resolved in a single join. `userId` is the
   * `user.id` surrogate key. The result is shaped the same as the legacy
   * `getAllData` (a `Partial<StorageData>`).
   */
  getUserData(userId: string): Promise<Partial<StorageData>>;
  /** Create a user row for `email` (no-op if it already exists); returns the user's `id` */
  createUser(email: string): Promise<string>;
  /**
   * Whether the user is an admin — true if their email is in the `ADMIN_USERS`
   * env list, or if they belong to any group flagged `isAdmin`.
   */
  isAdmin(userId: string): Promise<boolean>;
  /** List all access groups */
  getGroups(): Promise<StorageGroup[]>;
  /** Upsert access groups into the `group` table */
  createGroups(groups: StorageGroup[]): Promise<void>;
  /**
   * Set a user's group memberships to exactly `groupIds`: inserts any that are
   * missing and removes any existing mapping not in the list.
   */
  mapUserToGroup(userId: string, groupIds: string[]): Promise<void>;
  /** Upsert db connections (each carries its own `group`) into the `db_connection` table */
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
