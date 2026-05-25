const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { AtlassianClient, buildAuthUrl, exchangeCode, getAccessibleResources } = require('./atlassian');
const { buildQaContext } = require('./context-builder');
const { generateTestCases } = require('./llm');
const { pushCases } = require('./testrail');
const { buildCoverage, validateCases } = require('./validation');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || process.env.QA_AGENT_PORT || 5174);
const DEFAULT_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;
const APP_BASE_URL = process.env.QA_AGENT_BASE_URL || DEFAULT_BASE_URL;
const IS_HTTPS = APP_BASE_URL.startsWith('https://');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIT_FILE = path.join(__dirname, 'audit-log.jsonl');
const sessions = new Map();
const oauthStates = new Map();

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

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function buildSessionCookie(value, maxAge) {
  const parts = [`qa_sid=${encodeURIComponent(value || '')}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  if (IS_HTTPS) parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(req) {
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

function getSession(req) {
  const sid = parseCookies(req).qa_sid;
  return sid ? sessions.get(sid) : null;
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    sendError(res, 401, 'Atlassian login required.');
    return null;
  }
  return session;
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function serveStatic(req, res) {
  const url = new URL(req.url, APP_BASE_URL);
  const filePath = url.pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch (error) {
    sendError(res, 404, 'Not found');
  }
}

function createClient(session) {
  return new AtlassianClient({ accessToken: session.accessToken, cloudId: session.cloudId });
}

function shouldEnforceAcceptanceCriteria(context, confidencePermissionApproved) {
  if (!context) return false;
  if (context.requiresConfidencePermission && confidencePermissionApproved) return false;
  return context.confidenceLevel === 'high' && Array.isArray(context.acceptanceCriteria) && context.acceptanceCriteria.length > 0;
}

async function appendAudit(event) {
  await fs.appendFile(AUDIT_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}

async function handleApi(req, res) {
  const url = new URL(req.url, APP_BASE_URL);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const session = getSession(req);
    sendJson(res, 200, {
      authenticated: Boolean(session),
      user: session && session.user,
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
    });
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
    const body = await readBody(req);
    const jiraKey = String(body.jiraKey || '').trim().toUpperCase();
    if (!jiraKey) {
      sendError(res, 400, 'Jira key is required.');
      return;
    }
    const context = await buildQaContext(createClient(session), jiraKey, {
      feOnly: body.feOnly !== false,
      beAlreadyTested: Boolean(body.beAlreadyTested),
      includeComments: body.includeComments !== false,
      notes: body.notes || '',
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
    const body = await readBody(req);
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
    const generation = await generateTestCases(config.llm, generationContext);
    const validation = validateCases(generation.testCases, {
      jiraKey: body.context.ticketKey,
      epic: body.context.epic,
      feOnly: body.context.constraints && body.context.constraints.feOnly,
      acceptanceCriteria: body.context.acceptanceCriteria,
      enforceAcceptanceCriteria: coverageEnforced,
    });
    const coverage = buildCoverage(generation.testCases, body.context.acceptanceCriteria, {
      enforceAcceptanceCriteria: coverageEnforced,
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
      testCases: generation.testCases,
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
    const body = await readBody(req);
    const validation = validateCases(body.testCases || [], {
      jiraKey: body.jiraKey,
      epic: body.epic,
      feOnly: body.feOnly,
      allowNonMainRefs: body.allowNonMainRefs,
      acceptanceCriteria: body.acceptanceCriteria,
      enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
    });
    sendJson(res, 200, {
      validation,
      coverage: buildCoverage(body.testCases || [], body.acceptanceCriteria, {
        enforceAcceptanceCriteria: body.enforceAcceptanceCriteria !== false,
      }),
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
    const body = await readBody(req);
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

function summarizeResults(results) {
  return {
    pushed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    total: results.length,
  };
}

async function handleAuth(req, res) {
  const url = new URL(req.url, APP_BASE_URL);
  if (url.pathname === '/auth/atlassian') {
    if (!config.atlassian.clientId || !config.atlassian.clientSecret) {
      sendError(res, 400, 'Atlassian OAuth is not configured.');
      return;
    }
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now());
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
      user: resource.name || resource.url,
      createdAt: Date.now(),
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
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    if (req.url.startsWith('/auth/')) {
      await handleAuth(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`QA Agent Web App running at ${APP_BASE_URL} on 0.0.0.0:${PORT}`);
});

async function loadEnv(envPath) {
  try {
    const content = require('fs').readFileSync(envPath, 'utf8');
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
    if (error.code !== 'ENOENT') throw error;
  }
}
