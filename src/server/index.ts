import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AtlassianClient,
  buildAuthUrl,
  exchangeCode,
  getCurrentUserProfile,
  getAccessibleResources,
  refreshAccessToken,
  type AccessibleResource,
} from './services/atlassian';
import { classifyAcceptanceCriteriaExecution, finalizeAcceptanceCriteria } from './services/acceptance-criteria';
import { buildQaContext } from './services/context-builder';
import {
  configuredLlmProviders,
  generateTestCases,
  orderLlmProviders,
  recommendDuplicateCases,
  selectScopedApiEndpoints,
  synthesizeAcceptanceCriteria,
  translateScopeSnapshot,
  usesFastAcceptanceCriteriaPath,
} from './services/llm';
import { startPrivacyReportingLoop } from './services/privacy';
import { buildSprintBurndownJql, buildTicketSuggestionsJql } from './services/suggestions';
import { summarizeSprintBurndown } from './services/sprint-burndown';
import { addAttachmentToResult, addResultForCase, buildManageCaseBody, fetchAttachment, findExistingCasesByJiraRef, getUserByEmail, guessAttachmentMime, pushCases, trWrite, type TestRailConfig } from './services/testrail';
import { assessEncryptionKeyStrength, decryptSecret, encryptionAvailable, encryptSecret } from './services/crypto';
import { buildApiContract, assessApiContractRelevance } from './services/api-docs';
import { clearDashboardCaches, findPlansForStory, getCoverageForKeys, getPlanReview, getPlanRunCounts, getSummary, invalidateEvidenceCaches, listPlans } from './services/testrail-dashboard';
import { withTimeout } from './services/http';
import { buildCoverage, trulyUncoveredCriteria, validateCases } from './services/validation';
import { hydrateTestCasesWithEvidence } from './services/evidence';
import { clarificationBlockedCaseIds, resolvePushSelection } from './services/push-selection';
import { getRecentIssues, logger } from './services/logger';
import { createPersistence, type SessionRecord } from './services/persistence';
import type {
  AnalyzeRequest,
  CoverageSummary,
  ConfigResponse,
  DiagnosticsResponse,
  GenerationStepTiming,
  GenerateRequest,
  GenerateQualityEvaluation,
  GeneratedTestCase,
  ManageCaseRequest,
  ManageRunRequest,
  PushPreflightRequest,
  PushRequest,
  QaContext,
  ScopeSnapshotTranslationRequest,
  ScopeSnapshotTranslationResponse,
  TicketSuggestionsResponse,
  JiraSprintBurndownResponse,
  ValidateRequest,
  ValidationEntry,
} from '../shared/contracts';

const PORT = Number(process.env.PORT || process.env.QA_AGENT_PORT || 5174);
const DEFAULT_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`;
const APP_BASE_URL = process.env.QA_AGENT_BASE_URL || DEFAULT_BASE_URL;
const IS_HTTPS = APP_BASE_URL.startsWith('https://');
const PROJECT_ROOT = process.cwd();
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'client-dist');
const AUDIT_FILE = path.join(PROJECT_ROOT, 'audit-log.jsonl');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'src/server/migrations');
const OAUTH_VERIFIER_COOKIE = 'qa_oauth';
// Hard ceiling for the heavy TestRail dashboard reads (coverage / summary / plan review). Their fan-out
// can stall under the shared rate limiter; bound the whole route so it fails fast instead of hanging the
// request (which, in dev, also holds the process and blocks the watcher from restarting).
const DASHBOARD_ROUTE_BUDGET_MS = Number(process.env.DASHBOARD_ROUTE_BUDGET_MS || 60_000);

loadEnv(path.join(PROJECT_ROOT, '.env'));

function normalizeAtlassianScopes(rawScopes: string): string {
  // Always include the scopes the app relies on, even if ATLASSIAN_SCOPES is customized.
  const required = [
    'read:jira-work',
    'read:page:confluence',
    'read:confluence-content.all',
    'read:confluence-space.summary',
    'read:me',
    'report:personal-data',
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
    providers: orderLlmProviders([
      {
        name: 'deepseek',
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      },
      {
        name: 'openai',
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || '',
        model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      },
    ]),
  },
  testrail: {
    baseUrl: process.env.TESTRAIL_BASE_URL || '',
    user: process.env.TESTRAIL_USER || '',
    apiKey: process.env.TESTRAIL_API_KEY || '',
    projectId: process.env.TESTRAIL_PROJECT_ID || '',
    // Suite defaults to the project id (this instance uses matching ids); override with TESTRAIL_SUITE_ID if they differ.
    suiteId: process.env.TESTRAIL_SUITE_ID || process.env.TESTRAIL_PROJECT_ID || '1',
  },
  reporterUrl: (process.env.TESTRAIL_REPORTER_URL || '').replace(/\/$/, ''),
  apiDocsUrl: process.env.API_DOCS_URL || 'https://dev.lokasi.com/api-docs/',
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

// OAuth state is paired with this callback-scoped verifier cookie so a valid
// callback URL from one browser cannot create a session in another browser.
function buildOAuthVerifierCookie(value: string, maxAge = 900): string {
  const parts = [`${OAUTH_VERIFIER_COOKIE}=${encodeURIComponent(value || '')}`, 'HttpOnly', 'Path=/auth/atlassian/callback', 'SameSite=Lax'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  if (IS_HTTPS) parts.push('Secure');
  return parts.join('; ');
}

function clearOAuthVerifierCookie(): string {
  return buildOAuthVerifierCookie('', 0);
}

function canonicalAuthStartUrl(req: IncomingMessage): string | null {
  const configured = new URL(APP_BASE_URL);
  const requestHost = String(req.headers.host || '').toLowerCase();
  const configuredHost = configured.host.toLowerCase();
  if (!requestHost || requestHost === configuredHost) return null;
  configured.pathname = '/auth/atlassian';
  configured.search = '';
  configured.hash = '';
  return configured.toString();
}

// Store only a hash of the browser verifier server-side; the raw verifier stays
// in the HttpOnly callback cookie and is cleared after success or failure.
function hashOAuthVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
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

function getOAuthVerifier(req: IncomingMessage): string | null {
  return parseCookies(req)[OAUTH_VERIFIER_COOKIE] || null;
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

type TrustedPushSource =
  | { ok: true; context?: QaContext; testCases: GeneratedTestCase[]; enforceAcceptanceCriteria: boolean }
  | { ok: false; status: number; message: string };

/**
 * A persisted generation is the authority for source diagnostics and original AC traceability.
 * Reviewers may edit case content before push, but cannot clear a clarification blocker by altering
 * the echoed context or remapping the affected case in the request payload.
 */
async function loadTrustedPushSource(
  body: PushRequest,
  sessionUser: string,
  submittedCases: GeneratedTestCase[]
): Promise<TrustedPushSource> {
  const generatedRunId = String(body.generatedRunId || '').trim();
  if (!generatedRunId) {
    return {
      ok: true,
      context: body.context,
      testCases: submittedCases,
      enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
    };
  }

  const encodedRunId = generatedRunId.startsWith('generation:') ? generatedRunId : `generation:${generatedRunId}`;
  const run = await persistence.getHistoryRun(encodedRunId);
  if (!run || run.entryType !== 'generation') {
    return { ok: false, status: 400, message: 'The generated run could not be verified. Regenerate the suite before pushing.' };
  }
  if (run.user !== sessionUser) {
    return { ok: false, status: 403, message: 'The generated run belongs to a different QA user.' };
  }
  if (run.jiraKey !== body.jiraKey) {
    return { ok: false, status: 400, message: `The generated run belongs to ${run.jiraKey}, not ${body.jiraKey}.` };
  }
  if (!run.context) {
    return { ok: false, status: 400, message: 'The generated run has no trusted analysis context. Regenerate the suite before pushing.' };
  }
  return {
    ok: true,
    context: run.context,
    testCases: run.testCases || [],
    enforceAcceptanceCriteria: run.coverage?.enforced ?? (body.enforceAcceptanceCriteria !== false),
  };
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  // Keep request parsing dependency-free, but cap body size so large payloads cannot exhaust memory.
  const maxBodyBytes = Number(process.env.MAX_REQUEST_BODY_BYTES || 1_000_000);
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) {
      throw new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
    }
  }
  return (body ? JSON.parse(body) : {}) as T;
}

// Read a raw binary request body (e.g. an evidence upload) into a Buffer, capped so a large upload
// can't exhaust memory. Returns null when the cap is exceeded so the caller can answer 413.
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// Evidence uploads: accepted content types + size cap (see PlanReviewModal client-side mirror).
const EVIDENCE_MAX_BYTES = Number(process.env.EVIDENCE_MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const EVIDENCE_ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
]);

// Validate + read an evidence upload (shared by the result and case routes). Pure: returns a
// discriminated result so the caller maps failures to sendError without scope coupling.
async function parseEvidenceUpload(
  req: IncomingMessage,
  fallbackName: string
): Promise<
  | { ok: true; buffer: Buffer; filename: string; contentType: string }
  | { ok: false; status: number; message: string }
> {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!EVIDENCE_ALLOWED_TYPES.has(contentType)) {
    return { ok: false, status: 415, message: 'Unsupported evidence type. Allowed: PNG, JPEG, GIF, WebP, MP4, MOV, WebM, PDF.' };
  }
  let filename = fallbackName;
  const rawName = String(req.headers['x-filename'] || '').trim();
  if (rawName) {
    try {
      filename = decodeURIComponent(rawName); // client encodes so the header stays ASCII-safe
    } catch {
      filename = rawName;
    }
  }
  const buffer = await readRawBody(req, EVIDENCE_MAX_BYTES);
  if (!buffer) {
    return { ok: false, status: 413, message: `Evidence file exceeds the ${Math.round(EVIDENCE_MAX_BYTES / (1024 * 1024))}MB limit.` };
  }
  if (!buffer.length) {
    return { ok: false, status: 400, message: 'Evidence file is empty.' };
  }
  return { ok: true, buffer, filename, contentType };
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

  // Defend the static file server from path traversal before reading from client-dist.
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
  // Refresh through persistence first so concurrent requests use the newest refresh token.
  const current = (await persistence.getSession(sid)) || session;
  if (!current.refreshToken) {
    throw new Error('Atlassian session cannot be refreshed because no refresh token is stored.');
  }
  const refreshed = await refreshAccessToken(config.atlassian, current.refreshToken);
  const resources = await getAccessibleResources(refreshed.access_token);
  let profile: Awaited<ReturnType<typeof getCurrentUserProfile>> | null = null;
  try {
    profile = await getCurrentUserProfile(refreshed.access_token);
  } catch (error) {
    log.warn('auth.atlassian.profile_refresh_unavailable', errorDetails(error));
  }
  const selectedResource = choosePrimaryResource(resources) || current.selectedResource || null;
  const updated: SessionRecord = {
    ...current,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || current.refreshToken,
    cloudId: selectedResource?.id || current.cloudId,
    resources,
    selectedResource,
    user: profile?.displayName || current.user,
    accountId: profile?.accountId || current.accountId || null,
    displayName: profile?.displayName || current.displayName || current.user,
    personalDataRetrievedAt: profile ? Date.now() : current.personalDataRetrievedAt || current.createdAt,
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
  // A user can authorize multiple Atlassian sites; prefer explicit env config, then the known production host, then first available.
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
    pathname.startsWith('/api/history/runs/') ||
    pathname.startsWith('/api/testrail/')
  ) {
    return true;
  }
  return false;
}

function shouldEnforceAcceptanceCriteria(context: QaContext | null, _confidencePermissionApproved: boolean): boolean {
  // Acceptance-criteria coverage is enforced only when the analyzer found criteria trustworthy enough to track.
  if (!context) return false;
  return Array.isArray(context.acceptanceCriteria) && context.acceptanceCriteria.length > 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function analysisSourceFingerprint(context: QaContext): string {
  return sha256({
    // Bumped to 17: endpoint planning now separates asynchronous submit triggers from result-field
    // observation and keeps each synthesized criterion on one observable surface.
    version: 17,
    ticketKey: context.ticketKey,
    mainIssue: context.mainIssue,
    linkedIssues: context.linkedIssues,
    confluencePages: context.confluencePages,
    scopeParentIssue: context.scopeParentIssue,
    scopeConfluenceSection: context.scopeConfluenceSection,
    scopeAuthority: context.scopeAuthority,
    acceptanceCriteria: context.acceptanceCriteria,
    userStories: context.userStories,
    acceptanceCriteriaSource: context.acceptanceCriteriaSource,
    constraints: context.constraints,
    figmaReferences: context.figmaReferences || [],
    apiDocsUrl: context.apiDocsUrl || '',
    actualDevScopeGuidance: context.actualDevScopeGuidance || '',
  });
}

function finalizedAcceptanceCriteriaHash(context: QaContext): string {
  return sha256({
    version: 2,
    acceptanceCriteria: context.acceptanceCriteria.map((item) => ({ id: item.id, text: item.text, source: item.source })),
    source: context.acceptanceCriteriaSource,
    rawQuality: context.acceptanceCriteriaDiagnostics?.rawAcceptanceCriteriaQuality || '',
    synthesisUsed: Boolean(context.acceptanceCriteriaDiagnostics?.synthesisUsed),
    directRequirements: (context.acceptanceCriteriaDiagnostics?.directRequirements || []).map((requirement) => ({
      id: requirement.id,
      disposition: requirement.disposition,
      acceptanceCriteriaIds: requirement.acceptanceCriteriaIds,
    })),
  });
}

function executionPlanHash(context: QaContext): string {
  return sha256({
    version: 2,
    executionPlan: context.acceptanceCriteriaDiagnostics?.acceptanceCriteriaExecutionPlan || [],
  });
}

function apiContractHash(context: QaContext): string {
  return sha256({
    version: 1,
    relevant: context.constraints?.apiContractRelevant ?? null,
    reason: context.constraints?.apiContractRelevanceReason || '',
    endpoints: context.apiContract?.matchedEndpoints || [],
    warnings: context.apiContract?.warnings || [],
  });
}

function cacheMetadata(context: QaContext) {
  return context.acceptanceCriteriaDiagnostics.cache || {};
}

function buildGenerationQualityEvaluation(input: {
  provider: string;
  model: string;
  context: QaContext;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary;
  coverageEnforced: boolean;
  durationMs: number;
  stepTimings?: GenerationStepTiming[];
}): GenerateQualityEvaluation {
  const totalCriteria = input.coverage.totalCriteria || 0;
  const acceptanceCriteriaCount = input.context.acceptanceCriteria?.length || 0;
  const testCaseCount = input.testCases.length;
  const weakCoverageClaims = input.coverage.unsubstantiatedClaims?.length || 0;
  const singlePolarityWarnings = input.coverage.singlePolarityCriteria?.length || 0;
  const allWarnings = input.validation.flatMap((item) => item.warnings || []);
  const validationWarningCount = allWarnings.length;
  const broadCoverageWarnings = allWarnings.filter((warning) => /maps to \d+ acceptance criteria/i.test(warning)).length;
  const duplicateCaseWarnings = allWarnings.filter((warning) => /Potential duplicate of/i.test(warning)).length;
  const endpointAlignmentWarnings = allWarnings.filter((warning) =>
    /additional endpoint\(s\).*not represented by apiSpec/i.test(warning)
  ).length;
  const executionAlignmentWarnings = allWarnings.filter((warning) =>
    /executionType is .* but apiSpec defines|Postman API case|Manual DB case|apiSpec endpoint .* not in the matched API contract/i.test(warning)
  ).length;
  const executionTypeMismatchWarnings = allWarnings.filter((warning) => /is classified as .* but this case is/i.test(warning)).length;
  const invalidCaseIds = input.validation.filter((item) => !item.valid).map((item) => item.id);
  const minimumFocusedCaseCount = totalCriteria
    ? Math.min(totalCriteria, 12, Math.max(4, Math.ceil(totalCriteria * 0.75)))
    : 0;
  const tinyBroadSuite =
    Boolean(input.coverageEnforced && totalCriteria >= 3 && input.coverage.uncoveredCriteria.length === 0) &&
    testCaseCount < minimumFocusedCaseCount;
  const diagnostics = input.context.acceptanceCriteriaDiagnostics || {};
  const blockedCaseIds = clarificationBlockedCaseIds(input.context, input.testCases);
  const readyCaseIds = input.testCases.map((testCase) => testCase.id).filter((id) => !blockedCaseIds.includes(id));
  const unresolvedClarificationCount = (diagnostics.directRequirements || []).filter(
    (requirement) => requirement.disposition === 'needs_clarification'
  ).length;
  const endpointDowngradeCount = (diagnostics.acceptanceCriteriaExecutionPlan || []).filter((item) => Boolean(item.endpointDowngrade)).length;
  const noisyRawAcceptanceCriteria = Boolean(diagnostics.rawAcceptanceCriteriaQuality !== 'strong' && !diagnostics.synthesisUsed);
  const abnormalRequirementInventory = Boolean(diagnostics.abnormalRequirementInventory);
  const unmappedRequirementCount = Number(diagnostics.unmappedRequirementCount || 0);
  const singlePolarityWarningLimit = totalCriteria ? Math.max(3, Math.ceil(totalCriteria * 0.35)) : 0;
  // Broad cases (mapping to >2 ACs) are ratio-limited rather than zero-tolerance: a single stream/response
  // can legitimately verify several related output ACs in one well-substantiated case, and genuine
  // false-green (breadth hiding unasserted claims) is already a hard-fail via weakCoverageClaims. So allow a
  // small number of consolidated cases proportional to suite size; only an excess signals lazy mapping.
  const broadCoverageWarningLimit = testCaseCount ? Math.max(1, Math.ceil(testCaseCount * 0.15)) : 0;
  const falseGreenCoverageRisk =
    input.coverage.uncoveredCriteria.length === 0 &&
    (weakCoverageClaims > 0 ||
      singlePolarityWarnings > 0 ||
      tinyBroadSuite ||
      noisyRawAcceptanceCriteria ||
      broadCoverageWarnings > 0 ||
      duplicateCaseWarnings > 0 ||
      endpointAlignmentWarnings > 0 ||
      executionTypeMismatchWarnings > 0 ||
      unresolvedClarificationCount > 0 ||
      abnormalRequirementInventory ||
      unmappedRequirementCount > 0);
  const failed =
    invalidCaseIds.length > 0 ||
    input.coverage.uncoveredCriteria.length > 0 ||
    weakCoverageClaims > 0 ||
    singlePolarityWarnings > singlePolarityWarningLimit ||
    tinyBroadSuite ||
    noisyRawAcceptanceCriteria ||
    broadCoverageWarnings > broadCoverageWarningLimit ||
    duplicateCaseWarnings > 0 ||
    endpointAlignmentWarnings > 0 ||
    executionTypeMismatchWarnings > 0 ||
    unresolvedClarificationCount > 0;

  return {
    mode: input.provider.toLowerCase() === 'deepseek' ? 'deepseek_quality_first' : 'quality_baseline',
    provider: input.provider,
    model: input.model,
    durationMs: input.durationMs,
    acceptanceCriteriaCount,
    testCaseCount,
    coverageEnforced: input.coverageEnforced,
    coveredCriteria: input.coverage.coveredCriteria,
    totalCriteria,
    uncoveredCriteria: input.coverage.uncoveredCriteria,
    weakCoverageClaims,
    singlePolarityWarnings,
    singlePolarityWarningLimit,
    validationWarningCount,
    broadCoverageWarnings,
    broadCoverageWarningLimit,
    duplicateCaseWarnings,
    endpointAlignmentWarnings,
    executionAlignmentWarnings,
    executionTypeMismatchWarnings,
    invalidCaseIds,
    minimumFocusedCaseCount,
    tinyBroadSuite,
    rawAcceptanceCriteriaQuality: diagnostics.rawAcceptanceCriteriaQuality || 'none',
    synthesisUsed: Boolean(diagnostics.synthesisUsed),
    noisyRawAcceptanceCriteria,
    abnormalRequirementInventory,
    unmappedRequirementCount,
    falseGreenCoverageRisk,
    unresolvedClarificationCount,
    blockedCaseIds,
    readyCaseIds,
    endpointDowngradeCount,
    stepTimings: input.stepTimings || [],
    qualityGate: failed ? 'fail' : falseGreenCoverageRisk ? 'warn' : 'pass',
  };
}

async function appendAudit(event: Record<string, unknown>): Promise<void> {
  await persistence.appendAudit(event);
}

/** Effective TestRail config for a session: the user's own saved creds if present, else shared env. */
async function resolveTestrailConfig(session: SessionRecord | null | undefined): Promise<TestRailConfig> {
  if (encryptionAvailable() && session?.accountId) {
    try {
      const creds = await persistence.getUserTestrailCreds(session.accountId);
      if (creds) return { ...config.testrail, user: creds.user, apiKey: decryptSecret(creds.apiKeyEnc) };
    } catch {
      // fall back to the shared account
    }
  }
  return config.testrail;
}

/**
 * TestRail management writes (Phase C). All routes require a session + configured TestRail.
 * Every action supports `dryRun` — it returns the resolved endpoint + payload without
 * calling TestRail. Successful writes clear the dashboard caches so reads reflect changes.
 */
async function handleTestRailManage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const sessionEnvelope = await requireSession(req, res);
  if (!sessionEnvelope) return;
  if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
    sendError(res, 503, 'TestRail is not configured.');
    return;
  }

  const trConfig = await resolveTestrailConfig(sessionEnvelope.session);
  const segments = url.pathname.split('/').filter(Boolean); // ['api','testrail','manage',...]
  const resource = segments[3] || '';
  const idA = segments[4];
  const idB = segments[5];
  const method = req.method || 'GET';

  async function run(action: string, endpoint: string, payload: Record<string, unknown>, dryRun: boolean): Promise<void> {
    if (dryRun) {
      sendJson(res, 200, { dryRun: true, action, endpoint, payload });
      return;
    }
    try {
      const result = await trWrite(trConfig, endpoint, payload);
      clearDashboardCaches();
      sendJson(res, 200, { ok: true, action, id: result.id, result });
    } catch (error) {
      sendError(res, 502, (error as Error).message || `TestRail ${action} failed.`);
    }
  }

  try {
    // ----- cases -----
    if (resource === 'case' && !idA && method === 'POST') {
      const body = await readBody<ManageCaseRequest>(req);
      const sectionId = String(body.sectionId || process.env.TESTRAIL_SECTION_ID || '').trim();
      if (!sectionId) {
        sendError(res, 400, 'sectionId is required to create a case.');
        return;
      }
      const payload = buildManageCaseBody(body);
      if (body.bddScenario !== undefined && body.templateId === undefined) payload.template_id = 4;
      await run('case.create', `add_case/${encodeURIComponent(sectionId)}`, payload, Boolean(body.dryRun));
      return;
    }
    if (resource === 'case' && idA && (method === 'PUT' || method === 'POST')) {
      const body = await readBody<ManageCaseRequest>(req);
      await run('case.update', `update_case/${encodeURIComponent(idA)}`, buildManageCaseBody(body), Boolean(body.dryRun));
      return;
    }
    if (resource === 'case' && idA && method === 'DELETE') {
      const dryRun = url.searchParams.get('dry_run') === 'true';
      await run('case.delete', `delete_case/${encodeURIComponent(idA)}`, {}, dryRun);
      return;
    }

    // ----- runs -----
    if (resource === 'run' && !idA && method === 'POST') {
      const body = await readBody<ManageRunRequest>(req);
      const projectId = String(body.projectId || config.testrail.projectId || '').trim();
      if (!projectId) {
        sendError(res, 400, 'projectId is required to create a run.');
        return;
      }
      const payload: Record<string, unknown> = {
        name: body.name,
        ...(body.suiteId !== undefined ? { suite_id: body.suiteId } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.refs !== undefined ? { refs: body.refs } : {}),
        include_all: body.includeAll ?? !(body.caseIds && body.caseIds.length),
        ...(body.caseIds ? { case_ids: body.caseIds } : {}),
      };
      await run('run.create', `add_run/${encodeURIComponent(projectId)}`, payload, Boolean(body.dryRun));
      return;
    }
    if (resource === 'run' && idA && idB === 'cases' && method === 'POST') {
      const body = await readBody<ManageRunRequest>(req);
      const payload = { include_all: false, case_ids: body.caseIds || [] };
      await run('run.setCases', `update_run/${encodeURIComponent(idA)}`, payload, Boolean(body.dryRun));
      return;
    }
    if (resource === 'run' && idA && !idB && (method === 'PUT' || method === 'POST')) {
      const body = await readBody<ManageRunRequest>(req);
      const payload: Record<string, unknown> = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.refs !== undefined ? { refs: body.refs } : {}),
      };
      await run('run.update', `update_run/${encodeURIComponent(idA)}`, payload, Boolean(body.dryRun));
      return;
    }
    if (resource === 'run' && idA && !idB && method === 'DELETE') {
      const dryRun = url.searchParams.get('dry_run') === 'true';
      await run('run.delete', `delete_run/${encodeURIComponent(idA)}`, {}, dryRun);
      return;
    }

    // ----- plans -----
    if (resource === 'plan' && idA && idB === 'entry' && method === 'POST') {
      const body = await readBody<ManageRunRequest>(req);
      const suiteId = String(body.suiteId ?? config.testrail.suiteId ?? '1');
      const payload: Record<string, unknown> = {
        suite_id: Number(suiteId),
        name: body.name,
        include_all: false,
        case_ids: body.caseIds || [],
        ...(body.refs !== undefined ? { refs: body.refs } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      };
      await run('plan.addEntry', `add_plan_entry/${encodeURIComponent(idA)}`, payload, Boolean(body.dryRun));
      return;
    }
    if (resource === 'plan' && !idA && method === 'POST') {
      const body = await readBody<ManageRunRequest>(req);
      const projectId = String(body.projectId || config.testrail.projectId || '').trim();
      if (!projectId) {
        sendError(res, 400, 'projectId is required to create a plan.');
        return;
      }
      const payload: Record<string, unknown> = {
        name: body.name,
        ...(body.refs !== undefined ? { refs: body.refs } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      };
      await run('plan.create', `add_plan/${encodeURIComponent(projectId)}`, payload, Boolean(body.dryRun));
      return;
    }
    if (resource === 'plan' && idA && (method === 'PUT' || method === 'POST')) {
      const body = await readBody<ManageRunRequest>(req);
      const payload: Record<string, unknown> = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.refs !== undefined ? { refs: body.refs } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      };
      await run('plan.update', `update_plan/${encodeURIComponent(idA)}`, payload, Boolean(body.dryRun));
      return;
    }
    if (resource === 'plan' && idA && method === 'DELETE') {
      const dryRun = url.searchParams.get('dry_run') === 'true';
      await run('plan.delete', `delete_plan/${encodeURIComponent(idA)}`, {}, dryRun);
      return;
    }

    sendError(res, 404, 'Unknown TestRail management action.');
  } catch (error) {
    sendError(res, 400, (error as Error).message || 'Invalid management request.');
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, log = logger): Promise<void> {
  const url = new URL(req.url || '/', APP_BASE_URL);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const session = await getSession(req);
    const body: ConfigResponse = {
      authenticated: Boolean(session),
      user: session?.user || null,
      accountId: session?.accountId || null,
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
        llm: configuredLlmProviders(config.llm.providers).length > 0,
        testrail: Boolean(config.testrail.baseUrl && config.testrail.user && config.testrail.apiKey),
        database: persistence.isDatabaseBacked(),
      },
      defaults: {
        testrailSectionId: process.env.TESTRAIL_SECTION_ID || '69',
        testrailApiSectionId: process.env.TESTRAIL_API_SECTION_ID || '19',
        reporterUrl: config.reporterUrl,
        apiDocsUrl: config.apiDocsUrl,
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
        accountId: session?.accountId || null,
        selectedResource: session?.selectedResource
          ? {
              cloudId: session.selectedResource.id,
              url: session.selectedResource.url || null,
              name: session.selectedResource.name || null,
            }
          : null,
        sessionExpiresAt: session?.expiresAt || null,
      },
      privacy: {
        enabled: Boolean(process.env.PRIVACY_REPORTING_ENABLED !== 'false'),
        ...(await persistence.getPrivacyReportingStatus(Number(process.env.PRIVACY_REPORTING_DEFAULT_CYCLE_DAYS || 7), Date.now())),
      },
      persistence: persistence.getDiagnostics(),
      readiness: {
        atlassian: Boolean(config.atlassian.clientId && config.atlassian.clientSecret),
        llm: configuredLlmProviders(config.llm.providers).length > 0,
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
    sendJson(res, 200, { visibility: historyVisibility(), runs: await persistence.listHistoryRuns(100) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/suggestions/tickets') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { sid, session } = sessionEnvelope;
    const jql = buildTicketSuggestionsJql(QA_ASSIGNEE_JQL_FIELD);
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

  if (req.method === 'GET' && url.pathname === '/api/jira/sprint-burndown') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { sid, session } = sessionEnvelope;
    const jql = buildSprintBurndownJql();
    const issues = await createClient(sid, session, log).searchIssues(jql, 100);
    const body: JiraSprintBurndownResponse = summarizeSprintBurndown(jql, issues);
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

  // --- TestRail management (write) -------------------------------------
  if (url.pathname.startsWith('/api/testrail/manage/')) {
    await handleTestRailManage(req, res, url);
    return;
  }

  // --- TestRail dashboard (read views) ---------------------------------
  if (req.method === 'GET' && url.pathname === '/api/testrail/plans') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    try {
      const projectId = url.searchParams.get('project_id') || config.testrail.projectId || '';
      const plans = await listPlans(config.testrail, projectId);
      sendJson(res, 200, { projectId: String(projectId), plans });
    } catch (error) {
      sendError(res, 502, (error as Error).message || 'Failed to load TestRail plans.');
    }
    return;
  }

  if (url.pathname === '/api/testrail/credentials') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const accountId = sessionEnvelope.session.accountId || '';

    if (req.method === 'GET') {
      let configured = false;
      let user: string | null = null;
      if (encryptionAvailable() && accountId) {
        const creds = await persistence.getUserTestrailCreds(accountId);
        if (creds) {
          configured = true;
          user = creds.user;
        }
      }
      sendJson(res, 200, { available: encryptionAvailable(), configured, user });
      return;
    }

    if (req.method === 'POST') {
      if (!encryptionAvailable()) {
        sendError(res, 503, 'Server encryption key (ENCRYPTION_KEY) is not configured, so personal credentials are disabled.');
        return;
      }
      if (!accountId) {
        sendError(res, 400, 'No Atlassian account on this session.');
        return;
      }
      if (!config.testrail.baseUrl) {
        sendError(res, 503, 'TestRail base URL is not configured.');
        return;
      }
      const body = await readBody<{ user?: string; apiKey?: string }>(req);
      const trUser = String(body.user || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      if (!trUser || !apiKey) {
        sendError(res, 400, 'TestRail email and API key are required.');
        return;
      }
      try {
        await getUserByEmail({ ...config.testrail, user: trUser, apiKey }, trUser);
      } catch {
        sendError(res, 400, 'Could not verify those TestRail credentials — check the email and API key.');
        return;
      }
      await persistence.setUserTestrailCreds(accountId, trUser, encryptSecret(apiKey));
      sendJson(res, 200, { available: true, configured: true, user: trUser });
      return;
    }

    if (req.method === 'DELETE') {
      if (accountId) await persistence.deleteUserTestrailCreds(accountId);
      sendJson(res, 200, { available: encryptionAvailable(), configured: false, user: null });
      return;
    }

    sendError(res, 405, 'Method not allowed.');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/testrail/plan-run-counts') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    const ids = (url.searchParams.get('ids') || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (!ids.length) {
      sendJson(res, 200, { counts: {} });
      return;
    }
    try {
      sendJson(res, 200, { counts: await getPlanRunCounts(config.testrail, ids) });
    } catch (error) {
      sendError(res, 502, (error as Error).message || 'Failed to load run counts.');
    }
    return;
  }

  if (req.method === 'GET' && /^\/api\/testrail\/plans\/[^/]+\/review$/.test(url.pathname)) {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    const planId = decodeURIComponent(url.pathname.replace(/^\/api\/testrail\/plans\//, '').replace(/\/review$/, ''));
    if (!planId.trim()) {
      sendError(res, 400, 'A plan ID is required.');
      return;
    }
    try {
      const trConfig = await resolveTestrailConfig(sessionEnvelope.session);
      const review = await withTimeout(getPlanReview(trConfig, planId), DASHBOARD_ROUTE_BUDGET_MS, 'TestRail plan review');
      sendJson(res, 200, review);
    } catch (error) {
      const timedOut = (error as { name?: string }).name === 'UpstreamTimeoutError';
      sendError(res, timedOut ? 504 : 502, (error as Error).message || 'Failed to load plan review.');
    }
    return;
  }

  if (req.method === 'GET' && /^\/api\/testrail\/attachments\/[^/]+$/.test(url.pathname)) {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    const attachmentId = decodeURIComponent(url.pathname.replace(/^\/api\/testrail\/attachments\//, ''));
    if (!attachmentId.trim()) {
      sendError(res, 400, 'An attachment ID is required.');
      return;
    }
    try {
      const trConfig = await resolveTestrailConfig(sessionEnvelope.session);
      const { stream, statusCode, headers } = await fetchAttachment(trConfig, attachmentId);
      if (statusCode < 200 || statusCode >= 300) {
        let raw = '';
        for await (const chunk of stream) raw += chunk;
        let message = `HTTP ${statusCode}`;
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          if (parsed?.error) message = String(parsed.error);
        } catch {
          /* non-JSON upstream error body */
        }
        sendError(res, statusCode === 404 ? 404 : 502, message);
        return;
      }
      // Client passes the filename so the Content-Disposition is meaningful; sanitise header-unsafe chars.
      const rawName = (url.searchParams.get('name') || `attachment-${attachmentId}`).replace(/[\r\n"\\]/g, '').slice(0, 200);
      const download = url.searchParams.get('download') === '1';
      const upstreamType = String(headers['content-type'] || '');
      const contentType =
        guessAttachmentMime(rawName) || (upstreamType && !/octet-stream/i.test(upstreamType) ? upstreamType : '') || 'application/octet-stream';
      const length = headers['content-length'];
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${rawName}"`,
        'Cache-Control': 'private, max-age=300',
        ...(length ? { 'Content-Length': length } : {}),
      });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      sendError(res, 502, (error as Error).message || 'Failed to load attachment.');
    }
    return;
  }

  // Upload an evidence file as an attachment on a TestRail result (Plan Review "upload evidence").
  if (req.method === 'POST' && /^\/api\/testrail\/results\/[^/]+\/attachments$/.test(url.pathname)) {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    const resultId = decodeURIComponent(url.pathname.replace(/^\/api\/testrail\/results\//, '').replace(/\/attachments$/, ''));
    if (!resultId.trim()) {
      sendError(res, 400, 'A result ID is required.');
      return;
    }
    const upload = await parseEvidenceUpload(req, `evidence-${resultId}`);
    if (!upload.ok) {
      sendError(res, upload.status, upload.message);
      return;
    }
    try {
      const trConfig = await resolveTestrailConfig(sessionEnvelope.session);
      const { attachmentId } = await addAttachmentToResult(trConfig, resultId, upload);
      invalidateEvidenceCaches(); // so the next plan-review/coverage fetch reflects the new evidence
      log.info('api.testrail.evidence_uploaded', {
        user: sessionEnvelope.session.user,
        target: 'result',
        resultId,
        attachmentId,
        bytes: upload.buffer.length,
        contentType: upload.contentType,
      });
      sendJson(res, 200, { attachmentId, resultId });
    } catch (error) {
      sendError(res, 502, (error as Error).message || 'Failed to upload evidence.');
    }
    return;
  }

  // Pass-with-evidence: a test with no result yet (e.g. Untested) has nothing to attach result-evidence
  // to, so record a Passed result for the case in the run, then attach the file to that new result.
  // This MUTATES TestRail (sets the test to Passed); the client confirms before calling it.
  if (req.method === 'POST' && /^\/api\/testrail\/runs\/[^/]+\/cases\/[^/]+\/pass-with-evidence$/.test(url.pathname)) {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    const match = url.pathname.match(/^\/api\/testrail\/runs\/([^/]+)\/cases\/([^/]+)\/pass-with-evidence$/);
    const runId = decodeURIComponent(match?.[1] || '');
    const caseId = decodeURIComponent(match?.[2] || '');
    if (!runId.trim() || !caseId.trim()) {
      sendError(res, 400, 'A run ID and case ID are required.');
      return;
    }
    const upload = await parseEvidenceUpload(req, `evidence-${caseId}`);
    if (!upload.ok) {
      sendError(res, upload.status, upload.message);
      return;
    }
    try {
      const trConfig = await resolveTestrailConfig(sessionEnvelope.session);
      const { resultId } = await addResultForCase(trConfig, runId, caseId, 1); // status_id 1 = Passed
      const { attachmentId } = await addAttachmentToResult(trConfig, resultId, upload);
      invalidateEvidenceCaches(); // status + evidence both changed
      log.info('api.testrail.evidence_uploaded', {
        user: sessionEnvelope.session.user,
        target: 'pass',
        runId,
        caseId,
        resultId,
        attachmentId,
        bytes: upload.buffer.length,
        contentType: upload.contentType,
      });
      sendJson(res, 200, { resultId, attachmentId, status: 'Passed' });
    } catch (error) {
      sendError(res, 502, (error as Error).message || 'Failed to record result and upload evidence.');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/testrail/coverage') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    const keys = (url.searchParams.get('keys') || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!keys.length) {
      sendJson(res, 200, { coverage: {} });
      return;
    }
    try {
      const coverage = await withTimeout(getCoverageForKeys(config.testrail, keys), DASHBOARD_ROUTE_BUDGET_MS, 'TestRail coverage');
      sendJson(res, 200, { coverage });
    } catch (error) {
      const timedOut = (error as { name?: string }).name === 'UpstreamTimeoutError';
      sendError(res, timedOut ? 504 : 502, (error as Error).message || 'Failed to compute coverage.');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/testrail/plan-for-story') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    const storyKey = url.searchParams.get('key') || '';
    if (!storyKey) {
      sendError(res, 400, 'A story key is required.');
      return;
    }
    try {
      sendJson(res, 200, { storyKey, plans: await findPlansForStory(config.testrail, storyKey) });
    } catch (error) {
      sendError(res, 502, (error as Error).message || 'Failed to look up plans.');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/testrail/summary') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 503, 'TestRail is not configured.');
      return;
    }
    try {
      const projectId = url.searchParams.get('project_id') || config.testrail.projectId || '';
      const summary = await withTimeout(getSummary(config.testrail, projectId), DASHBOARD_ROUTE_BUDGET_MS, 'TestRail summary');
      sendJson(res, 200, summary);
    } catch (error) {
      const timedOut = (error as { name?: string }).name === 'UpstreamTimeoutError';
      sendError(res, timedOut ? 504 : 502, (error as Error).message || 'Failed to load TestRail summary.');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/testrail/cache/clear') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    clearDashboardCaches();
    sendJson(res, 200, { ok: true });
    return;
  }

  // Analyze builds the scope snapshot from Jira/Confluence, then finalizes criteria before anything is generated.
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
      scopeType: body.scopeType || 'auto',
      apiDocsUrl: body.apiDocsUrl || config.apiDocsUrl,
      beAlreadyTested: Boolean(body.beAlreadyTested),
      includeComments: body.includeComments !== false,
      figmaReferenceCount: Array.isArray(body.figmaReferences) ? body.figmaReferences.length : 0,
    });
    const context = await buildQaContext(createClient(sid, session, log), jiraKey, {
      feOnly: body.feOnly !== false,
      scopeType: body.scopeType || 'auto',
      apiDocsUrl: body.apiDocsUrl || config.apiDocsUrl,
      beAlreadyTested: Boolean(body.beAlreadyTested),
      includeComments: body.includeComments !== false,
      figmaReferences: body.figmaReferences,
      logger: log,
    });
    const acProvider = configuredLlmProviders(config.llm.providers)[0];
    const analysisSourceHash = analysisSourceFingerprint(context);
    let finalizedContext: QaContext | null = null;
    if (acProvider) {
      const cached = await persistence.findCachedAnalysisContext({
        jiraKey,
        analysisSourceHash,
        acProvider: acProvider.name,
        acModel: acProvider.model,
      });
      if (cached) {
        finalizedContext = {
          ...cached.context,
          analysisRunId: undefined,
          acceptanceCriteriaDiagnostics: {
            ...cached.context.acceptanceCriteriaDiagnostics,
            cache: {
              ...(cached.context.acceptanceCriteriaDiagnostics.cache || {}),
              cacheHit: true,
              cachedFromAnalysisRunId: cached.analysisRunId,
            },
          },
        };
        log.info('api.analyze.cache_hit', {
          jiraKey,
          cachedFromAnalysisRunId: cached.analysisRunId,
          provider: acProvider.name,
          model: acProvider.model,
          acceptanceCriteriaCount: finalizedContext.acceptanceCriteria.length,
        });
      } else {
        log.info('api.analyze.cache_miss', {
          jiraKey,
          provider: acProvider.name,
          model: acProvider.model,
          analysisSourceHash,
        });
      }
    }

    if (!finalizedContext) {
      finalizedContext = await finalizeAcceptanceCriteria(context, {
        synthesizer: async (input) => synthesizeAcceptanceCriteria(config.llm, input, log),
        logger: log,
        skipStrongLlmSynthesis: usesFastAcceptanceCriteriaPath(config.llm),
        // F3: enables the LLM excerpt-relevance gate (only fires when EXCERPT_RELEVANCE_LLM is set).
        llm: config.llm,
      });
      if (finalizedContext.constraints.scopeType === 'api') {
        // Not every backend ticket touches the HTTP API. Only fetch the docs when the ticket is
        // actually API-contract work; internal backend work (migration/backfill/DB) skips the crawl.
        const relevance = assessApiContractRelevance(finalizedContext);
        finalizedContext.constraints.apiContractRelevant = relevance.relevant;
        finalizedContext.constraints.apiContractRelevanceReason = relevance.reason;
        if (relevance.relevant) {
          try {
            finalizedContext.apiContract = await buildApiContract(
              finalizedContext,
              finalizedContext.apiDocsUrl || config.apiDocsUrl,
              (input) => selectScopedApiEndpoints(config.llm, input)
            );
          } catch (error) {
            finalizedContext.apiContract = {
              sourceUrl: finalizedContext.apiDocsUrl || config.apiDocsUrl,
              matchedEndpoints: [],
              warnings: [`API docs enrichment failed: ${(error as Error).message}`],
            };
          }
        } else {
          log.info('context.api_docs_skipped', { jiraKey, reason: relevance.reason });
        }
      }
    }
    finalizedContext.acceptanceCriteriaDiagnostics.acceptanceCriteriaExecutionPlan = classifyAcceptanceCriteriaExecution(finalizedContext);
    finalizedContext.acceptanceCriteriaDiagnostics.cache = {
      ...(finalizedContext.acceptanceCriteriaDiagnostics.cache || {}),
      analysisSourceHash,
      finalizedAcHash: finalizedAcceptanceCriteriaHash(finalizedContext),
      executionPlanHash: executionPlanHash(finalizedContext),
      apiContractHash: apiContractHash(finalizedContext),
      acProvider: acProvider?.name || '',
      acModel: acProvider?.model || '',
      cacheHit: Boolean(finalizedContext.acceptanceCriteriaDiagnostics.cache?.cacheHit),
    };
    log.info('context.ac_execution_plan', {
      jiraKey,
      items: (finalizedContext.acceptanceCriteriaDiagnostics.acceptanceCriteriaExecutionPlan || []).map((item) => ({
        criterionId: item.criterionId,
        executionType: item.executionType,
        coveragePolicy: item.coveragePolicy,
        observableSurface: item.observableSurface,
      })),
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
      scopeType: finalizedContext.constraints.scopeType,
      apiEndpointCount: finalizedContext.apiContract?.matchedEndpoints.length || 0,
    });
    await appendAudit({ type: 'analyze', user: session.user, jiraKey, linkedIssueCount: context.linkedIssues.length });
    sendJson(res, 200, { context: finalizedContext });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/context/translate') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    if (!configuredLlmProviders(config.llm.providers).length) {
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

  // Generate is intentionally gated by scope confidence and AC coverage so the model cannot silently expand weak scope.
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { session } = sessionEnvelope;
    if (!configuredLlmProviders(config.llm.providers).length) {
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
    // Not-production-ready block: weak raw ACs + failed/empty synthesis produced a reduced AC set. Refuse
    // to generate against it unless explicitly overridden, so a transient synthesis failure can't silently
    // ship a degraded suite. (The synthesizer retries transient errors first; this catches the residue.)
    const acDiagnostics = body.context.acceptanceCriteriaDiagnostics;
    if (acDiagnostics?.acceptanceCriteriaNotProductionReady && !body.acceptanceCriteriaOverrideApproved) {
      log.warn('api.generate.blocked_not_production_ready', {
        jiraKey: body.context.ticketKey,
        user: session.user,
        reason: acDiagnostics.acceptanceCriteriaNotProductionReadyReason || '',
      });
      sendJson(res, 422, {
        blocked: true,
        reason: 'acceptance_criteria_not_production_ready',
        message:
          acDiagnostics.acceptanceCriteriaNotProductionReadyReason ||
          'Acceptance criteria are weak and synthesis did not produce a usable set. Re-run analyze (synthesis retries transient failures) or override explicitly to generate anyway.',
      });
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
      providerCandidates: configuredLlmProviders(config.llm.providers).map((provider) => provider.name),
      coverageEnforced,
      acceptanceCriteriaCount: body.context.acceptanceCriteria.length,
      scopeAuthorityType: body.context.scopeAuthority?.type || 'none',
      scopeType: body.context.constraints.scopeType,
      manualScopeOverride: generationContext.manualScopeOverride,
    });
    const generationStartedAt = Date.now();
    const primaryGenerationProvider = configuredLlmProviders(config.llm.providers)[0];
    const contextCache = cacheMetadata(body.context);
    let generation:
      | {
          provider: string;
          model: string;
          testCases: GeneratedTestCase[];
          stepTimings?: GenerationStepTiming[];
        }
      | null = null;
    if (
      primaryGenerationProvider &&
      contextCache.analysisSourceHash &&
      contextCache.finalizedAcHash &&
      contextCache.executionPlanHash &&
      typeof contextCache.apiContractHash === 'string'
    ) {
      const cached = await persistence.findCachedGeneratedRun({
        jiraKey: body.context.ticketKey,
        analysisSourceHash: contextCache.analysisSourceHash,
        finalizedAcHash: contextCache.finalizedAcHash,
        executionPlanHash: contextCache.executionPlanHash,
        apiContractHash: contextCache.apiContractHash,
        provider: primaryGenerationProvider.name,
        model: primaryGenerationProvider.model,
      });
      if (cached) {
        generation = {
          provider: cached.provider,
          model: cached.model,
          testCases: cached.testCases,
          stepTimings: [],
        };
        log.info('api.generate.cache_hit', {
          jiraKey: body.context.ticketKey,
          cachedFromGeneratedRunId: cached.generatedRunId,
          provider: cached.provider,
          model: cached.model,
          caseCount: cached.testCases.length,
        });
      } else {
        log.info('api.generate.cache_miss', {
          jiraKey: body.context.ticketKey,
          provider: primaryGenerationProvider.name,
          model: primaryGenerationProvider.model,
          finalizedAcHash: contextCache.finalizedAcHash,
          executionPlanHash: contextCache.executionPlanHash,
        });
      }
    }
    if (!generation) {
      generation = await generateTestCases(config.llm, generationContext, log);
    }
    const generationDurationMs = Date.now() - generationStartedAt;
    // Per-LLM-step timing breakdown (initial gen + each repair pass) so a slow run shows which pass burned
    // the time, not just the total. Especially important for multi-minute DeepSeek runs.
    log.info('api.generate.step_timings', {
      jiraKey: body.context.ticketKey,
      provider: generation.provider,
      model: generation.model,
      totalDurationMs: generationDurationMs,
      steps: generation.stepTimings || [],
    });
    const testCases = hydrateTestCasesWithEvidence(generation.testCases, body.context);
    const validation = validateCases(testCases, {
      jiraKey: body.context.ticketKey,
      epic: body.context.epic,
      feOnly: body.context.constraints && body.context.constraints.feOnly,
      scopeType: body.context.constraints?.scopeType,
      acceptanceCriteria: body.context.acceptanceCriteria,
      enforceAcceptanceCriteria: coverageEnforced,
      matchedEndpoints: body.context.apiContract?.matchedEndpoints,
      acceptanceCriteriaExecutionPlan: body.context.acceptanceCriteriaDiagnostics?.acceptanceCriteriaExecutionPlan,
      directRequirements: body.context.acceptanceCriteriaDiagnostics?.directRequirements,
    });
    const coverage = buildCoverage(testCases, body.context.acceptanceCriteria, {
      enforceAcceptanceCriteria: coverageEnforced,
      scopeType: body.context.constraints?.scopeType,
      acceptanceCriteriaExecutionPlan: body.context.acceptanceCriteriaDiagnostics?.acceptanceCriteriaExecutionPlan,
    });
    const qualityEvaluation = buildGenerationQualityEvaluation({
      provider: generation.provider,
      model: generation.model,
      context: body.context,
      testCases,
      validation,
      coverage,
      coverageEnforced,
      durationMs: generationDurationMs,
      stepTimings: generation.stepTimings || [],
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
          qualityEvaluation,
          durationMs: generationDurationMs,
          stepTimings: generation.stepTimings || [],
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
      durationMs: generationDurationMs,
      qualityGate: qualityEvaluation.qualityGate,
      weakCoverageClaims: qualityEvaluation.weakCoverageClaims,
      singlePolarityWarnings: qualityEvaluation.singlePolarityWarnings,
      broadCoverageWarnings: qualityEvaluation.broadCoverageWarnings,
      duplicateCaseWarnings: qualityEvaluation.duplicateCaseWarnings,
      endpointAlignmentWarnings: qualityEvaluation.endpointAlignmentWarnings,
      executionTypeMismatchWarnings: qualityEvaluation.executionTypeMismatchWarnings,
    });
    log.info('api.generate.quality_evaluation', { ...qualityEvaluation });
    await appendAudit({
      type: 'generate',
      user: session.user,
      jiraKey: body.context.ticketKey,
      caseCount: generation.testCases.length,
      provider: generation.provider,
      model: generation.model,
      coverageEnforced,
      durationMs: generationDurationMs,
      qualityGate: qualityEvaluation.qualityGate,
      weakCoverageClaims: qualityEvaluation.weakCoverageClaims,
      singlePolarityWarnings: qualityEvaluation.singlePolarityWarnings,
      broadCoverageWarnings: qualityEvaluation.broadCoverageWarnings,
      duplicateCaseWarnings: qualityEvaluation.duplicateCaseWarnings,
      endpointAlignmentWarnings: qualityEvaluation.endpointAlignmentWarnings,
      executionTypeMismatchWarnings: qualityEvaluation.executionTypeMismatchWarnings,
      qualityEvaluation,
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
      qualityEvaluation,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/validate') {
    const body = await readBody<ValidateRequest>(req);
    const testCases = body.context ? hydrateTestCasesWithEvidence(body.testCases || [], body.context) : body.testCases || [];
    const acceptanceCriteriaExecutionPlan =
      body.acceptanceCriteriaExecutionPlan || body.context?.acceptanceCriteriaDiagnostics?.acceptanceCriteriaExecutionPlan;
    const validation = validateCases(testCases, {
      jiraKey: body.jiraKey,
      epic: body.epic,
      feOnly: body.feOnly,
      scopeType: body.scopeType || body.context?.constraints.scopeType,
      allowNonMainRefs: body.allowNonMainRefs,
      acceptanceCriteria: body.acceptanceCriteria,
      enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
      matchedEndpoints: body.matchedEndpoints || body.context?.apiContract?.matchedEndpoints,
      acceptanceCriteriaExecutionPlan,
      directRequirements: body.context?.acceptanceCriteriaDiagnostics?.directRequirements,
    });
    sendJson(res, 200, {
      testCases,
      validation,
      coverage: buildCoverage(testCases, body.acceptanceCriteria, {
        enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
        scopeType: body.scopeType || body.context?.constraints.scopeType,
        acceptanceCriteriaExecutionPlan,
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

  // Preflight catches validation, coverage, and duplicate TestRail cases before the irreversible push.
  if (req.method === 'POST' && url.pathname === '/api/push/preflight') {
    const sessionEnvelope = await requireSession(req, res);
    if (!sessionEnvelope) return;
    const { session } = sessionEnvelope;
    if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
      sendError(res, 400, 'TestRail configuration is incomplete.');
      return;
    }
    const body = await readBody<PushPreflightRequest>(req);
    if (!body.approved) {
      sendError(res, 400, 'QA approval is required before checking TestRail duplicates.');
      return;
    }
    const sectionId = String(body.sectionId || '').trim();
    if (!sectionId) {
      sendError(res, 400, 'TestRail section ID is required.');
      return;
    }
    const testCases = body.testCases || [];
    const trustedSource = await loadTrustedPushSource(body, session.user, testCases);
    if (!trustedSource.ok) {
      sendError(res, trustedSource.status, trustedSource.message);
      return;
    }
    const trustedContext = trustedSource.context;
    const enforceAcceptanceCriteria = trustedSource.enforceAcceptanceCriteria;
    const trustedBlockedCaseIds = trustedContext
      ? clarificationBlockedCaseIds(trustedContext, trustedSource.testCases)
      : undefined;
    const pushSelection = resolvePushSelection(trustedContext, testCases, body.selectedCaseIds, trustedBlockedCaseIds);
    if (pushSelection.unknownCaseIds.length) {
      sendError(res, 400, `Selected case IDs are not part of this reviewed suite: ${pushSelection.unknownCaseIds.join(', ')}`);
      return;
    }
    const selectedBlockedCaseIds = pushSelection.selectedCases
      .map((testCase) => testCase.id)
      .filter((caseId) => pushSelection.blockedCaseIds.includes(caseId));
    if (selectedBlockedCaseIds.length) {
      sendJson(res, 400, {
        error: `Selected cases are blocked pending technical-spec clarification: ${selectedBlockedCaseIds.join(', ')}`,
        blockedCaseIds: selectedBlockedCaseIds,
      });
      return;
    }
    if (!pushSelection.selectedCases.length) {
      sendError(res, 400, 'No ready test cases are selected for TestRail preflight.');
      return;
    }
    const acceptanceCriteriaExecutionPlan =
      trustedContext?.acceptanceCriteriaDiagnostics?.acceptanceCriteriaExecutionPlan || body.acceptanceCriteriaExecutionPlan;
    const acceptanceCriteria = trustedContext?.acceptanceCriteria || body.acceptanceCriteria;
    const scopeType = trustedContext?.constraints.scopeType || body.scopeType;
    const validation = validateCases(pushSelection.selectedCases, {
      jiraKey: trustedContext?.ticketKey || body.jiraKey,
      epic: trustedContext?.epic || body.epic,
      feOnly: trustedContext?.constraints.feOnly ?? body.feOnly,
      scopeType,
      allowNonMainRefs: body.allowNonMainRefs,
      acceptanceCriteria,
      enforceAcceptanceCriteria,
      matchedEndpoints: trustedContext?.apiContract?.matchedEndpoints || body.matchedEndpoints,
      acceptanceCriteriaExecutionPlan,
      directRequirements: trustedContext?.acceptanceCriteriaDiagnostics?.directRequirements,
    });
    const invalid = validation.filter((item) => !item.valid);
    const coverage = buildCoverage(pushSelection.selectedCases, acceptanceCriteria, {
      enforceAcceptanceCriteria,
      scopeType,
      acceptanceCriteriaExecutionPlan,
    });
    // Only a genuine gap (an AC nothing even claims) hard-blocks. An AC whose sole claim was flagged
    // weak is overrideable via the weak-coverage acknowledgement below, not blocked here.
    const pushingEntireSuite = pushSelection.selectedCases.length === testCases.length;
    if (invalid.length || (pushingEntireSuite && coverage.enforced && trulyUncoveredCriteria(coverage).length)) {
      sendJson(res, 400, {
        error: invalid.length ? 'Validation failed.' : 'Acceptance criteria coverage is incomplete.',
        validation,
        coverage,
      });
      return;
    }
    // Weak coverage (claimed but unsubstantiated) is non-blocking at preflight — surfaced so the client
    // can obtain an explicit acknowledgement. The /api/push gate enforces it.
    const weakCoverage = coverage.unsubstantiatedClaims.length ? { claims: coverage.unsubstantiatedClaims } : undefined;
    // Single-polarity coverage (conditional AC tested in only one direction) — same acknowledge-to-override.
    const singlePolarity = coverage.singlePolarityCriteria.length ? { criteria: coverage.singlePolarityCriteria } : undefined;

    if (!config.testrail.projectId) {
      log.warn('api.push.preflight.skipped', {
        jiraKey: body.jiraKey,
        user: session.user,
        sectionId,
        reason: 'missing_testrail_project_id',
      });
      sendJson(res, 200, {
        duplicatesFound: false,
        duplicateLookupSkipped: {
          reason: 'TestRail project ID is not configured, so existing-case duplicate lookup was skipped.',
        },
        existingCases: [],
        recommendations: [],
        summary: {
          jiraKey: body.jiraKey,
          sectionId,
          existingCount: 0,
          generatedCount: pushSelection.selectedCases.length,
        },
        validation,
        coverage,
        weakCoverage,
        singlePolarity,
      });
      return;
    }

    const existingCases = await findExistingCasesByJiraRef(config.testrail, sectionId, body.jiraKey);
    const recommendations = existingCases.length
      ? await recommendDuplicateCases(config.llm, body.jiraKey, existingCases, pushSelection.selectedCases)
      : [];
    log.info('api.push.preflight.complete', {
      jiraKey: body.jiraKey,
      user: session.user,
      sectionId,
      existingCases: existingCases.length,
      generatedCases: pushSelection.selectedCases.length,
      unsubstantiatedClaims: coverage.unsubstantiatedClaims.length,
      singlePolarityCriteria: coverage.singlePolarityCriteria.length,
    });
    sendJson(res, 200, {
      duplicatesFound: existingCases.length > 0,
      existingCases,
      recommendations,
      summary: {
        jiraKey: body.jiraKey,
        sectionId,
        existingCount: existingCases.length,
        generatedCount: pushSelection.selectedCases.length,
      },
      validation,
      coverage,
      weakCoverage,
      singlePolarity,
    });
    return;
  }

  // Push repeats the same validation gates as preflight because callers can invoke this route directly.
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
    const allTestCases = body.testCases || [];
    const trustedSource = await loadTrustedPushSource(body, session.user, allTestCases);
    if (!trustedSource.ok) {
      sendError(res, trustedSource.status, trustedSource.message);
      return;
    }
    const trustedContext = trustedSource.context;
    const enforceAcceptanceCriteria = trustedSource.enforceAcceptanceCriteria;
    const trustedBlockedCaseIds = trustedContext
      ? clarificationBlockedCaseIds(trustedContext, trustedSource.testCases)
      : undefined;
    const pushSelection = resolvePushSelection(trustedContext, allTestCases, body.selectedCaseIds, trustedBlockedCaseIds);
    if (pushSelection.unknownCaseIds.length) {
      sendError(res, 400, `Selected case IDs are not part of this reviewed suite: ${pushSelection.unknownCaseIds.join(', ')}`);
      return;
    }
    const selectedBlockedCaseIds = pushSelection.selectedCases
      .map((testCase) => testCase.id)
      .filter((caseId) => pushSelection.blockedCaseIds.includes(caseId));
    if (selectedBlockedCaseIds.length) {
      log.warn('api.push.clarification_blocked', { jiraKey: body.jiraKey, user: session.user, blockedCaseIds: selectedBlockedCaseIds });
      sendJson(res, 400, {
        error: `Selected cases are blocked pending technical-spec clarification: ${selectedBlockedCaseIds.join(', ')}`,
        blockedCaseIds: selectedBlockedCaseIds,
      });
      return;
    }
    if (!pushSelection.selectedCases.length) {
      sendError(res, 400, 'No ready test cases are selected for TestRail push.');
      return;
    }
    const acceptanceCriteriaExecutionPlan =
      trustedContext?.acceptanceCriteriaDiagnostics?.acceptanceCriteriaExecutionPlan || body.acceptanceCriteriaExecutionPlan;
    const acceptanceCriteria = trustedContext?.acceptanceCriteria || body.acceptanceCriteria;
    const scopeType = trustedContext?.constraints.scopeType || body.scopeType;
    const validation = validateCases(pushSelection.selectedCases, {
      jiraKey: trustedContext?.ticketKey || body.jiraKey,
      epic: trustedContext?.epic || body.epic,
      feOnly: trustedContext?.constraints.feOnly ?? body.feOnly,
      scopeType,
      allowNonMainRefs: body.allowNonMainRefs,
      acceptanceCriteria,
      enforceAcceptanceCriteria,
      matchedEndpoints: trustedContext?.apiContract?.matchedEndpoints || body.matchedEndpoints,
      acceptanceCriteriaExecutionPlan,
      directRequirements: trustedContext?.acceptanceCriteriaDiagnostics?.directRequirements,
    });
    const invalid = validation.filter((item) => !item.valid);
    const coverage = buildCoverage(pushSelection.selectedCases, acceptanceCriteria, {
      enforceAcceptanceCriteria,
      scopeType,
      acceptanceCriteriaExecutionPlan,
    });
    // Genuine gaps hard-block; weak-only-claimed ACs fall through to the acknowledgement gate below.
    const pushingEntireSuite = pushSelection.selectedCases.length === allTestCases.length;
    if (invalid.length || (pushingEntireSuite && coverage.enforced && trulyUncoveredCriteria(coverage).length)) {
      sendJson(res, 400, {
        error: invalid.length ? 'Validation failed.' : 'Acceptance criteria coverage is incomplete.',
        validation,
        coverage,
      });
      return;
    }
    // Acknowledge-to-override: a case claiming an AC its steps don't substantiate must not silently
    // ship as green. Block unless the reviewer explicitly acknowledged the weak coverage.
    if (coverage.enforced && coverage.unsubstantiatedClaims.length && !body.weakCoverageAcknowledged) {
      log.warn('api.push.weak_coverage_blocked', {
        jiraKey: body.jiraKey,
        user: session.user,
        unsubstantiatedClaims: coverage.unsubstantiatedClaims.length,
      });
      sendJson(res, 400, {
        error: 'Some acceptance criteria are claimed but not substantiated by the case steps. Acknowledge weak coverage to proceed.',
        requiresWeakCoverageAck: true,
        validation,
        coverage,
      });
      return;
    }
    // Acknowledge-to-override: a conditional AC tested in only one direction (e.g. the disabled state but
    // never the enabled state) reads as green while a real branch is untested. Block unless acknowledged.
    if (coverage.enforced && coverage.singlePolarityCriteria.length && !body.singlePolarityAcknowledged) {
      log.warn('api.push.single_polarity_blocked', {
        jiraKey: body.jiraKey,
        user: session.user,
        singlePolarityCriteria: coverage.singlePolarityCriteria.length,
      });
      sendJson(res, 400, {
        error: 'Some conditional acceptance criteria are tested in only one direction (e.g. the disabled state but not the enabled state). Acknowledge single-polarity coverage to proceed.',
        requiresSinglePolarityAck: true,
        validation,
        coverage,
      });
      return;
    }
    // Acknowledge-to-override: a synthesized criterion that contradicts a source line (F1, detected at
    // analyze and carried on the context) must not ship unflagged. Independent of coverage enforcement —
    // a requirement contradiction is worth a human's eyes regardless.
    const crossSourceConflicts =
      trustedContext?.acceptanceCriteriaDiagnostics?.crossSourceConflicts || body.crossSourceConflicts || [];
    if (crossSourceConflicts.length && !body.crossSourceConflictsAcknowledged) {
      log.warn('api.push.cross_source_conflicts_blocked', {
        jiraKey: body.jiraKey,
        user: session.user,
        conflicts: crossSourceConflicts.length,
      });
      sendJson(res, 400, {
        error: 'Some acceptance criteria contradict the source documents (Jira/PRD/spec). Acknowledge the cross-source conflicts to proceed.',
        requiresCrossSourceConflictAck: true,
        validation,
        coverage,
      });
      return;
    }
    // Backup quality-gate guard: even if the UI is bypassed or stale cases are submitted directly, a run
    // with unresolved quality problems must not silently reach TestRail. Recompute the gate here (needs the
    // analyzed context for AC diagnostics) and block on the RESIDUAL issues the earlier push gates do not
    // already cover — invalid/uncovered are hard-blocked above, and weak-coverage/single-polarity/cross-
    // source are acknowledge-gated above, so enforcing the whole qualityGate here would double-block those.
    // The residue is: not-production-ready (noisy/unsynthesized ACs), broad coverage over the limit, and
    // endpoint-alignment / duplicate / tiny-suite warnings. Overridable with an explicit acknowledgement.
    if (trustedContext) {
      const pushQualityEvaluation = buildGenerationQualityEvaluation({
        provider: 'push',
        model: 'push',
        context: trustedContext,
        testCases: allTestCases,
        validation: validateCases(allTestCases, {
          jiraKey: trustedContext.ticketKey,
          epic: trustedContext.epic,
          feOnly: trustedContext.constraints.feOnly,
          scopeType: trustedContext.constraints.scopeType,
          allowNonMainRefs: body.allowNonMainRefs,
          acceptanceCriteria,
          enforceAcceptanceCriteria,
          matchedEndpoints: trustedContext.apiContract?.matchedEndpoints,
          acceptanceCriteriaExecutionPlan,
          directRequirements: trustedContext.acceptanceCriteriaDiagnostics?.directRequirements,
        }),
        coverage: buildCoverage(allTestCases, acceptanceCriteria, {
          enforceAcceptanceCriteria,
          scopeType: trustedContext.constraints.scopeType,
          acceptanceCriteriaExecutionPlan,
        }),
        coverageEnforced: enforceAcceptanceCriteria,
        durationMs: 0,
      });
      const residualQualityIssues =
        pushQualityEvaluation.noisyRawAcceptanceCriteria ||
        pushQualityEvaluation.broadCoverageWarnings > pushQualityEvaluation.broadCoverageWarningLimit ||
        pushQualityEvaluation.endpointAlignmentWarnings > 0 ||
        pushQualityEvaluation.duplicateCaseWarnings > 0 ||
        pushQualityEvaluation.tinyBroadSuite;
      if (residualQualityIssues && !body.qualityGateAcknowledged) {
        log.warn('api.push.quality_gate_blocked', {
          jiraKey: body.jiraKey,
          user: session.user,
          qualityGate: pushQualityEvaluation.qualityGate,
          noisyRawAcceptanceCriteria: pushQualityEvaluation.noisyRawAcceptanceCriteria,
          broadCoverageWarnings: pushQualityEvaluation.broadCoverageWarnings,
          endpointAlignmentWarnings: pushQualityEvaluation.endpointAlignmentWarnings,
          duplicateCaseWarnings: pushQualityEvaluation.duplicateCaseWarnings,
          tinyBroadSuite: pushQualityEvaluation.tinyBroadSuite,
        });
        sendJson(res, 400, {
          error:
            'This run has unresolved quality issues (e.g. weak/unsynthesized acceptance criteria, broad or duplicate cases), so it is not safe to push. Acknowledge to proceed anyway.',
          requiresQualityGateAck: true,
          qualityEvaluation: pushQualityEvaluation,
          validation,
          coverage,
        });
        return;
      }
      if (residualQualityIssues) {
        log.warn('api.push.quality_gate_overridden', {
          jiraKey: body.jiraKey,
          user: session.user,
          reason: body.qualityGateAcknowledgedReason || '',
        });
      }
    }
    const trConfig = await resolveTestrailConfig(session);
    const results = await pushCases(trConfig, sectionId, pushSelection.selectedCases);
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
    const canonicalUrl = canonicalAuthStartUrl(req);
    if (canonicalUrl) {
      res.writeHead(302, { Location: canonicalUrl });
      res.end();
      return;
    }
    if (!config.atlassian.clientId || !config.atlassian.clientSecret) {
      sendError(res, 400, 'Atlassian OAuth is not configured.');
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(24).toString('base64url');
    await persistence.storeOAuthState(state, Date.now(), hashOAuthVerifier(verifier));
    log.info('auth.atlassian.start');
    res.writeHead(302, { Location: buildAuthUrl(config.atlassian, state), 'Set-Cookie': buildOAuthVerifierCookie(verifier) });
    res.end();
    return;
  }

  // Callback must prove both the server-side state and the browser-bound verifier cookie.
  if (url.pathname === '/auth/atlassian/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const verifier = getOAuthVerifier(req);
    if (!state || !code || !verifier || !(await persistence.consumeOAuthState(state, hashOAuthVerifier(verifier)))) {
      res.setHeader('Set-Cookie', clearOAuthVerifierCookie());
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
    let profile: Awaited<ReturnType<typeof getCurrentUserProfile>> | null = null;
    try {
      profile = await getCurrentUserProfile(token.access_token);
    } catch (error) {
      log.warn('auth.atlassian.profile_unavailable', errorDetails(error));
    }
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
      user: profile?.displayName || resource.name || resource.url || resource.id,
      accountId: profile?.accountId || null,
      displayName: profile?.displayName || null,
      personalDataRetrievedAt: profile ? Date.now() : null,
      createdAt: Date.now(),
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    };
    await persistence.setSession(sid, sessionRecord);
    log.info('auth.atlassian.complete', {
      cloudId: resource.id,
      user: profile?.displayName || resource.name || resource.url || resource.id,
      accountId: profile?.accountId || null,
    });
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': [buildSessionCookie(sid), clearOAuthVerifierCookie()],
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
  startPrivacyReportingLoop({
    persistence,
    atlassianConfig: config.atlassian,
    logger,
    enabled: Boolean(process.env.PRIVACY_REPORTING_ENABLED !== 'false'),
    intervalMs: Number(process.env.PRIVACY_REPORTING_INTERVAL_MS || 6 * 60 * 60 * 1000),
  });
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
  if (!configuredLlmProviders(config.llm.providers).length) {
    logger.warn('startup.config.llm_missing');
  }
  if (!config.testrail.baseUrl || !config.testrail.user || !config.testrail.apiKey) {
    logger.warn('startup.config.testrail_missing');
  }
  const hosted = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.NODE_ENV === 'production');
  if (hosted && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for hosted Phase 2 deployments.');
  }
  if (hosted && !encryptionAvailable()) {
    logger.warn('startup.config.encryption_key_missing');
  }
  const weakKeyReason = assessEncryptionKeyStrength();
  if (weakKeyReason) {
    logger.warn('startup.config.encryption_key_weak', { reason: weakKeyReason });
  }
}

// Workflow history is intentionally team-visible. Keep this helper explicit so
// future contributors do not mistake the global history query for an auth bug.
function historyVisibility(): 'team' {
  const configured = String(process.env.QA_HISTORY_VISIBILITY || 'team').trim().toLowerCase();
  if (configured !== 'team') {
    logger.warn('startup.config.history_visibility_unsupported', { configured, effective: 'team' });
  }
  return 'team';
}
