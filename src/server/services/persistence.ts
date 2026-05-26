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
import type { Logger } from './logger';

export interface SessionRecord {
  accessToken: string;
  refreshToken?: string;
  cloudId: string;
  resources: AccessibleResource[];
  selectedResource?: AccessibleResource | null;
  user: string;
  createdAt: number;
  expiresAt?: number | null;
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

export interface Persistence {
  initialize(): Promise<void>;
  ping(): Promise<{ ok: boolean; database: boolean; mode: 'postgres' | 'file+memory-fallback'; error?: string }>;
  storeOAuthState(state: string, createdAt: number): Promise<void>;
  consumeOAuthState(state: string): Promise<boolean>;
  getSession(sid: string): Promise<SessionRecord | null>;
  setSession(sid: string, session: SessionRecord): Promise<void>;
  deleteSession(sid: string): Promise<void>;
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
    private readonly allowFallbackOnInitError: boolean
  ) {
    this.active = primary;
  }

  async initialize(): Promise<void> {
    try {
      await this.primary.initialize();
      this.active = this.primary;
    } catch (error) {
      if (!this.allowFallbackOnInitError) throw error;
      this.logger.warn('persistence.postgres_init_failed_fallback', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await this.fallback.initialize();
      this.active = this.fallback;
    }
  }

  ping(): Promise<{ ok: boolean; database: boolean; mode: 'postgres' | 'file+memory-fallback'; error?: string }> {
    return this.active.ping();
  }

  storeOAuthState(state: string, createdAt: number): Promise<void> {
    return this.active.storeOAuthState(state, createdAt);
  }

  consumeOAuthState(state: string): Promise<boolean> {
    return this.active.consumeOAuthState(state);
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

  appendAudit(event: Record<string, unknown>): Promise<void> {
    return this.active.appendAudit(event);
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
  private readonly oauthStates = new Map<string, number>();

  constructor(private readonly auditFile: string, private readonly logger: Logger) {}

  async initialize(): Promise<void> {}

  async ping(): Promise<{ ok: boolean; database: boolean; mode: 'postgres' | 'file+memory-fallback'; error?: string }> {
    return {
      ok: true,
      database: false,
      mode: 'file+memory-fallback',
    };
  }

  async storeOAuthState(state: string, createdAt: number): Promise<void> {
    this.oauthStates.set(state, createdAt);
  }

  async consumeOAuthState(state: string): Promise<boolean> {
    const createdAt = this.oauthStates.get(state);
    if (!createdAt) return false;
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

  async appendAudit(event: Record<string, unknown>): Promise<void> {
    await fsPromises.appendFile(this.auditFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
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

  async storeOAuthState(state: string, createdAt: number): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO oauth_states (state, created_at)
        VALUES ($1, to_timestamp($2 / 1000.0))
        ON CONFLICT (state)
        DO UPDATE SET created_at = EXCLUDED.created_at
      `,
      [state, createdAt]
    );
  }

  async consumeOAuthState(state: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        DELETE FROM oauth_states
        WHERE state = $1
          AND created_at >= NOW() - INTERVAL '15 minutes'
        RETURNING state
      `,
      [state]
    );
    await this.pool.query(`DELETE FROM oauth_states WHERE created_at < NOW() - INTERVAL '15 minutes'`);
    return Boolean(result.rowCount);
  }

  async getSession(sid: string): Promise<SessionRecord | null> {
    const result = await this.pool.query(
      `SELECT access_token, refresh_token, cloud_id, resources_json, selected_resource_json, user_name, created_at, expires_at
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
      selectedResource: row.selected_resource_json || null,
      user: row.user_name,
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at ? Number(row.expires_at) : null,
    };
  }

  async setSession(sid: string, session: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (
         sid, access_token, refresh_token, cloud_id, resources_json, selected_resource_json, user_name, created_at, expires_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, NOW())
       ON CONFLICT (sid) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         cloud_id = EXCLUDED.cloud_id,
         resources_json = EXCLUDED.resources_json,
         selected_resource_json = EXCLUDED.selected_resource_json,
         user_name = EXCLUDED.user_name,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        sid,
        session.accessToken,
        session.refreshToken || null,
        session.cloudId,
        JSON.stringify(session.resources || []),
        JSON.stringify(session.selectedResource || null),
        session.user,
        session.createdAt,
        session.expiresAt || null,
      ]
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
      [
        timestamp,
        typeof event.type === 'string' ? event.type : null,
        typeof event.user === 'string' ? event.user : null,
        typeof event.jiraKey === 'string' ? event.jiraKey : null,
        JSON.stringify({ timestamp, ...event }),
      ]
    );
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
    connectionTimeoutMillis: 5000,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  });
  return new ResilientPersistence(
    new PostgresPersistence(pool, logger, migrationsDir || path.join(process.cwd(), 'src/server/migrations')),
    fallback,
    logger,
    Boolean(allowFallbackOnInitError)
  );
}
