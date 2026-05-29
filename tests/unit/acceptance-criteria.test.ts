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
      url: 'https://example.test/prd',
      anchor: '3.-As-User,-I-want-to-select-spatial-input-based-on-BVT-Data',
      matchedHeading: 'As User, I want to select spatial input based on BVT Data',
      matched: true,
      reason: '',
      sourceIssueKey: 'ORB-2873',
      body: 'PRD support context only.',
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
      notes: '',
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
});
