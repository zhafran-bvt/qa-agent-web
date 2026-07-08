import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerationPromptContext,
  buildChatCompletionBody,
  buildDeterministicDuplicateRecommendations,
  buildScopePriorityContext,
  buildScenarioPlan,
  canonicalizeApiSpecPaths,
  configuredLlmProviders,
  findAcceptanceCriteriaArray,
  findCaseArray,
  getMissingScenarioPlanItems,
  getUnderGranularAcceptanceCriteria,
  getSinglePolarityGaps,
  isFallbackError,
  isRetryableLlmContentError,
  maxOutputTokensForTask,
  mergeGeneratedCasesWithQualityGate,
  mergeRepairedCases,
  normalizeAssertionList,
  normalizeBddScenario,
  normalizeCase,
  normalizeJiraReference,
  normalizeScopeSnapshotTranslation,
  normalizeTextList,
  orderLlmProviders,
  providerContent,
  providerBehavior,
  allowLlmFallback,
  usesFastAcceptanceCriteriaPath,
  usesFastGenerationPath,
} from '../../src/server/services/llm';

test('orders OpenAI first by default while preserving fallback providers', () => {
  const providers = orderLlmProviders([
    { name: 'deepseek', model: 'deepseek-v4-pro' },
    { name: 'openai', model: 'gpt-5.4-mini' },
  ]);

  assert.deepEqual(providers.map((provider) => provider.name), ['openai', 'deepseek']);
});

test('orders DeepSeek first when LLM_PRIMARY_PROVIDER requests it', () => {
  const providers = orderLlmProviders(
    [
      { name: 'openai', model: 'gpt-5.4-mini' },
      { name: 'deepseek', model: 'deepseek-v4-pro' },
    ],
    'deepseek'
  );

  assert.deepEqual(providers.map((provider) => provider.name), ['deepseek', 'openai']);
});

test('configured providers remove disabled providers and skip fallback when disabled', () => {
  const previousPrimary = process.env.LLM_PRIMARY_PROVIDER;
  const previousDisabled = process.env.LLM_DISABLED_PROVIDERS;
  const previousFallback = process.env.LLM_ALLOW_FALLBACK;
  try {
    process.env.LLM_PRIMARY_PROVIDER = 'deepseek';
    process.env.LLM_DISABLED_PROVIDERS = 'openai';
    process.env.LLM_ALLOW_FALLBACK = 'false';

    const providers = configuredLlmProviders([
      { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'openai-key', model: 'gpt-5.4-mini' },
      { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-key', model: 'deepseek-v4-pro' },
    ]);

    assert.equal(allowLlmFallback(), false);
    assert.deepEqual(providers.map((provider) => provider.name), ['deepseek']);
  } finally {
    if (previousPrimary === undefined) delete process.env.LLM_PRIMARY_PROVIDER;
    else process.env.LLM_PRIMARY_PROVIDER = previousPrimary;
    if (previousDisabled === undefined) delete process.env.LLM_DISABLED_PROVIDERS;
    else process.env.LLM_DISABLED_PROVIDERS = previousDisabled;
    if (previousFallback === undefined) delete process.env.LLM_ALLOW_FALLBACK;
    else process.env.LLM_ALLOW_FALLBACK = previousFallback;
  }
});

test('configured providers do not use fallback by default', () => {
  const previousPrimary = process.env.LLM_PRIMARY_PROVIDER;
  const previousDisabled = process.env.LLM_DISABLED_PROVIDERS;
  const previousFallback = process.env.LLM_ALLOW_FALLBACK;
  try {
    process.env.LLM_PRIMARY_PROVIDER = 'deepseek';
    delete process.env.LLM_DISABLED_PROVIDERS;
    delete process.env.LLM_ALLOW_FALLBACK;

    const providers = configuredLlmProviders([
      { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'openai-key', model: 'gpt-5.4-mini' },
      { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-key', model: 'deepseek-v4-pro' },
    ]);

    assert.equal(allowLlmFallback(), false);
    assert.deepEqual(providers.map((provider) => provider.name), ['deepseek']);
  } finally {
    if (previousPrimary === undefined) delete process.env.LLM_PRIMARY_PROVIDER;
    else process.env.LLM_PRIMARY_PROVIDER = previousPrimary;
    if (previousDisabled === undefined) delete process.env.LLM_DISABLED_PROVIDERS;
    else process.env.LLM_DISABLED_PROVIDERS = previousDisabled;
    if (previousFallback === undefined) delete process.env.LLM_ALLOW_FALLBACK;
    else process.env.LLM_ALLOW_FALLBACK = previousFallback;
  }
});

test('configured providers keep ordered fallback only when explicitly allowed', () => {
  const previousPrimary = process.env.LLM_PRIMARY_PROVIDER;
  const previousDisabled = process.env.LLM_DISABLED_PROVIDERS;
  const previousFallback = process.env.LLM_ALLOW_FALLBACK;
  try {
    process.env.LLM_PRIMARY_PROVIDER = 'deepseek';
    delete process.env.LLM_DISABLED_PROVIDERS;
    process.env.LLM_ALLOW_FALLBACK = 'true';

    const providers = configuredLlmProviders([
      { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'openai-key', model: 'gpt-5.4-mini' },
      { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'deepseek-key', model: 'deepseek-v4-pro' },
    ]);

    assert.equal(allowLlmFallback(), true);
    assert.deepEqual(providers.map((provider) => provider.name), ['deepseek', 'openai']);
  } finally {
    if (previousPrimary === undefined) delete process.env.LLM_PRIMARY_PROVIDER;
    else process.env.LLM_PRIMARY_PROVIDER = previousPrimary;
    if (previousDisabled === undefined) delete process.env.LLM_DISABLED_PROVIDERS;
    else process.env.LLM_DISABLED_PROVIDERS = previousDisabled;
    if (previousFallback === undefined) delete process.env.LLM_ALLOW_FALLBACK;
    else process.env.LLM_ALLOW_FALLBACK = previousFallback;
  }
});

test('DeepSeek request bodies include JSON contract and task max tokens', () => {
  const body = buildChatCompletionBody(
    { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'key', model: 'deepseek-v4-pro' },
    'generation',
    {
      model: 'deepseek-v4-pro',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return strict JSON only.' },
        { role: 'user', content: '{"ticketKey":"ORB-1"}' },
      ],
    }
  );

  assert.equal(body.max_tokens, maxOutputTokensForTask('generation'));
  assert.match(String((body.messages as any[])[0].content), /Return exactly one valid JSON object/);
  assert.match(String((body.messages as any[])[0].content), /Return strict JSON only/);
});

test('OpenAI request bodies keep prompts unchanged and use max_completion_tokens', () => {
  const body = buildChatCompletionBody(
    { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'key', model: 'gpt-5.4-mini' },
    'translation',
    {
      model: 'gpt-5.4-mini',
      messages: [{ role: 'system', content: 'Translate scope.' }],
    }
  );

  assert.equal(body.max_completion_tokens, maxOutputTokensForTask('translation'));
  assert.equal(body.max_tokens, undefined);
  assert.equal(String((body.messages as any[])[0].content), 'Translate scope.');
});

test('provider behavior isolates model-specific generation hints from validation', () => {
  const deepseek = providerBehavior({ name: 'deepseek' });
  const openai = providerBehavior({ name: 'openai' });

  assert.equal(deepseek.tokenParameter, 'max_tokens');
  assert.match(deepseek.jsonContract, /Return exactly one valid JSON object/);
  assert.match(deepseek.caseDirectives.join('\n'), /non-duplicative/);
  assert.match(deepseek.caseDirectives.join('\n'), /apiSpec\.assertions must be an array of plain strings/);

  assert.equal(openai.tokenParameter, 'max_completion_tokens');
  assert.equal(openai.jsonContract, '');
  assert.match(openai.caseDirectives.join('\n'), /DB\/migration\/index ACs must be manual_db/);
  assert.doesNotMatch(openai.caseDirectives.join('\n'), /non-duplicative/);
});

test('provider behavior exposes provider-specific repair attempt knobs', () => {
  const previousScenarioAttempts = process.env.LLM_DEEPSEEK_SCENARIO_REPAIR_ATTEMPTS;
  const previousValidationAttempts = process.env.LLM_OPENAI_VALIDATION_REPAIR_ATTEMPTS;
  try {
    process.env.LLM_DEEPSEEK_SCENARIO_REPAIR_ATTEMPTS = '1';
    process.env.LLM_OPENAI_VALIDATION_REPAIR_ATTEMPTS = '0';

    assert.equal(providerBehavior({ name: 'deepseek' }).scenarioPlanRepairMaxAttempts, 1);
    assert.equal(providerBehavior({ name: 'openai' }).validationRepairMaxAttempts, 0);
  } finally {
    if (previousScenarioAttempts === undefined) delete process.env.LLM_DEEPSEEK_SCENARIO_REPAIR_ATTEMPTS;
    else process.env.LLM_DEEPSEEK_SCENARIO_REPAIR_ATTEMPTS = previousScenarioAttempts;
    if (previousValidationAttempts === undefined) delete process.env.LLM_OPENAI_VALIDATION_REPAIR_ATTEMPTS;
    else process.env.LLM_OPENAI_VALIDATION_REPAIR_ATTEMPTS = previousValidationAttempts;
  }
});

test('fast generation path is off by default so full-quality generation runs', () => {
  const previous = process.env.LLM_DEEPSEEK_FAST_GENERATION;
  delete process.env.LLM_DEEPSEEK_FAST_GENERATION;
  try {
    assert.equal(usesFastGenerationPath({ name: 'deepseek' }), false);
    assert.equal(usesFastGenerationPath({ name: 'openai' }), false);
  } finally {
    if (previous === undefined) delete process.env.LLM_DEEPSEEK_FAST_GENERATION;
    else process.env.LLM_DEEPSEEK_FAST_GENERATION = previous;
  }
});

test('DeepSeek fast generation is opt-in via LLM_DEEPSEEK_FAST_GENERATION=true', () => {
  const previous = process.env.LLM_DEEPSEEK_FAST_GENERATION;
  process.env.LLM_DEEPSEEK_FAST_GENERATION = 'true';
  try {
    assert.equal(usesFastGenerationPath({ name: 'deepseek' }), true);
    assert.equal(usesFastGenerationPath({ name: 'openai' }), false);
  } finally {
    if (previous === undefined) delete process.env.LLM_DEEPSEEK_FAST_GENERATION;
    else process.env.LLM_DEEPSEEK_FAST_GENERATION = previous;
  }
});

test('DeepSeek fast acceptance-criteria path is disabled by default when primary', () => {
  const previous = process.env.LLM_DEEPSEEK_FAST_AC;
  delete process.env.LLM_DEEPSEEK_FAST_AC;
  try {
    assert.equal(
      usesFastAcceptanceCriteriaPath({
        providers: [
          { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'key', model: 'deepseek-v4-pro' },
          { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'key', model: 'gpt-5.4-mini' },
        ],
      }),
      false
    );
  } finally {
    if (previous === undefined) delete process.env.LLM_DEEPSEEK_FAST_AC;
    else process.env.LLM_DEEPSEEK_FAST_AC = previous;
  }
});

test('fast acceptance-criteria path stays off for OpenAI primary and requires explicit DeepSeek opt-in', () => {
  const previousFastAc = process.env.LLM_DEEPSEEK_FAST_AC;
  const previousPrimary = process.env.LLM_PRIMARY_PROVIDER;
  try {
    process.env.LLM_PRIMARY_PROVIDER = 'openai';
    assert.equal(
      usesFastAcceptanceCriteriaPath({
        providers: [
          { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'key', model: 'deepseek-v4-pro' },
          { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'key', model: 'gpt-5.4-mini' },
        ],
      }),
      false
    );

    process.env.LLM_PRIMARY_PROVIDER = 'deepseek';
    process.env.LLM_DEEPSEEK_FAST_AC = 'true';
    assert.equal(
      usesFastAcceptanceCriteriaPath({
        providers: [{ name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'key', model: 'deepseek-v4-pro' }],
      }),
      true
    );
  } finally {
    if (previousFastAc === undefined) delete process.env.LLM_DEEPSEEK_FAST_AC;
    else process.env.LLM_DEEPSEEK_FAST_AC = previousFastAc;
    if (previousPrimary === undefined) delete process.env.LLM_PRIMARY_PROVIDER;
    else process.env.LLM_PRIMARY_PROVIDER = previousPrimary;
  }
});

test('providerContent throws on truncated responses (finish_reason=length) but returns normal content', () => {
  // BUG-09: a truncated case array must not be silently sliced into a partial-but-valid array.
  assert.throws(
    () => providerContent({ choices: [{ finish_reason: 'length', message: { content: '{"testCases":[{"id":"TC-01"' } }] }, 'generation'),
    /truncated \(finish_reason=length\)/
  );
  assert.equal(
    providerContent({ choices: [{ finish_reason: 'stop', message: { content: '{"testCases":[]}' } }] }, 'generation'),
    '{"testCases":[]}'
  );
  assert.equal(providerContent({ choices: [{ message: {} }] }, 'generation'), '');
});

test('truncated LLM content is retryable and eligible for fallback', () => {
  let error: unknown;
  try {
    providerContent({ choices: [{ finish_reason: 'length', message: { content: '{"testCases":[{"id":"TC-01"' } }] }, 'generation');
  } catch (caught) {
    error = caught;
  }
  assert.equal(isRetryableLlmContentError(error), true);
  assert.equal(isFallbackError(error as Error), true);
});

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
      caseIntent: 'positive',
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

test('normalizes explicit case intent and falls back for legacy cases', () => {
  assert.equal(
    normalizeCase(
      {
        title: '[Web][Spatial Analysis][ORB-3118] Reject invalid polygon row',
        type: 'BDD',
        case_intent: 'negative',
      },
      0
    ).caseIntent,
    'negative'
  );

  assert.equal(
    normalizeCase(
      {
        title: '[Web][Spatial Analysis][ORB-3118] Handle empty polygon dataset boundary',
        type: 'BDD',
      },
      0
    ).caseIntent,
    'edge'
  );
});

test('deterministic duplicate review excludes exact normalized title matches', () => {
  const recommendations = buildDeterministicDuplicateRecommendations(
    [
      {
        caseId: 123,
        title: '[Web][Spatial Analysis][ORB-3079] Preserve polygon dataset geometry',
        refs: 'ORB-3079',
      },
    ],
    [
      {
        id: 'TC-ORB-3079-001',
        title: '[Web][Spatial Analysis][ORB-3079] Preserve polygon dataset geometry',
        type: 'BDD',
        caseIntent: 'positive',
        jiraReference: 'ORB-3079',
        preconditions: '',
        bddScenario: '',
        coversAcceptanceCriteria: ['AC-1'],
        sourceScope: [],
        evidence: { prdSectionTitle: '', acceptanceCriteria: [], coverageNote: '' },
      },
    ]
  );

  assert.deepEqual(recommendations, [
    {
      newCaseId: 'TC-ORB-3079-001',
      recommendation: 'exclude',
      overlap: 'already_covered',
      matchedExistingCaseIds: [123],
      reason: 'Existing TestRail case has the same normalized title.',
      deterministic: true,
    },
  ]);
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

test('stringifies object payloads as JSON instead of [object Object]', () => {
  assert.equal(
    normalizeTextList({ grid_config: { output_mode: 'custom', catchment_radius_m: 500 } }),
    JSON.stringify({ grid_config: { output_mode: 'custom', catchment_radius_m: 500 } }, null, 2)
  );
  assert.equal(normalizeTextList([{ a: 1 }]), JSON.stringify({ a: 1 }, null, 2));
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

test('BUG-10: getSinglePolarityGaps surfaces a conditional criterion covered only in one polarity', () => {
  const context = {
    acceptanceCriteria: [{ id: 'AC-1', text: 'Generate Results button is disabled when radius is 0' }],
  };
  const testCases = [
    {
      id: 'TC-1',
      caseIntent: 'negative',
      coversAcceptanceCriteria: ['AC-1'],
      title: 'Generate Results button disabled when radius is 0',
      bddScenario: 'Given radius is 0 When the form is checked Then the Generate Results button is disabled',
    },
  ];
  const gaps = getSinglePolarityGaps(context as any, testCases as any);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].id, 'AC-1');
  assert.deepEqual(gaps[0].missing, ['positive']);
});

test('BUG-10: getSinglePolarityGaps reports no gap once both polarities are covered', () => {
  const context = {
    acceptanceCriteria: [{ id: 'AC-1', text: 'Generate Results button is disabled when radius is 0' }],
  };
  const testCases = [
    {
      id: 'TC-1',
      caseIntent: 'negative',
      coversAcceptanceCriteria: ['AC-1'],
      title: 'Generate Results button disabled when radius is 0',
      bddScenario: 'Given radius is 0 Then the Generate Results button is disabled',
    },
    {
      id: 'TC-2',
      caseIntent: 'positive',
      coversAcceptanceCriteria: ['AC-1'],
      title: 'Generate Results button enabled when radius is valid',
      bddScenario: 'Given a valid radius Then the Generate Results button is enabled',
    },
  ];
  const gaps = getSinglePolarityGaps(context as any, testCases as any);
  assert.equal(gaps.length, 0);
});

test('scenario plan derives generic, domain-neutral families mapped to real criteria', () => {
  const context = {
    ticketKey: 'ORB-1000',
    epic: 'Platform',
    mainIssue: {
      key: 'ORB-1000',
      summary: '[BE] Add an optional output method to the analysis endpoint',
      description: [
        'The endpoint accepts an optional method field. Omitting it preserves the existing default behavior for current callers.',
        'An explicit opt-in method value changes the output as specified.',
        'Invalid method values are rejected by validation.',
        'Re-running an existing analysis without the new field is unchanged.',
        'The method also applies to a secondary surface as well as the primary one.',
        'An alternate output format also supports the method.',
      ].join('\n'),
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'The optional method defaults to existing behavior when omitted and supports an explicit value.' },
      { id: 'AC-2', text: 'Invalid method values are rejected and the alternate output format is supported.' },
    ],
    confluencePages: [],
  };
  const plan = buildScenarioPlan(context as any);
  const titles = plan.map((item) => item.title).join('\n');

  assert.match(titles, /defaults to existing behavior/i);
  assert.match(titles, /explicit opt-in method/i);
  assert.match(titles, /Invalid method value/i);
  assert.match(titles, /Re-running an existing analysis/i);
  assert.match(titles, /Secondary surface/i);
  assert.match(titles, /Alternate output format/i);
  // Every planned item maps to a genuinely-matching criterion — no forced first-AC fallback.
  assert.ok(plan.every((item) => item.sourceCriterionIds.length > 0));
});

test('scenario plan drops a family that matches no acceptance criterion (no forced first-AC mapping)', () => {
  // The source fires the invalid-value family, but no AC mentions validation/rejection or any generic
  // method vocabulary — so matchingCriterionIds returns [] and the family is dropped, not force-credited
  // to an arbitrary first criterion (the old slice(0,1) fallback).
  const context = {
    ticketKey: 'ORB-1001',
    epic: 'Auth',
    mainIssue: {
      key: 'ORB-1001',
      summary: '[BE] Login',
      description: 'Invalid method values are rejected by validation. Users can also sign in and sign out.',
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'A user can sign in with correct credentials.' },
      { id: 'AC-2', text: 'A signed-in user can sign out and see a goodbye screen.' },
    ],
    confluencePages: [],
  };
  const plan = buildScenarioPlan(context as any);
  assert.equal(plan.some((item) => item.id === 'SP-INVALID-VALUE'), false);
});

test('one generic case does not cover distinct scenario families', () => {
  const context = {
    ticketKey: 'ORB-1000',
    epic: 'Platform',
    mainIssue: {
      key: 'ORB-1000',
      description: [
        'Omitting the optional method preserves the existing default behavior.',
        'Invalid method values are rejected by validation.',
        'The method also applies to a secondary surface as well as the primary one.',
      ].join('\n'),
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'The optional method defaults to existing behavior and rejects invalid values.' }],
    confluencePages: [],
  };
  const plan = buildScenarioPlan(context as any);
  const oneCase = [
    {
      id: 'TC-1',
      title: 'Submit analysis without the optional method uses the default',
      bddScenario: 'Given the method is omitted When the analysis runs Then the existing default behavior is preserved',
      evidence: { coverageNote: '' },
      sourceScope: [],
      coversAcceptanceCriteria: ['AC-1'],
    },
  ];
  const gaps = getMissingScenarioPlanItems(plan, oneCase as any);
  assert.ok(gaps.some((gap) => /Invalid method value/i.test(gap.title)));
  assert.ok(gaps.some((gap) => /Secondary surface/i.test(gap.title)));
});

test('scenario plan clears once each fired family has a covering case', () => {
  const context = {
    ticketKey: 'ORB-1000',
    epic: 'Platform',
    mainIssue: {
      key: 'ORB-1000',
      description: [
        'Omitting the optional method preserves the existing default behavior.',
        'Invalid method values are rejected by validation.',
      ].join('\n'),
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'The optional method defaults to existing behavior and rejects invalid values.' }],
    confluencePages: [],
  };
  const plan = buildScenarioPlan(context as any);
  const cases = [
    {
      title: 'Default: submit without the optional method',
      bddScenario: 'Given the method is omitted Then the default behavior is preserved',
      evidence: { coverageNote: '' },
      sourceScope: [],
    },
    {
      title: 'Invalid: an unsupported method value is rejected',
      bddScenario: 'Given an invalid method value When submitted Then validation rejects it',
      evidence: { coverageNote: '' },
      sourceScope: [],
    },
  ];
  assert.deepEqual(getMissingScenarioPlanItems(plan, cases as any), []);
});

test('scenario plan respects the 14-item cap', () => {
  const context = {
    ticketKey: 'ORB-9000',
    epic: 'Platform',
    mainIssue: {
      key: 'ORB-9000',
      description: [
        'Omitting the optional method preserves existing callers and default behavior.',
        'An explicit opt-in method value changes the output.',
        'The calculated output uses the specified weighting formula.',
        'Multiple entities produce one row per entity.',
        'A known reference with no matching rows produces a zero result.',
        'Missing reference data triggers the documented fallback behavior.',
        'Re-running an existing analysis is unchanged.',
        'The method also applies to a secondary surface as well as the primary.',
        'Invalid method values are rejected by validation.',
        'Unrelated attributes remain unaffected and unchanged.',
        'Coarser parent output levels aggregate child values.',
        'An alternate output format also supports the method.',
      ].join('\n'),
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'The optional method behavior, output, and value handling are supported.' }],
    confluencePages: [],
  };

  assert.ok(buildScenarioPlan(context as any).length <= 14);
});

test('scenario plan maps a family to its specific criteria, not every base-matching AC', () => {
  const context = {
    ticketKey: 'ORB-1002',
    epic: 'Platform',
    mainIssue: {
      key: 'ORB-1002',
      description: [
        'Omitting the optional method preserves the existing default behavior.',
        'Coarser parent output levels aggregate child values.',
      ].join('\n'),
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'The optional method defaults to existing behavior when omitted.' },
      { id: 'AC-2', text: 'Coarser parent output levels aggregate child values.' },
      { id: 'AC-3', text: 'The response includes a status field.' },
    ],
    confluencePages: [],
  };
  const plan = buildScenarioPlan(context as any);
  const byId = new Map(plan.map((item) => [item.id, item]));
  // Specific matches win: the default family maps only to AC-1, the aggregation family only to AC-2.
  // AC-3 matches only broad base vocabulary ("field") and must NOT be swept into either family — this is
  // the coverage-inflation fix (previously a family grabbed every base-matching AC via baseCriterionPatterns).
  assert.deepEqual(byId.get('SP-DEFAULT')?.sourceCriterionIds, ['AC-1']);
  assert.deepEqual(byId.get('SP-AGGREGATION')?.sourceCriterionIds, ['AC-2']);
  assert.ok(plan.every((item) => !item.sourceCriterionIds.includes('AC-3')));
});

test('under-granular coverage flags broad cases that staple many AC ids onto a tiny suite', () => {
  const context = {
    acceptanceCriteria: Array.from({ length: 9 }, (_, index) => ({ id: `AC-${index + 1}`, text: `Criterion ${index + 1}` })),
  };
  const cases = [
    { title: 'Broad case 1', coversAcceptanceCriteria: ['AC-1', 'AC-2', 'AC-3'] },
    { title: 'Broad case 2', coversAcceptanceCriteria: ['AC-4', 'AC-5', 'AC-6'] },
    { title: 'Broad case 3', coversAcceptanceCriteria: ['AC-7', 'AC-8', 'AC-9'] },
  ];

  const targets = getUnderGranularAcceptanceCriteria(context as any, cases as any, []);

  assert.deepEqual(targets.map((criterion) => criterion.id), ['AC-1', 'AC-2', 'AC-3', 'AC-4']);
});

test('under-granular coverage does not flag once focused case count is sufficient', () => {
  const context = {
    acceptanceCriteria: Array.from({ length: 4 }, (_, index) => ({ id: `AC-${index + 1}`, text: `Criterion ${index + 1}` })),
  };
  const cases = [
    { title: 'Focused case 1', coversAcceptanceCriteria: ['AC-1'] },
    { title: 'Focused case 2', coversAcceptanceCriteria: ['AC-2'] },
    { title: 'Focused case 3', coversAcceptanceCriteria: ['AC-3'] },
    { title: 'Focused case 4', coversAcceptanceCriteria: ['AC-4'] },
  ];

  assert.deepEqual(getUnderGranularAcceptanceCriteria(context as any, cases as any, []), []);
});

test('validation repair: mergeRepairedCases swaps invalid cases in place by id and keeps the rest', () => {
  const original = [
    { id: 'TC-1', title: 'Valid A' },
    { id: 'TC-2', title: 'Invalid B (no apiSpec)' },
    { id: 'TC-3', title: 'Valid C' },
  ];
  const repaired = [
    { id: 'TC-2', title: 'Fixed B', apiSpec: { method: 'POST', path: '/v1/analysis' } },
    { id: 'TC-99', title: 'Stray with no matching original — must be ignored' },
  ];

  const merged = mergeRepairedCases(original as any, repaired as any);

  // No appends, no drops, original order preserved.
  assert.deepEqual(merged.map((testCase) => testCase.id), ['TC-1', 'TC-2', 'TC-3']);
  // The invalid case is replaced in place with the corrected version.
  assert.equal(merged[1].title, 'Fixed B');
  assert.deepEqual((merged[1] as any).apiSpec, { method: 'POST', path: '/v1/analysis' });
  // Untouched cases are kept exactly (same reference).
  assert.equal(merged[0], original[0]);
  assert.equal(merged[2], original[2]);
});

test('generation merge drops semantic duplicate repair candidates before final validation', () => {
  const context = {
    acceptanceCriteria: [
      {
        id: 'AC-2',
        text: 'GET /onboarding/modules returns only active org modules and returns an empty modules array when no active modules exist.',
      },
      {
        id: 'AC-3',
        text: 'GET /onboarding/progress returns first_login_completed with module progress.',
      },
    ],
    constraints: { scopeType: 'web' },
    acceptanceCriteriaDiagnostics: { acceptanceCriteriaExecutionPlan: [] },
  };
  const existing = [
    {
      id: 'TC-ORB-3218-AC2',
      title: '[FE][Miscellaneous][ORB-3218] GET onboarding modules returns only active org modules and empty array when none exist',
      coversAcceptanceCriteria: ['AC-2'],
      caseIntent: 'positive',
      bddScenario: `Feature: Onboarding modules
Scenario: Active org modules are returned
Given the user has active and deleted modules
When the frontend requests GET /onboarding/modules
Then the response includes only active org modules
And the response is an empty modules array when no active modules exist`,
    },
  ];
  const repairCandidates = [
    {
      id: 'TC-ORB-3218-AC2-N1',
      title: '[FE][Miscellaneous][ORB-3218] GET onboarding modules returns an empty array when no active org modules exist',
      coversAcceptanceCriteria: ['AC-2'],
      caseIntent: 'negative',
      bddScenario: `Feature: Onboarding modules
Scenario: Empty active module set
Given the org has no active modules
When the frontend requests GET /onboarding/modules
Then the response is an empty modules array`,
    },
    {
      id: 'TC-ORB-3218-AC3',
      title: '[FE][Miscellaneous][ORB-3218] GET onboarding progress returns first_login_completed and progress records',
      coversAcceptanceCriteria: ['AC-3'],
      caseIntent: 'positive',
      bddScenario: `Feature: Onboarding progress
Scenario: Load progress
Given the user has module progress
When the frontend requests GET /onboarding/progress
Then the response includes first_login_completed and progress records`,
    },
  ];

  const merged = mergeGeneratedCasesWithQualityGate(context as any, [], existing as any, repairCandidates as any);

  assert.deepEqual(merged.map((testCase) => testCase.id), ['TC-ORB-3218-AC2', 'TC-ORB-3218-AC3']);
});

test('generation merge drops repair candidates with incompatible execution type', () => {
  const context = {
    acceptanceCriteria: [
      {
        id: 'AC-3',
        text: 'Submitting an analysis without proportion_method keeps the existing AREA behavior.',
      },
      {
        id: 'AC-4',
        text: 'Generated protobuf code includes proportion_method.',
      },
    ],
    constraints: { scopeType: 'api' },
    acceptanceCriteriaDiagnostics: {
      acceptanceCriteriaExecutionPlan: [
        {
          criterionId: 'AC-3',
          executionType: 'postman',
          observableSurface: 'POST /v1/analysis',
          reason: 'API request behavior.',
          coveragePolicy: 'api_assertion',
        },
        {
          criterionId: 'AC-4',
          executionType: 'manual_code_review',
          observableSurface: 'Generated protobuf code',
          reason: 'Code artifact verification.',
          coveragePolicy: 'code_review',
        },
      ],
    },
  };
  const existing = [
    {
      id: 'TC-ORB-3310-001',
      title: '[BE][Spatial Analysis][ORB-3310] Submit analysis without optional method defaults to existing behavior',
      executionType: 'postman',
      coversAcceptanceCriteria: ['AC-3'],
      caseIntent: 'positive',
      apiSpec: { method: 'POST', path: '/v1/analysis' },
      bddScenario: 'Given no proportion_method When POST /v1/analysis is sent Then AREA behavior is preserved',
    },
  ];
  const repairCandidates = [
    {
      id: 'TC-ORB-3310-014',
      title: '[BE][Spatial Analysis][ORB-3310] Analysis model maps empty proportion method to AREA',
      executionType: 'manual_code_review',
      coversAcceptanceCriteria: ['AC-3'],
      caseIntent: 'negative',
      manualVerification: {
        target: 'internal/model/analysis.go',
        steps: ['Review the model defaulting code.'],
        expectedResult: 'Empty proportion method maps to AREA.',
      },
      bddScenario: 'Given the code is available When the model defaulting code is reviewed Then empty proportion method maps to AREA',
    },
    {
      id: 'TC-ORB-3310-010',
      title: '[BE][Spatial Analysis][ORB-3310] Proto exposes proportion method contract',
      executionType: 'manual_code_review',
      coversAcceptanceCriteria: ['AC-4'],
      caseIntent: 'positive',
      manualVerification: {
        target: 'analytics.proto',
        steps: ['Review generated protobuf code.'],
        expectedResult: 'Generated protobuf code includes proportion_method.',
      },
      bddScenario: 'Given generated protobuf code is available When it is reviewed Then proportion_method exists',
    },
  ];

  const merged = mergeGeneratedCasesWithQualityGate(context as any, [], existing as any, repairCandidates as any);

  assert.deepEqual(merged.map((testCase) => testCase.id), ['TC-ORB-3310-001', 'TC-ORB-3310-010']);
});

test('canonicalizeApiSpecPaths snaps a fabricated id back to the documented {id} template', () => {
  const cases = [
    { id: 'TC-1', apiSpec: { method: 'GET', path: '/v1/analysis/AC3PosAnalysis/stream' } },
    { id: 'TC-2', apiSpec: { method: 'POST', path: '/v1/analysis' } },
    { id: 'TC-3', apiSpec: { method: 'GET', path: '/v1/unknown/thing' } },
    { id: 'TC-4', title: 'no apiSpec' },
  ];
  const matchedEndpoints = [
    { method: 'POST', path: '/v1/analysis' },
    { method: 'GET', path: '/v1/analysis/{id}/stream' },
  ];

  const result = canonicalizeApiSpecPaths(cases as any, matchedEndpoints);

  // Fabricated concrete id is snapped to the documented template.
  assert.equal((result[0] as any).apiSpec.path, '/v1/analysis/{id}/stream');
  // Already-correct path is left unchanged.
  assert.equal((result[1] as any).apiSpec.path, '/v1/analysis');
  // A path that matches no documented endpoint is left untouched (not fabricated into a match).
  assert.equal((result[2] as any).apiSpec.path, '/v1/unknown/thing');
  // A case without apiSpec is untouched.
  assert.equal((result[3] as any).apiSpec, undefined);
});

test('normalizeAssertionList extracts text from object assertions instead of yielding [object Object]', () => {
  const result = normalizeAssertionList([
    'response status is 201',
    { assertion: 'Dasymetric Weight = 0.65' },
    { description: 'proportion equals value times weight', expected: 1950 },
    { field: 'Dasymetric Weight', expected: 0.65 },
    '',
    null,
  ]);
  assert.deepEqual(result, [
    'response status is 201',
    'Dasymetric Weight = 0.65',
    'proportion equals value times weight (expected 1950)',
    'field: Dasymetric Weight, expected: 0.65',
  ]);
  // No coerced object survives.
  assert.equal(result.some((s) => s.includes('[object Object]')), false);
  // String input splits on newlines only, so commas inside an assertion are preserved.
  assert.deepEqual(normalizeAssertionList('status is 201, body has id\nweight is 0.5'), [
    'status is 201, body has id',
    'weight is 0.5',
  ]);
});
