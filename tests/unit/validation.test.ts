import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverage, normalizeAcceptanceCriteriaId, validateCase } from '../../src/server/services/validation';

const acceptanceCriteria = [
  { id: 'AC-1', text: 'Adm Area filter is required before Add Dataset button enabled' },
  { id: 'AC-2', text: 'Adm Area filter follows Global Area Filter sync' },
];

const validCase = {
  title: '[Web][Spatial Analysis][ORB-3077] Save project with BVT polygon datasets',
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
    { ...validCase, title: '[Web][Spatial Analysis][ORB-3039] Save project with BVT polygon datasets' },
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

test('rejects backend terms for FE-only scope', () => {
  const result = validateCase(
    { ...validCase, bddScenario: `${validCase.bddScenario}\n    And the POST /v1/analysis-configs response should be valid` },
    { jiraKey: 'ORB-3077', epic: 'Spatial Analysis', feOnly: true, acceptanceCriteria }
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /FE-only/);
});

test('does not reject FE-only scope when API appears only in title or feature label', () => {
  const result = validateCase(
    {
      ...validCase,
      title: '[Web][Spatial Analysis][ORB-3118] Enable Add Dataset after Adm Area filter is selected',
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
        title: '[Web][Spatial Analysis][ORB-3077] Global filter sync updates Adm Area',
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
