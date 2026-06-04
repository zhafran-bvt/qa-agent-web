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
    url: 'https://example.test/wiki/pages/897351682#5-story',
    anchor: '5-story',
    matchedHeading: '5. As a PM, I want the filter function can handle data contain multiple administrative area list',
    matched: true,
    reason: '',
    sourceIssueKey: 'ORB-2870',
    body: 'Acceptance Criteria...',
  },
  scopeAuthority: {
    type: 'matched_prd_subsection',
    title: '5. As a PM, I want the filter function can handle data contain multiple administrative area list',
    body: 'Acceptance Criteria...',
    reason: 'Use the main Jira issue and scoped Story PRD section.',
    quality: 'high',
    sourceIssueKey: 'ORB-2870',
    pageId: '897351682',
  },
  acceptanceCriteria: [
    {
      id: 'AC-1',
      text: 'Matching: A row is included when any administrative area matches the filter selection.',
      sourceExcerpts: [
        {
          text: 'A row is included when any administrative area matches the filter selection.',
          location: 'PRD: 5. As a PM, I want the filter function can handle data contain multiple administrative area list',
          url: 'https://example.test/wiki/pages/897351682#5-story',
          kind: 'prd',
          confidence: 'verbatim',
        },
        {
          text: 'The original record remains intact with no row splitting.',
          location: 'PRD: 5. As a PM, I want the filter function can handle data contain multiple administrative area list',
          url: 'https://example.test/wiki/pages/897351682#5-story',
          kind: 'prd',
          confidence: 'closest',
        },
      ],
      sourceExcerpt: 'A row is included when any administrative area matches the filter selection.',
      sourceExcerptLocation: 'PRD: 5. As a PM, I want the filter function can handle data contain multiple administrative area list',
      sourceExcerptUrl: 'https://example.test/wiki/pages/897351682#5-story',
      sourceExcerptKind: 'prd',
      sourceExcerptConfidence: 'verbatim',
    },
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
  assert.equal(evidence.acceptanceCriteria[0].sourceExcerptKind, 'prd');
  assert.equal(evidence.acceptanceCriteria[0].sourceExcerptUrl, 'https://example.test/wiki/pages/897351682#5-story');
  assert.equal(evidence.acceptanceCriteria[0].sourceExcerpts?.length, 2);
  assert.match(evidence.acceptanceCriteria[0].sourceExcerpt || '', /administrative area matches/i);
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
