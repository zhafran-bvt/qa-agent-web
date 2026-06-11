import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ExistingTestRailCase, GeneratedTestCase, PushCaseResult } from '../../shared/contracts';
import { requestHttpsJson, requestHttpsRawJson, requestHttpsStream } from './http';

export interface TestRailConfig {
  baseUrl: string;
  user: string;
  apiKey: string;
  projectId?: string;
  suiteId?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TestRail `add_case` body for a generated BDD case. Shared by push + manage. */
export function buildGeneratedCaseBody(testCase: GeneratedTestCase): Record<string, unknown> {
  const bddScenario = enrichBddScenario(testCase);
  return {
    title: testCase.title,
    template_id: 4,
    type_id: mapType(testCase.type),
    priority_id: 2,
    refs: testCase.jiraReference,
    custom_preconds: testCase.preconditions,
    custom_testrail_bdd_scenario: [{ content: bddScenario }],
  };
}

function enrichBddScenario(testCase: GeneratedTestCase): string {
  const sections = [String(testCase.bddScenario || '').trim()];
  if (testCase.apiSpec) {
    const lines = [
      '',
      'API Spec:',
      `${testCase.apiSpec.method || ''} ${testCase.apiSpec.path || ''}`.trim(),
      testCase.apiSpec.samplePayload ? `Sample Payload:\n${testCase.apiSpec.samplePayload}` : '',
      testCase.apiSpec.expectedResponse ? `Expected Response:\n${testCase.apiSpec.expectedResponse}` : '',
      testCase.apiSpec.assertions?.length ? `Assertions:\n${testCase.apiSpec.assertions.map((item) => `- ${item}`).join('\n')}` : '',
    ].filter(Boolean);
    sections.push(lines.join('\n'));
  }
  if (testCase.manualVerification) {
    const lines = [
      '',
      'Manual Verification:',
      testCase.manualVerification.target ? `Target: ${testCase.manualVerification.target}` : '',
      testCase.manualVerification.steps?.length ? `Steps:\n${testCase.manualVerification.steps.map((item) => `- ${item}`).join('\n')}` : '',
      testCase.manualVerification.expectedResult ? `Expected Result: ${testCase.manualVerification.expectedResult}` : '',
    ].filter(Boolean);
    sections.push(lines.join('\n'));
  }
  return sections.filter(Boolean).join('\n');
}

function authHeader(config: TestRailConfig): string {
  return `Basic ${Buffer.from(`${config.user}:${config.apiKey}`).toString('base64')}`;
}

export function normalizeRefTokens(refs: string): string[] {
  return String(refs || '')
    .split(/[\s,;|/]+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
}

export function hasExactJiraRef(refs: string, jiraKey: string): boolean {
  const normalizedJiraKey = String(jiraKey || '').trim().toUpperCase();
  return normalizeRefTokens(refs).includes(normalizedJiraKey);
}

/** The api/v2-relative path for a refs-filtered case lookup. Single source of truth so the full URL
 *  (buildGetCasesUrl) and the rate-limited trFetch path can't drift apart. */
export function buildGetCasesPath(projectId: string, sectionId: string, jiraKey: string): string {
  const params = new URLSearchParams({
    section_id: sectionId,
    refs: jiraKey,
  });
  return `get_cases/${encodeURIComponent(projectId)}&${params.toString()}`;
}

export function buildGetCasesUrl(config: TestRailConfig, projectId: string, sectionId: string, jiraKey: string): string {
  return trUrl(config, buildGetCasesPath(projectId, sectionId, jiraKey));
}

function extractBddScenario(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (item && typeof item === 'object' && 'content' in item) return String((item as { content?: unknown }).content || '').trim();
        return String(item || '').trim();
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(raw || '').trim();
}

function mapExistingCase(config: TestRailConfig, rawCase: Record<string, unknown>): ExistingTestRailCase {
  const caseId = (rawCase.id || rawCase.case_id || '') as number | string;
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  return {
    caseId,
    title: String(rawCase.title || ''),
    refs: String(rawCase.refs || ''),
    typeId: (rawCase.type_id || rawCase.typeId || undefined) as number | string | undefined,
    preconditions: String(rawCase.custom_preconds || rawCase.preconditions || '').trim(),
    bddScenario: extractBddScenario(rawCase.custom_testrail_bdd_scenario || rawCase.bddScenario || rawCase.bdd_scenario),
    webUrl: caseId ? `${baseUrl}/index.php?/cases/view/${caseId}` : undefined,
  };
}

function parseCasesResponse(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.cases)) return record.cases as Record<string, unknown>[];
  }
  return [];
}

export async function findExistingCasesByJiraRef(
  config: TestRailConfig,
  sectionId: string,
  jiraKey: string
): Promise<ExistingTestRailCase[]> {
  // TestRail refs filtering is not trusted alone; re-check exact Jira tokens after parsing the response.
  const projectId = String(config.projectId || '').trim();
  if (!projectId) throw new Error('TestRail project ID is required for duplicate lookup.');

  // Route through trFetch so this preflight lookup shares the rolling-window rate limiter and 429
  // retry like every other read — a direct request here would bypass both and risk tripping the cap.
  const response = await trFetch(config, { method: 'GET', path: buildGetCasesPath(projectId, sectionId, jiraKey) });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const parsed = response.body as Record<string, unknown>;
    throw new Error(String(parsed?.error || `HTTP ${response.statusCode}`));
  }

  return parseCasesResponse(response.body)
    .map((rawCase) => mapExistingCase(config, rawCase))
    .filter((testCase) => hasExactJiraRef(testCase.refs, jiraKey));
}

// ---------------------------------------------------------------------------
// Read API (dashboard) — mirrors the Python client's get_* helpers.
// ---------------------------------------------------------------------------

const TR_PAGE_LIMIT = 250;

function trTimeout(): number {
  return Number(process.env.TESTRAIL_HTTP_TIMEOUT_MS || process.env.UPSTREAM_HTTP_TIMEOUT_MS || 20_000);
}

function trUrl(config: TestRailConfig, path: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}/index.php?/api/v2/${path}`;
}

// --- Rate limiting + 429 retry -------------------------------------------
// TestRail caps requests (e.g. 180/min). Stay under a configurable ceiling with a
// rolling-window limiter, and on a 429 honour Retry-After (header or body message)
// before retrying with exponential-backoff fallback.
const TR_MAX_RPM = Number(process.env.TESTRAIL_MAX_RPM || 150);
const TR_MAX_RETRIES = Number(process.env.TESTRAIL_MAX_RETRIES || 4);
const RATE_WINDOW_MS = 60_000;
const recentRequests: number[] = [];
let rateGate: Promise<void> = Promise.resolve();

function acquireRateSlot(): Promise<void> {
  rateGate = rateGate.then(async () => {
    const now = Date.now();
    while (recentRequests.length && recentRequests[0] <= now - RATE_WINDOW_MS) recentRequests.shift();
    if (recentRequests.length >= TR_MAX_RPM) {
      const waitMs = recentRequests[0] + RATE_WINDOW_MS - now + 50;
      if (waitMs > 0) await delay(waitMs);
    }
    recentRequests.push(Date.now());
  });
  return rateGate;
}

export function retryAfterMs(headers: Record<string, string | string[] | undefined>, body: unknown): number {
  const header = headers['retry-after'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const fromHeader = headerValue ? Number(headerValue) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.min(fromHeader, 60) * 1000;
  const message = body && typeof body === 'object' ? String((body as Record<string, unknown>).error || '') : '';
  const match = message.match(/retry after (\d+)/i);
  return match ? Math.min(Number(match[1]), 60) * 1000 : 0;
}

async function trFetch(
  config: TestRailConfig,
  opts: { method: string; path: string; body?: unknown }
): Promise<{ body: unknown; headers: Record<string, string | string[] | undefined>; statusCode: number }> {
  let last: { body: unknown; headers: Record<string, string | string[] | undefined>; statusCode: number } | null = null;
  for (let attempt = 0; attempt <= TR_MAX_RETRIES; attempt += 1) {
    await acquireRateSlot();
    const response = await requestHttpsJson<unknown>({
      url: trUrl(config, opts.path),
      method: opts.method,
      headers: { Authorization: authHeader(config) },
      body: opts.body,
      upstream: 'TestRail',
      timeoutMs: trTimeout(),
    });
    if (response.statusCode !== 429) return response;
    last = response;
    if (attempt < TR_MAX_RETRIES) {
      const waitMs = retryAfterMs(response.headers, response.body) || Math.min(1000 * 2 ** attempt, 30_000);
      await delay(waitMs);
    }
  }
  return last as { body: unknown; headers: Record<string, string | string[] | undefined>; statusCode: number };
}

async function trGet<T = unknown>(config: TestRailConfig, path: string): Promise<T> {
  const response = await trFetch(config, { method: 'GET', path });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const parsed = (response.body || {}) as Record<string, unknown>;
    throw new Error(String(parsed.error || `HTTP ${response.statusCode}`));
  }
  return response.body as T;
}

/** Tolerant list extraction — TestRail returns either a bare array or `{ <key>: [] }`. */
function parseList(body: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

/** Fetch a paginated bulk endpoint, looping limit/offset until the page is short. */
async function trGetPaginated(
  config: TestRailConfig,
  pathBase: string,
  key: string
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  // hard stop guards against a misbehaving endpoint that never shortens
  for (let page = 0; page < 200; page++) {
    const path = `${pathBase}&limit=${TR_PAGE_LIMIT}&offset=${offset}`;
    const batch = parseList(await trGet(config, path), key);
    out.push(...batch);
    if (batch.length < TR_PAGE_LIMIT) break;
    offset += TR_PAGE_LIMIT;
  }
  return out;
}

function requireProjectId(config: TestRailConfig, override?: string): string {
  const projectId = String(override || config.projectId || '').trim();
  if (!projectId) throw new Error('TestRail project ID is required (set TESTRAIL_PROJECT_ID).');
  return projectId;
}

export function getPlans(config: TestRailConfig, projectId?: string): Promise<Record<string, unknown>[]> {
  return trGetPaginated(config, `get_plans/${requireProjectId(config, projectId)}`, 'plans');
}

export function getPlan(config: TestRailConfig, planId: number | string): Promise<Record<string, unknown>> {
  return trGet<Record<string, unknown>>(config, `get_plan/${encodeURIComponent(String(planId))}`);
}

export function getTests(config: TestRailConfig, runId: number | string): Promise<Record<string, unknown>[]> {
  return trGetPaginated(config, `get_tests/${encodeURIComponent(String(runId))}`, 'tests');
}

export function getResults(config: TestRailConfig, testId: number | string): Promise<Record<string, unknown>[]> {
  return trGetPaginated(config, `get_results/${encodeURIComponent(String(testId))}`, 'results');
}

/** All results for a run in one paginated call — far fewer requests than per-test get_results. */
export function getResultsForRun(config: TestRailConfig, runId: number | string): Promise<Record<string, unknown>[]> {
  return trGetPaginated(config, `get_results_for_run/${encodeURIComponent(String(runId))}`, 'results');
}

export function getAttachmentsForTest(config: TestRailConfig, testId: number | string): Promise<Record<string, unknown>[]> {
  return trGetPaginated(config, `get_attachments_for_test/${encodeURIComponent(String(testId))}`, 'attachments');
}

// TestRail returns attachments as application/octet-stream, so we infer a useful Content-Type from
// the filename — without it the browser won't play a .mov inline or render an image.
const MIME_BY_EXT: Record<string, string> = {
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  ogv: 'video/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export function guessAttachmentMime(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name || '');
  return match ? MIME_BY_EXT[match[1].toLowerCase()] || '' : '';
}

/** Stream a single attachment's bytes from TestRail (auth stays server-side). Caller pipes to client. */
export async function fetchAttachment(
  config: TestRailConfig,
  attachmentId: number | string
): Promise<{ stream: IncomingMessage; statusCode: number; headers: Record<string, string | string[] | undefined> }> {
  await acquireRateSlot();
  return requestHttpsStream({
    url: trUrl(config, `get_attachment/${encodeURIComponent(String(attachmentId))}`),
    method: 'GET',
    headers: { Authorization: authHeader(config) },
    upstream: 'TestRail',
    timeoutMs: trTimeout(),
  });
}

// Strip CR/LF and quotes so a filename can't break out of the Content-Disposition header.
export function sanitizeAttachmentName(name: string): string {
  return String(name || 'evidence')
    .replace(/[\r\n"]/g, '')
    .replace(/[\\/]/g, '_')
    .slice(0, 250)
    .trim() || 'evidence';
}

export function buildAttachmentMultipart(file: { buffer: Buffer; filename: string; contentType: string }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----qaAgentEvidence${crypto.randomBytes(16).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="attachment"; filename="${sanitizeAttachmentName(file.filename)}"\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, file.buffer, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function postAttachment(
  config: TestRailConfig,
  endpoint: string,
  file: { buffer: Buffer; filename: string; contentType: string }
): Promise<{ attachmentId: string }> {
  await acquireRateSlot();
  const { body, contentType } = buildAttachmentMultipart(file);
  const response = await requestHttpsRawJson<Record<string, unknown>>({
    url: trUrl(config, endpoint),
    method: 'POST',
    headers: { Authorization: authHeader(config) },
    body,
    contentType,
    upstream: 'TestRail',
    timeoutMs: trTimeout(),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const parsed = (response.body || {}) as Record<string, unknown>;
    throw new Error(String(parsed.error || `HTTP ${response.statusCode}`));
  }
  const attachmentId = (response.body?.attachment_id ?? response.body?.id ?? '') as number | string;
  return { attachmentId: String(attachmentId) };
}

/** Upload an evidence file as an attachment on a TestRail result (TestRail 5.7+). The result id is
 *  the one shown per passed test in Plan Review; attaching here flips its evidence status to present. */
export function addAttachmentToResult(
  config: TestRailConfig,
  resultId: number | string,
  file: { buffer: Buffer; filename: string; contentType: string }
): Promise<{ attachmentId: string }> {
  return postAttachment(config, `add_attachment_to_result/${encodeURIComponent(String(resultId))}`, file);
}

/** Record a result for a case in a run (status_id 1=Passed) and return the new result id. Used to
 *  "pass with evidence" for an Untested test: create the result here, then attach the file to it so the
 *  test moves to Passed AND gets real per-run evidence. Routed through trFetch (rate-limit + 429 retry). */
export async function addResultForCase(
  config: TestRailConfig,
  runId: number | string,
  caseId: number | string,
  statusId: number,
  comment?: string
): Promise<{ resultId: string }> {
  const response = await trFetch(config, {
    method: 'POST',
    path: `add_result_for_case/${encodeURIComponent(String(runId))}/${encodeURIComponent(String(caseId))}`,
    body: comment ? { status_id: statusId, comment } : { status_id: statusId },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const parsed = (response.body || {}) as Record<string, unknown>;
    throw new Error(String(parsed.error || `HTTP ${response.statusCode}`));
  }
  const result = (response.body || {}) as Record<string, unknown>;
  const id = result.id ?? result.result_id ?? '';
  if (!String(id)) throw new Error('TestRail did not return a result id for the recorded result.');
  return { resultId: String(id) };
}

export function getStatuses(config: TestRailConfig): Promise<Record<string, unknown>[]> {
  return trGet(config, 'get_statuses').then((body) => parseList(body, 'statuses'));
}

export function getUsers(config: TestRailConfig): Promise<Record<string, unknown>[]> {
  return trGet(config, 'get_users').then((body) => parseList(body, 'users'));
}

/** Verify credentials by resolving the TestRail user for an email (throws on bad auth). */
export function getUserByEmail(config: TestRailConfig, email: string): Promise<Record<string, unknown>> {
  return trGet<Record<string, unknown>>(config, `get_user_by_email&email=${encodeURIComponent(email)}`);
}

/** Single user by id — works for non-admins, unlike the bulk get_users (admin-only). */
export function getUser(config: TestRailConfig, userId: number | string): Promise<Record<string, unknown>> {
  return trGet<Record<string, unknown>>(config, `get_user/${encodeURIComponent(String(userId))}`);
}

/** All cases in the project's suite (used to compute which Jira refs already have coverage). */
export function getCases(config: TestRailConfig, projectId?: string, suiteId?: string): Promise<Record<string, unknown>[]> {
  const pid = requireProjectId(config, projectId);
  const sid = String(suiteId || config.suiteId || '1');
  return trGetPaginated(config, `get_cases/${pid}&suite_id=${encodeURIComponent(sid)}`, 'cases');
}

/** Flatten a plan's `entries[].runs[]` into a run list (used for run_count fallback). */
export function extractRunsFromPlan(plan: Record<string, unknown>): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  const entries = Array.isArray(plan.entries) ? (plan.entries as Record<string, unknown>[]) : [];
  for (const entry of entries) {
    const entryRuns = entry && Array.isArray(entry.runs) ? (entry.runs as Record<string, unknown>[]) : [];
    for (const run of entryRuns) {
      if (run && typeof run === 'object') runs.push(run);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Write API (manage) — generic POST + payload builders.
// ---------------------------------------------------------------------------

/** Generic TestRail write (all TestRail mutations are POST, including deletes). */
export async function trWrite(
  config: TestRailConfig,
  endpoint: string,
  payload: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const response = await trFetch(config, { method: 'POST', path: endpoint, body: payload });
  if (response.statusCode >= 200 && response.statusCode < 300) return (response.body as Record<string, unknown>) || {};
  const parsed = (response.body || {}) as Record<string, unknown>;
  throw new Error(String(parsed.error || `HTTP ${response.statusCode}`));
}

export interface ManageCaseInput {
  title?: string;
  refs?: string;
  preconditions?: string;
  bddScenario?: string;
  typeId?: number;
  priorityId?: number;
  templateId?: number;
}

/** Map a manage-case request to TestRail `add_case`/`update_case` fields (omitting undefined). */
export function buildManageCaseBody(input: ManageCaseInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.refs !== undefined) body.refs = input.refs;
  if (input.preconditions !== undefined) body.custom_preconds = input.preconditions;
  if (input.bddScenario !== undefined) {
    body.custom_testrail_bdd_scenario = input.bddScenario ? [{ content: input.bddScenario }] : [];
  }
  if (input.typeId !== undefined) body.type_id = input.typeId;
  if (input.priorityId !== undefined) body.priority_id = input.priorityId;
  if (input.templateId !== undefined) body.template_id = input.templateId;
  return body;
}

export function createCase(
  config: TestRailConfig,
  sectionId: string | number,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return trWrite(config, `add_case/${encodeURIComponent(String(sectionId))}`, payload);
}

export function mapType(type: string): number {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('negative')) return 2;
  if (normalized.includes('edge')) return 5;
  return 1;
}

export async function pushCases(config: TestRailConfig, sectionId: string, testCases: GeneratedTestCase[]): Promise<PushCaseResult[]> {
  // Push cases one by one so a single TestRail failure is reported without aborting the whole batch.
  const results: PushCaseResult[] = [];
  for (const testCase of testCases) {
    try {
      const result = await createCase(config, sectionId, buildGeneratedCaseBody(testCase));
      results.push({ ok: true, title: testCase.title, caseId: result.id as number | string });
    } catch (error) {
      results.push({ ok: false, title: testCase.title, error: (error as Error).message });
    }
    await delay(250);
  }
  return results;
}
