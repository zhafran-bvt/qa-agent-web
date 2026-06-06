import type { ExistingTestRailCase, GeneratedTestCase, PushCaseResult } from '../../shared/contracts';
import { requestHttpsJson } from './http';

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
  return {
    title: testCase.title,
    template_id: 4,
    type_id: mapType(testCase.type),
    priority_id: 2,
    refs: testCase.jiraReference,
    custom_preconds: testCase.preconditions,
    custom_testrail_bdd_scenario: [{ content: testCase.bddScenario }],
  };
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

export function buildGetCasesUrl(config: TestRailConfig, projectId: string, sectionId: string, jiraKey: string): string {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const params = new URLSearchParams({
    section_id: sectionId,
    refs: jiraKey,
  });
  return `${baseUrl}/index.php?/api/v2/get_cases/${encodeURIComponent(projectId)}&${params.toString()}`;
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
  const projectId = String(config.projectId || '').trim();
  if (!projectId) throw new Error('TestRail project ID is required for duplicate lookup.');

  const response = await requestHttpsJson<unknown>({
    url: buildGetCasesUrl(config, projectId, sectionId, jiraKey),
    method: 'GET',
    headers: {
      Authorization: authHeader(config),
    },
    upstream: 'TestRail',
    timeoutMs: Number(process.env.TESTRAIL_HTTP_TIMEOUT_MS || process.env.UPSTREAM_HTTP_TIMEOUT_MS || 20_000),
  });

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

async function trGet<T = unknown>(config: TestRailConfig, path: string): Promise<T> {
  const response = await requestHttpsJson<T>({
    url: trUrl(config, path),
    method: 'GET',
    headers: { Authorization: authHeader(config) },
    upstream: 'TestRail',
    timeoutMs: trTimeout(),
  });
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
  const response = await requestHttpsJson<Record<string, unknown>>({
    url: trUrl(config, endpoint),
    method: 'POST',
    headers: { Authorization: authHeader(config) },
    body: payload,
    upstream: 'TestRail',
    timeoutMs: trTimeout(),
  });
  if (response.statusCode >= 200 && response.statusCode < 300) return response.body || {};
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
