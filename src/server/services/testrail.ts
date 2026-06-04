import type { GeneratedTestCase, PushCaseResult } from '../../shared/contracts';
import { requestHttpsJson } from './http';

interface TestRailConfig {
  baseUrl: string;
  user: string;
  apiKey: string;
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
