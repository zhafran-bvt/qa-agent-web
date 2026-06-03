import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerationPromptContext,
  buildScopePriorityContext,
  findAcceptanceCriteriaArray,
  findCaseArray,
  isFallbackError,
  normalizeBddScenario,
  normalizeCase,
  normalizeJiraReference,
  normalizeScopeSnapshotTranslation,
  normalizeTextList,
} from '../../src/server/services/llm';

test('finds generated cases from common LLM JSON wrappers', () => {
  const testCases = [{ title: 'Case', bddScenario: 'Feature: Example' }];
  assert.equal(findCaseArray({ testCases }), testCases);
  assert.equal(findCaseArray({ test_cases: testCases }), testCases);
  assert.equal(findCaseArray({ result: { cases: testCases } }), testCases);
  assert.equal(findCaseArray({ data: { items: testCases } }), testCases);
});

test('finds synthesized acceptance criteria arrays from common wrappers', () => {
  const acceptanceCriteria = [{ id: 'AC-1', text: 'Criterion' }];
  assert.equal(findAcceptanceCriteriaArray({ acceptanceCriteria }), acceptanceCriteria);
  assert.equal(findAcceptanceCriteriaArray({ acceptance_criteria: acceptanceCriteria }), acceptanceCriteria);
});

test('normalizes snake case LLM fields', () => {
  assert.deepEqual(
    normalizeCase(
      {
        test_case_id: 'TC-01',
        title: '[Web][Spatial Analysis][ORB-3118] Example',
        type: 'Happy Path',
        jira_reference: 'ORB-3118',
        preconditions: 'User is logged in.',
        bdd_scenario: 'Feature: Example\nScenario: Example\nGiven x\nWhen y\nThen z',
        evidence: {
          coverageNote: 'This case verifies the main user workflow against the mapped acceptance criterion.',
        },
      },
      0
    ),
    {
      id: 'TC-01',
      title: '[Web][Spatial Analysis][ORB-3118] Example',
      type: 'Happy Path',
      jiraReference: 'ORB-3118',
      preconditions: 'User is logged in.',
      bddScenario: 'Feature: Example\nScenario: Example\nGiven x\nWhen y\nThen z',
      coversAcceptanceCriteria: [],
      sourceScope: [],
      evidence: {
        prdSectionTitle: '',
        acceptanceCriteria: [],
        coverageNote: 'This case verifies the main user workflow against the mapped acceptance criterion.',
      },
    }
  );
});

test('normalizes coverage metadata fields', () => {
  assert.deepEqual(
    normalizeCase(
      {
        title: '[Web][Spatial Analysis][ORB-3118] Example',
        covers_acceptance_criteria: ['AC-1', 'AC-2'],
        source_scope: ['Jira', 'Confluence'],
      },
      0
    ).coversAcceptanceCriteria,
    ['AC-1', 'AC-2']
  );
});

test('normalizes top-level coverage note fallback', () => {
  assert.equal(
    normalizeCase(
      {
        title: '[Web][Spatial Analysis][ORB-3118] Example',
        coverage_note: 'This case proves the feature behavior against the PRD mapping.',
      },
      0
    ).evidence.coverageNote,
    'This case proves the feature behavior against the PRD mapping.'
  );
});

test('normalizes jira references down to the main ticket key', () => {
  assert.equal(normalizeJiraReference('ORB-3079 / AC-1'), 'ORB-3079');
  assert.equal(normalizeJiraReference('orb-3079, AC-2'), 'ORB-3079');
  assert.equal(normalizeJiraReference('ORB-3079'), 'ORB-3079');
});

test('normalizes list preconditions into textarea-friendly text', () => {
  assert.equal(normalizeTextList(['User is logged in.', 'Dataset page is open.']), 'User is logged in.\nDataset page is open.');
});

test('normalizes structured BDD objects into Gherkin text', () => {
  assert.equal(
    normalizeBddScenario({
      Feature: 'Filter Line Dataset by Admin Area',
      Scenario: 'Add Dataset remains disabled until Adm Area filter is selected',
      Given: ['the user opens the line dataset selection screen', 'the Adm Area filter is required for the dataset'],
      When: ['the user views the dataset action area'],
      Then: ['the Add Dataset button should be disabled'],
    }),
    [
      'Feature: Filter Line Dataset by Admin Area',
      'Scenario: Add Dataset remains disabled until Adm Area filter is selected',
      'Given the user opens the line dataset selection screen',
      'Given the Adm Area filter is required for the dataset',
      'When the user views the dataset action area',
      'Then the Add Dataset button should be disabled',
    ].join('\n')
  );
});

test('falls back on rate limit status', () => {
  const error = new Error('Too many requests') as Error & { statusCode?: number };
  error.statusCode = 429;
  assert.equal(isFallbackError(error), true);
});

test('falls back on quota and token errors', () => {
  assert.equal(isFallbackError(new Error('insufficient_quota')), true);
  assert.equal(isFallbackError(new Error('context length exceeded')), true);
  assert.equal(isFallbackError(new Error('token limit exceeded')), true);
});

test('does not fall back on ordinary validation or auth errors', () => {
  const auth = new Error('Unauthorized') as Error & { statusCode?: number };
  auth.statusCode = 401;
  assert.equal(isFallbackError(auth), false);
  assert.equal(isFallbackError(new Error('invalid JSON schema')), false);
});

test('prefers main ticket description over story context when description is meaningful', () => {
  const scopePriority = buildScopePriorityContext({
    ticketKey: 'ORB-3118',
    epic: 'Spatial Analysis',
    mainIssue: {
      key: 'ORB-3118',
      description: `Add Admin Area filter to the line dataset flow.\nThe Add Dataset button stays disabled until a valid value is selected.\n\nAC:\n1. Adm Area filter is required\n2. Adm Area filter follows global sync`,
    },
    linkedIssues: [],
    confluencePages: [],
    scopeParentIssue: { key: 'ORB-2870', summary: 'Story context only' },
    scopeParentRelation: 'is child of',
    scopeConfluenceSection: null,
    scopeAuthority: {
      type: 'main_jira_description',
      title: 'ORB-3118',
      body: 'Add Admin Area filter to the line dataset flow.\nThe Add Dataset button stays disabled until a valid value is selected.',
      reason: 'Use the main Jira issue first.',
      quality: 'high',
      sourceIssueKey: 'ORB-3118',
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'Adm Area filter is required' }],
    userStories: [],
    acceptanceCriteriaSource: 'combined',
    confidenceLevel: 'high',
    confidenceReasons: [],
    requiresConfidencePermission: false,
    acceptanceCriteriaDiagnostics: { allIssueUserStories: [], allIssueCriteria: [], confluenceCriteria: [] },
    constraints: { feOnly: true, beAlreadyTested: false },
    actualDevScopeGuidance: 'Use the main Jira issue first.',
    coverageEnforced: true,
    manualScopeOverride: false,
    manualScopeOverrideReason: '',
  });

  assert.equal(scopePriority.primaryAuthority, 'main_jira_description');
  assert.match(scopePriority.mainTicketDescription, /Add Admin Area filter/);
});

test('falls back to acceptance criteria when description is only AC content', () => {
  const scopePriority = buildScopePriorityContext({
    ticketKey: 'ORB-3118',
    epic: 'Spatial Analysis',
    mainIssue: {
      key: 'ORB-3118',
      description: `AC:\n1. Adm Area filter is required\n2. Adm Area filter follows global sync`,
    },
    linkedIssues: [],
    confluencePages: [],
    scopeParentIssue: { key: 'ORB-2870', summary: 'Story context only' },
    scopeParentRelation: 'is child of',
    scopeConfluenceSection: null,
    scopeAuthority: {
      type: 'main_jira_acceptance_criteria',
      title: 'ORB-3118',
      body: 'AC-1. Adm Area filter is required',
      reason: 'Use the main Jira issue first.',
      quality: 'high',
      sourceIssueKey: 'ORB-3118',
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'Adm Area filter is required' }],
    userStories: [],
    acceptanceCriteriaSource: 'combined',
    confidenceLevel: 'high',
    confidenceReasons: [],
    requiresConfidencePermission: false,
    acceptanceCriteriaDiagnostics: { allIssueUserStories: [], allIssueCriteria: [], confluenceCriteria: [] },
    constraints: { feOnly: true, beAlreadyTested: false },
    actualDevScopeGuidance: 'Use the main Jira issue first.',
    coverageEnforced: true,
    manualScopeOverride: false,
    manualScopeOverrideReason: '',
  });

  assert.equal(scopePriority.primaryAuthority, 'main_jira_acceptance_criteria');
  assert.equal(scopePriority.mainTicketDescription, '');
});

test('uses matched PRD subsection as primary authority for thin-ticket PRD fallback', () => {
  const scopePriority = buildScopePriorityContext({
    ticketKey: 'ORB-3157',
    epic: 'AI Assistance',
    mainIssue: {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
    },
    linkedIssues: [],
    confluencePages: [],
    scopeParentIssue: { key: 'ORB-1248', summary: 'AI Assistance Summary Result', issueType: 'Story' },
    scopeParentRelation: 'is child of',
    scopeConfluenceSection: {
      pageId: '950075398',
      title: 'AI Powered Assistance',
      url: 'https://example.test/prd#AI-Summary-NO-SCORE',
      anchor: 'AI-Summary-NO-SCORE',
      matchedHeading: 'AI Summary NO SCORE',
      matched: true,
      reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
      sourceIssueKey: 'ORB-1248',
      body: 'The AI Summary tab is available for no-score analysis. General Summary uses absolute profiling. Strategic Takeaways remain available.',
    },
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'AI Summary NO SCORE',
      body: 'The AI Summary tab is available for no-score analysis. General Summary uses absolute profiling. Strategic Takeaways remain available.',
      reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
      quality: 'high',
      sourceIssueKey: 'ORB-1248',
      pageId: '950075398',
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'No-score AI Summary behavior is available' }],
    userStories: [],
    acceptanceCriteriaSource: 'parent_story_confluence_section',
    confidenceLevel: 'high',
    confidenceReasons: [],
    requiresConfidencePermission: false,
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      thinTicketFallbackUsed: true,
      prdSubsectionMatchQuality: 'confident',
    },
    constraints: { feOnly: true, beAlreadyTested: false },
    actualDevScopeGuidance: 'Use the matched PRD subsection for thin tickets.',
    coverageEnforced: true,
    manualScopeOverride: false,
    manualScopeOverrideReason: '',
  });

  assert.equal(scopePriority.primaryAuthority, 'matched_prd_subsection');
  assert.ok(scopePriority.matchedPrdSubsection);
  assert.equal(scopePriority.matchedPrdSubsection.title, 'AI Summary NO SCORE');
  assert.match(scopePriority.matchedPrdSubsection.body, /Strategic Takeaways/);
});

test('P3: the no-scopeAuthority fallback emits the unified main_jira_* authority vocabulary', () => {
  // Simulates an older/replayed context that predates scopeAuthority. The
  // fallback must use the same vocabulary as the rest of the system, not the
  // legacy main_ticket_* names.
  const base = {
    ticketKey: 'ORB-9100',
    epic: 'Spatial Analysis',
    linkedIssues: [],
    confluencePages: [],
    scopeParentIssue: null,
    scopeParentRelation: '',
    scopeConfluenceSection: null,
    // scopeAuthority intentionally omitted.
    userStories: [],
    acceptanceCriteriaSource: 'main_jira',
    confidenceLevel: 'high',
    confidenceReasons: [],
    requiresConfidencePermission: false,
    acceptanceCriteriaDiagnostics: { allIssueUserStories: [], allIssueCriteria: [], confluenceCriteria: [] },
    constraints: { feOnly: true, beAlreadyTested: false },
    actualDevScopeGuidance: 'Use the main Jira issue first.',
    coverageEnforced: true,
    manualScopeOverride: false,
    manualScopeOverrideReason: '',
  };

  const withDescription = buildScopePriorityContext({
    ...base,
    mainIssue: { key: 'ORB-9100', description: 'Add an export button to the analysis results toolbar.' },
    acceptanceCriteria: [{ id: 'AC-1', text: 'Export button is shown' }],
  } as any);
  assert.equal(withDescription.primaryAuthority, 'main_jira_description');

  const acOnly = buildScopePriorityContext({
    ...base,
    mainIssue: { key: 'ORB-9100', description: 'AC:\n1. Export button is shown' },
    acceptanceCriteria: [{ id: 'AC-1', text: 'Export button is shown' }],
  } as any);
  assert.equal(acOnly.primaryAuthority, 'main_jira_acceptance_criteria');
});

test('builds a slim generation prompt context without noisy diagnostics criteria dumps', () => {
  const payload = buildGenerationPromptContext({
    ticketKey: 'ORB-3079',
    epic: 'Spatial Analysis',
    mainIssue: {
      key: 'ORB-3079',
      summary: '[FE] Integration API - Run Analysis with BVT Polygon Catchment Datasets',
      description: 'Main issue description',
    },
    linkedIssues: [{ key: 'ORB-3090', summary: 'Blocking dependency', classification: 'blocking dependency' }],
    confluencePages: [],
    scopeParentIssue: { key: 'ORB-2873', summary: 'Parent story', issueType: 'Story' },
    scopeParentRelation: 'is child of',
    scopeConfluenceSection: {
      pageId: '1',
      title: 'PRD',
      url: 'https://example.test',
      anchor: 'story',
      matchedHeading: 'As User, I want to select spatial input based on BVT Data',
      matched: true,
      reason: '',
      sourceIssueKey: 'ORB-2873',
      body: 'Scoped PRD section',
    },
    scopeAuthority: {
      type: 'main_jira_description',
      title: '[FE] Integration API - Run Analysis with BVT Polygon Catchment Datasets',
      body: 'Main issue description',
      reason: 'Use the main Jira issue first.',
      quality: 'high',
      sourceIssueKey: 'ORB-3079',
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'Canonical acceptance criterion' }],
    userStories: [{ id: 'US-1', text: 'As User, I want ...' }],
    acceptanceCriteriaSource: 'main_jira',
    confidenceLevel: 'high',
    confidenceReasons: [],
    requiresConfidencePermission: false,
    acceptanceCriteriaDiagnostics: { allIssueUserStories: [], allIssueCriteria: [{ id: 'AC-99', text: 'Noisy raw criterion' }], confluenceCriteria: [] },
    constraints: { feOnly: true, beAlreadyTested: false },
    actualDevScopeGuidance: 'Use the main Jira issue first.',
    coverageEnforced: true,
    manualScopeOverride: false,
    manualScopeOverrideReason: '',
  });

  assert.equal('acceptanceCriteriaDiagnostics' in payload, false);
  assert.deepEqual(payload.acceptanceCriteria, [{ id: 'AC-1', text: 'Canonical acceptance criterion' }]);
  assert.equal(payload.scopeAuthority?.type, 'main_jira_description');
});

test('localizes scope snapshot with field-by-field fallback and preserves ids', () => {
  const context: any = {
    mainIssue: { summary: '[FE] AI Summary - no scoring' },
    scopeParentIssue: { summary: 'AI Assistance Summary Result' },
    scopeConfluenceSection: { matchedHeading: 'AI Summary NO SCORE', title: 'AI Powered Assistance' },
    confidenceReasons: [
      'Acceptance criteria were synthesized from structured technical design because deterministic extraction was weak.',
      'Main Jira scope was insufficient, so the matched PRD subsection was used.',
    ],
    acceptanceCriteriaDiagnostics: {
      selectedAcceptanceCriteriaReason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
    },
    userStories: [{ id: 'US-1', text: 'AI Assistance Summary Result' }],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text: 'The AI Summary tab is available for analysis results with no score.',
        sourceExcerpt: 'The AI Summary tab is available in the Analysis Summary window.',
        sourceExcerptLocation: 'PRD: AI Summary NO SCORE',
        sourceExcerptUrl: 'https://example.test/prd#AI-Summary-NO-SCORE',
        sourceExcerptKind: 'prd',
      },
      {
        id: 'AC-2',
        text: 'Strategic Takeaways remain available for the no-score variant.',
      },
    ],
  };

  const localized = normalizeScopeSnapshotTranslation(
    {
      mainSummary: 'AI Summary untuk hasil tanpa score',
      parentStorySummary: '',
      scopedPrdSection: 'AI Summary NO SCORE',
      confidenceReasons: ['AC final dibentuk dari penjelasan teknis karena hasil ekstraksi otomatisnya kurang kuat.'],
      selectedAcceptanceCriteriaReason: '',
      userStories: [{ id: 'US-1', text: 'Ringkasan hasil AI Assistance' }],
      acceptanceCriteria: [{ id: 'AC-1', text: 'Tab AI Summary tersedia untuk hasil analisis tanpa score.' }],
    },
    context
  );

  assert.equal(localized.mainSummary, 'AI Summary untuk hasil tanpa score');
  assert.equal(localized.parentStorySummary, 'AI Assistance Summary Result');
  assert.equal(localized.confidenceReasons.length, 2);
  assert.equal(localized.confidenceReasons[1], 'Main Jira scope was insufficient, so the matched PRD subsection was used.');
  assert.equal(localized.selectedAcceptanceCriteriaReason, 'Main Jira scope was insufficient, so the matched PRD subsection was used.');
  assert.deepEqual(localized.userStories, [{ id: 'US-1', text: 'Ringkasan hasil AI Assistance' }]);
  assert.equal(localized.acceptanceCriteria.length, 2);
  assert.equal(localized.acceptanceCriteria[0].id, 'AC-1');
  assert.equal(localized.acceptanceCriteria[0].text, 'Tab AI Summary tersedia untuk hasil analisis tanpa score.');
  assert.equal(localized.acceptanceCriteria[0].sourceExcerptLocation, 'PRD: AI Summary NO SCORE');
  assert.equal(localized.acceptanceCriteria[0].sourceExcerptUrl, 'https://example.test/prd#AI-Summary-NO-SCORE');
  assert.equal(localized.acceptanceCriteria[1].id, 'AC-2');
  assert.equal(localized.acceptanceCriteria[1].text, 'Strategic Takeaways remain available for the no-score variant.');
});
