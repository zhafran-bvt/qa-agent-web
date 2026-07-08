import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCoverage,
  endpointIsDocumented,
  normalizeAcceptanceCriteriaId,
  normalizeEndpointPath,
  trulyUncoveredCriteria,
  validateCase,
  validateCases,
} from '../../src/server/services/validation';

const acceptanceCriteria = [
  { id: 'AC-1', text: 'Adm Area filter is required before Add Dataset button enabled' },
  { id: 'AC-2', text: 'Adm Area filter follows Global Area Filter sync' },
];

const validCase = {
  title: '[FE][Spatial Analysis][ORB-3077] Save project with BVT polygon datasets',
  type: 'Happy Path',
  jiraReference: 'ORB-3077',
  coversAcceptanceCriteria: ['AC-1'],
  preconditions: 'User is logged in and feature flag is enabled.',
  evidence: {
    prdSectionTitle: '5. Story title',
    acceptanceCriteria: [{ id: 'AC-1', text: 'Adm Area filter is required before Add Dataset button enabled' }],
    coverageNote: 'This case validates the happy-path flow against the selected acceptance criterion.',
  },
  bddScenario: `Feature: Save project
  Scenario: Save project
    Given the user has selected BVT polygon datasets
    When the user saves the project
    Then the project should be saved successfully`,
};

test('validates a correct BDD test case', () => {
  const result = validateCase(validCase, { jiraKey: 'ORB-3077', epic: 'Spatial Analysis', feOnly: true, acceptanceCriteria });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('rejects title/ref Jira mismatch', () => {
  const result = validateCase(
    { ...validCase, title: '[FE][Spatial Analysis][ORB-3039] Save project with BVT polygon datasets' },
    { jiraKey: 'ORB-3077', epic: 'Spatial Analysis' }
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /does not match refs/);
});

test('rejects missing BDD keywords', () => {
  const result = validateCase({ ...validCase, bddScenario: 'Given only one step' }, { jiraKey: 'ORB-3077', acceptanceCriteria });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Feature:/);
  assert.match(result.errors.join('\n'), /Scenario:/);
});

test('allows API/endpoint mentions in FE BDD steps (FE-only backend-term rule removed)', () => {
  const result = validateCase(
    { ...validCase, bddScenario: `${validCase.bddScenario}\n    And the POST /v1/analysis-configs response should be valid` },
    { jiraKey: 'ORB-3077', epic: 'Spatial Analysis', feOnly: true, acceptanceCriteria }
  );
  assert.equal(result.valid, true);
  assert.doesNotMatch(result.errors.join('\n'), /FE-only/);
});

test('does not reject FE-only scope when API appears only in title or feature label', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[FE][Spatial Analysis][ORB-3118] Enable Add Dataset after Adm Area filter is selected',
      jiraReference: 'ORB-3118',
      bddScenario: `Feature: Integrate API - Filter Line Dataset by Admin Area
Scenario: Add Dataset becomes enabled after a valid Adm Area selection
Given the user opens the Add Dataset flow for a line dataset
When the user selects a valid Adm Area value
Then the Add Dataset button becomes enabled`,
    },
    { jiraKey: 'ORB-3118', epic: 'Spatial Analysis', feOnly: true, acceptanceCriteria }
  );
  assert.equal(result.valid, true);
  assert.doesNotMatch(result.errors.join('\n'), /FE-only/);
});

test('rejects missing acceptance criteria mapping when criteria exist', () => {
  const result = validateCase({ ...validCase, coversAcceptanceCriteria: [] }, { jiraKey: 'ORB-3077', acceptanceCriteria });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /at least one acceptance criterion/);
});

test('normalizes acceptance criteria ids with loose formatting', () => {
  assert.equal(normalizeAcceptanceCriteriaId('ac-2.'), 'AC-2');
  assert.equal(normalizeAcceptanceCriteriaId('AC 3'), 'AC-3');
  assert.equal(normalizeAcceptanceCriteriaId('AC4'), 'AC-4');
});

test('accepts normalized acceptance criteria ids from generated cases', () => {
  const result = validateCase(
    { ...validCase, coversAcceptanceCriteria: ['ac-1.'] },
    { jiraKey: 'ORB-3077', epic: 'Spatial Analysis', acceptanceCriteria }
  );
  assert.equal(result.valid, true);
});

test('does not report unknown acceptance criteria when none were detected in context', () => {
  const result = validateCase(
    { ...validCase, coversAcceptanceCriteria: ['AC-1'] },
    { jiraKey: 'ORB-3077', epic: 'Spatial Analysis', acceptanceCriteria: [] }
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('does not enforce acceptance criteria mapping when enforcement is explicitly disabled', () => {
  const result = validateCase(
    { ...validCase, coversAcceptanceCriteria: [] },
    { jiraKey: 'ORB-3077', epic: 'Spatial Analysis', acceptanceCriteria, enforceAcceptanceCriteria: false }
  );
  assert.equal(result.valid, true);
});

test('missing evidence note warns but does not fail validation', () => {
  const result = validateCase(
    { ...validCase, evidence: { ...validCase.evidence, coverageNote: '' } },
    { jiraKey: 'ORB-3077', epic: 'Spatial Analysis', acceptanceCriteria }
  );
  assert.equal(result.valid, true);
  assert.match(result.warnings.join('\n'), /Evidence coverage note is missing/);
});

test('builds coverage and flags uncovered criteria', () => {
  const coverage = buildCoverage(
    [
      validCase,
      {
        ...validCase,
        id: 'TC-02',
        title: '[FE][Spatial Analysis][ORB-3077] Global filter sync updates Adm Area',
        coversAcceptanceCriteria: ['AC-2'],
      },
    ],
    acceptanceCriteria
  );

  assert.equal(coverage.coveredCriteria, 2);
  assert.deepEqual(coverage.uncoveredCriteria, []);
});

test('marks coverage as not enforced when enforcement is explicitly disabled', () => {
  const coverage = buildCoverage([validCase], acceptanceCriteria, { enforceAcceptanceCriteria: false });
  assert.equal(coverage.enforced, false);
});

test('validates a Postman API case with payload and expected response', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3227] Create custom catchment config',
      jiraReference: 'ORB-3227',
      executionType: 'postman',
      apiSpec: {
        method: 'POST',
        path: '/v1/analysis-configs',
        samplePayload: '{"analysis_output":{"output_mode":"custom_catchment"}}',
        expectedResponse: '{"id":"<id>"}',
        assertions: ['response status is 200 or 201'],
      },
      bddScenario: `Feature: Analysis config API
Scenario: Create custom catchment config
Given the user is authenticated
When the user sends POST /v1/analysis-configs with payload:
"""
{"analysis_output":{"output_mode":"custom_catchment"}}
"""
Then the response status should be 201
And the response body should include "id"`,
    },
    { jiraKey: 'ORB-3227', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria }
  );

  assert.equal(result.valid, true);
});

test('rejects API write case without payload or expected response', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3227] Create custom catchment config',
      jiraReference: 'ORB-3227',
      executionType: 'postman',
      apiSpec: { method: 'POST', path: '/v1/analysis-configs' },
      bddScenario: `Feature: Analysis config API
Scenario: Create custom catchment config
Given the user is authenticated
When the user sends POST /v1/analysis-configs
Then it succeeds`,
    },
    { jiraKey: 'ORB-3227', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria }
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /sample payload/);
  assert.match(result.errors.join('\n'), /expected response/);
});

test('normalizeEndpointPath collapses concrete ids and trailing slashes to the documented template', () => {
  assert.equal(normalizeEndpointPath('/v1/datasets/42/'), normalizeEndpointPath('/v1/datasets/{id}'));
  assert.equal(normalizeEndpointPath('/v1/Datasets/42?expand=schema'), normalizeEndpointPath('/v1/datasets/:datasetId'));
  assert.equal(
    normalizeEndpointPath('/v1/datasets/3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
    normalizeEndpointPath('/v1/datasets/{uuid}')
  );
  assert.notEqual(normalizeEndpointPath('/v1/datasets'), normalizeEndpointPath('/v1/analysis'));
});

test('endpointIsDocumented matches structurally and respects method, no-op on empty contract', () => {
  const matched = [{ method: 'GET', path: '/v1/datasets/{id}' }];
  assert.equal(endpointIsDocumented('GET', '/v1/datasets/42', matched), true);
  assert.equal(endpointIsDocumented('GET', '/v1/datasets/42', []), true); // nothing to compare against
  assert.equal(endpointIsDocumented('DELETE', '/v1/datasets/42', matched), false); // method mismatch
  assert.equal(endpointIsDocumented('GET', '/v1/partners', matched), false); // path not in contract
});

test('warns when a postman case targets an endpoint absent from the matched contract', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3227] Reset partner credentials',
      jiraReference: 'ORB-3227',
      executionType: 'postman',
      apiSpec: {
        method: 'POST',
        path: '/v1/partners/reset',
        samplePayload: '{"partner_id":"<id>"}',
        expectedResponse: '{"status":"ok"}',
        assertions: ['response status is 200'],
      },
      bddScenario: `Feature: Partner API
Scenario: Reset partner credentials
Given the user is authenticated
When the user sends POST /v1/partners/reset with payload
Then the response status should be 200`,
    },
    {
      jiraKey: 'ORB-3227',
      epic: 'Spatial Analysis',
      scopeType: 'api',
      acceptanceCriteria,
      matchedEndpoints: [{ method: 'GET', path: '/v1/datasets/{id}' }],
    }
  );

  assert.equal(result.valid, true); // provenance is a warning, not a hard failure
  assert.match(result.warnings.join('\n'), /not in the matched API contract/);
});

test('does not warn on endpoint provenance when no contract was matched', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3227] Create config',
      jiraReference: 'ORB-3227',
      executionType: 'postman',
      apiSpec: {
        method: 'POST',
        path: '/v1/analysis-configs',
        samplePayload: '{"x":1}',
        expectedResponse: '{"id":"<id>"}',
        assertions: ['response status is 201'],
      },
      bddScenario: `Feature: Config API
Scenario: Create config
Given the user is authenticated
When the user sends POST /v1/analysis-configs with payload
Then the response status should be 201`,
    },
    { jiraKey: 'ORB-3227', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria }
  );

  assert.equal(result.valid, true);
  assert.doesNotMatch(result.warnings.join('\n'), /not in the matched API contract/);
});

test('does not warn on endpoint alignment when the BDD uses a concrete id for the apiSpec {id} template', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3227] AREA stream keeps standard columns',
      jiraReference: 'ORB-3227',
      executionType: 'postman',
      apiSpec: {
        method: 'GET',
        path: '/v1/analysis/{id}/stream',
        expectedResponse: '{"status":"ok"}',
        assertions: ['dataset row has no Dasymetric Weight column'],
      },
      preconditions: 'An analysis was submitted via POST /v1/analysis and completed; its id is known.',
      bddScenario: `Feature: Analysis Result Stream
Scenario: AREA stream keeps standard columns
Given an analysis with id "abc123" completed in AREA mode
When I retrieve the analysis result stream at GET /v1/analysis/abc123/stream
Then the dataset rows should not contain a "Dasymetric Weight" column`,
    },
    {
      jiraKey: 'ORB-3227',
      epic: 'Spatial Analysis',
      scopeType: 'api',
      acceptanceCriteria,
      matchedEndpoints: [{ method: 'GET', path: '/v1/analysis/{id}/stream' }],
    }
  );

  assert.equal(result.valid, true);
  // The concrete id in the BDD is the same endpoint as the apiSpec {id} template — not an extra endpoint.
  assert.doesNotMatch(result.warnings.join('\n'), /additional endpoint/);
});

test('still warns on endpoint alignment when the BDD exercises a genuinely different endpoint', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3227] Stream then read a different resource',
      jiraReference: 'ORB-3227',
      executionType: 'postman',
      apiSpec: {
        method: 'GET',
        path: '/v1/analysis/{id}/stream',
        expectedResponse: '{"status":"ok"}',
        assertions: ['stream returns rows'],
      },
      preconditions: 'An analysis exists and its id is known.',
      bddScenario: `Feature: Cross endpoint
Scenario: reads a different resource mid-scenario
Given an analysis exists
When I retrieve GET /v1/datasets/xyz/records
Then the response status should be 200`,
    },
    {
      jiraKey: 'ORB-3227',
      epic: 'Spatial Analysis',
      scopeType: 'api',
      acceptanceCriteria,
      matchedEndpoints: [{ method: 'GET', path: '/v1/analysis/{id}/stream' }],
    }
  );

  assert.equal(result.valid, true);
  // A different literal path (datasets vs analysis) is a real second endpoint — must still be flagged.
  assert.match(result.warnings.join('\n'), /additional endpoint/);
});

test('warns when one case claims too many acceptance criteria without being smoke or e2e', () => {
  const broadCriteria = [
    { id: 'AC-1', text: 'Analysis request stores proportion method' },
    { id: 'AC-2', text: 'Stream result includes Dasymetric Weight' },
    { id: 'AC-3', text: 'Response keeps score unchanged' },
  ];
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3310] Generate dasymetric analysis result',
      jiraReference: 'ORB-3310',
      executionType: 'postman',
      coversAcceptanceCriteria: ['AC-1', 'AC-2', 'AC-3'],
      apiSpec: {
        method: 'POST',
        path: '/v1/analysis',
        samplePayload: '{"proportion_method":"DASYMETRIC"}',
        expectedResponse: '{"score":1}',
        assertions: ['response status is 201', 'stream result includes Dasymetric Weight', 'score unchanged'],
      },
      bddScenario: `Feature: Spatial analysis API
Scenario: Generate dasymetric analysis result
Given the user is authenticated
When the user sends POST /v1/analysis with a proportion_method DASYMETRIC payload
Then the response status should be 201
And the stream result includes Dasymetric Weight
And the score remains unchanged`,
    },
    { jiraKey: 'ORB-3310', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria: broadCriteria }
  );

  assert.equal(result.valid, true);
  assert.match(result.warnings.join('\n'), /maps to 3 acceptance criteria/);
});

test('allows broad acceptance criteria mapping for explicit smoke or e2e cases', () => {
  const broadCriteria = [
    { id: 'AC-1', text: 'Analysis request stores proportion method' },
    { id: 'AC-2', text: 'Stream result includes Dasymetric Weight' },
    { id: 'AC-3', text: 'Response keeps score unchanged' },
  ];
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3310] Smoke generate dasymetric analysis result',
      type: 'Smoke',
      jiraReference: 'ORB-3310',
      executionType: 'postman',
      coversAcceptanceCriteria: ['AC-1', 'AC-2', 'AC-3'],
      apiSpec: {
        method: 'POST',
        path: '/v1/analysis',
        samplePayload: '{"proportion_method":"DASYMETRIC"}',
        expectedResponse: '{"score":1}',
        assertions: ['response status is 201', 'stream result includes Dasymetric Weight', 'score unchanged'],
      },
      bddScenario: `Feature: Spatial analysis API
Scenario: Smoke generate dasymetric analysis result
Given the user is authenticated
When the user sends POST /v1/analysis with a proportion_method DASYMETRIC payload
Then the response status should be 201
And the stream result includes Dasymetric Weight
And the score remains unchanged`,
    },
    { jiraKey: 'ORB-3310', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria: broadCriteria }
  );

  assert.equal(result.valid, true);
  assert.doesNotMatch(result.warnings.join('\n'), /maps to 3 acceptance criteria/);
});

test('warns when BDD API flow uses endpoints not represented by apiSpec', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3310] Stream dasymetric analysis result',
      jiraReference: 'ORB-3310',
      executionType: 'postman',
      coversAcceptanceCriteria: ['AC-1'],
      apiSpec: {
        method: 'POST',
        path: '/v1/analysis',
        samplePayload: '{"proportion_method":"DASYMETRIC"}',
        expectedResponse: '{"id":"<analysisId>"}',
        assertions: ['response status is 201'],
      },
      bddScenario: `Feature: Spatial analysis API
Scenario: Stream dasymetric analysis result
Given the user is authenticated
When the user sends POST /v1/analysis with a proportion_method DASYMETRIC payload
And the user reads GET /v1/analysis/{id}/stream
Then the response status should be 201
And the stream result includes Dasymetric Weight`,
    },
    {
      jiraKey: 'ORB-3310',
      epic: 'Spatial Analysis',
      scopeType: 'api',
      acceptanceCriteria: [{ id: 'AC-1', text: 'Stream result includes Dasymetric Weight' }],
      matchedEndpoints: [{ method: 'POST', path: '/v1/analysis' }],
    }
  );

  assert.equal(result.valid, true);
  assert.match(result.warnings.join('\n'), /additional endpoint\(s\) GET \/v1\/analysis\/\{id\}\/stream/);
});

test('validateCases warns on likely duplicate generated cases', () => {
  const criteria = [{ id: 'AC-1', text: 'Stream result includes Dasymetric Weight' }];
  const baseApiCase = {
    ...validCase,
    jiraReference: 'ORB-3310',
    executionType: 'postman' as const,
    coversAcceptanceCriteria: ['AC-1'],
    apiSpec: {
      method: 'POST',
      path: '/v1/analysis',
      samplePayload: '{"proportion_method":"DASYMETRIC"}',
      expectedResponse: '{"score":1}',
      assertions: ['response status is 201', 'stream result includes Dasymetric Weight'],
    },
    evidence: {
      ...validCase.evidence,
      coverageNote: 'This case verifies dasymetric stream output.',
    },
  };
  const validation = validateCases(
    [
      {
        ...baseApiCase,
        id: 'TC-1',
        title: '[BE][Spatial Analysis][ORB-3310] Apply dasymetric weight to stream response',
        bddScenario: `Feature: Spatial analysis API
Scenario: Apply dasymetric weight to stream response
Given the user is authenticated
When the user sends POST /v1/analysis with a proportion_method DASYMETRIC payload
Then the response status should be 201
And the stream result includes Dasymetric Weight`,
      },
      {
        ...baseApiCase,
        id: 'TC-2',
        title: '[BE][Spatial Analysis][ORB-3310] Verify dasymetric weight stream response',
        bddScenario: `Feature: Spatial analysis API
Scenario: Verify dasymetric weight stream response
Given the user is authenticated
When the user sends POST /v1/analysis with a DASYMETRIC proportion_method payload
Then the response status should be 201
And the stream result includes Dasymetric Weight`,
      },
    ],
    { jiraKey: 'ORB-3310', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria: criteria }
  );

  assert.equal(validation[1].valid, true);
  assert.match(validation[1].warnings.join('\n'), /Potential duplicate of TC-1/);
});

test('warns when executionType contradicts a populated apiSpec', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3016] Inspect schema',
      jiraReference: 'ORB-3016',
      executionType: 'manual_db',
      apiSpec: { method: 'GET', path: '/v1/datasets/{id}/schema' },
      manualVerification: {
        target: 'dataset_schema',
        steps: ['Run SELECT * FROM dataset_schema'],
        expectedResult: 'rows match',
      },
      bddScenario: `Feature: Schema
Scenario: Inspect schema
Given the migration has run
When QA checks dataset_schema using SQL
Then values match`,
    },
    { jiraKey: 'ORB-3016', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria }
  );

  assert.match(result.warnings.join('\n'), /executionType is manual_db but apiSpec defines an HTTP endpoint/);
});

test('trulyUncoveredCriteria separates genuine gaps from weak-only-claimed ACs (so weak claims stay overrideable)', () => {
  // AC-1 nothing claims (true gap); AC-2 is uncovered only because its sole claim was flagged weak.
  const coverage = { uncoveredCriteria: ['AC-1', 'AC-2'], unsubstantiatedClaims: [{ caseId: 'TC-02', criterionId: 'AC-2' }] };
  assert.deepEqual(trulyUncoveredCriteria(coverage), ['AC-1']); // AC-2 excluded → overrideable, not a hard block
  assert.deepEqual(trulyUncoveredCriteria({ uncoveredCriteria: [], unsubstantiatedClaims: [] }), []);
  assert.deepEqual(
    trulyUncoveredCriteria({ uncoveredCriteria: ['AC-9'], unsubstantiatedClaims: [] }),
    ['AC-9']
  );
});

test('builds coverage that flags unsubstantiated claims without dropping them silently', () => {
  const coverage = buildCoverage(
    [
      {
        ...validCase,
        coversAcceptanceCriteria: ['AC-1', 'AC-2'],
      },
    ],
    [
      { id: 'AC-1', text: 'BVT polygon datasets can be saved to a project' },
      { id: 'AC-2', text: 'Email routing CTA link contains the partner microsite URL' },
    ]
  );

  // AC-2 (email routing / partner microsite) is claimed but the case never mentions email or microsite.
  assert.ok(coverage.unsubstantiatedClaims.some((claim) => claim.criterionId === 'AC-2'));
  assert.ok(coverage.uncoveredCriteria.includes('AC-2'));
});

test('F2: flags a conditional AC covered by only one polarity (negative without positive)', () => {
  const coverage = buildCoverage(
    [
      {
        id: 'TC-1',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'negative',
        title: 'Generate Results button stays disabled when radius is 0',
        bddScenario: 'Given radius is 0 When the form is checked Then the Generate Results button is disabled',
      },
    ],
    [{ id: 'AC-1', text: 'Generate Results button is disabled when radius is missing or 0' }]
  );
  // Covered (green) but only the disabled branch is tested — the enabled-with-valid-radius branch is absent.
  assert.equal(coverage.coveredCriteria, 1);
  assert.equal(coverage.singlePolarityCriteria.length, 1);
  assert.equal(coverage.singlePolarityCriteria[0].criterionId, 'AC-1');
  assert.deepEqual(coverage.singlePolarityCriteria[0].have, ['negative']);
  assert.ok(coverage.singlePolarityCriteria[0].missing.includes('positive'));
});

test('F2: does not flag a conditional AC tested in both polarities', () => {
  const coverage = buildCoverage(
    [
      {
        id: 'TC-1',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'negative',
        title: 'Generate Results disabled when radius is 0',
        bddScenario: 'Given radius is 0 Then the Generate Results button is disabled',
      },
      {
        id: 'TC-2',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'positive',
        title: 'Generate Results enabled when radius is valid',
        bddScenario: 'Given a valid radius Then the Generate Results button is enabled',
      },
    ],
    [{ id: 'AC-1', text: 'Generate Results button is disabled when radius is missing or 0' }]
  );
  assert.equal(coverage.singlePolarityCriteria.length, 0);
});

test('F2: an edge case satisfies the opposing polarity, so positive+edge is not flagged', () => {
  const coverage = buildCoverage(
    [
      {
        id: 'TC-1',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'positive',
        title: 'Weight is the sum of building_ratio when cells match',
        bddScenario: 'Given cells match Then the weight is the sum of building_ratio',
      },
      {
        id: 'TC-2',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'edge',
        title: 'Weight is 0 when no cells match',
        bddScenario: 'Given no cells match Then the weight is 0',
      },
    ],
    [{ id: 'AC-1', text: 'Weight is the sum of building_ratio when cells match; 0 when none match' }]
  );
  // The three-state/boundary branch is authored as an edge case — it must count as the opposing side,
  // not read as a missing negative (this is the AC-4/5/7 false-flag fix).
  assert.equal(coverage.singlePolarityCriteria.length, 0);
});

test('F2: edge-only coverage still flags the missing affirming (positive) branch', () => {
  const coverage = buildCoverage(
    [
      {
        id: 'TC-1',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'edge',
        title: 'Weight is 0 when no cells match',
        bddScenario: 'Given no cells match Then the weight is 0',
      },
    ],
    [{ id: 'AC-1', text: 'Weight is the sum of building_ratio when cells match; 0 when none match' }]
  );
  // Opposing (edge) is covered, but the happy path is not — still a single-polarity gap, missing positive.
  assert.equal(coverage.singlePolarityCriteria.length, 1);
  assert.deepEqual(coverage.singlePolarityCriteria[0].missing, ['positive']);
});

test('F2: never flags a non-conditional AC even when tested in one polarity', () => {
  const coverage = buildCoverage(
    [
      {
        id: 'TC-1',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'positive',
        title: 'Coverage Type section shows the radius placeholder text',
        bddScenario: 'Given the config panel Then the radius placeholder text reads Enter radius',
      },
    ],
    [{ id: 'AC-1', text: 'The radius placeholder text reads Enter radius value' }]
  );
  assert.equal(coverage.singlePolarityCriteria.length, 0);
});

test('F2: only API-observable execution-plan items require single-polarity coverage', () => {
  const criteria = [
    { id: 'AC-API', text: 'The API rejects onboarding progress updates when the Authorization Bearer token is missing or invalid.' },
    { id: 'AC-DB', text: 'The database migration creates the dasymetric_output table and required index when the migration is applied.' },
    { id: 'AC-CODE', text: 'Generated protobuf code includes the proportion_method enum and output field.' },
    { id: 'AC-INTEGRATION', text: 'The analysis worker falls back to AREA proportioning when dasymetric prefetch data is unavailable.' },
  ];
  const executionPlan = [
    {
      criterionId: 'AC-API',
      executionType: 'postman' as const,
      observableSurface: 'POST /v1/onboarding/progress/{module_id}',
      reason: 'API request/response behavior.',
      coveragePolicy: 'api_assertion' as const,
    },
    {
      criterionId: 'AC-DB',
      executionType: 'manual_db' as const,
      observableSurface: 'Database migration state',
      reason: 'Schema/index verification.',
      coveragePolicy: 'db_verification' as const,
    },
    {
      criterionId: 'AC-CODE',
      executionType: 'manual_code_review' as const,
      observableSurface: 'Generated protobuf code',
      reason: 'Code artifact verification.',
      coveragePolicy: 'code_review' as const,
    },
    {
      criterionId: 'AC-INTEGRATION',
      executionType: 'manual_integration' as const,
      observableSurface: 'Analysis worker runtime behavior',
      reason: 'Internal worker behavior.',
      coveragePolicy: 'integration_verification' as const,
    },
  ];
  const coverage = buildCoverage(
    [
      {
        id: 'TC-API',
        executionType: 'postman',
        caseIntent: 'negative',
        coversAcceptanceCriteria: ['AC-API'],
        title: 'Reject onboarding progress update when bearer token is missing',
        bddScenario: 'Given the bearer token is missing When POST /v1/onboarding/progress/mod-1 is sent Then the API rejects the request',
        apiSpec: {
          method: 'POST',
          path: '/v1/onboarding/progress/{module_id}',
          expectedResponse: '401 Unauthorized',
        },
      },
      {
        id: 'TC-DB',
        executionType: 'manual_db',
        caseIntent: 'positive',
        coversAcceptanceCriteria: ['AC-DB'],
        title: 'Verify dasymetric table and index exist after migration',
        manualVerification: {
          target: 'database migration',
          steps: ['Inspect the applied migration and database schema for dasymetric_output table and required index.'],
          expectedResult: 'The dasymetric_output table and required index exist after the migration is applied.',
        },
      },
      {
        id: 'TC-CODE',
        executionType: 'manual_code_review',
        caseIntent: 'positive',
        coversAcceptanceCriteria: ['AC-CODE'],
        title: 'Verify generated protobuf proportion_method field',
        manualVerification: {
          target: 'generated protobuf code',
          steps: ['Inspect the generated protobuf output type for proportion_method enum and field.'],
          expectedResult: 'The generated protobuf code includes the proportion_method enum and output field.',
        },
      },
      {
        id: 'TC-INTEGRATION',
        executionType: 'manual_integration',
        caseIntent: 'edge',
        coversAcceptanceCriteria: ['AC-INTEGRATION'],
        title: 'Verify AREA fallback when dasymetric prefetch data is unavailable',
        manualVerification: {
          target: 'analysis worker runtime',
          steps: ['Run or inspect the worker path where dasymetric prefetch data is unavailable.'],
          expectedResult: 'The analysis worker falls back to AREA proportioning.',
        },
      },
    ],
    criteria,
    {
      scopeType: 'api',
      acceptanceCriteriaExecutionPlan: executionPlan,
    }
  );

  assert.deepEqual(
    coverage.singlePolarityCriteria.map((item) => item.criterionId),
    ['AC-API']
  );
  assert.deepEqual(coverage.singlePolarityCriteria[0].missing, ['positive']);
});

test('F2: an uncovered conditional AC is a gap, not a single-polarity warning', () => {
  const coverage = buildCoverage(
    [
      {
        id: 'TC-1',
        coversAcceptanceCriteria: ['AC-1'],
        caseIntent: 'negative',
        title: 'Generate Results disabled when radius is 0',
        bddScenario: 'Given radius is 0 Then the Generate Results button is disabled',
      },
    ],
    [
      { id: 'AC-1', text: 'Generate Results button is disabled when radius is missing or 0' },
      { id: 'AC-2', text: 'Save Project button is disabled when the address field is empty' },
    ]
  );
  // AC-2 is conditional but nothing covers it → it's a true uncovered gap, not single-polarity.
  assert.ok(coverage.uncoveredCriteria.includes('AC-2'));
  assert.ok(!coverage.singlePolarityCriteria.some((item) => item.criterionId === 'AC-2'));
  // AC-1 is covered by only a negative case → single-polarity.
  assert.ok(coverage.singlePolarityCriteria.some((item) => item.criterionId === 'AC-1'));
});

test('validates manual DB verification cases in API scope', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3016] Verify old dataset schema inference',
      jiraReference: 'ORB-3016',
      executionType: 'manual_db',
      manualVerification: {
        target: 'dataset_schema',
        steps: ['Run SELECT attribute_column, is_dimension, is_measure FROM dataset_schema WHERE dataset_metadata_id = <id>'],
        expectedResult: 'Inference flags are populated according to the AC.',
      },
      bddScenario: `Feature: Dataset schema backfill
Scenario: Verify old dataset schema inference in DB
Given the migration has run
When QA checks dataset_schema using SQL
Then is_dimension and is_measure should match the inference rules`,
    },
    { jiraKey: 'ORB-3016', epic: 'Spatial Analysis', scopeType: 'api', acceptanceCriteria }
  );

  assert.equal(result.valid, true);
});

test('flags Postman cases that claim manually executable DB acceptance criteria', () => {
  const dbCriteria = [{ id: 'AC-DB', text: 'Migration creates dasymetric_h3_level_8 table and unique covering indexes.' }];
  const executionPlan = [
    {
      criterionId: 'AC-DB',
      executionType: 'manual_db' as const,
      observableSurface: 'Database schema and migration state',
      reason: 'The AC is about DDL/index behavior, not an HTTP response.',
      coveragePolicy: 'db_verification' as const,
    },
  ];
  const postmanCase = {
    ...validCase,
    id: 'TC-DB-1',
    title: '[BE][Spatial Analysis][ORB-3310] Submit analysis returns success',
    jiraReference: 'ORB-3310',
    executionType: 'postman' as const,
    coversAcceptanceCriteria: ['AC-DB'],
    apiSpec: {
      method: 'POST',
      path: '/v1/analysis',
      samplePayload: '{"output":{"proportion_method":"DASYMETRIC"}}',
      expectedResponse: '{"id":"<analysis-id>"}',
      assertions: ['response status is 201'],
    },
    bddScenario: `Feature: Analysis API
Scenario: Submit dasymetric analysis
Given the user is authenticated
When the user sends POST /v1/analysis with payload:
"""
{"output":{"proportion_method":"DASYMETRIC"}}
"""
Then the response status should be 201
And the response body should include "id"`,
  };

  const validation = validateCase(postmanCase, {
    jiraKey: 'ORB-3310',
    epic: 'Spatial Analysis',
    scopeType: 'api',
    acceptanceCriteria: dbCriteria,
    acceptanceCriteriaExecutionPlan: executionPlan,
  });
  const coverage = buildCoverage([postmanCase], dbCriteria, { scopeType: 'api', acceptanceCriteriaExecutionPlan: executionPlan });

  assert.equal(validation.valid, true);
  assert.match(validation.warnings.join('\n'), /classified as manual_db/);
  assert.deepEqual(coverage.unsubstantiatedClaims, [{ caseId: 'TC-DB-1', criterionId: 'AC-DB' }]);
  assert.deepEqual(coverage.uncoveredCriteria, ['AC-DB']);
});

test('web coverage accepts legacy FE BDD evidence without Postman execution mismatch', () => {
  const webCriteria = [
    {
      id: 'AC-4',
      text:
        'The onboarding module walkthrough content must be defined on the frontend in a local module definition file, including step content and total step count derived locally; the backend must not be responsible for step content, step ordering, or total_steps.',
    },
    {
      id: 'AC-5',
      text:
        'When a module is opened, the frontend must compare the saved walkthrough_version from progress with the local config version. If the versions match, it must resume from the saved current_step when status is in_progress.',
    },
    {
      id: 'AC-6',
      text:
        'When a module is opened and the saved walkthrough_version does not match the local config version, the frontend must reset progress to not_started and start the tour from step 1 by sending PUT /onboarding/progress/{module_id} with status not_started before the tour starts.',
    },
    {
      id: 'AC-9',
      text:
        'All onboarding API endpoints must require a valid Authorization: Bearer token, and module-specific progress updates must fail when the module_id is not found or is not accessible for the user’s org.',
    },
  ];
  const executionPlan = webCriteria.map((criterion) => ({
    criterionId: criterion.id,
    executionType: criterion.id === 'AC-9' ? ('manual_other' as const) : ('manual_integration' as const),
    observableSurface: 'Web UI / frontend runtime behavior',
    reason: 'Web-scope criterion.',
    coveragePolicy: criterion.id === 'AC-9' ? ('manual_verification' as const) : ('integration_verification' as const),
  }));
  const cases = [
    {
      ...validCase,
      id: 'TC-ORB-3218-004',
      title: '[FE][Miscellaneous][ORB-3218] Render walkthrough steps from local module definition file only',
      jiraReference: 'ORB-3218',
      coversAcceptanceCriteria: ['AC-4'],
      preconditions: 'The local onboarding module definition file exists and includes step content plus locally derived total step count.',
      bddScenario: `Feature: Bring Your Own Data Onboarding Module
Scenario: Walkthrough content is sourced from local frontend module definition
Given the Bring Your Own Data module is opened
Given the local module definition file is loaded
When the frontend renders the walkthrough
Then the step content comes from the local module definition file
And the total step count is derived locally
And the backend is not required to provide step content, step ordering, or total_steps`,
    },
    {
      ...validCase,
      id: 'TC-ORB-3218-005',
      title: '[FE][Miscellaneous][ORB-3218] Resume in-progress walkthrough when saved version matches local version',
      jiraReference: 'ORB-3218',
      coversAcceptanceCriteria: ['AC-5'],
      preconditions: 'Saved walkthrough_version matches the local config version and saved status is in_progress with a current_step value.',
      bddScenario: `Feature: Bring Your Own Data Onboarding Module
Scenario: Matching walkthrough version resumes from saved current_step
Given the module is opened
Given the saved walkthrough_version matches the local config version
Given the saved status is in_progress
When the frontend resolves the starting step
Then the walkthrough resumes from the saved current_step`,
    },
    {
      ...validCase,
      id: 'TC-ORB-3218-008',
      title: '[FE][Miscellaneous][ORB-3218] Reset progress to not_started and start at step 1 when walkthrough version mismatches',
      jiraReference: 'ORB-3218',
      coversAcceptanceCriteria: ['AC-6'],
      preconditions: 'Saved walkthrough_version does not match the local config version and the user is authenticated.',
      bddScenario: `Feature: Bring Your Own Data Onboarding Module
Scenario: Version mismatch resets progress before the tour starts
Given the module is opened
Given the saved walkthrough_version does not match the local config version
When the frontend detects the mismatch before starting the tour
Then it sends PUT /onboarding/progress/{module_id} with status not_started
And the tour starts from step 1 before the walkthrough begins`,
    },
    {
      ...validCase,
      id: 'TC-ORB-3218-012',
      title: '[FE][Miscellaneous][ORB-3218] Reject progress update when Authorization Bearer token is missing or invalid',
      jiraReference: 'ORB-3218',
      coversAcceptanceCriteria: ['AC-9'],
      preconditions: 'The user is not authenticated or the Bearer token is invalid.',
      bddScenario: `Feature: Bring Your Own Data Onboarding Module
Scenario: Onboarding API calls fail without a valid Authorization Bearer token
Given a request is made to an onboarding endpoint
Given the Authorization Bearer token is missing or invalid
When the frontend attempts to call the onboarding API
Then the request is rejected
And no onboarding progress is stored or updated`,
    },
  ];

  const coverage = buildCoverage(cases, webCriteria, {
    scopeType: 'web',
    acceptanceCriteriaExecutionPlan: executionPlan,
  });

  assert.equal(coverage.coveredCriteria, 4);
  assert.deepEqual(coverage.uncoveredCriteria, []);
  assert.deepEqual(coverage.unsubstantiatedClaims, []);
});

test('rejects manual code review cases without manual verification evidence', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[BE][Spatial Analysis][ORB-3310] Verify generated proto output field',
      jiraReference: 'ORB-3310',
      executionType: 'manual_code_review',
      coversAcceptanceCriteria: ['AC-CODE'],
      bddScenario: `Feature: Proto code review
Scenario: Verify generated output field
Given the implementation branch is available
When QA reviews the generated proto code
Then Output should expose the proportion_method field`,
    },
    {
      jiraKey: 'ORB-3310',
      epic: 'Spatial Analysis',
      scopeType: 'api',
      acceptanceCriteria: [{ id: 'AC-CODE', text: 'Generated proto Output includes proportion_method.' }],
    }
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Manual code review case must include manualVerification\.target/);
  assert.match(result.errors.join('\n'), /Manual code review case must include manualVerification\.steps/);
  assert.match(result.errors.join('\n'), /Manual code review case must include manualVerification\.expectedResult/);
});
