import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AtlassianClient,
  buildAuthUrl,
  exchangeCode,
  getAccessibleResources,
  refreshAccessToken,
  type AccessibleResource,
} from './services/atlassian';
import { finalizeAcceptanceCriteria } from './services/acceptance-criteria';
import { buildQaContext } from './services/context-builder';
import { generateTestCases, synthesizeAcceptanceCriteria, translateScopeSnapshot } from './services/llm';
import { pushCases } from './services/testrail';
import { buildCoverage, validateCases } from './services/validation';
import { hydrateTestCasesWithEvidence } from './services/evidence';
import { getRecentIssues, logger } from './services/logger';
import { createPersistence, type SessionRecord } from './services/persistence';
import type {
  AnalyzeRequest,
  ConfigResponse,
  DiagnosticsResponse,
  GenerateRequest,
  PushRequest,
  QaContext,
  ScopeSnapshotTranslationRequest,
  ScopeSnapshotTranslationResponse,
  TicketSuggestionsResponse,
  ValidateRequest,
} from '../shared/contracts';

const PORT = Number(process.env.PORT || process.env.QA_AGENT_PORT || 5174);
const DEFAULT_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`;
const APP_BASE_URL = process.env.QA_AGENT_BASE_URL || DEFAULT_BASE_URL;
const IS_HTTPS = APP_BASE_URL.startsWith('https://');
const PROJECT_ROOT = process.cwd();
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'client-dist');
const AUDIT_FILE = path.join(PROJECT_ROOT, 'audit-log.jsonl');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'src/server/migrations');

loadEnv(path.join(PROJECT_ROOT, '.env'));

function normalizeAtlassianScopes(rawScopes: string): string {
  const required = [
    'read:jira-work',
    'read:page:confluence',
    'read:confluence-content.all',
    'read:confluence-space.summary',
    'offline_access',
  ];
  const present = new Set(
    String(rawScopes || '')
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
  for (const scope of required) present.add(scope);
  return Array.from(present).join(' ');
}

const config = {
  atlassian: {
    clientId: process.env.ATLASSIAN_CLIENT_ID || '',
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET || '',
    redirectUri: process.env.ATLASSIAN_REDIRECT_URI || `${APP_BASE_URL}/auth/atlassian/callback`,
    scopes: normalizeAtlassianScopes(
      process.env.ATLASSIAN_SCOPES || 'read:jira-work read:confluence-content.all read:confluence-space.summary offline_access'
    ),
  },
  llm: {
    providers: [
      {
        name: 'openai',
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || '',
        model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      },
      {
        name: 'deepseek',
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      },
    ],
  },
  testrail: {
    baseUrl: process.env.TESTRAIL_BASE_URL || '',
    user: process.env.TESTRAIL_USER || '',
    apiKey: process.env.TESTRAIL_API_KEY || '',
  },
};

const persistence = createPersistence({
  databaseUrl: process.env.DATABASE_URL || '',
  auditFile: AUDIT_FILE,
  logger,
  migrationsDir: MIGRATIONS_DIR,
  allowFallbackOnInitError: !process.env.RAILWAY_PUBLIC_DOMAIN && process.env.NODE_ENV !== 'production',
});

const QA_ASSIGNEE_JQL_FIELD = process.env.QA_ASSIGNEE_JQL_FIELD || '"qa assignee[user picker (single user)]"';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function errorDetails(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : 'Error',
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function buildSessionCookie(value: string, maxAge?: number): string {
  const parts = [`qa_sid=${encodeURIComponent(value || '')}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  if (IS_HTTPS) parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function getSessionId(req: IncomingMessage): string | null {
  return parseCookies(req).qa_sid || null;
}

async function getSession(req: IncomingMessage) {
  const sid = getSessionId(req);
  return sid ? persistence.getSession(sid) : null;
}

async function requireSession(req: IncomingMessage, res: ServerResponse) {
  const sid = getSessionId(req);
  if (!sid) {
    sendError(res, 401, 'Atlassian login required.');
    return null;
  }
  const session = await persistence.getSession(sid);
  if (!session) {
    sendError(res, 401, 'Atlassian login required.');
    return null;
  }
  return { sid, session };
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return (body ? JSON.parse(body) : {}) as T;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext === '.js') return 'text/javascript';
  if (ext === '.css') return 'text/css';
  if (ext === '.json') return 'application/json';
  if (ext === '.svg') return 'image/svg+xml';
  return 'text/html';
}

async function serveFrontend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', APP_BASE_URL);
  const requestedPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const assetPath = path.join(CLIENT_DIST_DIR, requestedPath);
  const normalizedClientDir = path.resolve(CLIENT_DIST_DIR);
  const normalizedAssetPath = path.resolve(assetPath);

  if (!normalizedAssetPath.startsWith(normalizedClientDir)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  try {
    const targetPath = fs.existsSync(normalizedAssetPath) && fs.statSync(normalizedAssetPath).isFile() ? normalizedAssetPath : path.join(CLIENT_DIST_DIR, 'index.html');
    const data = await fsPromises.readFile(targetPath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(targetPath) });
    res.end(data);
  } catch {
    sendError(res, 404, 'Frontend build not found. Run npm start or npm run build first.');
  }
}

async function refreshSessionToken(sid: string, session: SessionRecord, log = logger): Promise<SessionRecord> {
  const current = (await persistence.getSession(sid)) || session;
  if (!current.refreshToken) {
    throw new Error('Atlassian session cannot be refreshed because no refresh token is stored.');
  }
  const refreshed = await refreshAccessToken(config.atlassian, current.refreshToken);
  const resources = await getAccessibleResources(refreshed.access_token);
  const selectedResource = choosePrimaryResource(resources) || current.selectedResource || null;
  const updated: SessionRecord = {
    ...current,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || current.refreshToken,
    cloudId: selectedResource?.id || current.cloudId,
    resources,
    selectedResource,
    expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : current.expiresAt || null,
  };
  await persistence.setSession(sid, updated);
  log.info('auth.atlassian.token_refreshed', {
    cloudId: updated.cloudId,
    user: updated.user,
    expiresAt: updated.expiresAt,
  });
  return updated;
}

function createClient(sid: string, session: SessionRecord, log = logger): AtlassianClient {
  return new AtlassianClient({
    accessToken: session.accessToken,
    cloudId: session.cloudId,
    resources: session.resources || [],
    expiresAt: session.expiresAt || null,
    selectedResource: session.selectedResource || null,
    refreshSession: () => refreshSessionToken(sid, session, log),
    logger: log,
  });
}

function choosePrimaryResource(resources: AccessibleResource[]): AccessibleResource | null {
  if (!resources.length) return null;
  const preferredHost = String(process.env.ATLASSIAN_SITE_HOST || '').trim().toLowerCase();
  if (preferredHost) {
    const matched = resources.find((resource) => {
      try {
        return new URL(resource.url || '').hostname.toLowerCase() === preferredHost;
      } catch {
        return false;
      }
    });
    if (matched) return matched;
  }

  const preferredUrl = String(process.env.ATLASSIAN_SITE_URL || '').trim();
  if (preferredUrl) {
    try {
      const preferredHostname = new URL(preferredUrl).hostname.toLowerCase();
      const matched = resources.find((resource) => {
        try {
          return new URL(resource.url || '').hostname.toLowerCase() === preferredHostname;
        } catch {
          return false;
        }
      });
      if (matched) return matched;
    } catch {
      // ignore invalid configured URL
    }
  }

  const bvartaMatch = resources.find((resource) => {
    try {
      return /bvarta-project\.atlassian\.net$/i.test(new URL(resource.url || '').hostname);
    } catch {
      return false;
    }
  });
  if (bvartaMatch) return bvartaMatch;

  return resources[0];
}

function shouldLogRequestAtInfo(pathname: string, statusCode: number): boolean {
  if (statusCode >= 400) return true;
  if (pathname.startsWith('/auth/')) return true;
  if (
    pathname === '/api/analyze' ||
    pathname === '/api/generate' ||
    pathname === '/api/validate' ||
    pathname === '/api/push' ||
    pathname === '/api/diagnostics' ||
    pathname === '/api/history/runs' ||
    pathname.startsWith('/api/history/runs/')
  ) {
    return true;
  }
  return false;
}

function shouldEnforceAcceptanceCriteria(context: QaContext | null, _confidencePermissionApproved: boolean): boolean {
  if (!context) return false;
  return Array.isArray(context.acceptanceCriteria) && context.acceptanceCriteria.length > 0;
}

async function appendAudit(event: Record<string, unknown>): Promise<void> {
  await persistence.appendAudit(event);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, log = logger): Promise<void> {
  const url = new URL(req.url || '/', APP_BASE_URL);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const session = await getSession(req);
    const body: ConfigResponse = {
      authenticated: Boolean(session),
      user: session?.user || null,
      session: session
        ? {
            expiresAt: session.expiresAt || null,
            selectedResource: session.selectedResource
              ? {
                  cloudId: session.selectedResource.id,
                  url: session.selectedResource.url || null,
                  name: session.selectedResource.name || null,
                }
              : null,
          }
        : undefined,
      ready: {
        atlassian: Boolean(config.atlassian.clientId && config.atlassian.clientSecret),
        llm: config.llm.providers.some((provider) => Boolean(provider.apiKey)),
        testrail: Boolean(config.testrail.baseUrl && config.testrail.user && config.testrail.apiKey),
        database: persistence.isDatabaseBacked(),
      },
      defaults: {
        testrailSectionId: process.env.TESTRAIL_SECTION_ID || '',
        llmProviders: config.llm.providers.map((provider) => ({
          name: provider.name,
          model: provider.model,
          configured: Boolean(provider.apiKey),
        })),
      },
    };
    sendJson(res, 200, body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/healthz') {
    const health = await persistence.ping();
    sendJson(res, health.ok ? 200 : 503, {
      ok: health.ok,
      database: health.database,
      persistenceMode: health.mode,
      timestamp: new Date().toISOString(),
      ...(health.error ? { error: health.error } : {}),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { session } = sessionEnvelope;
    const body: DiagnosticsResponse = {
      auth: {
        configured: Boolean(config.atlassian.clientId && config.atlassian.clientSecret),
        selectedResource: session?.selectedResource
          ? {
              cloudId: session.selectedResource.id,
              url: session.selectedResource.url || null,
              name: session.selectedResource.name || null,
            }
          : null,
        sessionExpiresAt: session?.expiresAt || null,
      },
      persistence: persistence.getDiagnostics(),
      readiness: {
        atlassian: Boolean(config.atlassian.clientId && config.atlassian.clientSecret),
        llm: config.llm.providers.some((provider) => Boolean(provider.apiKey)),
        testrail: Boolean(config.testrail.baseUrl && config.testrail.user && config.testrail.apiKey),
        database: persistence.isDatabaseBacked(),
      },
      recentIssues: getRecentIssues(),
    };
    sendJson(res, 200, body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history/runs') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    sendJson(res, 200, { runs: await persistence.listHistoryRuns(100) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/suggestions/tickets') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { sid, session } = sessionEnvelope;
  const jql = [
    `${QA_ASSIGNEE_JQL_FIELD} = currentUser()`,
    'AND type = Task',
    'AND statusCategory != Done',
    'AND labels = frontend',
    'AND sprint in openSprints()',
    'ORDER BY updated DESC, created DESC',
  ].join(' ');
    const issues = await createClient(sid, session, log).searchIssues(jql, 12);
    const body: TicketSuggestionsResponse = {
      jql,
      tickets: issues.map((issue) => ({
        key: issue.key,
        summary: issue.summary || '',
        status: issue.status || '',
        issueType: issue.issueType || '',
        assignee: issue.assignee || '',
        webUrl: issue.webUrl || '',
        updatedAt: issue.updatedAt || '',
        createdAt: issue.createdAt || '',
      })),
    };
    sendJson(res, 200, body);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/history/runs/')) {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const run = await persistence.getHistoryRun(decodeURIComponent(url.pathname.slice('/api/history/runs/'.length)));
    if (!run) {
      sendError(res, 404, 'History run not found.');
      return;
    }
    sendJson(res, 200, { run });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const sid = getSessionId(req);
    if (sid) await persistence.deleteSession(sid);
    res.writeHead(204, { 'Set-Cookie': buildSessionCookie('', 0) });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { sid, session } = sessionEnvelope;
    const body = await readBody<AnalyzeRequest>(req);
    const jiraKey = String(body.jiraKey || '').trim().toUpperCase();
    if (!jiraKey) {
      sendError(res, 400, 'Jira key is required.');
      return;
    }
    log.info('api.analyze.start', {
      jiraKey,
      user: session.user,
      feOnly: body.feOnly !== false,
      beAlreadyTested: Boolean(body.beAlreadyTested),
      includeComments: body.includeComments !== false,
    });
    const context = await buildQaContext(createClient(sid, session, log), jiraKey, {
      feOnly: body.feOnly !== false,
      beAlreadyTested: Boolean(body.beAlreadyTested),
      includeComments: body.includeComments !== false,
      logger: log,
    });
    const finalizedContext = await finalizeAcceptanceCriteria(context, {
      synthesizer: async (input) => synthesizeAcceptanceCriteria(config.llm, input),
      logger: log,
    });
    log.info('context.ac_finalized', {
      jiraKey,
      source: finalizedContext.acceptanceCriteriaSource,
      finalAcceptanceCriteriaCount: finalizedContext.acceptanceCriteria.length,
      synthesisUsed: finalizedContext.acceptanceCriteriaDiagnostics.synthesisUsed || false,
      rawAcceptanceCriteriaQuality: finalizedContext.acceptanceCriteriaDiagnostics.rawAcceptanceCriteriaQuality || 'none',
      discardedFragmentCount: finalizedContext.acceptanceCriteriaDiagnostics.discardedFragmentCount || 0,
    });
    const analysisRunId = await persistence.createAnalysisRun({ jiraKey, user: session.user, context: finalizedContext });
    if (analysisRunId) finalizedContext.analysisRunId = analysisRunId;
    log.info('api.analyze.complete', {
      jiraKey,
      user: session.user,
      acceptanceCriteriaSource: finalizedContext.acceptanceCriteriaSource,
      acceptanceCriteriaCount: finalizedContext.acceptanceCriteria.length,
      userStoryCount: finalizedContext.userStories.length,
      confidenceLevel: finalizedContext.confidenceLevel,
    });
    await appendAudit({ type: 'analyze', user: session.user, jiraKey, linkedIssueCount: context.linkedIssues.length });
    sendJson(res, 200, { context: finalizedContext });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/context/translate') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.llm.providers.some((provider) => provider.apiKey)) {
      sendError(res, 400, 'No LLM provider API key is configured.');
      return;
    }
    const body = await readBody<ScopeSnapshotTranslationRequest>(req);
    if (!body.context) {
      sendError(res, 400, 'Context is required.');
      return;
    }
    if (body.targetLanguage !== 'id') {
      sendError(res, 400, 'Unsupported target language.');
      return;
    }
    log.info('api.context_translate.start', {
      jiraKey: body.context.ticketKey,
      targetLanguage: body.targetLanguage,
      acceptanceCriteriaCount: body.context.acceptanceCriteria.length,
      userStoryCount: body.context.userStories.length,
    });
    const translation = await translateScopeSnapshot(config.llm, body.context, body.targetLanguage);
    const response: ScopeSnapshotTranslationResponse = { translation };
    log.info('api.context_translate.complete', {
      jiraKey: body.context.ticketKey,
      targetLanguage: body.targetLanguage,
      translatedAcceptanceCriteriaCount: translation.acceptanceCriteria.length,
      translatedUserStoryCount: translation.userStories.length,
    });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { session } = sessionEnvelope;
    if (!config.llm.providers.some((provider) => provider.apiKey)) {
      sendError(res, 400, 'No LLM provider API key is configured.');
      return;
    }
    const body = await readBody<GenerateRequest>(req);
    if (!body.context) {
      sendError(res, 400, 'Context is required.');
      return;
    }
    const confidencePermissionApproved = Boolean(body.confidencePermissionApproved);
    if (body.context.requiresConfidencePermission && !confidencePermissionApproved) {
      sendError(res, 400, `Scope confidence requires QA permission: ${(body.context.confidenceReasons || []).join(' ')}`);
      return;
    }
    const coverageEnforced = shouldEnforceAcceptanceCriteria(body.context, confidencePermissionApproved);
    const generationContext = {
      ...body.context,
      coverageEnforced,
      manualScopeOverride: Boolean(body.context.requiresConfidencePermission && confidencePermissionApproved),
      manualScopeOverrideReason: body.manualScopeOverrideReason || '',
    };
    log.info('api.generate.start', {
      jiraKey: body.context.ticketKey,
      user: session.user,
      providerCandidates: config.llm.providers.filter((provider) => provider.apiKey).map((provider) => provider.name),
      coverageEnforced,
      acceptanceCriteriaCount: body.context.acceptanceCriteria.length,
      scopeAuthorityType: body.context.scopeAuthority?.type || 'none',
      manualScopeOverride: generationContext.manualScopeOverride,
    });
    const generation = await generateTestCases(config.llm, generationContext);
    const testCases = hydrateTestCasesWithEvidence(generation.testCases, body.context);
    const validation = validateCases(testCases, {
      jiraKey: body.context.ticketKey,
      epic: body.context.epic,
      feOnly: body.context.constraints && body.context.constraints.feOnly,
      acceptanceCriteria: body.context.acceptanceCriteria,
      enforceAcceptanceCriteria: coverageEnforced,
    });
    const coverage = buildCoverage(testCases, body.context.acceptanceCriteria, {
      enforceAcceptanceCriteria: coverageEnforced,
    });
    const runId = body.context.analysisRunId
      ? await persistence.createGeneratedRun({
          analysisRunId: body.context.analysisRunId,
          jiraKey: body.context.ticketKey,
          user: session.user,
          provider: generation.provider,
          model: generation.model,
          testCases,
          validation,
          coverage,
          coverageEnforced,
          manualScopeOverride: generationContext.manualScopeOverride,
        })
      : null;
    log.info('api.generate.complete', {
      jiraKey: body.context.ticketKey,
      user: session.user,
      provider: generation.provider,
      model: generation.model,
      generatedCaseCount: generation.testCases.length,
      hydratedCaseCount: testCases.length,
      coverageEnforced,
      scopeAuthorityType: body.context.scopeAuthority?.type || 'none',
      coveredCriteria: coverage.coveredCriteria,
      totalCriteria: coverage.totalCriteria,
      uncoveredCriteria: coverage.uncoveredCriteria,
      invalidCases: validation.filter((item) => !item.valid).map((item) => item.id),
    });
    await appendAudit({
      type: 'generate',
      user: session.user,
      jiraKey: body.context.ticketKey,
      caseCount: generation.testCases.length,
      provider: generation.provider,
      model: generation.model,
      coverageEnforced,
    });
    sendJson(res, 200, {
      runId,
      testCases,
      validation,
      coverage,
      coverageEnforced,
      manualScopeOverride: generationContext.manualScopeOverride,
      provider: generation.provider,
      model: generation.model,
      pendingReplacement: false,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/validate') {
    const body = await readBody<ValidateRequest>(req);
    const testCases = body.context ? hydrateTestCasesWithEvidence(body.testCases || [], body.context) : body.testCases || [];
    const validation = validateCases(testCases, {
      jiraKey: body.jiraKey,
      epic: body.epic,
      feOnly: body.feOnly,
      allowNonMainRefs: body.allowNonMainRefs,
      acceptanceCriteria: body.acceptanceCriteria,
      enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
    });
    sendJson(res, 200, {
      testCases,
      validation,
      coverage: buildCoverage(testCases, body.acceptanceCriteria, {
        enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
      }),
    });
    log.info('api.validate.complete', {
      jiraKey: body.jiraKey,
      caseCount: testCases.length,
      invalidCases: validation.filter((item) => !item.valid).map((item) => item.id),
      warnings: validation.reduce((count, item) => count + item.warnings.length, 0),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/push') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { session } = sessionEnvelope;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 400, 'TestRail configuration is incomplete.');
      return;
    }
    const body = await readBody<PushRequest>(req);
    if (!body.approved) {
      sendError(res, 400, 'QA approval is required before pushing to TestRail.');
      return;
    }
    const sectionId = String(body.sectionId || '').trim();
    if (!sectionId) {
      sendError(res, 400, 'TestRail section ID is required.');
      return;
    }
    const validation = validateCases(body.testCases || [], {
      jiraKey: body.jiraKey,
      epic: body.epic,
      feOnly: body.feOnly,
      allowNonMainRefs: body.allowNonMainRefs,
      acceptanceCriteria: body.acceptanceCriteria,
      enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
    });
    const invalid = validation.filter((item) => !item.valid);
    const coverage = buildCoverage(body.testCases || [], body.acceptanceCriteria, {
      enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
    });
    if (invalid.length || (coverage.enforced && coverage.uncoveredCriteria.length)) {
      sendJson(res, 400, {
        error: invalid.length ? 'Validation failed.' : 'Acceptance criteria coverage is incomplete.',
        validation,
        coverage,
      });
      return;
    }
    const results = await pushCases(config.testrail, sectionId, body.testCases || []);
    const summary = summarizeResults(results);
    if (body.generatedRunId) {
      await persistence.createPushRun({
        generatedRunId: body.generatedRunId,
        jiraKey: body.jiraKey,
        user: session.user,
        sectionId,
        approved: body.approved,
        results,
        summary,
      });
    }
    log.info('api.push.complete', {
      jiraKey: body.jiraKey,
      user: session.user,
      sectionId,
      pushed: summary.pushed,
      failed: summary.failed,
    });
    await appendAudit({
      type: 'push',
      user: session.user,
      jiraKey: body.jiraKey,
      sectionId,
      results,
    });
    sendJson(res, 200, { results, summary });
    return;
  }

  sendError(res, 404, 'API route not found.');
}

function summarizeResults(results: Array<{ ok: boolean }>) {
  return {
    pushed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    total: results.length,
  };
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, log = logger): Promise<void> {
  const url = new URL(req.url || '/', APP_BASE_URL);
  if (url.pathname === '/auth/atlassian') {
    if (!config.atlassian.clientId || !config.atlassian.clientSecret) {
      sendError(res, 400, 'Atlassian OAuth is not configured.');
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    await persistence.storeOAuthState(state, Date.now());
    log.info('auth.atlassian.start');
    res.writeHead(302, { Location: buildAuthUrl(config.atlassian, state) });
    res.end();
    return;
  }

  if (url.pathname === '/auth/atlassian/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code || !(await persistence.consumeOAuthState(state))) {
      sendError(res, 400, 'Invalid OAuth callback.');
      return;
    }
    log.info('auth.atlassian.callback.accepted');
    log.debug('auth.atlassian.exchange_code.start');
    const token = await exchangeCode(config.atlassian, code);
    log.info('auth.atlassian.exchange_code.complete', {
      hasRefreshToken: Boolean(token.refresh_token),
      expiresInSeconds: token.expires_in || null,
    });
    log.debug('auth.atlassian.accessible_resources.start');
    const resources = await getAccessibleResources(token.access_token);
    log.info('auth.atlassian.accessible_resources.complete', {
      resourceCount: resources.length,
    });
    const resource = choosePrimaryResource(resources);
    if (!resource) {
      sendError(res, 400, 'No Atlassian cloud resource is available for this account.');
      return;
    }
    log.info('auth.atlassian.resources_resolved', {
      selectedCloudId: resource.id,
      selectedUrl: resource.url || '',
      selectedName: resource.name || '',
      resourceCount: resources.length,
      resources: resources.map((candidate) => ({
        id: candidate.id,
        name: candidate.name || '',
        url: candidate.url || '',
      })),
    });
    const sid = crypto.randomBytes(24).toString('hex');
    const sessionRecord: SessionRecord = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      cloudId: resource.id,
      resources,
      selectedResource: resource,
      user: resource.name || resource.url || resource.id,
      createdAt: Date.now(),
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    };
    await persistence.setSession(sid, sessionRecord);
    log.info('auth.atlassian.complete', {
      cloudId: resource.id,
      user: resource.name || resource.url || resource.id,
    });
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': buildSessionCookie(sid),
    });
    res.end();
    return;
  }

  sendError(res, 404, 'Auth route not found.');
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const url = new URL(req.url || '/', APP_BASE_URL);
  const log = logger.child({
    requestId,
    method: req.method || 'GET',
    path: url.pathname,
  });
  let statusCode = 200;
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, ...args: any[]) => {
    statusCode = status;
    return originalWriteHead(status, ...args);
  }) as typeof res.writeHead;
  res.on('finish', () => {
    const fields = {
      statusCode,
      durationMs: Date.now() - startedAt,
    };
    if (shouldLogRequestAtInfo(url.pathname, statusCode)) {
      log.info('http.request.complete', fields);
      return;
    }
    log.debug('http.request.complete', fields);
  });
  try {
    if ((req.url || '').startsWith('/api/')) {
      await handleApi(req, res, log);
      return;
    }
    if ((req.url || '').startsWith('/auth/')) {
      await handleAuth(req, res, log);
      return;
    }
    await serveFrontend(req, res);
  } catch (error) {
    log.error('http.request.error', errorDetails(error));
    sendError(res, 500, (error as Error).message);
  }
});

async function startServer() {
  logger.info('app.boot.begin', {
    nodeEnv: process.env.NODE_ENV || 'development',
    hosted: Boolean(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.NODE_ENV === 'production'),
  });
  validateStartupConfig();
  await persistence.initialize();
  server.listen(PORT, '0.0.0.0', () => {
    const persistenceDiagnostics = persistence.getDiagnostics();
    logger.info('app.boot.ready', {
      appBaseUrl: APP_BASE_URL,
      host: '0.0.0.0',
      port: PORT,
      logLevel: process.env.LOG_LEVEL || 'info',
      persistence: persistenceDiagnostics.mode,
      migrationVersion: persistenceDiagnostics.currentVersion,
    });
  });
}

void startServer().catch((error) => {
  logger.error('app.boot.failed', errorDetails(error));
  process.exit(1);
});

function loadEnv(envPath: string): void {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function validateStartupConfig(): void {
  if (!config.atlassian.clientId || !config.atlassian.clientSecret) {
    logger.warn('startup.config.atlassian_missing');
  }
  if (!config.llm.providers.some((provider) => provider.apiKey)) {
    logger.warn('startup.config.llm_missing');
  }
  if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
    logger.warn('startup.config.testrail_missing');
  }
  const hosted = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.NODE_ENV === 'production');
  if (hosted && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for hosted Phase 2 deployments.');
  }
}
