import type { ExistingTestRailCase, GeneratedTestCase, PushCaseResult } from '../../shared/contracts';
import { requestHttpsJson } from './http';

export interface TestRailConfig {
  baseUrl: string;
  user: string;
  apiKey: string;
  projectId?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addCase(config: TestRailConfig, sectionId: string, testCase: GeneratedTestCase): Promise<Record<string, unknown>> {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const url = new URL(`/index.php?/api/v2/add_case/${sectionId}`, baseUrl);
  const auth = Buffer.from(`${config.user}:${config.apiKey}`).toString('base64');
  return requestHttpsJson<Record<string, unknown>>({
    url: url.toString(),
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
    },
    body: {
      title: testCase.title,
      template_id: 4,
      type_id: mapType(testCase.type),
      priority_id: 2,
      refs: testCase.jiraReference,
      custom_preconds: testCase.preconditions,
      custom_testrail_bdd_scenario: [{ content: testCase.bddScenario }],
    },
    upstream: 'TestRail',
    timeoutMs: Number(process.env.TESTRAIL_HTTP_TIMEOUT_MS || process.env.UPSTREAM_HTTP_TIMEOUT_MS || 20_000),
  }).then((response) => {
    if (response.statusCode >= 200 && response.statusCode < 300) return response.body;
    const parsed = response.body || {};
    throw new Error(String((parsed as Record<string, unknown>).error || `HTTP ${response.statusCode}`));
  });
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
      const result = await addCase(config, sectionId, testCase);
      results.push({ ok: true, title: testCase.title, caseId: result.id as number | string });
    } catch (error) {
      results.push({ ok: false, title: testCase.title, error: (error as Error).message });
    }
    await delay(250);
  }
  return results;
}
