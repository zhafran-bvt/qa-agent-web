import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCoverage,
  endpointIsDocumented,
  normalizeAcceptanceCriteriaId,
  normalizeEndpointPath,
  validateCase,
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
