import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AtlassianClient, buildAuthUrl, exchangeCode, getAccessibleResources } from './services/atlassian';
import { buildQaContext } from './services/context-builder';
import { generateTestCases } from './services/llm';
import { pushCases } from './services/testrail';
import { buildCoverage, validateCases } from './services/validation';
import { hydrateTestCasesWithEvidence } from './services/evidence';
import { logger } from './services/logger';
import type { AnalyzeRequest, ConfigResponse, GenerateRequest, PushRequest, QaContext, ValidateRequest } from '../shared/contracts';

const PORT = Number(process.env.PORT || process.env.QA_AGENT_PORT || 5174);
const DEFAULT_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`;
const APP_BASE_URL = process.env.QA_AGENT_BASE_URL || DEFAULT_BASE_URL;
const IS_HTTPS = APP_BASE_URL.startsWith('https://');
const PROJECT_ROOT = process.cwd();
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'client-dist');
const AUDIT_FILE = path.join(PROJECT_ROOT, 'audit-log.jsonl');
const sessions = new Map<string, { accessToken: string; refreshToken?: string; cloudId: string; user: string; createdAt: number }>();
const oauthStates = new Map<string, number>();

loadEnv(path.join(PROJECT_ROOT, '.env'));

const config = {
  atlassian: {
    clientId: process.env.ATLASSIAN_CLIENT_ID || '',
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET || '',
    redirectUri: process.env.ATLASSIAN_REDIRECT_URI || `${APP_BASE_URL}/auth/atlassian/callback`,
    scopes:
      process.env.ATLASSIAN_SCOPES ||
      'read:jira-work read:confluence-content.all read:confluence-space.summary offline_access',
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

function getSession(req: IncomingMessage) {
  const sid = parseCookies(req).qa_sid;
  return sid ? sessions.get(sid) : null;
}

function requireSession(req: IncomingMessage, res: ServerResponse) {
  const session = getSession(req);
  if (!session) {
    sendError(res, 401, 'Atlassian login required.');
    return null;
  }
  return session;
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

function createClient(session: NonNullable<ReturnType<typeof getSession>>): AtlassianClient {
  return new AtlassianClient({ accessToken: session.accessToken, cloudId: session.cloudId });
}

function shouldEnforceAcceptanceCriteria(context: QaContext | null, confidencePermissionApproved: boolean): boolean {
  if (!context) return false;
  if (context.requiresConfidencePermission && confidencePermissionApproved) return false;
  return context.confidenceLevel === 'high' && Array.isArray(context.acceptanceCriteria) && context.acceptanceCriteria.length > 0;
}

async function appendAudit(event: Record<string, unknown>): Promise<void> {
  await fsPromises.appendFile(AUDIT_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, log = logger): Promise<void> {
  const url = new URL(req.url || '/', APP_BASE_URL);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const session = getSession(req);
    const body: ConfigResponse = {
      authenticated: Boolean(session),
      user: session?.user || null,
      ready: {
        atlassian: Boolean(config.atlassian.clientId && config.atlassian.clientSecret),
        llm: config.llm.providers.some((provider) => Boolean(provider.apiKey)),
        testrail: Boolean(config.testrail.baseUrl && config.testrail.user && config.testrail.apiKey),
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

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const sid = parseCookies(req).qa_sid;
    if (sid) sessions.delete(sid);
    res.writeHead(204, { 'Set-Cookie': buildSessionCookie('', 0) });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    const session = requireSession(req, res);
    if (!session) return;
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
    const context = await buildQaContext(createClient(session), jiraKey, {
      feOnly: body.feOnly !== false,
      beAlreadyTested: Boolean(body.beAlreadyTested),
      includeComments: body.includeComments !== false,
      notes: body.notes || '',
      logger: log,
    });
    log.info('api.analyze.complete', {
      jiraKey,
      user: session.user,
      acceptanceCriteriaSource: context.acceptanceCriteriaSource,
      acceptanceCriteriaCount: context.acceptanceCriteria.length,
      userStoryCount: context.userStories.length,
      confidenceLevel: context.confidenceLevel,
    });
    await appendAudit({ type: 'analyze', user: session.user, jiraKey, linkedIssueCount: context.linkedIssues.length });
    sendJson(res, 200, { context });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const session = requireSession(req, res);
    if (!session) return;
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
    log.info('api.generate.complete', {
      jiraKey: body.context.ticketKey,
      user: session.user,
      provider: generation.provider,
      model: generation.model,
      generatedCaseCount: generation.testCases.length,
      hydratedCaseCount: testCases.length,
      coverageEnforced,
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
      testCases,
      validation,
      coverage,
      coverageEnforced,
      manualScopeOverride: generationContext.manualScopeOverride,
      provider: generation.provider,
      model: generation.model,
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
    const session = requireSession(req, res);
    if (!session) return;
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
    log.info('api.push.complete', {
      jiraKey: body.jiraKey,
      user: session.user,
      sectionId,
      pushed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
    });
    await appendAudit({
      type: 'push',
      user: session.user,
      jiraKey: body.jiraKey,
      sectionId,
      results,
    });
    sendJson(res, 200, { results, summary: summarizeResults(results) });
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
    oauthStates.set(state, Date.now());
    log.info('auth.atlassian.start');
    res.writeHead(302, { Location: buildAuthUrl(config.atlassian, state) });
    res.end();
    return;
  }

  if (url.pathname === '/auth/atlassian/callback') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !oauthStates.has(state) || !code) {
      sendError(res, 400, 'Invalid OAuth callback.');
      return;
    }
    oauthStates.delete(state);
    const token = await exchangeCode(config.atlassian, code);
    const resources = await getAccessibleResources(token.access_token);
    const resource = resources[0];
    if (!resource) {
      sendError(res, 400, 'No Atlassian cloud resource is available for this account.');
      return;
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      cloudId: resource.id,
      user: resource.name || resource.url || resource.id,
      createdAt: Date.now(),
    });
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
    log.info('http.request.complete', {
      statusCode,
      durationMs: Date.now() - startedAt,
    });
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

server.listen(PORT, '0.0.0.0', () => {
  logger.info('server.start', {
    appBaseUrl: APP_BASE_URL,
    host: '0.0.0.0',
    port: PORT,
    logLevel: process.env.LOG_LEVEL || 'info',
  });
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
