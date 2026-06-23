/**
 * PostgreSQL Server Storage Provider
 * Uses the existing `pg` package (already a project dependency).
 */

import type { ServerStorageProvider, StorageData } from '../types';
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

    // Create tables
    try {
      // Per-user data blob (StorageData minus connections). `id` is the
      // surrogate key used everywhere; `email` is a unique natural key.
      // `role` records whether the user is an admin or a regular user.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS app_user (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email      TEXT NOT NULL UNIQUE,
          data       TEXT NOT NULL,
          role       TEXT NOT NULL DEFAULT 'user',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS db_connection (
          id         TEXT PRIMARY KEY,
          user_group TEXT,
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

  async getUserData(userId: string, groups: string[] = []): Promise<Partial<StorageData>> {
    this.ensurePool();

    // The per-user data blob, fetched on its own.
    const { rows: userRows } = await this.pool!.query(
      `SELECT data AS user_data FROM app_user WHERE id = $1`,
      [userId]
    );

    const result: Partial<StorageData> = {};
    if (userRows.length === 0) return result;

    try {
      Object.assign(result, JSON.parse(userRows[0].user_data));
    } catch {
      logger.warn('Skipping corrupted user storage data', { provider: 'postgres', userId });
    }

    // Connections the caller can reach: those whose `user_group` matches one of
    // the groups supplied by the identity provider, plus ungrouped (NULL) ones,
    // which are visible to everyone.
    const { rows: connRows } = await this.pool!.query(
      `SELECT data AS connection_data
         FROM db_connection
        WHERE user_group IS NULL OR user_group = ANY($1)`,
      [groups]
    );

    const connections: DatabaseConnection[] = [];
    for (const row of connRows) {
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

  async upsertUser(email: string, role: 'admin' | 'user'): Promise<string> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      `INSERT INTO app_user (email, data, role)
       VALUES ($1, '{}', $2)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
       RETURNING id`,
      [email, role]
    );
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
      `SELECT email, role FROM app_user WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) return false;
    if (rows[0].role === 'admin') return true;

    const adminEmails = (process.env.ADMIN_USERS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    return adminEmails.includes(String(rows[0].email).toLowerCase());
  }

  async setDbConnections(connections: DatabaseConnection[]): Promise<void> {
    this.ensurePool();
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      for (const connection of connections) {
        await client.query(
          `INSERT INTO db_connection (id, user_group, data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id)
           DO UPDATE SET user_group = EXCLUDED.user_group, data = EXCLUDED.data, updated_at = NOW()`,
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
