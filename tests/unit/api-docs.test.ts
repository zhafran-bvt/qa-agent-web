import test from 'node:test';
import assert from 'node:assert/strict';
import { assessApiContractRelevance, collectDocPagePaths, extractEndpointMentions, normalizeSelectedEndpoints, resolveScopeType } from '../../src/server/services/api-docs';

function makeContext(overrides: Record<string, unknown> = {}): any {
  return {
    mainIssue: { summary: '', description: '', renderedDescription: '', comments: [] },
    linkedIssues: [],
    confluencePages: [],
    acceptanceCriteria: [],
    ...overrides,
  };
}

test('extracts API endpoint mentions from ticket text', () => {
  const endpoints = extractEndpointMentions(
    'APIs: POST /v1/analysis-configs, PUT /v1/analysis-configs/{id}, GET /datasets/{id}/analytics',
    'jira'
  );

  assert.deepEqual(endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`), [
    'POST /v1/analysis-configs',
    'PUT /v1/analysis-configs/{id}',
    'GET /datasets/{id}/analytics',
  ]);
});

test('normalizeSelectedEndpoints links LLM-chosen endpoints to the documented set', () => {
  const documented = [
    { method: 'GET', path: '/v1/datasets', source: 'api_docs' as const, summary: 'List datasets', documentationExcerpt: 'doc-1' },
    { method: 'POST', path: '/v1/analysis', source: 'api_docs' as const, summary: 'Submit analysis' },
  ];
  const llmOutput = {
    endpoints: [
      { method: 'get', path: '/v1/datasets', label: 'Get dataset list' },
      { method: 'POST', path: '/v1/analysis', summary: 'Submit analysis' },
      { method: 'POST', path: '', label: 'Reset password' }, // referenced but not in docs
      { method: 'BOGUS', path: '/x' }, // invalid method → dropped
    ],
  };

  const out = normalizeSelectedEndpoints(llmOutput, documented);
  const byKey = Object.fromEntries(out.map((e) => [`${e.method} ${e.path || e.label}`, e]));

  // documented matches inherit source api_docs + the real summary/excerpt
  assert.equal(byKey['GET /v1/datasets'].source, 'api_docs');
  assert.equal(byKey['GET /v1/datasets'].summary, 'List datasets');
  assert.equal(byKey['GET /v1/datasets'].documentationExcerpt, 'doc-1');
  // a name-only reference not in docs stays source jira with its label
  assert.equal(byKey['POST Reset password'].source, 'jira');
  assert.equal(byKey['POST Reset password'].path, '');
  // invalid method dropped
  assert.equal(out.some((e) => e.method === 'BOGUS'), false);
  assert.equal(out.length, 3);
});

test('normalizeSelectedEndpoints tolerates a bare array and empty input', () => {
  assert.deepEqual(normalizeSelectedEndpoints(null, []), []);
  assert.deepEqual(normalizeSelectedEndpoints({}, []), []);
  const out = normalizeSelectedEndpoints([{ method: 'GET', path: '/a' }], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'jira'); // no documented match → jira
});

test('auto resolves BE endpoint-heavy tickets to API scope', () => {
  assert.equal(
    resolveScopeType({
      requestedScopeType: 'auto',
      feOnly: true,
      title: '[BE] Enhance Analysis Config API',
      text: 'POST /v1/analysis-configs with request body validation',
    }),
    'api'
  );
});

test('backend label resolves to API scope regardless of FE-looking title', () => {
  assert.equal(
    resolveScopeType({
      requestedScopeType: 'auto',
      feOnly: true,
      title: 'Implement coverage type section',
      labels: ['backend'],
    }),
    'api'
  );
});

test('frontend label resolves to web scope even with endpoint mentions', () => {
  assert.equal(
    resolveScopeType({
      requestedScopeType: 'auto',
      feOnly: false,
      title: 'Integrate API - Get onboarding module state',
      text: 'consumes GET /v1/onboarding-state',
      labels: ['frontend'],
    }),
    'web'
  );
});

test('collectDocPagePaths includes only Analytics + Internal BFF groups by default', () => {
  const config = {
    groups: [
      {
        title: 'Protocol Buffers',
        id: 'proto',
        subgroups: [{ title: 'Analysis', id: 'proto-analysis', pages: [{ title: 'V1', path: 'go-proto/analysis/v1/analysis.html' }] }],
      },
      {
        title: 'Analytics APIs',
        id: 'analytics',
        pages: [
          { title: 'Analysis Api', path: 'analytics-service/analysis_api.html' },
          { title: 'Dataset Api', path: 'analytics-service/dataset_api.html' },
        ],
      },
      {
        title: 'Internal BFF APIs',
        id: 'bff',
        pages: [{ title: 'User Api', path: 'internal-bff/user_api.html' }],
      },
      { title: 'Targetin APIs', id: 'targetin', pages: [{ path: 'targetin-bff/site_api.html' }] },
      { title: 'Legacy', id: 'legacy', pages: [{ path: 'legacy/li/spatial_service.html' }] },
    ],
  };

  assert.deepEqual(collectDocPagePaths(config), [
    'analytics-service/analysis_api.html',
    'analytics-service/dataset_api.html',
    'internal-bff/user_api.html',
  ]);
});

test('collectDocPagePaths honors a custom group allowlist', () => {
  const config = {
    groups: [
      { title: 'Analytics APIs', id: 'analytics', pages: [{ path: 'analytics-service/analysis_api.html' }] },
      { title: 'Targetin APIs', id: 'targetin', pages: [{ path: 'targetin-bff/site_api.html' }] },
    ],
  };
  assert.deepEqual(collectDocPagePaths(config, ['targetin']), ['targetin-bff/site_api.html']);
});

test('collectDocPagePaths de-duplicates repeated page paths within allowed groups', () => {
  const config = {
    groups: [
      { title: 'Analytics APIs', id: 'analytics', pages: [{ path: 'x/page.html' }] },
      { title: 'Internal BFF APIs', id: 'bff', pages: [{ path: 'x/page.html' }] },
    ],
  };
  assert.deepEqual(collectDocPagePaths(config), ['x/page.html']);
});

test('assessApiContractRelevance: endpoint-referencing ticket is API-contract work', () => {
  const context = makeContext({
    mainIssue: { summary: '[BE] Enhance Spatial Analysis API', description: 'Update POST /v1/analysis to accept grid_config.', comments: [] },
  });
  assert.equal(assessApiContractRelevance(context).relevant, true);
});

test('assessApiContractRelevance: contract keywords (request body) count as API work', () => {
  const context = makeContext({
    mainIssue: { summary: '[BE] Add field', description: 'Extend the request body with a new optional field and document the response payload.', comments: [] },
  });
  assert.equal(assessApiContractRelevance(context).relevant, true);
});

test('assessApiContractRelevance: ORB-3016-style data backfill is NOT API work', () => {
  // Mentions "analytic endpoint" and "dataset_schema" in passing, but changes no HTTP contract.
  const context = makeContext({
    mainIssue: {
      summary: '[BE] Update Dimension and Measure on Dataset Schema for old dataset',
      description:
        'The analytic endpoint requires each attribute in dataset_schema to be classified with is_dimension and is_measure. Run inference against existing datasets that lack these flags. Cardinality threshold default 500.',
      comments: [],
    },
  });
  assert.equal(assessApiContractRelevance(context).relevant, false);
});

test('explicit web scope overrides endpoint-heavy auto detection', () => {
  assert.equal(
    resolveScopeType({
      requestedScopeType: 'web',
      feOnly: true,
      title: '[BE] Mentioned in parent but QA wants web',
      text: 'POST /v1/example',
    }),
    'web'
  );
});
