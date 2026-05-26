import https from 'node:https';
import type { GeneratedTestCase, PushCaseResult } from '../../shared/contracts';

interface TestRailConfig {
  baseUrl: string;
  user: string;
  apiKey: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addCase(config: TestRailConfig, sectionId: string, testCase: GeneratedTestCase): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const baseUrl = config.baseUrl.replace(/\/$/, '');
    const url = new URL(`/index.php?/api/v2/add_case/${sectionId}`, baseUrl);
    const auth = Buffer.from(`${config.user}:${config.apiKey}`).toString('base64');
    const payload = JSON.stringify({
      title: testCase.title,
      template_id: 4,
      type_id: mapType(testCase.type),
      priority_id: 2,
      refs: testCase.jiraReference,
      custom_preconds: testCase.preconditions,
      custom_testrail_bdd_scenario: [{ content: testCase.bddScenario }],
    });

    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown>;
          try {
            parsed = body ? JSON.parse(body) : {};
          } catch {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${body}`));
            return;
          }
          if ((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300) {
            resolve(parsed);
            return;
          }
          reject(new Error(String(parsed.error || `HTTP ${res.statusCode}`)));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
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
