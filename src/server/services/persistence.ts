import fsPromises from 'node:fs/promises';
import { Pool } from 'pg';
import type { AccessibleResource } from './atlassian';
import type { Logger } from './logger';

export interface SessionRecord {
  accessToken: string;
  refreshToken?: string;
  cloudId: string;
  resources: AccessibleResource[];
  user: string;
  createdAt: number;
}

export interface Persistence {
  initialize(): Promise<void>;
  getSession(sid: string): Promise<SessionRecord | null>;
  setSession(sid: string, session: SessionRecord): Promise<void>;
  deleteSession(sid: string): Promise<void>;
  appendAudit(event: Record<string, unknown>): Promise<void>;
  isDatabaseBacked(): boolean;
}

class FileBackedPersistence implements Persistence {
  constructor(private readonly auditFile: string) {}

  async initialize(): Promise<void> {}

  async getSession(): Promise<SessionRecord | null> {
    return null;
  }

  async setSession(): Promise<void> {}

  async deleteSession(): Promise<void> {}

  async appendAudit(event: Record<string, unknown>): Promise<void> {
    await fsPromises.appendFile(this.auditFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  }

  isDatabaseBacked(): boolean {
    return false;
  }
}

class PostgresPersistence implements Persistence {
  constructor(private readonly pool: Pool, private readonly logger: Logger) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        cloud_id TEXT NOT NULL,
        resources_json JSONB NOT NULL,
        user_name TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_type TEXT,
        user_name TEXT,
        jira_key TEXT,
        payload_json JSONB NOT NULL
      )
    `);

    this.logger.info('persistence.postgres.initialized');
  }

  async getSession(sid: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      `SELECT access_token, refresh_token, cloud_id, resources_json, user_name, created_at
       FROM sessions
       WHERE sid = $1`,
      [sid]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token || undefined,
      cloudId: row.cloud_id,
      resources: Array.isArray(row.resources_json) ? row.resources_json : [],
      user: row.user_name,
      createdAt: Number(row.created_at),
    };
  }

  async setSession(sid: string, session: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (sid, access_token, refresh_token, cloud_id, resources_json, user_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
       ON CONFLICT (sid) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         cloud_id = EXCLUDED.cloud_id,
         resources_json = EXCLUDED.resources_json,
         user_name = EXCLUDED.user_name,
         created_at = EXCLUDED.created_at,
         updated_at = NOW()`,
      [sid, session.accessToken, session.refreshToken || null, session.cloudId, JSON.stringify(session.resources || []), session.user, session.createdAt]
    );
  }

  async deleteSession(sid: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE sid = $1`, [sid]);
  }

  async appendAudit(event: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO audit_events (timestamp, event_type, user_name, jira_key, payload_json)
       VALUES ($1::timestamptz, $2, $3, $4, $5::jsonb)`,
      [timestamp, typeof event.type === 'string' ? event.type : null, typeof event.user === 'string' ? event.user : null, typeof event.jiraKey === 'string' ? event.jiraKey : null, JSON.stringify({ timestamp, ...event })]
    );
  }

  isDatabaseBacked(): boolean {
    return true;
  }
}

export function createPersistence({
  databaseUrl,
  auditFile,
  logger,
}: {
  databaseUrl: string;
  auditFile: string;
  logger: Logger;
}): Persistence {
  if (!databaseUrl) {
    logger.warn('persistence.fallback_file_audit');
    return new FileBackedPersistence(auditFile);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  });
  return new PostgresPersistence(pool, logger);
}
