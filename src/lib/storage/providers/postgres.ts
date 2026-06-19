/**
 * PostgreSQL Server Storage Provider
 * Uses the existing `pg` package (already a project dependency).
 */

import type { ServerStorageProvider, StorageData, StorageGroup } from '../types';
import type { DatabaseConnection } from '@/lib/types';
import { logger } from '@/lib/logger';

let Pool: typeof import('pg').Pool;

export class PostgresStorageProvider implements ServerStorageProvider {
  private pool: InstanceType<typeof import('pg').Pool> | null = null;
  private connectionString: string;

  constructor(connectionString?: string) {
    this.connectionString =
      connectionString || process.env.STORAGE_POSTGRES_URL || '';
  }

  async initialize(): Promise<void> {
    if (!this.connectionString) {
      throw new Error(
        'STORAGE_POSTGRES_URL is required when STORAGE_PROVIDER=postgres'
      );
    }

    // Dynamic import to avoid requiring pg when not needed
    if (!Pool) {
      const pg = await import('pg');
      Pool = pg.Pool;
    }

    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      ssl: this.buildSSLConfig(),
    });

    // Create tables (order matters: referenced tables before FKs).
    try {
      // Access groups: id + human-readable name. `is_admin` marks groups
      // whose members are admin users.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS user_group (
          id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name     TEXT NOT NULL UNIQUE,
          is_admin BOOLEAN NOT NULL DEFAULT FALSE,
          active   BOOLEAN NOT NULL DEFAULT TRUE
        )
      `);

      // Per-user data blob (StorageData minus connections). `id` is the
      // surrogate key used everywhere; `email` is a unique natural key.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS app_user (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email      TEXT NOT NULL UNIQUE,
          data       TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Which user belongs to which group (composite PK).
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS user_group_mapping (
          user_id  UUID NOT NULL REFERENCES app_user(id),
          group_id INTEGER NOT NULL REFERENCES user_group(id),
          PRIMARY KEY (user_id, group_id)
        )
      `);

      // Each db connection lives in its own row and references the group that
      // is allowed to access it; the full DatabaseConnection is stored as JSON.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS db_connection (
          id         TEXT PRIMARY KEY,
          group_id   INTEGER NOT NULL REFERENCES user_group(id),
          data       TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not support SSL')) {
        throw new Error(
          'PostgreSQL storage connection failed: server does not support SSL. Add ?sslmode=disable to STORAGE_POSTGRES_URL for local PostgreSQL.',
          { cause: error }
        );
      }
      logger.error('PostgreSQL storage initialization failed', error, { provider: 'postgres' });
      throw error;
    }
  }

  async getUserData(userId: string): Promise<Partial<StorageData>> {
    this.ensurePool();

    // Single join: user blob + every connection reachable through the user's
    // group memberships (user_group_mapping -> group -> db_connection).
    const { rows } = await this.pool!.query(
      `SELECT u.data AS user_data, dc.data AS connection_data
         FROM app_user u
         LEFT JOIN user_group_mapping ugm ON ugm.user_id = u.id
         LEFT JOIN db_connection dc ON dc.group_id = ugm.group_id
        WHERE u.id = $1`,
      [userId]
    );

    const result: Partial<StorageData> = {};
    if (rows.length === 0) return result;

    // user_data is identical across the joined rows; parse it once.
    try {
      Object.assign(result, JSON.parse(rows[0].user_data));
    } catch {
      logger.warn('Skipping corrupted user storage data', { provider: 'postgres', userId });
    }

    const connections: DatabaseConnection[] = [];
    for (const row of rows) {
      if (!row.connection_data) continue;
      try {
        connections.push(JSON.parse(row.connection_data) as DatabaseConnection);
      } catch {
        logger.warn('Skipping corrupted db connection data', { provider: 'postgres' });
      }
    }
    result.connections = connections;

    return result;
  }

  async upsertUser(email: string, groups: string[]): Promise<string> {
    const alreadyExists = await this.userExists(email);
    if (alreadyExists){
      const groupIds = await this.createGroups(groups.map((group) => {
        return { name: group, isAdmin: false, active: true } as StorageGroup;
      }));
      await this.mapUserToGroup(alreadyExists, groupIds);
      return alreadyExists;
    }

    this.ensurePool();
    // The no-op `DO UPDATE` lets us return the id whether the row was just
    // inserted or already existed.
    const { rows } = await this.pool!.query(
      `INSERT INTO app_user (email, data)
       VALUES ($1, '{}')
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email]
    );
    const userId = rows[0].id as string;
    const groupIds = await this.createGroups(groups.map((group) => {
      return { name: group, isAdmin: false, active: true } as StorageGroup;
    }));
    await this.mapUserToGroup(userId, groupIds);
    return rows[0].id as string;
  }

  async userExists(
    email: string
  ): Promise<string | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `SELECT id, email FROM app_user WHERE email = $1`,
      [email]
    );
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw "Multiple users found for email: " + email;
    }
    
    return rows[0].id as string;
  }

  async isAdmin(userId: string): Promise<boolean> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `SELECT u.email,
              EXISTS (
                SELECT 1
                  FROM user_group_mapping ugm
                  JOIN user_group g ON g.id = ugm.group_id
                 WHERE ugm.user_id = u.id AND g.is_admin = TRUE
              ) AS in_admin_group
         FROM app_user u
        WHERE u.id = $1`,
      [userId]
    );
    if (rows.length === 0) return false;
    if (rows[0].in_admin_group) return true;

    const adminEmails = (process.env.ADMIN_USERS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    return adminEmails.includes(String(rows[0].email).toLowerCase());
  }

  async getGroups(): Promise<StorageGroup[]> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      'SELECT id, name, is_admin, active FROM user_group'
    );
    return rows.map(
      (row) =>
        ({
          id: row.id,
          name: row.name,
          isAdmin: row.is_admin,
          active: row.active,
        }) as StorageGroup
    );
  }

  async getGroupsByUserId(userId: string): Promise<StorageGroup[]> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `SELECT g.id, g.name, g.is_admin, g.active
         FROM user_group_mapping ugm
         JOIN user_group g ON g.id = ugm.group_id
        WHERE ugm.user_id = $1`,
      [userId]
    );
    return rows.map(
      (row) =>
        ({
          id: row.id,
          name: row.name,
          isAdmin: row.is_admin,
          active: row.active,
        }) as StorageGroup
    );
  }

  async createGroups(groups: StorageGroup[]): Promise<number[]> {
    this.ensurePool();
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const ids: number[] = [];
      for (const group of groups) {
        // DO UPDATE (not DO NOTHING) so RETURNING yields the id of the
        // existing row on a name conflict, not just freshly inserted rows.
        const { rows } = await client.query(
          `INSERT INTO user_group (name, is_admin, active)
           VALUES ($1, $2, $3)
           ON CONFLICT (name)
           DO UPDATE SET is_admin = EXCLUDED.is_admin, active = EXCLUDED.active
           RETURNING id`,
          [group.name, group.isAdmin, group.active]
        );
        ids.push(rows[0].id as number);
      }
      await client.query('COMMIT');
      return ids;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async mapUserToGroup(userId: string, groupIds: number[]): Promise<void> {
    this.ensurePool();
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      // Clear all of the user's existing memberships, then apply the new set.
      await client.query(
        `DELETE FROM user_group_mapping WHERE user_id = $1`,
        [userId]
      );
      // Insert the desired memberships (ON CONFLICT guards duplicate ids).
      for (const groupId of groupIds) {
        await client.query(
          `INSERT INTO user_group_mapping (user_id, group_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, group_id) DO NOTHING`,
          [userId, groupId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setDbConnections(connections: DatabaseConnection[]): Promise<void> {
    this.ensurePool();
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      for (const connection of connections) {
        await client.query(
          `INSERT INTO db_connection (id, group_id, data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id)
           DO UPDATE SET group_id = EXCLUDED.group_id, data = EXCLUDED.data, updated_at = NOW()`,
          [connection.id, connection.group ?? null, JSON.stringify(connection)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setUserData(userId: string, data: StorageData): Promise<void> {
    this.ensurePool();
    // `email` is NOT NULL, so a row must already exist (created with its email
    // elsewhere); this only refreshes the data blob keyed by the surrogate id.
    await this.pool!.query(
      `UPDATE app_user
          SET data = $2, updated_at = NOW()
        WHERE id = $1`,
      [userId, JSON.stringify(data)]
    );
  }

  // async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
  //   this.ensurePool();
  //   const client = await this.pool!.connect();
  //   try {
  //     await client.query('BEGIN');
  //     for (const collection of STORAGE_COLLECTIONS) {
  //       const collectionData = (data as Record<string, unknown>)[collection];
  //       if (collectionData !== undefined) {
  //         await client.query(
  //           `INSERT INTO user_storage (user_id, collection, data, updated_at)
  //            VALUES ($1, $2, $3, NOW())
  //            ON CONFLICT (user_id, collection)
  //            DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
  //           [userId, collection, JSON.stringify(collectionData)]
  //         );
  //       }
  //     }
  //     await client.query('COMMIT');
  //   } catch (err) {
  //     await client.query('ROLLBACK');
  //     throw err;
  //   } finally {
  //     client.release();
  //   }
  // }

  async isHealthy(): Promise<boolean> {
    try {
      this.ensurePool();
      const { rows } = await this.pool!.query('SELECT 1 as ok');
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private ensurePool(): void {
    if (!this.pool) {
      throw new Error(
        'PostgreSQL storage not initialized. Call initialize() first.'
      );
    }
  }

  private buildSSLConfig(): boolean | { rejectUnauthorized: boolean } {
    const { host, searchParams } = this.parseConnectionString(this.connectionString);

    const sslMode = searchParams.get('sslmode')?.toLowerCase();
    if (sslMode === 'disable') return false;
    if (
      sslMode === 'require' ||
      sslMode === 'prefer' ||
      sslMode === 'verify-ca' ||
      sslMode === 'verify-full'
    ) {
      return { rejectUnauthorized: false };
    }

    const sslParam = searchParams.get('ssl')?.toLowerCase();
    if (sslParam === 'false' || sslParam === '0' || sslParam === 'no') {
      return false;
    }
    if (sslParam === 'true' || sslParam === '1' || sslParam === 'yes') {
      return { rejectUnauthorized: false };
    }

    if (this.isLocalHost(host)) return false;
    return { rejectUnauthorized: false };
  }

  private parseConnectionString(connectionString: string): {
    host: string;
    searchParams: URLSearchParams;
  } {
    try {
      const parsed = new URL(connectionString);
      return {
        host: parsed.hostname.toLowerCase(),
        searchParams: parsed.searchParams,
      };
    } catch {
      return {
        host: '',
        searchParams: new URLSearchParams(),
      };
    }
  }

  private isLocalHost(host: string): boolean {
    const localHosts = new Set([
      'localhost',
      '::1',
      'host.docker.internal',
      'docker.for.mac.localhost',
      'docker.for.win.localhost',
      'gateway.docker.internal',
    ]);
    if (localHosts.has(host)) return true;
    if (host.startsWith('127.')) return true;
    return false;
  }
}
