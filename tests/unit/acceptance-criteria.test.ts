import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeAcceptanceCriteria } from '../../src/server/services/acceptance-criteria';
import type { QaContext } from '../../src/shared/contracts';

function buildBaseContext(overrides: Partial<QaContext> = {}): QaContext {
  return {
    ticketKey: 'ORB-3079',
    epic: 'Spatial Analysis',
    mainIssue: {
      key: 'ORB-3079',
      summary: '[FE] Integration API - Run Analysis with BVT Polygon Catchment Datasets',
      description: `Tech Design:
1. Goals
- Mendukung dataset spatial_aggregation_type === "polygon" di Catchment Dataset (BY_DATASET mode).
- Hasilkan payload Run Analysis dan Save Config yang konsisten — tiap polygon row → 1 location/marker.
- MultiPolygon row tetap utuh sebagai satu entitas (1 location dengan geometry MultiPolygon), bukan di-explode.
- Hidden: section catchment-type (radius/road-access) saat polygon dataset dipilih, karena tidak relevan.
1. Feature Flag
- Off → fallback ke legacy dataset singular, hanya POI yang valid.
- On → enable polygon dataset selection + multi-dataset payload (datasets[]).
1. UI Behavior
- Catchment Type section: di-hide saat polygon dataset terpilih.
- PolygonPopup.tsx: klik polygon di map → tampil nama dari properties.name.`,
    },
    linkedIssues: [],
    confluencePages: [],
    scopeParentIssue: { key: 'ORB-2873', summary: 'As User, I want to select spatial input based on BVT Data', issueType: 'Story' },
    scopeParentRelation: 'is child of',
    scopeConfluenceSection: {
      pageId: '1228177422',
      title: 'Spatial Analysis Functional Improvement',
      url: 'https://example.test/prd#AI-Summary-NO-SCORE',
      anchor: '3.-As-User,-I-want-to-select-spatial-input-based-on-BVT-Data',
      matchedHeading: 'As User, I want to select spatial input based on BVT Data',
      matched: true,
      reason: '',
      sourceIssueKey: 'ORB-2873',
      body: 'PRD support context only.',
    },
    scopeAuthority: {
      type: 'main_jira_description',
      title: '[FE] Integration API - Run Analysis with BVT Polygon Catchment Datasets',
      body: `Tech Design:
1. Goals
- Mendukung dataset spatial_aggregation_type === "polygon" di Catchment Dataset (BY_DATASET mode).
- Hasilkan payload Run Analysis dan Save Config yang konsisten — tiap polygon row → 1 location/marker.
- MultiPolygon row tetap utuh sebagai satu entitas (1 location with geometry MultiPolygon), bukan di-explode.
- Hidden: section catchment-type (radius/road-access) saat polygon dataset dipilih, karena tidak relevan.`,
      reason: 'Main Jira requirements inferred from numbered description items.',
      quality: 'high',
      sourceIssueKey: 'ORB-3079',
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'Hidden: section catchment-type (radius/road-access) saat polygon dataset dipilih, karena tidak relevan.', source: 'ORB-3079 description' },
      { id: 'AC-2', text: 'Feature Flag isBVTDataForCatchmentEnabled (dari useAppFeatures) menggate seluruh polygon-catchment-dataset path:', source: 'ORB-3079 description' },
      { id: 'AC-3', text: 'On → enable polygon dataset selection + multi-dataset payload (datasets[]).', source: 'ORB-3079 description' },
      { id: 'AC-4', text: '└── if isBVTDataForCatchmentEnabled', source: 'ORB-3079 rendered description' },
    ],
    userStories: [{ id: 'US-1', text: 'As User, I want to select spatial input based on BVT Data', source: 'ORB-2873 summary' }],
    acceptanceCriteriaSource: 'main_jira',
    confidenceLevel: 'high',
    confidenceReasons: ['Main Jira requirements inferred from numbered description items.'],
    requiresConfidencePermission: false,
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      selectedAcceptanceCriteriaSource: 'main_jira',
      selectedAcceptanceCriteriaReason: 'Main Jira requirements inferred from numbered description items.',
      ignoredSources: ['parent_story_confluence_section'],
      ignoredMetadataLabels: ['PRD', 'FF'],
    },
    constraints: {
      feOnly: true,
      beAlreadyTested: false,
      },
    actualDevScopeGuidance:
      'Use the main Jira issue for implementation-specific acceptance criteria, then the linked parent Story and its targeted PRD subsection for canonical scope. Blocking and BE tickets are context only.',
    ...overrides,
  };
}

test('finalizes weak technical-design criteria into a synthesized canonical set', async () => {
  const context = buildBaseContext();
  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async () => ({
      acceptanceCriteria: [
        { id: 'AC-1', text: 'Support polygon datasets in Catchment Dataset BY_DATASET mode.' },
        { id: 'AC-2', text: 'Build Run Analysis and Save Config payloads so each polygon feature becomes one location or marker.' },
        { id: 'AC-3', text: 'Preserve MultiPolygon features as a single location or marker and do not explode them.' },
        { id: 'AC-4', text: 'Hide catchment type controls when a polygon dataset is selected.' },
        { id: 'AC-5', text: 'When the feature flag is on, enable polygon dataset selection and use datasets[] without mixing the legacy singular dataset field.' },
      ],
      provider: 'openai',
      model: 'gpt-5.4-mini',
    }),
  });

  assert.deepEqual(
    finalized.acceptanceCriteria.map((criterion) => criterion.text),
    [
      'Support polygon datasets in Catchment Dataset BY_DATASET mode.',
      'Build Run Analysis and Save Config payloads so each polygon feature becomes one location or marker.',
      'Preserve MultiPolygon features as a single location or marker and do not explode them.',
      'Hide catchment type controls when a polygon dataset is selected.',
      'When the feature flag is on, enable polygon dataset selection and use datasets[] without mixing the legacy singular dataset field.',
    ]
  );
  assert.equal(finalized.acceptanceCriteriaDiagnostics.synthesisUsed, true);
  assert.equal(finalized.acceptanceCriteriaDiagnostics.rawAcceptanceCriteriaQuality, 'weak');
  assert.equal((finalized.acceptanceCriteriaDiagnostics.discardedFragmentExamples || []).some((text) => /└── if/i.test(text)), true);
  assert.match(finalized.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaReason || '', /synthesized/i);
});

test('falls back to deterministic quality-gated criteria when synthesis is unavailable', async () => {
  const context = buildBaseContext();
  const finalized = await finalizeAcceptanceCriteria(context);

  assert.equal(finalized.acceptanceCriteria.length, 2);
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /└── if/i.test(criterion.text)), false);
  assert.equal(
    finalized.acceptanceCriteria.some((criterion) => /^Feature Flag isBVTDataForCatchmentEnabled/i.test(criterion.text)),
    false
  );
  assert.equal(finalized.acceptanceCriteriaDiagnostics.synthesisUsed, false);
  assert.equal(finalized.acceptanceCriteriaDiagnostics.rawAcceptanceCriteriaQuality, 'weak');
});

test('preserves strong explicit acceptance criteria through canonical synthesis', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3118',
    mainIssue: {
      key: 'ORB-3118',
      summary: '[FE] Integrate API - Filter Line Dataset by Admin Area',
      description: 'AC:\n1. Adm Area filter is required before Add Dataset button is enabled\n2. Adm Area filter follows the existing Global Area Filter sync',
    },
    scopeAuthority: {
      type: 'main_jira_acceptance_criteria',
      title: '[FE] Integrate API - Filter Line Dataset by Admin Area',
      body: 'AC-1. Adm Area filter is required before Add Dataset button is enabled\nAC-2. Adm Area filter follows the existing Global Area Filter sync',
      reason: 'Main Jira ticket contains explicit acceptance criteria.',
      quality: 'high',
      sourceIssueKey: 'ORB-3118',
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'Adm Area filter is required before Add Dataset button is enabled', source: 'ORB-3118 description' },
      { id: 'AC-2', text: 'Adm Area filter follows the existing Global Area Filter sync', source: 'ORB-3118 description' },
    ],
    confidenceReasons: ['Main Jira ticket contains explicit acceptance criteria.'],
  });

  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async (input) => ({
      acceptanceCriteria: input.rawSelectedAcceptanceCriteria.map((criterion, index) => ({
        id: `AC-${index + 1}`,
        text: criterion.text,
      })),
      provider: 'openai',
      model: 'gpt-5.4-mini',
    }),
  });

  assert.deepEqual(
    finalized.acceptanceCriteria.map((criterion) => criterion.text),
    [
      'Adm Area filter is required before Add Dataset button is enabled',
      'Adm Area filter follows the existing Global Area Filter sync',
    ]
  );
  assert.equal(finalized.acceptanceCriteriaDiagnostics.synthesisUsed, true);
  assert.equal(finalized.acceptanceCriteriaDiagnostics.rawAcceptanceCriteriaQuality, 'strong');
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerpt, 'Adm Area filter is required before Add Dataset button is enabled');
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptLocation, 'Main Jira');
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptKind, 'jira');
});

test('traces a synthesized AC to the parent PRD section when the Jira ticket has no matching line', async () => {
  const prdLine = 'Users accessing the platform through a partner URL shall only access datasets assigned to their partner.';
  const context = buildBaseContext({
    ticketKey: 'ORB-3198',
    mainIssue: {
      key: 'ORB-3198',
      summary: '[BE] Partner Whitelabel - Partner Dataset Access Validation',
      // Ticket body is just an endpoint list — it does NOT contain the behavioural PRD line below.
      description: 'Scope\n* Get dataset list\n* Submit analysis\n* Reset password',
    },
    scopeAuthority: {
      type: 'main_jira_description',
      title: '[BE] Partner Whitelabel - Partner Dataset Access Validation',
      body: 'Scope\n* Get dataset list\n* Submit analysis\n* Reset password',
      reason: 'Main Jira requirements from endpoint scope list.',
      quality: 'high',
      sourceIssueKey: 'ORB-3198',
    },
    scopeConfluenceSection: {
      pageId: '599588937',
      title: 'Settings & Auth',
      url: 'https://example.test/prd',
      anchor: '13.-As-a-Partner',
      matchedHeading: 'As a Partner, I want a partner URL',
      matched: true,
      reason: '',
      sourceIssueKey: 'ORB-675',
      body: `Partner access rules:\n${prdLine}\nThe partner URL shows branded logo.`,
    },
    acceptanceCriteria: [{ id: 'AC-1', text: prdLine, source: 'ORB-3198 synthesized' }],
  });

  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async (input) => ({
      acceptanceCriteria: input.rawSelectedAcceptanceCriteria.map((criterion, index) => ({ id: `AC-${index + 1}`, text: criterion.text })),
      provider: 'openai',
      model: 'gpt-5.4-mini',
    }),
  });

  const ac = finalized.acceptanceCriteria[0];
  assert.equal(ac.sourceExcerptKind, 'prd');
  assert.match(String(ac.sourceExcerptLocation), /^PRD:/);
  assert.match(String(ac.sourceExcerpt), /only access datasets assigned to their partner/);
});

test('BUG-03 step 2: attributes spec-derived criteria to the technical spec (kind "spec"), above the PRD paraphrase', async () => {
  const specLine =
    'Export relies on point-in-time access validated at analysis submission via FindDataset; no additional per-dataset partner re-check occurs at export time.';
  const context = buildBaseContext({
    ticketKey: 'ORB-3198',
    mainIssue: {
      key: 'ORB-3198',
      summary: '[BE] Partner Whitelabel - Partner Dataset Access Validation',
      description: 'Scope\n* User dataset export\n* Submit analysis',
    },
    scopeAuthority: {
      type: 'main_jira_description',
      title: '[BE] Partner Whitelabel - Partner Dataset Access Validation',
      body: 'Scope\n* User dataset export\n* Submit analysis',
      reason: 'Main Jira requirements from endpoint scope list.',
      quality: 'high',
      sourceIssueKey: 'ORB-3198',
    },
    scopeConfluenceSection: {
      pageId: '599588937',
      title: 'Settings & Auth',
      url: 'https://example.test/prd',
      anchor: '13.-As-a-Partner',
      matchedHeading: 'As a Partner',
      matched: true,
      reason: '',
      sourceIssueKey: 'ORB-675',
      body: 'Partner access rules: users on a partner URL only access datasets assigned to their partner.',
    },
    confluencePages: [
      {
        id: '1760198658',
        title: 'Partner URL & White-Label Access Control — Technical Specification',
        webUrl: 'https://example.test/wiki/spec',
        body: `6.5.3 Export\n${specLine}`,
        sourceRefs: [{ issueKey: 'ORB-3198', sourceType: 'confluence', relationship: 'blocks' }],
      },
    ],
    acceptanceCriteria: [{ id: 'AC-1', text: specLine, source: 'ORB-3198 synthesized' }],
  });

  const finalized = await finalizeAcceptanceCriteria(context);
  const ac = finalized.acceptanceCriteria[0];
  assert.equal(ac.sourceExcerptKind, 'spec');
  assert.match(String(ac.sourceExcerptLocation), /^Spec:/);
  assert.match(String(ac.sourceExcerpt), /point-in-time access/);
});

test('BUG-03 scope guard: drops spec login-isolation criteria when no login endpoint is in scope, keeps dataset/email', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3198',
    mainIssue: {
      key: 'ORB-3198',
      summary: '[BE] Partner Whitelabel - Partner Dataset Access Validation',
      description: 'Scope\n* Get dataset list\n* User dataset export\n* Reset password',
    },
    scopeAuthority: {
      type: 'main_jira_description',
      title: '[BE] Partner Whitelabel - Partner Dataset Access Validation',
      body: 'Scope\n* Get dataset list\n* User dataset export\n* Reset password',
      reason: 'Main Jira requirements from endpoint scope list.',
      quality: 'high',
      sourceIssueKey: 'ORB-3198',
    },
    confluencePages: [
      {
        id: '1760198658',
        title: 'Partner URL & White-Label Access Control — Technical Specification',
        webUrl: 'https://example.test/wiki/spec',
        body: 'Login Isolation — organizations assigned to a partner may only authenticate via their partner subdomain URL.\nDataset Access Control — partner users see only assigned datasets.',
        sourceRefs: [{ issueKey: 'ORB-3198', sourceType: 'confluence', relationship: 'blocks' }],
      },
    ],
    // Scope has dataset + password endpoints but NO login/session endpoint.
    apiContract: {
      sourceUrl: 'https://dev.lokasi.com/api-docs/',
      matchedEndpoints: [
        { method: 'GET', path: '/v1/datasets', source: 'api_docs' },
        { method: 'POST', path: '/v1/auth/reset-password', source: 'api_docs' },
      ],
      warnings: [],
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'Partner-assigned organizations may only authenticate via their partner subdomain URL; login through the general LI URL is blocked.', source: 'ORB-3198 synthesized' },
      { id: 'AC-2', text: 'Partner users only receive datasets explicitly assigned to their partner; unassigned datasets are hidden.', source: 'ORB-3198 synthesized' },
      { id: 'AC-3', text: 'Reset-password emails replace the general LI base URL with the partner subdomain URL for partner-assigned organizations.', source: 'ORB-3198 synthesized' },
    ],
  });

  const synthCriteria = [
    'Partner-assigned organizations may only authenticate via their partner subdomain URL; login through the general LI URL is blocked.',
    'Partner users only receive datasets explicitly assigned to their partner; unassigned datasets are hidden.',
    'Reset-password emails replace the general LI base URL with the partner subdomain URL for partner-assigned organizations.',
  ];
  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async () => ({
      acceptanceCriteria: synthCriteria.map((text, index) => ({ id: `AC-${index + 1}`, text })),
      provider: 'openai',
      model: 'gpt-5.4-mini',
    }),
  });
  const texts = finalized.acceptanceCriteria.map((criterion) => criterion.text).join('\n');
  assert.doesNotMatch(texts, /authenticate via their partner subdomain|login through the general LI URL is blocked/);
  assert.match(texts, /datasets explicitly assigned/);
  assert.match(texts, /Reset-password emails replace/); // email-routing criterion preserved (no login verb)
});

test('repairs over-merged thin-ticket PRD synthesis into medium-granularity criteria', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3157',
    epic: 'AI Assistance',
    mainIssue: {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
    },
    scopeParentIssue: { key: 'ORB-1248', summary: 'AI Assistance Summary Result', issueType: 'Story' },
    scopeConfluenceSection: {
      pageId: '950075398',
      title: 'AI Powered Assistance',
      url: 'https://example.test/prd#AI-Summary-NO-SCORE',
      anchor: 'AI-Assistance-Summary-Result',
      matchedHeading: 'AI Summary NO SCORE',
      matched: true,
      reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
      sourceIssueKey: 'ORB-1248',
      body:
        'AI Summary NO SCORE\nAcceptance Criteria\n1. The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.\n2. The no-score AI Summary uses an absolute profiling-based narrative and describes the area characteristics, defining signals, and zone type.\n3. The no-score AI Summary includes landmark context and environment risk indication.\n4. Strategic Takeaways remain available for the no-score variant.',
    },
    acceptanceCriteriaSource: 'parent_story_confluence_section',
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'AI Summary NO SCORE',
      body:
        'AI Summary NO SCORE\nAcceptance Criteria\n1. The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.\n2. The no-score AI Summary uses an absolute profiling-based narrative and describes the area characteristics, defining signals, and zone type.\n3. The no-score AI Summary includes landmark context and environment risk indication.\n4. Strategic Takeaways remain available for the no-score variant.',
      reason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
      quality: 'high',
      sourceIssueKey: 'ORB-1248',
      pageId: '950075398',
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.', source: '950075398 AI Summary NO SCORE' },
      { id: 'AC-2', text: 'The no-score AI Summary uses an absolute profiling-based narrative and describes the area characteristics, defining signals, and zone type.', source: '950075398 AI Summary NO SCORE' },
      { id: 'AC-3', text: 'The no-score AI Summary includes landmark context and environment risk indication.', source: '950075398 AI Summary NO SCORE' },
      { id: 'AC-4', text: 'Strategic Takeaways remain available for the no-score variant.', source: '950075398 AI Summary NO SCORE' },
    ],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      selectedAcceptanceCriteriaSource: 'parent_story_confluence_section',
      selectedAcceptanceCriteriaReason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
      thinTicketFallbackUsed: true,
      prdSubsectionMatchQuality: 'confident',
      matchedPrdSubsectionHeading: 'AI Summary NO SCORE',
      matchedPrdSubsectionConfidence: 1,
      userStoryFragmentsDiscardedCount: 1,
    },
  });

  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async (input) => {
      assert.equal(input.targetMinCriteria, 4);
      assert.equal(input.targetMaxCriteria, 6);
      assert.match(input.granularityHint || '', /thin-ticket PRD subsection fallback/i);
      return {
        acceptanceCriteria: [
          { id: 'AC-1', text: 'The AI Summary tab is available for analysis results with no score.' },
          {
            id: 'AC-2',
            text:
              'The no-score AI Summary uses an absolute profiling-based narrative instead of ranking-based scoring. General Summary describes the area characteristics, defining signals, and zone type. The no-score AI Summary includes landmark context and environment risk indication. Strategic Takeaways remain available for the no-score variant.',
          },
        ],
      };
    },
  });

  assert.equal(finalized.acceptanceCriteria.length, 5);
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /General Summary/i.test(criterion.text)), true);
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /Strategic Takeaways/i.test(criterion.text)), true);
});

test('repairs label-style over-merged thin-ticket PRD synthesis', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3157',
    mainIssue: {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
    },
    scopeConfluenceSection: {
      pageId: '950075398',
      title: 'AI Powered Assistance',
      url: 'https://example.test/prd#AI-Summary-NO-SCORE',
      anchor: 'AI-Assistance-Summary-Result',
      matchedHeading: 'AI Summary NO SCORE',
      matched: true,
      reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
      sourceIssueKey: 'ORB-1248',
      body: 'Matched PRD subsection body.',
    },
    acceptanceCriteriaSource: 'parent_story_confluence_section',
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'AI Summary NO SCORE',
      body: 'Matched PRD subsection body.',
      reason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
      quality: 'high',
      sourceIssueKey: 'ORB-1248',
      pageId: '950075398',
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.', source: '950075398 AI Summary NO SCORE' },
    ],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      thinTicketFallbackUsed: true,
      prdSubsectionMatchQuality: 'confident',
    },
  });

  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async () => ({
      acceptanceCriteria: [
        { id: 'AC-1', text: 'Availability: The AI Summary tab is available for analysis results with no score. Narrative style: The output uses absolute profiling instead of ranking. Risk warnings: The summary includes landmark and environment risk information. Recommendations: Strategic Takeaways remain available for the no-score variant.' },
      ],
    }),
  });

  assert.equal(finalized.acceptanceCriteria.length, 4);
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /^Availability:/i.test(criterion.text)), true);
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /^Narrative style:/i.test(criterion.text)), true);
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /^Risk warnings:/i.test(criterion.text)), true);
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /^Recommendations:/i.test(criterion.text)), true);
});

test('attaches PRD-scoped source excerpts without leaking neighboring sections', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3157',
    mainIssue: {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
    },
    acceptanceCriteriaSource: 'parent_story_confluence_section',
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'AI Summary NO SCORE',
      body:
        'AI Summary NO SCORE\nAcceptance Criteria\n1. The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.\n2. The no-score AI Summary includes landmark context and environment risk indication.\n3. Strategic Takeaways remain available for the no-score variant.\nWITH SCORE nearby text should not leak here.',
      reason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
      quality: 'high',
      sourceIssueKey: 'ORB-1248',
      pageId: '950075398',
    },
    scopeConfluenceSection: {
      pageId: '950075398',
      title: 'AI Powered Assistance',
      url: 'https://example.test/prd#AI-Summary-NO-SCORE',
      anchor: 'AI-Summary-NO-SCORE',
      matchedHeading: 'AI Summary NO SCORE',
      matched: true,
      reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
      sourceIssueKey: 'ORB-1248',
      body:
        'AI Summary NO SCORE\nAcceptance Criteria\n1. The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.\n2. The no-score AI Summary includes landmark context and environment risk indication.\n3. Strategic Takeaways remain available for the no-score variant.',
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'The AI Summary tab is available for analysis results with no score.' },
      { id: 'AC-2', text: 'The no-score AI Summary includes landmark context and environment risk indication.' },
    ],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      thinTicketFallbackUsed: true,
      prdSubsectionMatchQuality: 'confident',
    },
  });

  const finalized = await finalizeAcceptanceCriteria(context);

  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptLocation, 'PRD: AI Summary NO SCORE');
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptUrl, 'https://example.test/prd#AI-Summary-NO-SCORE');
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptKind, 'prd');
  assert.match(finalized.acceptanceCriteria[0].sourceExcerpt || '', /Analysis Summary window/i);
  assert.doesNotMatch(finalized.acceptanceCriteria[0].sourceExcerpt || '', /WITH SCORE/i);
});

test('source excerpts reject schema noise, pick the specific line, and suppress shared boilerplate', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3157',
    mainIssue: { key: 'ORB-3157', summary: '[FE] AI Summary - executive summary with no scoring', description: '' },
    acceptanceCriteriaSource: 'parent_story_confluence_section',
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'AI Summary NO SCORE',
      body: [
        'AI Summary NO SCORE',
        'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.',
        'The no-score AI Summary uses an absolute profiling-based narrative and describes the area characteristics, defining signals, and zone type.',
        'The no-score AI Summary includes landmark context and environment risk indication.',
        'Strategic Takeaways remain available for the no-score variant.',
        'feedback_table ├── feedback_id ← unique ID (Primary Key) ├── response_id ← foreign key → ai_response_table ├── surface ← "ai_summary" / "ai_chat"',
      ].join('\n'),
      reason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
      quality: 'high',
      sourceIssueKey: 'ORB-1248',
      pageId: '950075398',
    },
    scopeConfluenceSection: {
      pageId: '950075398',
      title: 'AI Powered Assistance',
      url: 'https://example.test/prd#AI-Summary-NO-SCORE',
      anchor: 'AI-Summary-NO-SCORE',
      matchedHeading: 'AI Summary NO SCORE',
      matched: true,
      reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
      sourceIssueKey: 'ORB-1248',
      body: 'unused',
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'The no-score summary must describe the area using absolute characteristics, defining signals, and zone type.' },
      { id: 'AC-2', text: 'The no-score summary must include landmark context and an environment risk warning for the area.' },
      { id: 'AC-3', text: 'Strategic Takeaways must remain available as a separate section.' },
      { id: 'AC-4', text: 'Strategic Takeaways in the no-score variant must remain actionable.' },
    ],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      thinTicketFallbackUsed: true,
      prdSubsectionMatchQuality: 'confident',
    },
  });

  const finalized = await finalizeAcceptanceCriteria(context);
  const acs = finalized.acceptanceCriteria;
  const find = (re: RegExp) => acs.find((criterion) => re.test(criterion.text));

  // Schema/table dumps are never offered as evidence.
  assert.equal(acs.every((criterion) => !/feedback_table|├|←/.test(criterion.sourceExcerpt || '')), true);
  // F1 scoring picks the specific justifying line, not a high-overlap blob.
  assert.match(find(/absolute characteristics|defining signals/i)?.sourceExcerpt || '', /absolute profiling-based narrative/i);
  assert.match(find(/landmark/i)?.sourceExcerpt || '', /landmark context and environment risk indication/i);
  assert.equal(find(/landmark/i)?.sourceExcerptUrl, 'https://example.test/prd#AI-Summary-NO-SCORE');
  assert.equal(find(/landmark/i)?.sourceExcerptKind, 'prd');
  // Two ACs that resolve to the same single line are generic boilerplate -> suppressed.
  const takeaways = acs.filter((criterion) => /Strategic Takeaways/i.test(criterion.text));
  assert.equal(takeaways.length, 2);
  assert.equal(takeaways.every((criterion) => !criterion.sourceExcerpt), true);
});

test('short high-signal PRD bullets still attach as excerpts when they match specific AC tokens', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3157',
    mainIssue: { key: 'ORB-3157', summary: '[FE] AI Summary - executive summary with no scoring', description: '' },
    acceptanceCriteriaSource: 'parent_story_confluence_section',
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'AI Summary NO SCORE',
      body: [
        'Analysis result with NO Score should have AI summary',
        'Add landmark and environment risk',
        'Strategic Takeaways',
      ].join('\n'),
      reason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
      quality: 'high',
      sourceIssueKey: 'ORB-1248',
      pageId: '950075398',
    },
    scopeConfluenceSection: {
      pageId: '950075398',
      title: 'AI Powered Assistance',
      url: 'https://example.test/prd#AI-Summary-NO-SCORE',
      anchor: 'AI-Summary-NO-SCORE',
      matchedHeading: 'AI Summary NO SCORE',
      matched: true,
      reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
      sourceIssueKey: 'ORB-1248',
      body: 'unused',
    },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text: 'The Analysis Summary view must show an AI Summary for analysis results that do not produce a score, using the no-score variant rather than a ranking-based summary.',
      },
      {
        id: 'AC-3',
        text: 'The no-score AI Summary must include landmark context and an environment risk/warning for the area.',
      },
      {
        id: 'AC-4',
        text: 'The no-score AI Summary must include a Strategic Takeaways section.',
      },
    ],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      thinTicketFallbackUsed: true,
      prdSubsectionMatchQuality: 'confident',
    },
  });

  const finalized = await finalizeAcceptanceCriteria(context);
  assert.match(finalized.acceptanceCriteria.find((criterion) => /analysis results.*score|no-score variant/i.test(criterion.text))?.sourceExcerpt || '', /NO Score should have AI summary/i);
  assert.match(finalized.acceptanceCriteria.find((criterion) => /landmark context|environment risk/i.test(criterion.text))?.sourceExcerpt || '', /landmark and environment risk/i);
  assert.match(finalized.acceptanceCriteria.find((criterion) => /Strategic Takeaways/i.test(criterion.text))?.sourceExcerpt || '', /Strategic Takeaways/i);
});

test('composite AC can attach multiple supporting excerpts from the same authority', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3079',
    mainIssue: {
      key: 'ORB-3079',
      summary: '[FE] Integration API - Run Analysis with BVT Polygon Catchment Datasets',
      description: [
        'Polygon rows must preserve original Polygon or MultiPolygon geometry as-is.',
        'Do not explode MultiPolygon rows into multiple locations.',
        'Run analysis payload maps each polygon dataset row into one marker with polygon as WKT.',
        'Point-on-feature must be calculated from the original geometry.',
      ].join('\n'),
    },
    acceptanceCriteriaSource: 'main_jira',
    scopeAuthority: {
      type: 'main_jira_description',
      title: 'Main Jira description',
      body: [
        'Polygon rows must preserve original Polygon or MultiPolygon geometry as-is.',
        'Do not explode MultiPolygon rows into multiple locations.',
        'Run analysis payload maps each polygon dataset row into one marker with polygon as WKT.',
        'Point-on-feature must be calculated from the original geometry.',
      ].join('\n'),
      reason: 'Main Jira provided the clearest technical scope.',
      quality: 'high',
      sourceIssueKey: 'ORB-3079',
    },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text:
          'Run Analysis payload mapping must convert polygon dataset rows into markers with the expected shape: each item includes coordinate, polygon as WKT for the original Polygon or MultiPolygon geometry, and point-on-feature calculation must operate on the original geometry without splitting MultiPolygon rows.',
      },
    ],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
    },
  });

  const finalized = await finalizeAcceptanceCriteria(context);
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerpts?.length, 3);
  assert.equal(
    finalized.acceptanceCriteria[0].sourceExcerpts?.some((item) => /polygon dataset row into one marker/i.test(item.text)),
    true
  );
  assert.equal(
    finalized.acceptanceCriteria[0].sourceExcerpts?.some((item) => /original Polygon or MultiPolygon geometry/i.test(item.text)),
    true
  );
  assert.equal(
    finalized.acceptanceCriteria[0].sourceExcerpts?.some((item) => /Point-on-feature must be calculated/i.test(item.text)),
    true
  );
});

test('below-gate excerpt candidates are still shown as weak evidence', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3079',
    mainIssue: {
      key: 'ORB-3079',
      summary: '[FE] Integration API - Run Analysis with BVT Polygon Catchment Datasets',
      description: [
        'Save Config',
      ].join('\n'),
    },
    acceptanceCriteriaSource: 'main_jira',
    scopeAuthority: {
      type: 'main_jira_description',
      title: 'Main Jira description',
      body: [
        'Save Config',
      ].join('\n'),
      reason: 'Main Jira provided the clearest technical scope.',
      quality: 'high',
      sourceIssueKey: 'ORB-3079',
    },
    acceptanceCriteria: [
      {
        id: 'AC-5',
        text: 'Save Config payload mapping must convert selected polygon dataset features into catchment.locations entries with preserved geometry, matching sequence numbers, and Location layer polygon naming across the saved dataset set.',
      },
    ],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
    },
  });

  const finalized = await finalizeAcceptanceCriteria(context);
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptConfidence, 'weak');
  assert.match(finalized.acceptanceCriteria[0].sourceExcerpt || '', /Save Config/i);
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerpts?.[0].confidence, 'weak');
});

// F3 semantic evidence gate: a paraphrased criterion whose best PRD match clears the score gate on token
// overlap but is not a verbatim containment match → 'closest' tier, which is exactly what the gate re-checks.
function buildClosestExcerptContext(): QaContext {
  return buildBaseContext({
    ticketKey: 'ORB-3157',
    mainIssue: {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - executive summary for results with no scoring',
      description: '',
    },
    acceptanceCriteriaSource: 'parent_story_confluence_section',
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'AI Summary NO SCORE',
      body:
        'AI Summary NO SCORE\nAcceptance Criteria\n1. The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.\n2. The no-score AI Summary includes landmark context and environment risk indication.',
      reason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
      quality: 'high',
      sourceIssueKey: 'ORB-1248',
      pageId: '950075398',
    },
    acceptanceCriteria: [{ id: 'AC-1', text: 'The AI Summary tab is available for analysis results with no score.' }],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
      thinTicketFallbackUsed: true,
      prdSubsectionMatchQuality: 'confident',
    },
  });
}

test('F3: the relevance gate keeps a closest excerpt the check accepts (and only that closest excerpt is checked)', async () => {
  const checked: string[] = [];
  const finalized = await finalizeAcceptanceCriteria(buildClosestExcerptContext(), {
    excerptRelevanceCheck: async (input) => {
      checked.push(input.excerpt);
      return true;
    },
  });
  // The closest excerpt was the only thing the gate looked at, and it was kept unchanged.
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptConfidence, 'closest');
  assert.match(finalized.acceptanceCriteria[0].sourceExcerpt || '', /Analysis Summary window/i);
  assert.equal(checked.length, 1);
});

test('F3: the relevance gate drops a closest excerpt the check rejects (same-topic, different behavior)', async () => {
  const finalized = await finalizeAcceptanceCriteria(buildClosestExcerptContext(), {
    excerptRelevanceCheck: async () => false,
  });
  // Rejected → no near-miss shown rather than a misleading "closest" excerpt.
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerpt, undefined);
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerpts, undefined);
});

test('F3: the relevance gate never touches weak-tier excerpts', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3079',
    mainIssue: { key: 'ORB-3079', summary: '[FE] Run Analysis with BVT Polygon Catchment Datasets', description: 'Save Config' },
    acceptanceCriteriaSource: 'main_jira',
    scopeAuthority: {
      type: 'main_jira_description',
      title: 'Main Jira description',
      body: 'Save Config',
      reason: 'Main Jira provided the clearest technical scope.',
      quality: 'high',
      sourceIssueKey: 'ORB-3079',
    },
    acceptanceCriteria: [
      {
        id: 'AC-5',
        text: 'Save Config payload mapping must convert selected polygon dataset features into catchment.locations entries with preserved geometry, matching sequence numbers, and Location layer polygon naming across the saved dataset set.',
      },
    ],
    acceptanceCriteriaDiagnostics: { allIssueUserStories: [], allIssueCriteria: [], confluenceCriteria: [] },
  });
  const finalized = await finalizeAcceptanceCriteria(context, {
    excerptRelevanceCheck: async () => {
      throw new Error('gate must not run on weak-tier excerpts');
    },
  });
  // The weak fallback excerpt is a separate, lower tier — left untouched, so the check is never called.
  assert.equal(finalized.acceptanceCriteria[0].sourceExcerptConfidence, 'weak');
});
