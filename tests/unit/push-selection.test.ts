import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeneratedTestCase, QaContext } from '../../src/shared/contracts';
import { clarificationBlockedCaseIds, resolvePushSelection } from '../../src/server/services/push-selection';

function generatedCase(id: string, criterionId: string): GeneratedTestCase {
  return {
    id,
    title: `[BE][Spatial Analysis][ORB-2565] ${criterionId}`,
    goal: criterionId,
    type: 'BDD',
    caseIntent: 'positive',
    jiraReference: 'ORB-2565',
    preconditions: 'A known analysis fixture exists.',
    inputs: 'analysis_id=fixture-1',
    expectedResult: `${criterionId} is satisfied.`,
    bddScenario: `Feature: Coverage\nScenario: ${criterionId}\nGiven a known fixture\nWhen the behavior is verified\nThen ${criterionId} is satisfied`,
    coversAcceptanceCriteria: [criterionId],
    sourceScope: [],
    evidence: { prdSectionTitle: '', acceptanceCriteria: [], coverageNote: `Verifies ${criterionId}.` },
  };
}

const context = {
  acceptanceCriteriaDiagnostics: {
    directRequirements: [
      {
        id: 'REQ-1',
        text: 'The response includes the first coverage value.',
        disposition: 'in_scope',
        sourceKind: 'spec',
        sourceLocation: 'Spec: Result contract',
        acceptanceCriteriaIds: ['AC-1'],
      },
      {
        id: 'REQ-2',
        text: 'The empty-value fallback is TBD.',
        disposition: 'needs_clarification',
        sourceKind: 'spec',
        sourceLocation: 'Spec: Result contract',
        acceptanceCriteriaIds: ['AC-2'],
        clarificationReason: 'The source leaves the fallback undefined.',
      },
    ],
  },
} as QaContext;

const suite = [generatedCase('TC-ORB-2565-001', 'AC-1'), generatedCase('TC-ORB-2565-002', 'AC-2'), generatedCase('TC-ORB-2565-003', 'AC-3')];

test('clarification blocking is scoped only to cases mapped to the ambiguous requirement', () => {
  assert.deepEqual(clarificationBlockedCaseIds(context, suite), ['TC-ORB-2565-002']);

  const selection = resolvePushSelection(context, suite);
  assert.deepEqual(selection.blockedCaseIds, ['TC-ORB-2565-002']);
  assert.deepEqual(selection.selectedCases.map((testCase) => testCase.id), ['TC-ORB-2565-001', 'TC-ORB-2565-003']);
});

test('push selection preserves the full suite while allowing only the requested ready subset', () => {
  const ready = resolvePushSelection(context, suite, ['TC-ORB-2565-003']);
  assert.deepEqual(ready.selectedCases.map((testCase) => testCase.id), ['TC-ORB-2565-003']);
  assert.deepEqual(ready.unknownCaseIds, []);

  const blocked = resolvePushSelection(context, suite, ['TC-ORB-2565-002']);
  assert.deepEqual(blocked.selectedCases.map((testCase) => testCase.id), ['TC-ORB-2565-002']);
  assert.deepEqual(blocked.blockedCaseIds, ['TC-ORB-2565-002']);

  assert.deepEqual(resolvePushSelection(context, suite, []).selectedCases, []);
  assert.deepEqual(resolvePushSelection(context, suite, ['TC-UNKNOWN']).unknownCaseIds, ['TC-UNKNOWN']);
});

test('trusted blocker IDs cannot be bypassed by changing a case AC mapping in the request payload', () => {
  const editedSuite = suite.map((testCase) =>
    testCase.id === 'TC-ORB-2565-002' ? { ...testCase, coversAcceptanceCriteria: ['AC-1'] } : testCase
  );
  const selection = resolvePushSelection(
    context,
    editedSuite,
    ['TC-ORB-2565-002'],
    clarificationBlockedCaseIds(context, suite)
  );

  assert.deepEqual(selection.blockedCaseIds, ['TC-ORB-2565-002']);
  assert.deepEqual(selection.selectedCases.map((testCase) => testCase.id), ['TC-ORB-2565-002']);
});
