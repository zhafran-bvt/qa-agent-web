import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assessAcceptanceCriteriaQuality,
  type AcceptanceCriteriaSynthesisInput,
  buildDirectRequirementInventory,
  buildSourceGroundingExamples,
  classifyAcceptanceCriteriaExecution,
  detectCrossSourceConflicts,
  finalizeAcceptanceCriteria,
  requirementCriterionMatchScore,
} from '../../src/server/services/acceptance-criteria';
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

interface Orb2565RequirementFixtureRecord {
  text: string;
  sourceKind: 'jira' | 'prd' | 'spec';
}

function buildRealOrb2565RequirementContext(): QaContext {
  const records = JSON.parse(
    readFileSync(resolve(process.cwd(), 'tests/fixtures/orb-2565-run-9056c40c-direct-requirements.json'), 'utf8')
  ) as Orb2565RequirementFixtureRecord[];
  const sourceText = (sourceKind: Orb2565RequirementFixtureRecord['sourceKind']) =>
    records.filter((record) => record.sourceKind === sourceKind).map((record) => record.text).join('\n');
  const prdBody = sourceText('prd');

  return buildBaseContext({
    ticketKey: 'ORB-2565',
    mainIssue: {
      key: 'ORB-2565',
      summary: '[BE] Enhance Spatial Analysis - Add administrative area coverage information on spatial analysis result (site profiling)',
      description: sourceText('jira'),
      webUrl: 'https://bvarta-project.atlassian.net/browse/ORB-2565',
    },
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: '[BE] Enhance Spatial Analysis - Add administrative area coverage information on spatial analysis result (site profiling)',
      body: prdBody,
      reason: 'Actual scoped PRD fragments captured from analysis run 9056c40c.',
      quality: 'high',
      sourceIssueKey: 'ORB-2565',
    },
    scopeConfluenceSection: {
      pageId: '1228177422',
      title: 'Spatial Analysis Functional Improvement',
      url: 'https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/1228177422/Spatial+Analysis+Functional+Improvement',
      anchor: '2.-As-a-User,-I-want-to-see-administrative-info-at-spatial-analysis-result-table',
      matchedHeading: 'As a User, I want to see administrative info at spatial analysis result table',
      matched: true,
      reason: 'Actual ORB-2565 scoped PRD section.',
      sourceIssueKey: 'ORB-2565',
      body: prdBody,
    },
    confluencePages: [
      {
        id: '1869414433',
        title: 'Spatial Analysis - Administrative Area Coverage on Result',
        body: sourceText('spec'),
        sourceUrl:
          'https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/1869414433/Spatial+Analysis+-+Administrative+Area+Coverage+on+Result',
        sourceRefs: [{ issueKey: 'ORB-2565', sourceType: 'main-rendered-description', relationship: 'spec-descendant' }],
      },
    ],
    constraints: { feOnly: false, beAlreadyTested: false, scopeType: 'api', apiContractRelevant: true },
  });
}

test('classifies ORB-3310-style SQL, sample tables, and rendered implementation chunks as weak AC', () => {
  const assessment = assessAcceptanceCriteriaQuality([
    {
      id: 'AC-1',
      text:
        '-- unique among live rows only CREATE UNIQUE INDEX uq_dasymetric_h3_level_8_h3_adm ON dasymetric_h3_level_8 (h3_id, adm_area_id) WHERE deleted = false; CREATE INDEX idx_dasymetric_h3_level_8_adm_area_id ON dasymetric_h3_level_8 (adm_area_id) INCLUDE (h3_id, building_ratio) WHERE deleted = false;',
      source: 'ORB-3310 description',
    },
    {
      id: 'AC-2',
      text:
        '0.30 x 1,000 = 300 Expected Output - Dataset After Analysis Table Assumptions: K2z55 (Catchment 1) weight=0.40; kFUkt (Catchment 2) weight=0.20; FJnEy (Catchment 2) weight=0.65.',
      source: 'ORB-3310 description',
    },
    {
      id: 'AC-3',
      text:
        '91.74 2,790 4,036 Implementation (BE - Task 1a / 1b / 1c) Proto (orbis-go-proto): add ProportionMethod enum (AREA=0, DASYMETRIC=1) + proportion_method = 5 to message Output in geospatial/proto/analytics/analytics.proto (NOT GridConfig); regenerate &amp; publish. Migration (DDL only): create dasymetric_h3_level_8.',
      source: 'ORB-3310 rendered description',
    },
    {
      id: 'AC-4',
      text: 'Dataset metadata proportion_method = DASYMETRIC.',
      source: 'ORB-3310 description',
    },
  ]);

  assert.equal(assessment.quality, 'weak');
  assert.equal(assessment.kept.length, 0);
  assert.equal(assessment.discarded.length, 4);
  assert.ok(assessment.weakSignals.some((signal) => /noisy implementation fragments/i.test(signal)));
});

test('keeps clean behavior-focused acceptance criteria strong', () => {
  const assessment = assessAcceptanceCriteriaQuality([
    {
      id: 'AC-1',
      text: 'POST /v1/analysis must accept an optional output-level proportion_method field and default to AREA when omitted.',
      source: 'ORB-3310 synthesized',
    },
    {
      id: 'AC-2',
      text: 'When proportion_method is DASYMETRIC, the result stream must include Dasymetric Weight and renamed proportion columns.',
      source: 'ORB-3310 synthesized',
    },
    {
      id: 'AC-3',
      text: 'The service must prefetch distinct adm_area_id values once per dataset before row processing.',
      source: 'ORB-3310 synthesized',
    },
  ]);

  assert.equal(assessment.quality, 'strong');
  assert.equal(assessment.discarded.length, 0);
});

test('does not skip synthesis for noisy implementation fragments even when strong-skip is requested', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3310',
    mainIssue: {
      key: 'ORB-3310',
      summary: '[BE] Spatial Analysis - Dasymetric Proportion',
      description:
        'Implementation (BE): create dasymetric_h3_level_8 indexes and add proportion_method. Expected Output table contains numeric examples.',
    },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text:
          '-- unique among live rows CREATE UNIQUE INDEX uq_dasymetric_h3_level_8_h3_adm ON dasymetric_h3_level_8 (h3_id, adm_area_id) WHERE deleted = false; CREATE INDEX idx_dasymetric_h3_level_8_adm_area_id ON dasymetric_h3_level_8 (adm_area_id) WHERE deleted = false;',
        source: 'ORB-3310 description',
      },
      {
        id: 'AC-2',
        text:
          '0.30 x 1,000 = 300 Expected Output - Dataset After Analysis Table Assumptions: K2z55 weight=0.40; kFUkt weight=0.20; FJnEy weight=0.65.',
        source: 'ORB-3310 description',
      },
    ],
  });
  let synthesisCalled = false;

  const finalized = await finalizeAcceptanceCriteria(context, {
    skipStrongLlmSynthesis: true,
    synthesizer: async () => {
      synthesisCalled = true;
      return {
        acceptanceCriteria: [
          {
            id: 'AC-1',
            text: 'When proportion_method is DASYMETRIC, the result stream must include Dasymetric Weight and renamed proportion columns.',
          },
        ],
      };
    },
  });

  assert.equal(synthesisCalled, true);
  assert.equal(finalized.acceptanceCriteriaDiagnostics.rawAcceptanceCriteriaQuality, 'weak');
  assert.equal(finalized.acceptanceCriteriaDiagnostics.synthesisUsed, true);
  assert.deepEqual(finalized.acceptanceCriteria.map((criterion) => criterion.text), [
    'When proportion_method is DASYMETRIC, the result stream must include Dasymetric Weight and renamed proportion columns.',
  ]);
});

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

test('explicit Jira See US reference sets medium granularity for the matched PRD requirements', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-2564',
    mainIssue: {
      key: 'ORB-2564',
      summary: '[BE] Add administrative area coverage to grid analysis results',
      description: [
        'See US on the linked PRD subsection.',
        'Scope',
        '- Enhance API: POST analytics/v1/analysis',
        '- Add administrative area coverage attribute for grid analysis.',
        '- Data format should be in JSON array to support multiple areas.',
        '- Set data_label to bulleted_list.',
      ].join('\n'),
    },
    acceptanceCriteria: [
      { id: 'AC-1', text: 'Data format should be in JSON array to support multiple areas.', source: 'ORB-2564 description' },
      { id: 'AC-2', text: 'Set data_label to bulleted_list.', source: 'ORB-2564 description' },
    ],
    scopeConfluenceSection: {
      pageId: '1228177422',
      title: 'Spatial Analysis Functional Improvement',
      url: 'https://example.test/prd',
      anchor: 'administrative-info',
      matchedHeading: 'As a User, I want to see administrative info at spatial analysis result table',
      matched: true,
      reason: 'Explicit Jira link matched this subsection.',
      sourceIssueKey: 'ORB-2530',
      body: [
        'The attribute may contain multiple administrative areas.',
        'Each administrative area includes its coverage percentage.',
        'The attribute can be null when administrative areas have not been mapped.',
        'Null values do not block the analysis result.',
      ].join('\n'),
    },
  });
  let synthesisInput: AcceptanceCriteriaSynthesisInput | undefined;

  await finalizeAcceptanceCriteria(context, {
    synthesizer: async (input) => {
      synthesisInput = input;
      return {
        acceptanceCriteria: [
          { id: 'AC-1', text: 'POST /v1/analysis returns the administrative area coverage attribute for grid analysis.' },
          { id: 'AC-2', text: 'The coverage value is a JSON array containing multiple administrative areas.' },
          { id: 'AC-3', text: 'Each returned administrative area includes its coverage percentage.' },
          { id: 'AC-4', text: 'Unmapped coverage may be null without invalidating the analysis result.' },
          { id: 'AC-5', text: 'The coverage attribute data_label equals bulleted_list.' },
        ],
      };
    },
  });

  assert.equal(synthesisInput?.targetMinCriteria, 4);
  assert.equal(synthesisInput?.targetMaxCriteria, 6);
  assert.match(synthesisInput?.granularityHint || '', /explicitly delegates requirement detail/i);
  assert.match(synthesisInput?.prdSectionBody || '', /coverage percentage/i);
});

test('marks the run not-production-ready and records a reason when synthesis returns an empty set', async () => {
  const context = buildBaseContext();
  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async () => ({ acceptanceCriteria: [], provider: 'deepseek', model: 'deepseek-v4-pro' }),
  });
  const diagnostics = finalized.acceptanceCriteriaDiagnostics;
  // Empty synthesis on weak raw ACs must not silently ship the reduced fallback as if it were fine.
  assert.equal(diagnostics.synthesisUsed, false);
  assert.equal(diagnostics.rawAcceptanceCriteriaQuality, 'weak');
  assert.equal(diagnostics.acceptanceCriteriaNotProductionReady, true);
  assert.match(diagnostics.synthesisFailureReason || '', /no usable acceptance criteria/i);
});

test('marks the run not-production-ready when no usable raw acceptance criteria exist', async () => {
  const context = buildBaseContext({
    acceptanceCriteria: [],
    acceptanceCriteriaDiagnostics: {
      allIssueUserStories: [],
      allIssueCriteria: [],
      confluenceCriteria: [],
    },
  });
  const finalized = await finalizeAcceptanceCriteria(context);
  const diagnostics = finalized.acceptanceCriteriaDiagnostics;

  assert.equal(diagnostics.rawAcceptanceCriteriaQuality, 'none');
  assert.equal(diagnostics.synthesisUsed, false);
  assert.equal(diagnostics.acceptanceCriteriaNotProductionReady, true);
  assert.match(diagnostics.acceptanceCriteriaNotProductionReadyReason || '', /none/i);
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

test('F1: flags an opposite-polarity contradiction between a criterion and a source line', () => {
  // Mirrors ORB-3205: AC says the button is NOT disabled at radius 0 (permission +), PRD says zero is
  // rejected (permission −). Negation flips "disabled" to positive; shared subject "radius".
  const conflicts = detectCrossSourceConflicts(
    [{ id: 'AC-7', text: 'Save Project button is not disabled when radius is 0', source: 'jira' }],
    [{ source: 'prd', text: 'Zero or negative radius values are rejected by the form.' }],
    undefined,
    'ORB-3205'
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].criterionId, 'AC-7');
  assert.equal(conflicts[0].axis, 'permission');
  assert.equal(conflicts[0].criterionSign, 'positive');
  assert.equal(conflicts[0].conflictingSource, 'prd');
  assert.ok(conflicts[0].sharedSubjects.includes('radius'));
});

test('F1: does not flag a same-polarity restatement', () => {
  const conflicts = detectCrossSourceConflicts(
    [{ id: 'AC-4', text: 'Generate Results button is disabled when radius is 0', source: 'jira' }],
    [{ source: 'prd', text: 'Zero radius values are rejected.' }],
    undefined,
    'ORB-3205'
  );
  assert.equal(conflicts.length, 0);
});

test('F1: does not flag opposite polarity when no subject is shared', () => {
  const conflicts = detectCrossSourceConflicts(
    [{ id: 'AC-1', text: 'Export button is disabled when the dataset is empty', source: 'jira' }],
    [{ source: 'prd', text: 'The radius slider is enabled for premium accounts.' }],
    undefined,
    'ORB-3205'
  );
  assert.equal(conflicts.length, 0);
});

test('F1: does not flag a contradiction across different polarity axes', () => {
  // visibility (hidden) vs permission (enabled) — same subject but different axes, not a real contradiction.
  const conflicts = detectCrossSourceConflicts(
    [{ id: 'AC-1', text: 'The coverage type section is hidden when the flag is off', source: 'jira' }],
    [{ source: 'prd', text: 'The coverage type section is enabled for all accounts.' }],
    undefined,
    'ORB-3205'
  );
  assert.equal(conflicts.length, 0);
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

test('PRD requirement inventory preserves distinct contracts (incl. opposite-polarity pairs) and worked examples', async () => {
  const prdUrl = 'https://example.test/wiki/pages/2565/admin-coverage';
  // Requirements (the "what") live in the matched PRD subsection.
  const prdBody = [
    '- adm_area_coverage_1 must contain the hierarchy and percentage using the worked example `Central Jakarta - 61.5%`.',
    '- Returned administrative areas must be ordered by coverage percentage descending.',
    '- The response must expose exactly the top two values through adm_area_coverage_1 and adm_area_coverage_2.',
    '- When only one administrative area exists, adm_area_coverage_2 must be an empty string.',
    '- When no mapped area exists, both coverage attributes must be null.',
    '- When the feature flag is disabled, the response must omit both coverage attributes.',
    '- When the feature flag is enabled, the response must include both coverage attributes.',
    '- Persistence must write both computed coverage values to the analysis result record.',
    '- CSV export must include adm_area_coverage_1 and adm_area_coverage_2.',
    '- Existing response fields must remain backward compatible for clients that ignore the new attributes.',
    '- Coverage percentage rounding must remain TBD pending clarification.',
    '- A dashboard visualization is out of scope and must not generate a test case.',
  ].join('\n');
  const context = buildBaseContext({
    ticketKey: 'ORB-2565',
    mainIssue: {
      key: 'ORB-2565',
      summary: '[BE] Enhance Spatial Analysis - Administrative Area Coverage',
      description: 'Add administrative area coverage columns to the spatial analysis result.',
    },
    scopeAuthority: {
      type: 'matched_prd_subsection',
      title: 'Administrative Area Coverage',
      body: prdBody,
      reason: 'Matched PRD subsection carries the requirements.',
      quality: 'high',
      sourceIssueKey: 'ORB-2565',
    },
    scopeConfluenceSection: {
      pageId: 'PRD-2565',
      title: 'Administrative Area Coverage',
      url: prdUrl,
      anchor: '',
      matchedHeading: 'Administrative Area Coverage',
      matched: true,
      reason: '',
      sourceIssueKey: 'ORB-2565',
      body: prdBody,
    },
    // A tech-spec page must exist to enable the inventory, but its implementation prose is NOT a requirement.
    confluencePages: [
      {
        id: '2565001',
        title: 'Administrative Area Coverage Design',
        body: 'The value is stored as a native BSON string via the existing save path; an in-memory R-Tree is reused.',
        sourceRefs: [{ issueKey: 'ORB-2565', sourceType: 'remote-link', relationship: 'Tech Doc' }],
        sourceUrl: 'https://example.test/wiki/pages/2565/design',
      },
    ],
  });

  const finalized = await finalizeAcceptanceCriteria(context, { skipStrongLlmSynthesis: true });
  const inventory = finalized.acceptanceCriteriaDiagnostics.directRequirements || [];
  const actionable = inventory.filter((requirement) => requirement.disposition !== 'out_of_scope');

  assert.ok(actionable.length >= 10, `expected more than nine distinct direct requirements, got ${actionable.length}`);
  // The tech-spec implementation prose never becomes a requirement.
  assert.equal(inventory.some((requirement) => requirement.sourceKind === 'spec'), false);
  assert.equal(inventory.some((requirement) => /bson string|r-tree/i.test(requirement.text)), false);
  // Opposite-polarity contracts share most of their wording but must both survive dedup as distinct rules.
  assert.ok(actionable.some((requirement) => /feature flag is disabled/i.test(requirement.text)), 'flag-off contract must be preserved');
  assert.ok(actionable.some((requirement) => /feature flag is enabled/i.test(requirement.text)), 'flag-on contract must be preserved');
  // No verbatim-append: a source-only requirement with no matching raw AC must NOT be pasted in as an AC.
  assert.equal(finalized.acceptanceCriteria.some((criterion) => /csv export must include/i.test(criterion.text)), false);
  assert.equal(inventory.find((requirement) => /rounding/i.test(requirement.text))?.disposition, 'needs_clarification');
  assert.equal(inventory.find((requirement) => /dashboard visualization/i.test(requirement.text))?.disposition, 'out_of_scope');
  const workedExample = inventory.find((requirement) => /Central Jakarta/i.test(requirement.text));
  assert.equal(workedExample?.sourceKind, 'prd');
  assert.ok(workedExample?.workedExamples?.some((example) => example.includes('Central Jakarta')));
  assert.ok(workedExample?.workedExamples?.some((example) => example.includes('61.5%')));
});

test('downgrades explicit API criteria to manual integration when no fetched contract verifies their endpoints', () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3310',
    constraints: { feOnly: false, beAlreadyTested: false, scopeType: 'api', apiContractRelevant: true },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text: 'POST /v1/analysis accepts optional output-level proportion_method and defaults to AREA when omitted.',
      },
      {
        id: 'AC-2',
        text: 'Proto orbis-go-proto adds ProportionMethod enum and generated Output.proportion_method field.',
      },
      {
        id: 'AC-3',
        text: 'Migration creates dasymetric_h3_level_8 table and unique covering indexes.',
      },
      {
        id: 'AC-4',
        text: 'Repository prefetches distinct adm_area_id values before processRowGridWorker builds its ratio map.',
      },
      {
        id: 'AC-5',
        text: 'GET /v1/analysis/{id}/stream returns Dasymetric Weight, renamed proportion columns, and metadata proportion_method.',
      },
    ],
  });

  const plan = classifyAcceptanceCriteriaExecution(context);
  const byId = new Map(plan.map((item) => [item.criterionId, item]));

  assert.equal(byId.get('AC-1')?.executionType, 'manual_integration');
  assert.deepEqual(byId.get('AC-1')?.endpointDowngrade, {
    method: 'POST',
    path: '/v1/analysis',
    reason: 'Endpoint POST /v1/analysis is not present in the fetched API contract; Postman generation is prohibited until the contract is verified.',
  });
  assert.equal(byId.get('AC-2')?.executionType, 'manual_code_review');
  assert.equal(byId.get('AC-3')?.executionType, 'manual_db');
  assert.equal(byId.get('AC-4')?.executionType, 'manual_integration');
  assert.equal(byId.get('AC-5')?.executionType, 'manual_integration');
  assert.deepEqual(byId.get('AC-5')?.endpointDowngrade, {
    method: 'GET',
    path: '/v1/analysis/{id}/stream',
    reason: 'Endpoint GET /v1/analysis/{id}/stream is not present in the fetched API contract; Postman generation is prohibited until the contract is verified.',
  });
});

test('classifies API-observable enum and schema acceptance criteria as postman, not manual artifacts', () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-4000',
    constraints: { feOnly: false, beAlreadyTested: false, scopeType: 'api', apiContractRelevant: true },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text: 'The response enum values must include AREA and DASYMETRIC.',
      },
      {
        id: 'AC-2',
        text: 'The GET /v1/analysis/{id}/stream response must conform to the dataset schema.',
      },
      {
        id: 'AC-3',
        text: 'Proto orbis-go-proto adds ProportionMethod enum and generated Output.proportion_method field.',
      },
      {
        id: 'AC-4',
        text: 'The database schema migration creates dasymetric_h3_level_8 and its covering index.',
      },
      {
        id: 'AC-5',
        text:
          'The new dasymetric_h3_level_8 reference table must be created with soft-delete columns and a foreign key to adm_area.',
      },
    ],
    apiContract: {
      sourceUrl: 'https://dev.lokasi.com/api-docs/',
      matchedEndpoints: [
        { method: 'POST', path: '/v1/analysis', source: 'api_docs' },
        { method: 'GET', path: '/v1/analysis/{id}/stream', source: 'api_docs' },
      ],
      warnings: [],
    },
  });

  const byId = new Map(classifyAcceptanceCriteriaExecution(context).map((item) => [item.criterionId, item]));

  assert.equal(byId.get('AC-1')?.executionType, 'postman');
  assert.equal(byId.get('AC-2')?.executionType, 'postman');
  assert.equal(byId.get('AC-3')?.executionType, 'manual_code_review');
  assert.equal(byId.get('AC-4')?.executionType, 'manual_db');
  assert.equal(byId.get('AC-5')?.executionType, 'manual_db');
});

test('ORB-2564: classifies POST-prefixed and JSON response contracts as explicit API cases', () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-2564',
    constraints: { feOnly: false, beAlreadyTested: false, scopeType: 'api', apiContractRelevant: true },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text: 'POST analytics/v1/analysis returns an administrative area coverage attribute in the grid analysis result dataset.',
      },
      {
        id: 'AC-2',
        text: 'The administrative area coverage attribute is returned as a JSON array so multiple areas can be represented.',
      },
      {
        id: 'AC-3',
        text: 'The response includes a data_label value of bulleted_list for the administrative area coverage array.',
      },
      {
        id: 'AC-4',
        text: "When multiple administrative areas are present, the returned array contains each area's hierarchy and coverage percentage and is ordered by coverage percentage in descending order.",
      },
      {
        id: 'AC-5',
        text: 'If one administrative area is available, the array contains that single value; if areas have not been mapped or the grid is outside supported regions, the attribute may be null.',
      },
    ],
    apiContract: {
      sourceUrl: 'https://dev.lokasi.com/api-docs/',
      matchedEndpoints: [
        { method: 'POST', path: '/v1/analysis', source: 'api_docs' },
        { method: 'GET', path: '/v1/analysis/{id}/summary', source: 'api_docs' },
      ],
      warnings: [],
    },
  });

  const byId = new Map(classifyAcceptanceCriteriaExecution(context).map((item) => [item.criterionId, item]));

  assert.equal(byId.get('AC-1')?.executionType, 'postman');
  assert.equal(byId.get('AC-1')?.observableSurface, 'POST /v1/analysis');
  assert.equal(byId.get('AC-2')?.executionType, 'postman');
  assert.match(byId.get('AC-2')?.observableSurface || '', /POST \/v1\/analysis/);
  assert.match(byId.get('AC-2')?.observableSurface || '', /GET \/v1\/analysis\/\{id\}\/summary/);
  assert.equal(byId.get('AC-3')?.executionType, 'postman');
  assert.equal(byId.get('AC-3')?.observableSurface, 'GET /v1/analysis/{id}/summary');
  assert.equal(byId.get('AC-4')?.executionType, 'postman');
  assert.equal(byId.get('AC-4')?.observableSurface, 'GET /v1/analysis/{id}/summary');
  assert.equal(byId.get('AC-5')?.executionType, 'postman');
  assert.equal(byId.get('AC-5')?.observableSurface, 'GET /v1/analysis/{id}/summary');
});

test('ORB-2565: classifies a returned attribute format as an API result assertion', () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-2565',
    constraints: { feOnly: false, beAlreadyTested: false, scopeType: 'api', apiContractRelevant: true },
    acceptanceCriteria: [
      {
        id: 'AC-2',
        text:
          'The administrative area coverage attribute contains the administrative area hierarchy text together with its coverage percentage, using the format " ( % coverage)".',
      },
    ],
    apiContract: {
      sourceUrl: 'https://dev.lokasi.com/api-docs/',
      matchedEndpoints: [
        { method: 'POST', path: '/v1/analysis', source: 'api_docs' },
        { method: 'GET', path: '/v1/analysis/{id}/summary', source: 'api_docs' },
      ],
      warnings: [],
    },
  });

  const plan = classifyAcceptanceCriteriaExecution(context);

  assert.deepEqual(plan, [
    {
      criterionId: 'AC-2',
      executionType: 'postman',
      coveragePolicy: 'api_assertion',
      observableSurface: 'GET /v1/analysis/{id}/summary',
      reason: 'Criterion defines observable result-field values, format, collection shape/order, or null behavior in the documented API response.',
    },
  ]);
});

test('ORB-3472: classifies table-column and ETL criteria as manual DB verification', () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3472',
    constraints: { feOnly: false, beAlreadyTested: false, scopeType: 'api', apiContractRelevant: true },
    apiContract: {
      sourceUrl: 'https://dev.lokasi.com/api-docs/',
      matchedEndpoints: [
        { method: 'POST', path: '/v1/analysis', source: 'api_docs' },
        { method: 'GET', path: '/v1/analysis/{id}/stream', source: 'api_docs' },
      ],
      warnings: [],
    },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text: 'Dasymetric weight is calculated using the area-weighted formula and returned by the analysis result stream.',
      },
      {
        id: 'AC-4',
        text: 'The dasymetric_id_h3_level_8 table includes a non-null DOUBLE PRECISION column named intersection_area_m2.',
      },
      {
        id: 'AC-5',
        text: 'The ETL populates intersection_area_m2 for each h3_id and adm_area_id row with the geometric intersection area.',
      },
      {
        id: 'AC-6',
        text: 'GetH3BuildingRatio returns intersection_area_m2 together with building_ratio for each cell.',
      },
    ],
  });

  const byId = new Map(classifyAcceptanceCriteriaExecution(context).map((item) => [item.criterionId, item]));

  assert.equal(byId.get('AC-1')?.executionType, 'postman');
  assert.equal(byId.get('AC-4')?.executionType, 'manual_db');
  assert.equal(byId.get('AC-5')?.executionType, 'manual_db');
  assert.equal(byId.get('AC-6')?.executionType, 'manual_integration');
});

test('does not classify generic API wording as Postman without a concrete endpoint', () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3472',
    constraints: { feOnly: false, beAlreadyTested: false, scopeType: 'api', apiContractRelevant: false },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text: 'Dasymetric weight is calculated using the area-weighted formula and returned by the analysis result stream.',
      },
      {
        id: 'AC-2',
        text: 'The response must preserve the sum of dasymetric weights across partitions.',
      },
      {
        id: 'AC-3',
        text: 'Submit analysis accepts an optional proportion method.',
      },
    ],
  });

  const plan = classifyAcceptanceCriteriaExecution(context);

  assert.equal(plan.some((item) => item.executionType === 'postman'), false);
  assert.ok(plan.every((item) => item.executionType === 'manual_integration'));
  assert.ok(plan.every((item) => !/Documented analysis API response|POST \/v1\/analysis/.test(item.observableSurface)));
});

test('classifies web-scope onboarding criteria without analysis API defaults', () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-3218',
    epic: 'Miscellaneous',
    constraints: { feOnly: true, beAlreadyTested: false, scopeType: 'web', apiContractRelevant: false },
    acceptanceCriteria: [
      {
        id: 'AC-1',
        text:
          'On app load, the frontend must fetch onboarding modules and onboarding progress in parallel using GET /onboarding/modules and GET /onboarding/progress, then store both responses in global state before deciding what onboarding UI to show.',
      },
      {
        id: 'AC-4',
        text:
          'The onboarding module walkthrough content must be defined on the frontend in a local module definition file, including step content and total step count derived locally; the backend must not be responsible for step content, step ordering, or total_steps.',
      },
      {
        id: 'AC-8',
        text:
          'PUT /onboarding/progress/{module_id} must upsert the user’s progress for that module using the request body fields current_step, status, and walkthrough_version.',
      },
    ],
  });

  const plan = classifyAcceptanceCriteriaExecution(context);
  const byId = new Map(plan.map((item) => [item.criterionId, item]));

  assert.equal(plan.some((item) => item.executionType === 'postman'), false);
  assert.equal(plan.some((item) => item.observableSurface.includes('/v1/analysis')), false);
  assert.equal(byId.get('AC-1')?.executionType, 'manual_integration');
  assert.match(byId.get('AC-1')?.observableSurface || '', /GET \/onboarding\/modules/);
  assert.equal(byId.get('AC-4')?.executionType, 'manual_integration');
  assert.equal(byId.get('AC-8')?.executionType, 'manual_integration');
  assert.match(byId.get('AC-8')?.observableSurface || '', /PUT \/onboarding\/progress\/\{module_id\}/);
});

test('ORB-2565 regression: requirements come from PRD/Jira; the tech-spec body is not mined as requirements', () => {
  // The requirement "what" lives in the PRD (with a duplicate restatement to exercise dedup).
  const prdBody = [
    'The results must be sorted by coverage_pct in descending order.',
    'Results must be sorted by coverage_pct descending.',
    'The response must include the top two administrative areas by coverage.',
    'The export must contain the coverage_pct column for each administrative area.',
    'The stream must expose per-row coverage values to the client.',
    'The legacy singular dataset field must be removed from the response payload.',
    'The MCP tools must exclude the adm_area_coverage dataset from their output.',
    'When the feature flag is off, the system must fall back to the legacy behavior.',
    'The persisted analysis config must store the selected proportion method.',
  ].join('\n');
  // The tech spec is implementation prose — it must NOT become requirements (only grounding/context).
  const specBody = [
    'sequenceDiagram',
    'FE->>BE: request analysis',
    'CREATE TABLE adm_area_coverage (id UUID PRIMARY KEY, coverage_pct DOUBLE PRECISION NOT NULL);',
    'CREATE INDEX idx_cov ON adm_area_coverage (coverage_pct);',
    'The value routes through convertToMongoDBType and is stored as a native BSON string.',
    'Build one in-memory adm R-Tree per level via rtree.BulkLoad for the tile candidates.',
    'key = (floor(lon/S), floor(lat/S)); group by key, keeping a running bbox per occupied tile.',
    'Feed accumulator into the same column writer as grid (top-2 → two string columns).',
  ].join('\n');

  const context = buildBaseContext({
    ticketKey: 'ORB-2565',
    mainIssue: { key: 'ORB-2565', summary: '[BE] Enhance Spatial Analysis', description: 'Add coverage-based ranking and export.' },
    scopeAuthority: { type: 'matched_prd_subsection', title: 'Enhanced Spatial Analysis', body: prdBody, reason: '', quality: 'high', sourceIssueKey: 'ORB-2565' },
    scopeConfluenceSection: { pageId: 'PRD-1', title: 'PRD', url: '', anchor: '', matchedHeading: '', matched: true, reason: '', sourceIssueKey: 'ORB-2565', body: prdBody },
    confluencePages: [{ id: 'SPEC-1', title: 'Technical Design - Spatial Analysis', body: specBody }],
  });

  const inventory = buildDirectRequirementInventory(context);
  const texts = inventory.map((requirement) => requirement.text.toLowerCase());

  // No requirement is sourced from the tech spec — that is the core of the fix.
  assert.equal(inventory.some((requirement) => requirement.sourceKind === 'spec'), false);
  // And none of the spec's implementation prose leaks in as a requirement.
  assert.equal(
    texts.some((text) => /create table|create index|r-tree|sequencediagram|fe->>be|bson string|floor\(|feed accumulator/.test(text)),
    false,
    'spec implementation prose must not become requirements'
  );
  // Real PRD contracts are kept; the count stays focused.
  assert.ok(texts.some((text) => text.includes('top two administrative areas')));
  assert.ok(texts.some((text) => text.includes('mcp tools must exclude')));
  assert.ok(inventory.length >= 5 && inventory.length <= 12, `expected a focused PRD/Jira inventory, got ${inventory.length}`);
  // The sorting restatement collapses to a single requirement.
  const sortingRequirements = texts.filter((text) => /sort(?:ed)?[\s\S]*coverage_pct[\s\S]*(?:desc|descending)/.test(text));
  assert.equal(sortingRequirements.length, 1, `sorting contract should collapse to 1, got ${sortingRequirements.length}`);
});

test('ORB-2565 real-run regression: requirements come from PRD/Jira, spec noise excluded, spec grounding survives', () => {
  const context = buildRealOrb2565RequirementContext();
  const inventory = buildDirectRequirementInventory(context);
  const texts = inventory.map((requirement) => requirement.text.toLowerCase());

  // The fix: the technical spec is never a requirement source — every requirement is PRD or Jira.
  assert.equal(
    inventory.every((requirement) => requirement.sourceKind === 'prd' || requirement.sourceKind === 'jira'),
    true,
    'no requirement may be sourced from the technical spec'
  );
  // The 51 spec fragments no longer inflate the count.
  assert.ok(inventory.length >= 8 && inventory.length <= 18, `expected a focused PRD/Jira inventory, got ${inventory.length}`);
  // Spec architecture / code / SQL / diagram / persistence prose never survives as a requirement.
  assert.equal(
    texts.some((text) =>
      /r-tree|processdatasetsstream|scoringrows|floor\s*\(|savebatchrows|values\s+join|flowchart|admlevelstepupthreshold|bson|rtree\.bulkload|converttomongodbtype/.test(
        text
      )
    ),
    false,
    'spec architecture, code, SQL, diagram, and persistence prose must not survive as requirements'
  );
  // Spec problem/background narration is not a contract either.
  assert.equal(texts.some((text) => /a spatial-analysis result has no administrative-area context today/.test(text)), false);

  // Real PRD/Jira contracts are present.
  assert.ok(texts.some((text) => /top[-\s]?(?:2|two)/.test(text)));
  assert.ok(texts.some((text) => /descending|sort/.test(text)));
  assert.ok(texts.some((text) => /info panel/.test(text)));
  assert.ok(texts.some((text) => /export|download dataset/.test(text)));
  assert.ok(texts.some((text) => /latency|performance/.test(text)));

  // Grounding is extracted independently from the raw corpus (spec included), so concrete formats and
  // worked values survive even though the spec body is never mined for requirements.
  const grounding = buildSourceGroundingExamples(context).flatMap((entry) => entry.workedExamples || []);
  assert.ok(grounding.some((example) => /Name \(X\.XX% coverage\)/i.test(example)), 'spec format template must survive as grounding');
  assert.ok(grounding.some((example) => /Cengkareng Timur/i.test(example)), 'PRD worked value must survive as grounding');
});

test('abnormal inventory: synthesis is compacted (no checklist) and the run is not production-ready', async () => {
  // 45 genuinely-distinct externally-observable rules in the PRD — over the abnormal ceiling, none collapse.
  const prdLines = Array.from(
    { length: 45 },
    (_, index) => `The response for module_alpha${index} must include field_beta${index}, outcome_gamma${index}, invariant_delta${index}, and marker_epsilon${index} when trigger_zeta${index} occurs.`
  );
  // A spec page must exist to enable the inventory, and it carries the format grounding (not a requirement).
  const specBody = 'The coverage column value uses the format "Name (X.XX% coverage)" as its display template.';
  const context = buildBaseContext({
    ticketKey: 'ORB-BIG',
    scopeAuthority: { type: 'matched_prd_subsection', title: 'Big Surface', body: prdLines.join('\n'), reason: '', quality: 'high', sourceIssueKey: 'ORB-BIG' },
    confluencePages: [{ id: 'SPEC-BIG', title: 'Technical Design - Big Surface', body: specBody }],
  });

  let capturedInput: AcceptanceCriteriaSynthesisInput | undefined;
  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async (input) => {
      capturedInput = input;
      return { acceptanceCriteria: [{ id: 'AC-1', text: 'The system returns a focused analysis result.' }] };
    },
  });

  const diagnostics = finalized.acceptanceCriteriaDiagnostics;
  assert.equal(diagnostics.abnormalRequirementInventory, true);
  // The inflated checklist must NOT be handed to synthesis — that is what forced ~one AC per line.
  assert.equal((capturedInput?.directRequirements || []).length, 0, 'synthesis must not receive the inflated requirement checklist');
  assert.ok(
    capturedInput?.groundingExamples?.some((requirement) =>
      requirement.workedExamples?.some((example) => /Name \(X\.XX% coverage\)/.test(example))
    ),
    'source grounding must remain available even while the abnormal checklist is withheld'
  );
  // And the run must not stay silently production-eligible.
  assert.equal(diagnostics.acceptanceCriteriaNotProductionReady, true);
});

test('source grounding repairs a blank compacted coverage format and preserves angle-bracket templates', async () => {
  const realContext = buildRealOrb2565RequirementContext();
  let synthesisInput: AcceptanceCriteriaSynthesisInput | undefined;
  const grounded = await finalizeAcceptanceCriteria(realContext, {
    synthesizer: async (input) => {
      synthesisInput = input;
      return {
        acceptanceCriteria: [
          {
            id: 'AC-1',
            text: 'The administrative area coverage value must use the source hierarchy and percentage format " ".',
          },
        ],
      };
    },
  });

  assert.ok(
    synthesisInput?.groundingExamples?.some((requirement) =>
      requirement.workedExamples?.some((example) => /Cengkareng Timur[\s\S]*48\.84% coverage/.test(example))
    )
  );
  assert.equal(
    (synthesisInput?.directRequirements || []).some((requirement) =>
      /fmt\.sprintf|model\.AdmAreaIntersection/.test(requirement.text)
    ),
    false,
    'the implementation sentence carrying the example must not become a checklist item'
  );
  assert.match(grounded.acceptanceCriteria[0].text, /Name \(X\.XX% coverage\)/);

  const placeholderContext = buildBaseContext();
  const placeholder = await finalizeAcceptanceCriteria(placeholderContext, {
    synthesizer: async () => ({
      acceptanceCriteria: [
        {
          id: 'AC-1',
          text: 'The response uses format "<administrative-area-hierarchy> (<coverage-percentage>% coverage)".',
        },
      ],
    }),
  });
  assert.match(placeholder.acceptanceCriteria[0].text, /<administrative-area-hierarchy>/);
  assert.match(placeholder.acceptanceCriteria[0].text, /<coverage-percentage>/);
});

test('semantic requirement mapping prevents a top-two wording variant from triggering omission repair', async () => {
  const context = buildBaseContext({
    ticketKey: 'ORB-MAP',
    mainIssue: {
      key: 'ORB-MAP',
      summary: 'Return top-two coverage fields',
      description: 'The result must select the top-2 administrative areas by coverage desc and write them into two string columns.',
    },
    scopeAuthority: {
      type: 'main_jira_description',
      title: 'Return top-two coverage fields',
      body: 'The result must select the top-2 administrative areas by coverage desc and write them into two string columns.',
      reason: 'Focused mapping fixture.',
      quality: 'high',
      sourceIssueKey: 'ORB-MAP',
    },
    confluencePages: [
      {
        id: 'SPEC-MAP',
        title: 'Technical Design - Coverage Result',
        body: 'The result must select the top-2 administrative areas by coverage desc and write them into two string columns.',
      },
    ],
  });
  let synthesisCalls = 0;
  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async () => {
      synthesisCalls += 1;
      return {
        acceptanceCriteria: [
          {
            id: 'AC-1',
            text: 'Administrative areas must be selected by coverage percentage in descending order, with the highest written to the first column and the second-highest to the second column.',
          },
        ],
      };
    },
  });

  assert.equal(synthesisCalls, 1, 'a semantically covered requirement must not trigger a repair call');
  assert.deepEqual(finalized.acceptanceCriteriaDiagnostics.directRequirements?.[0]?.acceptanceCriteriaIds, ['AC-1']);
});

test('requirement mapping rejects cross-family lookalikes that share coverage or flag identifiers', () => {
  const trace = (id: string, text: string) => ({
    id,
    text,
    disposition: 'in_scope' as const,
    sourceKind: 'spec' as const,
    sourceLocation: 'Spec: ORB-2565',
    acceptanceCriteriaIds: [],
  });
  const criterion = (id: string, text: string) => ({ id, text, source: 'ORB-2565 synthesized' });

  const formatRequirement = trace(
    'REQ-FORMAT',
    'Each value is a plain string with the coverage percentage appended as (X.XX% coverage).'
  );
  const formatCriterion = criterion('AC-FORMAT', 'Each coverage column uses the format "<name> (<X.XX% coverage>)".');
  const orderingCriterion = criterion('AC-ORDER', 'Administrative areas are sorted by coverage percentage descending.');
  assert.ok(requirementCriterionMatchScore(formatRequirement, formatCriterion) > 0);
  assert.equal(requirementCriterionMatchScore(formatRequirement, orderingCriterion), 0);

  const clampRequirement = trace('REQ-CLAMP', 'Clamp coverage_pct to [0,100].');
  const thresholdCriterion = criterion('AC-THRESHOLD', 'Only rows with coverage_pct > 0 are retained.');
  assert.equal(requirementCriterionMatchScore(clampRequirement, thresholdCriterion), 0);

  const flagRequirement = trace(
    'REQ-FLAG',
    'Gate enrichment on ADM_AREA_COVERAGE_ENABLED, which defaults to off.'
  );
  const flagCriterion = criterion(
    'AC-FLAG',
    'ADM_AREA_COVERAGE_ENABLED controls enrichment and defaults to off.'
  );
  const latencyCriterion = criterion(
    'AC-LATENCY',
    'Compare latency with ADM_AREA_COVERAGE_ENABLED enabled and disabled.'
  );
  assert.ok(requirementCriterionMatchScore(flagRequirement, flagCriterion) > 0);
  assert.equal(requirementCriterionMatchScore(flagRequirement, latencyCriterion), 0);
});

test('focused omission repair keeps at most one best candidate per missing requirement', async () => {
  const sourceBody = [
    'The result columns must be exported in dataset downloads.',
    'The result columns must be streamed to API clients.',
  ].join('\n');
  const context = buildBaseContext({
    ticketKey: 'ORB-REPAIR',
    mainIssue: { key: 'ORB-REPAIR', summary: 'Stream and export result columns', description: sourceBody },
    scopeAuthority: {
      type: 'main_jira_description',
      title: 'Stream and export result columns',
      body: sourceBody,
      reason: 'Focused repair fixture.',
      quality: 'high',
      sourceIssueKey: 'ORB-REPAIR',
    },
    confluencePages: [{ id: 'SPEC-REPAIR', title: 'Technical Design - Result Delivery', body: sourceBody }],
  });
  let calls = 0;
  let repairInput: AcceptanceCriteriaSynthesisInput | undefined;
  const finalized = await finalizeAcceptanceCriteria(context, {
    synthesizer: async (input) => {
      calls += 1;
      if (!input.repairOnlyMissingRequirements) {
        return { acceptanceCriteria: [{ id: 'AC-1', text: 'The result columns must be included in dataset exports.' }] };
      }
      repairInput = input;
      return {
        acceptanceCriteria: [
          { id: 'AC-1', text: 'The result columns must be streamed to API clients.' },
          { id: 'AC-2', text: 'The result columns must be stored, streamed, and exported for all clients.' },
        ],
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(repairInput?.targetMinCriteria, 1);
  assert.equal(repairInput?.targetMaxCriteria, 1);
  assert.equal(repairInput?.existingCriteria?.length, 1);
  assert.equal(finalized.acceptanceCriteria.filter((criterion) => /direct-requirement repair/.test(criterion.source || '')).length, 1);
});
