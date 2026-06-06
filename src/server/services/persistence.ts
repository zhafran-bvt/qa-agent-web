import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import type {
  CoverageSummary,
  GeneratedTestCase,
  PushCaseResult,
  QaContext,
  ValidationEntry,
  WorkflowHistoryDetail,
  WorkflowHistorySummary,
} from '../../shared/contracts';
import type { AccessibleResource } from './atlassian';
import { decryptSecret, encryptionAvailable, encryptSecret } from './crypto';
import type { Logger } from './logger';

export interface SessionRecord {
  accessToken: string;
  refreshToken?: string;
  cloudId: string;
  resources: AccessibleResource[];
  selectedResource?: AccessibleResource | null;
  user: string;
  accountId?: string | null;
  displayName?: string | null;
  personalDataRetrievedAt?: number | null;
  createdAt: number;
  expiresAt?: number | null;
}

export interface PrivacyReportingAccount {
  accountId: string;
  displayName?: string | null;
  retrievedAt: number;
}

export interface PrivacyReportingSession {
  sid: string;
  session: SessionRecord;
}

export interface PrivacyReportingStatus {
  storedAccountCount: number;
  dueAccountCount: number;
  lastSuccessfulRunAt?: number | null;
  lastRunError?: string | null;
  lastCyclePeriodDays?: number | null;
}

export interface PersistenceDiagnostics {
  mode: 'postgres' | 'file+memory-fallback';
  migrationsEnabled: boolean;
  currentVersion: string | null;
}

interface StoredGenerationRunInput {
  analysisRunId: string;
  jiraKey: string;
  user: string;
  provider: string;
  model: string;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary;
  coverageEnforced: boolean;
  manualScopeOverride: boolean;
}

interface StoredPushRunInput {
  generatedRunId: string;
  jiraKey: string;
  user: string;
  sectionId: string;
  approved: boolean;
  results: PushCaseResult[];
  summary: {
    pushed: number;
    failed: number;
    total: number;
  };
}

export interface UserTestrailCreds {
  user: string;
  apiKeyEnc: string;
}

export interface Persistence {
  initialize(): Promise<void>;
  ping(): Promise<{ ok: boolean; database: boolean; mode: 'postgres' | 'file+memory-fallback'; error?: string }>;
  storeOAuthState(state: string, createdAt: number, verifierHash?: string | null): Promise<void>;
  consumeOAuthState(state: string, verifierHash?: string | null): Promise<boolean>;
  getSession(sid: string): Promise<SessionRecord | null>;
  setSession(sid: string, session: SessionRecord): Promise<void>;
  deleteSession(sid: string): Promise<void>;
  getPrivacyReportingSession(): Promise<PrivacyReportingSession | null>;
  getPrivacyReportingSessionForAccount(accountId: string): Promise<PrivacyReportingSession | null>;
  listPrivacyReportingAccountsDue(now: number, defaultCycleDays: number, limit: number): Promise<PrivacyReportingAccount[]>;
  recordPrivacyReportingRun(input: {
    reportedAt: number;
    cyclePeriodDays: number;
    results: Array<{ accountId: string; ageSeconds: number; status: 'ok' | 'closed' | 'updated' }>;
  }): Promise<void>;
  recordPrivacyReportingRunError(message: string, occurredAt: number): Promise<void>;
  erasePersonalDataForAccount(accountId: string): Promise<{ sessionsDeleted: number }>;
  refreshPersonalDataForAccount(accountId: string, updates: { displayName?: string | null; retrievedAt: number }): Promise<{ sessionsUpdated: number }>;
  getPrivacyReportingStatus(defaultCycleDays: number, now: number): Promise<PrivacyReportingStatus>;
  getUserTestrailCreds(accountId: string): Promise<UserTestrailCreds | null>;
  setUserTestrailCreds(accountId: string, user: string, apiKeyEnc: string): Promise<void>;
  deleteUserTestrailCreds(accountId: string): Promise<void>;
  appendAudit(event: Record<string, unknown>): Promise<void>;
  createAnalysisRun(input: { jiraKey: string; user: string; context: QaContext }): Promise<string | null>;
  createGeneratedRun(input: StoredGenerationRunInput): Promise<string | null>;
  createPushRun(input: StoredPushRunInput): Promise<string | null>;
  listHistoryRuns(limit?: number): Promise<WorkflowHistorySummary[]>;
  getHistoryRun(id: string): Promise<WorkflowHistoryDetail | null>;
  getDiagnostics(): PersistenceDiagnostics;
  isDatabaseBacked(): boolean;
}

class ResilientPersistence implements Persistence {
  private active: Persistence;

  constructor(
    private readonly primary: Persistence,
    private readonly fallback: Persistence,
    private readonly logger: Logger,
    private readonly allowFallbackOnInitError: boolean,
    private readonly maxInitAttempts: number,
    private readonly retryDelayMs: number
  ) {
    this.active = primary;
  }

  async initialize(): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxInitAttempts; attempt += 1) {
      try {
        await this.primary.initialize();
        this.active = this.primary;
        return;
      } catch (error) {
        lastError = error;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (attempt < this.maxInitAttempts) {
          this.logger.warn('persistence.postgres_init_retry', {
            attempt,
            maxAttempts: this.maxInitAttempts,
            retryDelayMs: this.retryDelayMs,
            errorMessage,
          });
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
          continue;
        }
      }
    }

    if (!this.allowFallbackOnInitError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    this.logger.warn('persistence.postgres_init_failed_fallback', {
      errorMessage: lastError instanceof Error ? lastError.message : String(lastError),
    });
    await this.fallback.initialize();
    this.active = this.fallback;
  }

  ping(): Promise<{ ok: boolean; database: boolean; mode: 'postgres' | 'file+memory-fallback'; error?: string }> {
    return this.active.ping();
  }

  storeOAuthState(state: string, createdAt: number, verifierHash?: string | null): Promise<void> {
    return this.active.storeOAuthState(state, createdAt, verifierHash);
  }

  consumeOAuthState(state: string, verifierHash?: string | null): Promise<boolean> {
    return this.active.consumeOAuthState(state, verifierHash);
  }

  getSession(sid: string): Promise<SessionRecord | null> {
    return this.active.getSession(sid);
  }

  setSession(sid: string, session: SessionRecord): Promise<void> {
    return this.active.setSession(sid, session);
  }

  deleteSession(sid: string): Promise<void> {
    return this.active.deleteSession(sid);
  }

  getPrivacyReportingSession(): Promise<PrivacyReportingSession | null> {
    return this.active.getPrivacyReportingSession();
  }

  getPrivacyReportingSessionForAccount(accountId: string): Promise<PrivacyReportingSession | null> {
    return this.active.getPrivacyReportingSessionForAccount(accountId);
  }

  listPrivacyReportingAccountsDue(now: number, defaultCycleDays: number, limit: number): Promise<PrivacyReportingAccount[]> {
    return this.active.listPrivacyReportingAccountsDue(now, defaultCycleDays, limit);
  }

  recordPrivacyReportingRun(input: {
    reportedAt: number;
    cyclePeriodDays: number;
    results: Array<{ accountId: string; ageSeconds: number; status: 'ok' | 'closed' | 'updated' }>;
  }): Promise<void> {
    return this.active.recordPrivacyReportingRun(input);
  }

  recordPrivacyReportingRunError(message: string, occurredAt: number): Promise<void> {
    return this.active.recordPrivacyReportingRunError(message, occurredAt);
  }

  erasePersonalDataForAccount(accountId: string): Promise<{ sessionsDeleted: number }> {
    return this.active.erasePersonalDataForAccount(accountId);
  }

  refreshPersonalDataForAccount(accountId: string, updates: { displayName?: string | null; retrievedAt: number }): Promise<{ sessionsUpdated: number }> {
    return this.active.refreshPersonalDataForAccount(accountId, updates);
  }

  getPrivacyReportingStatus(defaultCycleDays: number, now: number): Promise<PrivacyReportingStatus> {
    return this.active.getPrivacyReportingStatus(defaultCycleDays, now);
  }

  appendAudit(event: Record<string, unknown>): Promise<void> {
    return this.active.appendAudit(event);
  }

  getUserTestrailCreds(accountId: string): Promise<UserTestrailCreds | null> {
    return this.active.getUserTestrailCreds(accountId);
  }

  setUserTestrailCreds(accountId: string, user: string, apiKeyEnc: string): Promise<void> {
    return this.active.setUserTestrailCreds(accountId, user, apiKeyEnc);
  }

  deleteUserTestrailCreds(accountId: string): Promise<void> {
    return this.active.deleteUserTestrailCreds(accountId);
  }

  createAnalysisRun(input: { jiraKey: string; user: string; context: QaContext }): Promise<string | null> {
    return this.active.createAnalysisRun(input);
  }

  createGeneratedRun(input: StoredGenerationRunInput): Promise<string | null> {
    return this.active.createGeneratedRun(input);
  }

  createPushRun(input: StoredPushRunInput): Promise<string | null> {
    return this.active.createPushRun(input);
  }

  listHistoryRuns(limit?: number): Promise<WorkflowHistorySummary[]> {
    return this.active.listHistoryRuns(limit);
  }

  getHistoryRun(id: string): Promise<WorkflowHistoryDetail | null> {
    return this.active.getHistoryRun(id);
  }

  getDiagnostics(): PersistenceDiagnostics {
    return this.active.getDiagnostics();
  }

  isDatabaseBacked(): boolean {
    return this.active.isDatabaseBacked();
  }
}

class FileBackedPersistence implements Persistence {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly oauthStates = new Map<string, { createdAt: number; verifierHash: string | null }>();
  private readonly privacyStates = new Map<string, { lastReportedAt: number; lastCyclePeriodDays: number; lastStatus: 'ok' | 'closed' | 'updated'; lastReportedAgeSeconds: number }>();
  private readonly userTestrailCreds = new Map<string, UserTestrailCreds>();
  private lastPrivacyRunAt: number | null = null;
  private lastPrivacyRunError: string | null = null;

  constructor(private readonly auditFile: string, private readonly logger: Logger) {}

  async initialize(): Promise<void> {}

  async ping(): Promise<{ ok: boolean; database: boolean; mode: 'postgres' | 'file+memory-fallback'; error?: string }> {
    return {
      ok: true,
      database: false,
      mode: 'file+memory-fallback',
    };
  }

  async storeOAuthState(state: string, createdAt: number, verifierHash?: string | null): Promise<void> {
    this.oauthStates.set(state, { createdAt, verifierHash: verifierHash || null });
  }

  async consumeOAuthState(state: string, verifierHash?: string | null): Promise<boolean> {
    const stored = this.oauthStates.get(state);
    if (!stored) return false;
    if (stored.verifierHash && stored.verifierHash !== verifierHash) return false;
    this.oauthStates.delete(state);
    return true;
  }

  async getSession(sid: string): Promise<SessionRecord | null> {
    return this.sessions.get(sid) || null;
  }

  async setSession(sid: string, session: SessionRecord): Promise<void> {
    this.sessions.set(sid, session);
  }

  async deleteSession(sid: string): Promise<void> {
    this.sessions.delete(sid);
  }

  async getPrivacyReportingSession(): Promise<PrivacyReportingSession | null> {
    for (const [sid, session] of this.sessions.entries()) {
      if (session.accountId && session.refreshToken) return { sid, session };
    }
    return null;
  }

  async getPrivacyReportingSessionForAccount(accountId: string): Promise<PrivacyReportingSession | null> {
    for (const [sid, session] of this.sessions.entries()) {
      if (session.accountId === accountId && session.refreshToken) return { sid, session };
    }
    return null;
  }

  async listPrivacyReportingAccountsDue(now: number, defaultCycleDays: number, limit: number): Promise<PrivacyReportingAccount[]> {
    const accounts = new Map<string, PrivacyReportingAccount>();
    for (const session of this.sessions.values()) {
      if (!session.accountId) continue;
      const retrievedAt = session.personalDataRetrievedAt || session.createdAt;
      const existing = accounts.get(session.accountId);
      if (!existing || retrievedAt < existing.retrievedAt) {
        accounts.set(session.accountId, {
          accountId: session.accountId,
          displayName: session.displayName || session.user || null,
          retrievedAt,
        });
      }
    }
    return Array.from(accounts.values())
      .filter((account) => {
        const state = this.privacyStates.get(account.accountId);
        if (!state) return true;
        return state.lastReportedAt + state.lastCyclePeriodDays * 86_400_000 <= now;
      })
      .sort((a, b) => a.retrievedAt - b.retrievedAt)
      .slice(0, Math.max(1, limit));
  }

  async recordPrivacyReportingRun(input: {
    reportedAt: number;
    cyclePeriodDays: number;
    results: Array<{ accountId: string; ageSeconds: number; status: 'ok' | 'closed' | 'updated' }>;
  }): Promise<void> {
    for (const result of input.results) {
      this.privacyStates.set(result.accountId, {
        lastReportedAt: input.reportedAt,
        lastCyclePeriodDays: input.cyclePeriodDays,
        lastStatus: result.status,
        lastReportedAgeSeconds: result.ageSeconds,
      });
    }
    this.lastPrivacyRunAt = input.reportedAt;
    this.lastPrivacyRunError = null;
  }

  async recordPrivacyReportingRunError(message: string, occurredAt: number): Promise<void> {
    this.lastPrivacyRunAt = occurredAt;
    this.lastPrivacyRunError = message;
  }

  async erasePersonalDataForAccount(accountId: string): Promise<{ sessionsDeleted: number }> {
    let sessionsDeleted = 0;
    for (const [sid, session] of this.sessions.entries()) {
      if (session.accountId === accountId) {
        this.sessions.delete(sid);
        sessionsDeleted += 1;
      }
    }
    return { sessionsDeleted };
  }

  async refreshPersonalDataForAccount(accountId: string, updates: { displayName?: string | null; retrievedAt: number }): Promise<{ sessionsUpdated: number }> {
    let sessionsUpdated = 0;
    for (const session of this.sessions.values()) {
      if (session.accountId !== accountId) continue;
      session.displayName = updates.displayName || session.displayName || session.user;
      session.user = updates.displayName || session.user;
      session.personalDataRetrievedAt = updates.retrievedAt;
      sessionsUpdated += 1;
    }
    return { sessionsUpdated };
  }

  async getPrivacyReportingStatus(defaultCycleDays: number, now: number): Promise<PrivacyReportingStatus> {
    const storedAccountCount = new Set(Array.from(this.sessions.values()).map((session) => session.accountId).filter(Boolean)).size;
    const dueAccountCount = (await this.listPrivacyReportingAccountsDue(now, defaultCycleDays, 10_000)).length;
    return {
      storedAccountCount,
      dueAccountCount,
      lastSuccessfulRunAt: this.lastPrivacyRunError ? null : this.lastPrivacyRunAt,
      lastRunError: this.lastPrivacyRunError,
      lastCyclePeriodDays: this.privacyStates.size
        ? Math.max(...Array.from(this.privacyStates.values()).map((state) => state.lastCyclePeriodDays))
        : defaultCycleDays,
    };
  }

  async appendAudit(event: Record<string, unknown>): Promise<void> {
    await fsPromises.appendFile(this.auditFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  }

  async getUserTestrailCreds(accountId: string): Promise<UserTestrailCreds | null> {
    return this.userTestrailCreds.get(accountId) || null;
  }

  async setUserTestrailCreds(accountId: string, user: string, apiKeyEnc: string): Promise<void> {
    this.userTestrailCreds.set(accountId, { user, apiKeyEnc });
  }

  async deleteUserTestrailCreds(accountId: string): Promise<void> {
    this.userTestrailCreds.delete(accountId);
  }

  async createAnalysisRun(): Promise<string | null> {
    return null;
  }

  async createGeneratedRun(): Promise<string | null> {
    return null;
  }

  async createPushRun(): Promise<string | null> {
    return null;
  }

  async listHistoryRuns(): Promise<WorkflowHistorySummary[]> {
    return [];
  }

  async getHistoryRun(): Promise<WorkflowHistoryDetail | null> {
    return null;
  }

  getDiagnostics(): PersistenceDiagnostics {
    return {
      mode: 'file+memory-fallback',
      migrationsEnabled: false,
      currentVersion: null,
    };
  }

  isDatabaseBacked(): boolean {
    return false;
  }
}

function encodeEntryId(type: 'analysis' | 'generation' | 'push', id: string): string {
  return `${type}:${id}`;
}

function decodeEntryId(encoded: string): { type: 'analysis' | 'generation' | 'push'; id: string } | null {
  const [type, id] = String(encoded || '').split(':', 2);
  if (!id) return null;
  if (type === 'analysis' || type === 'generation' || type === 'push') return { type, id };
  return null;
}

class PostgresPersistence implements Persistence {
  private currentVersion: string | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    private readonly migrationsDir: string
  ) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = (await fsPromises.readdir(this.migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const existing = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [file]);
      if (existing.rowCount) continue;
      const sql = await fsPromises.readFile(path.join(this.migrationsDir, file), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      this.currentVersion = file;
    }

    if (!this.currentVersion && migrationFiles.length) {
      this.currentVersion = migrationFiles[migrationFiles.length - 1];
    }

    this.logger.info('persistence.postgres.initialized', { currentVersion: this.currentVersion });
  }

  async ping(): Promise<{ ok: boolean; database: boolean; mode: 'postgres' | 'file+memory-fallback'; error?: string }> {
    try {
      await this.pool.query('SELECT 1');
      return {
        ok: true,
        database: true,
        mode: 'postgres',
      };
    } catch (error) {
      return {
        ok: false,
        database: false,
        mode: 'postgres',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async storeOAuthState(state: string, createdAt: number, verifierHash?: string | null): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO oauth_states (state, created_at, verifier_hash)
        VALUES ($1, to_timestamp($2 / 1000.0), $3)
        ON CONFLICT (state)
        DO UPDATE SET created_at = EXCLUDED.created_at,
                      verifier_hash = EXCLUDED.verifier_hash
      `,
      [state, createdAt, verifierHash || null]
    );
  }

  async consumeOAuthState(state: string, verifierHash?: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `
        DELETE FROM oauth_states
        WHERE state = $1
          AND created_at >= NOW() - INTERVAL '15 minutes'
          AND (verifier_hash IS NULL OR verifier_hash = $2)
        RETURNING state
      `,
      [state, verifierHash || null]
    );
    await this.pool.query(`DELETE FROM oauth_states WHERE created_at < NOW() - INTERVAL '15 minutes'`);
    return Boolean(result.rowCount);
  }

  async getSession(sid: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      `SELECT access_token, refresh_token, cloud_id, resources_json, selected_resource_json, user_name, account_id, display_name, personal_data_retrieved_at, created_at, expires_at
       FROM sessions
       WHERE sid = $1`,
      [sid]
    );
    const row = result.rows[0];
    if (!row) return null;
    const accessToken = decodeStoredToken(row.access_token);
    const refreshToken = row.refresh_token ? decodeStoredToken(row.refresh_token) : undefined;
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken,
      cloudId: row.cloud_id,
      resources: Array.isArray(row.resources_json) ? row.resources_json : [],
      selectedResource: row.selected_resource_json || null,
      user: row.user_name,
      accountId: row.account_id || null,
      displayName: row.display_name || null,
      personalDataRetrievedAt: row.personal_data_retrieved_at ? Number(row.personal_data_retrieved_at) : null,
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at ? Number(row.expires_at) : null,
    };
  }

  async setSession(sid: string, session: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (
         sid, access_token, refresh_token, cloud_id, resources_json, selected_resource_json, user_name, account_id, display_name, personal_data_retrieved_at, created_at, expires_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (sid) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         cloud_id = EXCLUDED.cloud_id,
         resources_json = EXCLUDED.resources_json,
         selected_resource_json = EXCLUDED.selected_resource_json,
         user_name = EXCLUDED.user_name,
         account_id = EXCLUDED.account_id,
         display_name = EXCLUDED.display_name,
         personal_data_retrieved_at = EXCLUDED.personal_data_retrieved_at,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        sid,
        encodeStoredToken(session.accessToken),
        session.refreshToken ? encodeStoredToken(session.refreshToken) : null,
        session.cloudId,
        JSON.stringify(session.resources || []),
        JSON.stringify(session.selectedResource || null),
        session.user,
        session.accountId || null,
        session.displayName || null,
        session.personalDataRetrievedAt || session.createdAt,
        session.createdAt,
        session.expiresAt || null,
      ]
    );
  }

  async deleteSession(sid: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE sid = $1`, [sid]);
  }

  async getPrivacyReportingSession(): Promise<PrivacyReportingSession | null> {
    const result = await this.pool.query(
      `SELECT sid, access_token, refresh_token, cloud_id, resources_json, selected_resource_json, user_name, account_id, display_name, personal_data_retrieved_at, created_at, expires_at
       FROM sessions
       WHERE account_id IS NOT NULL
         AND refresh_token IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    const accessToken = decodeStoredToken(row.access_token);
    const refreshToken = row.refresh_token ? decodeStoredToken(row.refresh_token) : undefined;
    if (!accessToken || !refreshToken) return null;
    return {
      sid: row.sid,
      session: {
        accessToken,
        refreshToken,
        cloudId: row.cloud_id,
        resources: Array.isArray(row.resources_json) ? row.resources_json : [],
        selectedResource: row.selected_resource_json || null,
        user: row.user_name,
        accountId: row.account_id || null,
        displayName: row.display_name || null,
        personalDataRetrievedAt: row.personal_data_retrieved_at ? Number(row.personal_data_retrieved_at) : null,
        createdAt: Number(row.created_at),
        expiresAt: row.expires_at ? Number(row.expires_at) : null,
      },
    };
  }

  async getPrivacyReportingSessionForAccount(accountId: string): Promise<PrivacyReportingSession | null> {
    const result = await this.pool.query(
      `SELECT sid, access_token, refresh_token, cloud_id, resources_json, selected_resource_json, user_name, account_id, display_name, personal_data_retrieved_at, created_at, expires_at
       FROM sessions
       WHERE account_id = $1
         AND refresh_token IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const accessToken = decodeStoredToken(row.access_token);
    const refreshToken = row.refresh_token ? decodeStoredToken(row.refresh_token) : undefined;
    if (!accessToken || !refreshToken) return null;
    return {
      sid: row.sid,
      session: {
        accessToken,
        refreshToken,
        cloudId: row.cloud_id,
        resources: Array.isArray(row.resources_json) ? row.resources_json : [],
        selectedResource: row.selected_resource_json || null,
        user: row.user_name,
        accountId: row.account_id || null,
        displayName: row.display_name || null,
        personalDataRetrievedAt: row.personal_data_retrieved_at ? Number(row.personal_data_retrieved_at) : null,
        createdAt: Number(row.created_at),
        expiresAt: row.expires_at ? Number(row.expires_at) : null,
      },
    };
  }

  async listPrivacyReportingAccountsDue(now: number, defaultCycleDays: number, limit: number): Promise<PrivacyReportingAccount[]> {
    const result = await this.pool.query(
      `SELECT
         s.account_id,
         MAX(COALESCE(s.display_name, s.user_name)) AS display_name,
         MIN(COALESCE(s.personal_data_retrieved_at, s.created_at)) AS retrieved_at
       FROM sessions s
       LEFT JOIN privacy_report_state prs ON prs.account_id = s.account_id
       WHERE s.account_id IS NOT NULL
         AND (
           prs.last_reported_at IS NULL
           OR prs.last_reported_at + (COALESCE(prs.last_cycle_period_days, $2) * INTERVAL '1 day') <= to_timestamp($1 / 1000.0)
         )
       GROUP BY s.account_id
       ORDER BY MIN(COALESCE(s.personal_data_retrieved_at, s.created_at)) ASC
       LIMIT $3`,
      [now, defaultCycleDays, Math.max(1, limit)]
    );
    return result.rows.map((row) => ({
      accountId: row.account_id,
      displayName: row.display_name || null,
      retrievedAt: Number(row.retrieved_at),
    }));
  }

  async recordPrivacyReportingRun(input: {
    reportedAt: number;
    cyclePeriodDays: number;
    results: Array<{ accountId: string; ageSeconds: number; status: 'ok' | 'closed' | 'updated' }>;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const result of input.results) {
        await client.query(
          `INSERT INTO privacy_report_state (
             account_id, last_reported_at, last_reported_age_seconds, last_action_required, last_cycle_period_days, updated_at
           )
           VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, NOW())
           ON CONFLICT (account_id) DO UPDATE SET
             last_reported_at = EXCLUDED.last_reported_at,
             last_reported_age_seconds = EXCLUDED.last_reported_age_seconds,
             last_action_required = EXCLUDED.last_action_required,
             last_cycle_period_days = EXCLUDED.last_cycle_period_days,
             updated_at = NOW()`,
          [result.accountId, input.reportedAt, result.ageSeconds, result.status === 'ok' ? null : result.status, input.cyclePeriodDays]
        );
      }
      await client.query(
        `INSERT INTO privacy_reporting_meta (meta_key, meta_value_json, updated_at)
         VALUES ('last_run', $1::jsonb, NOW())
         ON CONFLICT (meta_key) DO UPDATE SET meta_value_json = EXCLUDED.meta_value_json, updated_at = NOW()`,
        [
          JSON.stringify({
            lastSuccessfulRunAt: input.reportedAt,
            lastRunError: null,
            lastCyclePeriodDays: input.cyclePeriodDays,
          }),
        ]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPrivacyReportingRunError(message: string, occurredAt: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO privacy_reporting_meta (meta_key, meta_value_json, updated_at)
       VALUES ('last_run', $1::jsonb, NOW())
       ON CONFLICT (meta_key) DO UPDATE SET meta_value_json = EXCLUDED.meta_value_json, updated_at = NOW()`,
      [
        JSON.stringify({
          lastSuccessfulRunAt: null,
          lastRunError: message,
          lastErrorAt: occurredAt,
        }),
      ]
    );
  }

  async erasePersonalDataForAccount(accountId: string): Promise<{ sessionsDeleted: number }> {
    const result = await this.pool.query(`DELETE FROM sessions WHERE account_id = $1`, [accountId]);
    return { sessionsDeleted: result.rowCount || 0 };
  }

  async refreshPersonalDataForAccount(accountId: string, updates: { displayName?: string | null; retrievedAt: number }): Promise<{ sessionsUpdated: number }> {
    const result = await this.pool.query(
      `UPDATE sessions
       SET display_name = COALESCE($2, display_name),
           user_name = COALESCE($2, user_name),
           personal_data_retrieved_at = $3,
           updated_at = NOW()
       WHERE account_id = $1`,
      [accountId, updates.displayName || null, updates.retrievedAt]
    );
    return { sessionsUpdated: result.rowCount || 0 };
  }

  async getPrivacyReportingStatus(defaultCycleDays: number, now: number): Promise<PrivacyReportingStatus> {
    const storedResult = await this.pool.query(`SELECT COUNT(DISTINCT account_id)::integer AS count FROM sessions WHERE account_id IS NOT NULL`);
    const dueResult = await this.pool.query(
      `SELECT COUNT(DISTINCT s.account_id)::integer AS count
       FROM sessions s
       LEFT JOIN privacy_report_state prs ON prs.account_id = s.account_id
       WHERE s.account_id IS NOT NULL
         AND (
           prs.last_reported_at IS NULL
           OR prs.last_reported_at + (COALESCE(prs.last_cycle_period_days, $2) * INTERVAL '1 day') <= to_timestamp($1 / 1000.0)
         )`,
      [now, defaultCycleDays]
    );
    const metaResult = await this.pool.query(`SELECT meta_value_json FROM privacy_reporting_meta WHERE meta_key = 'last_run'`);
    const meta = (metaResult.rows[0]?.meta_value_json || {}) as Record<string, unknown>;
    return {
      storedAccountCount: storedResult.rows[0]?.count || 0,
      dueAccountCount: dueResult.rows[0]?.count || 0,
      lastSuccessfulRunAt: typeof meta.lastSuccessfulRunAt === 'number' ? meta.lastSuccessfulRunAt : null,
      lastRunError: typeof meta.lastRunError === 'string' ? meta.lastRunError : null,
      lastCyclePeriodDays: typeof meta.lastCyclePeriodDays === 'number' ? meta.lastCyclePeriodDays : defaultCycleDays,
    };
  }

  async appendAudit(event: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO audit_events (timestamp, event_type, user_name, jira_key, payload_json)
       VALUES ($1::timestamptz, $2, $3, $4, $5::jsonb)`,
      [
        timestamp,
        typeof event.type === 'string' ? event.type : null,
        typeof event.user === 'string' ? event.user : null,
        typeof event.jiraKey === 'string' ? event.jiraKey : null,
        JSON.stringify({ timestamp, ...event }),
      ]
    );
  }

  async getUserTestrailCreds(accountId: string): Promise<UserTestrailCreds | null> {
    const result = await this.pool.query(
      `SELECT tr_user, tr_api_key_enc FROM user_testrail_credentials WHERE account_id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { user: String(row.tr_user), apiKeyEnc: String(row.tr_api_key_enc) };
  }

  async setUserTestrailCreds(accountId: string, user: string, apiKeyEnc: string): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO user_testrail_credentials (account_id, tr_user, tr_api_key_enc, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (account_id) DO UPDATE SET tr_user = EXCLUDED.tr_user, tr_api_key_enc = EXCLUDED.tr_api_key_enc, updated_at = EXCLUDED.updated_at`,
      [accountId, user, apiKeyEnc, now]
    );
  }

  async deleteUserTestrailCreds(accountId: string): Promise<void> {
    await this.pool.query(`DELETE FROM user_testrail_credentials WHERE account_id = $1`, [accountId]);
  }

  async createAnalysisRun(input: { jiraKey: string; user: string; context: QaContext }): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO analysis_runs (jira_key, user_name, context_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [input.jiraKey, input.user, JSON.stringify(input.context)]
    );
    return String(result.rows[0].id);
  }

  async createGeneratedRun(input: StoredGenerationRunInput): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO generated_runs (
         analysis_run_id, jira_key, user_name, provider, model, validation_json, coverage_json, coverage_enforced, manual_scope_override
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING id`,
      [
        input.analysisRunId,
        input.jiraKey,
        input.user,
        input.provider,
        input.model,
        JSON.stringify(input.validation),
        JSON.stringify(input.coverage),
        input.coverageEnforced,
        input.manualScopeOverride,
      ]
    );
    const generatedRunId = String(result.rows[0].id);
    for (const [caseOrder, testCase] of input.testCases.entries()) {
      await this.pool.query(
        `INSERT INTO generated_test_cases (generated_run_id, case_order, case_key, title, payload_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [generatedRunId, caseOrder, testCase.id, testCase.title, JSON.stringify(testCase)]
      );
    }
    return generatedRunId;
  }

  async createPushRun(input: StoredPushRunInput): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO push_runs (generated_run_id, jira_key, user_name, section_id, approved, summary_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [input.generatedRunId, input.jiraKey, input.user, input.sectionId, input.approved, JSON.stringify(input.summary)]
    );
    const pushRunId = String(result.rows[0].id);
    for (const [caseOrder, entry] of input.results.entries()) {
      await this.pool.query(
        `INSERT INTO push_case_results (push_run_id, case_order, title, ok, case_ref, error, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [pushRunId, caseOrder, entry.title, entry.ok, entry.caseId ? String(entry.caseId) : null, entry.error || null, JSON.stringify(entry)]
      );
    }
    return pushRunId;
  }

  async listHistoryRuns(limit = 100): Promise<WorkflowHistorySummary[]> {
    const result = await this.pool.query(
      `
      SELECT * FROM (
        SELECT
          'analysis' AS entry_type,
          ar.id::text AS raw_id,
          ar.jira_key,
          ar.user_name,
          ar.created_at,
          NULL::text AS provider,
          NULL::text AS model,
          NULL::integer AS case_count,
          NULL::integer AS pushed,
          NULL::integer AS failed,
          'completed' AS status
        FROM analysis_runs ar
        UNION ALL
        SELECT
          'generation' AS entry_type,
          gr.id::text AS raw_id,
          gr.jira_key,
          gr.user_name,
          gr.created_at,
          gr.provider,
          gr.model,
          (SELECT COUNT(*)::integer FROM generated_test_cases gtc WHERE gtc.generated_run_id = gr.id) AS case_count,
          NULL::integer AS pushed,
          NULL::integer AS failed,
          'completed' AS status
        FROM generated_runs gr
        UNION ALL
        SELECT
          'push' AS entry_type,
          pr.id::text AS raw_id,
          pr.jira_key,
          pr.user_name,
          pr.created_at,
          gr.provider,
          gr.model,
          (SELECT COUNT(*)::integer FROM generated_test_cases gtc WHERE gtc.generated_run_id = pr.generated_run_id) AS case_count,
          COALESCE((pr.summary_json->>'pushed')::integer, 0) AS pushed,
          COALESCE((pr.summary_json->>'failed')::integer, 0) AS failed,
          'pushed' AS status
        FROM push_runs pr
        LEFT JOIN generated_runs gr ON gr.id = pr.generated_run_id
      ) history
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      id: encodeEntryId(row.entry_type, row.raw_id),
      entryType: row.entry_type,
      jiraKey: row.jira_key,
      user: row.user_name,
      createdAt: new Date(row.created_at).toISOString(),
      provider: row.provider || undefined,
      model: row.model || undefined,
      caseCount: row.case_count ?? undefined,
      pushed: row.pushed ?? undefined,
      failed: row.failed ?? undefined,
      status: row.status,
    }));
  }

  async getHistoryRun(encodedId: string): Promise<WorkflowHistoryDetail | null> {
    const decoded = decodeEntryId(encodedId);
    if (!decoded) return null;
    if (decoded.type === 'analysis') return this.getAnalysisRun(decoded.id);
    if (decoded.type === 'generation') return this.getGeneratedRun(decoded.id);
    return this.getPushRun(decoded.id);
  }

  getDiagnostics(): PersistenceDiagnostics {
    return {
      mode: 'postgres',
      migrationsEnabled: true,
      currentVersion: this.currentVersion,
    };
  }

  isDatabaseBacked(): boolean {
    return true;
  }

  private async getAnalysisRun(id: string): Promise<WorkflowHistoryDetail | null> {
    const result = await this.pool.query(
      `SELECT id, jira_key, user_name, created_at, context_json
       FROM analysis_runs
       WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: encodeEntryId('analysis', String(row.id)),
      entryType: 'analysis',
      jiraKey: row.jira_key,
      user: row.user_name,
      createdAt: new Date(row.created_at).toISOString(),
      context: row.context_json,
      testCases: [],
      validation: [],
      coverage: null,
      push: null,
    };
  }

  private async getGeneratedRun(id: string): Promise<WorkflowHistoryDetail | null> {
    const result = await this.pool.query(
      `SELECT gr.id, gr.jira_key, gr.user_name, gr.created_at, gr.provider, gr.model, gr.validation_json, gr.coverage_json,
              ar.context_json
       FROM generated_runs gr
       LEFT JOIN analysis_runs ar ON ar.id = gr.analysis_run_id
       WHERE gr.id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const testCases = await this.loadGeneratedTestCases(String(row.id));
    return {
      id: encodeEntryId('generation', String(row.id)),
      entryType: 'generation',
      jiraKey: row.jira_key,
      user: row.user_name,
      createdAt: new Date(row.created_at).toISOString(),
      context: row.context_json,
      testCases,
      validation: row.validation_json || [],
      coverage: row.coverage_json || null,
      provider: row.provider || undefined,
      model: row.model || undefined,
      push: null,
    };
  }

  private async getPushRun(id: string): Promise<WorkflowHistoryDetail | null> {
    const result = await this.pool.query(
      `SELECT pr.id, pr.jira_key, pr.user_name, pr.created_at, pr.section_id, pr.summary_json,
              gr.id AS generated_run_id, gr.provider, gr.model, gr.validation_json, gr.coverage_json,
              ar.context_json
       FROM push_runs pr
       LEFT JOIN generated_runs gr ON gr.id = pr.generated_run_id
       LEFT JOIN analysis_runs ar ON ar.id = gr.analysis_run_id
       WHERE pr.id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const testCases = row.generated_run_id ? await this.loadGeneratedTestCases(String(row.generated_run_id)) : [];
    const pushResults = await this.loadPushCaseResults(String(row.id));
    return {
      id: encodeEntryId('push', String(row.id)),
      entryType: 'push',
      jiraKey: row.jira_key,
      user: row.user_name,
      createdAt: new Date(row.created_at).toISOString(),
      context: row.context_json,
      testCases,
      validation: row.validation_json || [],
      coverage: row.coverage_json || null,
      provider: row.provider || undefined,
      model: row.model || undefined,
      push: {
        sectionId: row.section_id,
        summary: row.summary_json,
        results: pushResults,
        createdAt: new Date(row.created_at).toISOString(),
      },
    };
  }

  private async loadGeneratedTestCases(generatedRunId: string): Promise<GeneratedTestCase[]> {
    const result = await this.pool.query(
      `SELECT payload_json
       FROM generated_test_cases
       WHERE generated_run_id = $1
       ORDER BY case_order ASC`,
      [generatedRunId]
    );
    return result.rows.map((row) => row.payload_json as GeneratedTestCase);
  }

  private async loadPushCaseResults(pushRunId: string): Promise<PushCaseResult[]> {
    const result = await this.pool.query(
      `SELECT payload_json
       FROM push_case_results
       WHERE push_run_id = $1
       ORDER BY case_order ASC`,
      [pushRunId]
    );
    return result.rows.map((row) => row.payload_json as PushCaseResult);
  }
}

export function createPersistence({
  databaseUrl,
  auditFile,
  logger,
  migrationsDir,
  allowFallbackOnInitError,
}: {
  databaseUrl: string;
  auditFile: string;
  logger: Logger;
  migrationsDir?: string;
  allowFallbackOnInitError?: boolean;
}): Persistence {
  const fallback = new FileBackedPersistence(auditFile, logger);
  if (!databaseUrl) {
    logger.warn('persistence.fallback_file_audit');
    return fallback;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1') ? 5000 : 30000,
    ssl: buildPostgresSslConfig(databaseUrl),
  });
  return new ResilientPersistence(
    new PostgresPersistence(pool, logger, migrationsDir || path.join(process.cwd(), 'src/server/migrations')),
    fallback,
    logger,
    Boolean(allowFallbackOnInitError),
    allowFallbackOnInitError ? 1 : 6,
    5000
  );
}

export function buildPostgresSslConfig(databaseUrl: string): false | { rejectUnauthorized: boolean; ca?: string } {
  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
  if (isLocal) return false;
  const ca = process.env.DATABASE_CA_CERT || process.env.PGSSLROOTCERT_CONTENT;
  // With a CA we can verify strictly. Otherwise stay TLS-encrypted but don't verify the
  // chain — managed Postgres (Railway/Heroku/etc.) serves a self-signed cert and provides
  // no CA, so `rejectUnauthorized: true` would fail with "self-signed certificate in chain".
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false };
}

const TOKEN_PREFIX = 'enc:v1:';

export function encodeStoredToken(token: string): string {
  return encryptionAvailable() ? `${TOKEN_PREFIX}${encryptSecret(token)}` : token;
}

export function decodeStoredToken(token: string): string {
  if (!token.startsWith(TOKEN_PREFIX)) return token;
  try {
    return decryptSecret(token.slice(TOKEN_PREFIX.length));
  } catch {
    return '';
  }
}
