import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaseEvidence, hydrateTestCasesWithEvidence } from '../../src/server/services/evidence';
import type { GeneratedTestCase, QaContext } from '../../src/shared/contracts';

const context: QaContext = {
  ticketKey: 'ORB-3118',
  epic: 'Spatial Analysis',
  mainIssue: {
    key: 'ORB-3118',
    summary: '[FE] Integrate API - Filter Line Dataset by Admin Area',
  },
  linkedIssues: [],
  confluencePages: [],
  scopeParentIssue: {
    key: 'ORB-2870',
    summary: 'As a PM, I want the filter function can handle data contain multiple administrative area list',
  },
  scopeParentRelation: 'is child of',
  scopeConfluenceSection: {
    pageId: '897351682',
    title: 'Handling Administrative Area Filter',
    url: 'https://example.test/wiki/pages/897351682',
    anchor: '5-story',
    matchedHeading: '5. As a PM, I want the filter function can handle data contain multiple administrative area list',
    matched: true,
    reason: '',
    sourceIssueKey: 'ORB-2870',
    body: 'Acceptance Criteria...',
  },
  acceptanceCriteria: [
    { id: 'AC-1', text: 'Matching: A row is included when any administrative area matches the filter selection.' },
    { id: 'AC-2', text: 'Integrity: The system returns the original record with no row splitting.' },
  ],
  userStories: [{ id: 'US-1', text: 'As a PM, I want...' }],
  acceptanceCriteriaSource: 'combined',
  confidenceLevel: 'high',
  confidenceReasons: ['Main Jira ticket contains explicit acceptance criteria.'],
  requiresConfidencePermission: false,
  acceptanceCriteriaDiagnostics: {
    allIssueUserStories: [],
    allIssueCriteria: [],
    confluenceCriteria: [],
  },
  constraints: {
    feOnly: true,
    beAlreadyTested: false,
    notes: '',
  },
  actualDevScopeGuidance: 'Use the main Jira issue and scoped Story PRD section.',
};

const testCase: GeneratedTestCase = {
  id: 'TC-01',
  title: '[Web][Spatial Analysis][ORB-3118] Example',
  type: 'Happy Path',
  jiraReference: 'ORB-3118',
  preconditions: 'User is on the dataset screen.',
  bddScenario: 'Feature: Example\nScenario: Example\nGiven x\nWhen y\nThen z',
  coversAcceptanceCriteria: ['AC-1', 'AC-9'],
  sourceScope: ['ORB-3118', 'ORB-2870'],
  evidence: {
    prdSectionTitle: '',
    acceptanceCriteria: [],
    coverageNote: 'This case verifies the matching behavior against the scoped PRD acceptance criterion.',
  },
};

test('builds deterministic evidence from PRD section and mapped ACs', () => {
  const evidence = buildCaseEvidence(testCase, context);
  assert.equal(evidence.prdSectionTitle, '5. As a PM, I want the filter function can handle data contain multiple administrative area list');
  assert.deepEqual(evidence.acceptanceCriteria, [context.acceptanceCriteria[0]]);
  assert.equal(evidence.coverageNote, testCase.evidence.coverageNote);
});

test('falls back to story summary when scoped PRD heading is unavailable', () => {
  const fallbackContext = {
    ...context,
    scopeConfluenceSection: null,
  };
  assert.equal(buildCaseEvidence(testCase, fallbackContext).prdSectionTitle, context.scopeParentIssue?.summary);
});

test('hydrates generated cases with deterministic evidence', () => {
  const hydrated = hydrateTestCasesWithEvidence([testCase], context);
  assert.equal(hydrated[0].evidence.acceptanceCriteria.length, 1);
  assert.equal(hydrated[0].evidence.coverageNote, testCase.evidence.coverageNote);
});
