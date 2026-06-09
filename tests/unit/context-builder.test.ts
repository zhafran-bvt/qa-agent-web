import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorToHeading,
  buildQaContext,
  classifyLinkedIssue,
  extractAcceptanceCriteriaFromText,
  extractConfluencePageRefsFromText,
  isolateStorySection,
  parseConfluenceReference,
} from '../../src/server/services/context-builder';

test('extracts Confluence page links from Jira text', () => {
  const refs = extractConfluencePageRefsFromText(
    'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/897351682/Handling+Administrative+Area+Filter#5.-As-a-PM%2C-I-want-the-filter-function',
    'ORB-2870',
    'description'
  );

  assert.deepEqual(refs, [
    {
      pageId: '897351682',
      url: 'https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/897351682/Handling+Administrative+Area+Filter#5.-As-a-PM%2C-I-want-the-filter-function',
      anchor: '5.-As-a-PM,-I-want-the-filter-function',
      issueKey: 'ORB-2870',
      sourceType: 'description',
      relationship: '',
    },
  ]);
});

test('normalizes anchor fragments into heading text', () => {
  assert.equal(anchorToHeading('5.-As-a-PM,-I-want-the-filter-function'), '5. As a PM, I want the filter function');
});

test('classifies parent story relation correctly', () => {
  assert.equal(classifyLinkedIssue({ key: 'ORB-1', linkRelation: 'is child of', issueType: 'Story' }), 'parent story');
  assert.equal(classifyLinkedIssue({ key: 'ORB-2', linkRelation: 'is blocked by', issueType: 'Task' }), 'blocking dependency');
});

test('extracts acceptance criteria from shorthand AC section', () => {
  const criteria = extractAcceptanceCriteriaFromText(
    `AC:

1. Adm Area filter is required before Add Dataset button enabled
2. Adm Area filter follows Global Area Filter sync`,
    'ORB-3118 description'
  );

  assert.deepEqual(criteria, [
    { text: 'Adm Area filter is required before Add Dataset button enabled', source: 'ORB-3118 description' },
    { text: 'Adm Area filter follows Global Area Filter sync', source: 'ORB-3118 description' },
  ]);
});

test('extracts wrapped multiline acceptance criteria without dropping later items', () => {
  const criteria = extractAcceptanceCriteriaFromText(
    `AC:

1. Adm Area filter is a required filter like any other BVT datasets before user can add the dataset i.e. Add
Dataset button is disabled
2. Adm Area filter follows the existing Global Area Filter sync`,
    'ORB-3118 description'
  );

  assert.deepEqual(criteria, [
    {
      text: 'Adm Area filter is a required filter like any other BVT datasets before user can add the dataset i.e. Add Dataset button is disabled',
      source: 'ORB-3118 description',
    },
    {
      text: 'Adm Area filter follows the existing Global Area Filter sync',
      source: 'ORB-3118 description',
    },
  ]);
});

test('extracts requirements from a non-AC heading', () => {
  const criteria = extractAcceptanceCriteriaFromText(
    `Requirements:

1. Adm Area filter is required before the user can add a dataset
2. Adm Area filter follows the existing Global Area Filter sync`,
    'ORB-3118 description'
  );

  assert.deepEqual(criteria, [
    {
      text: 'Adm Area filter is required before the user can add a dataset',
      source: 'ORB-3118 description',
    },
    {
      text: 'Adm Area filter follows the existing Global Area Filter sync',
      source: 'ORB-3118 description',
    },
  ]);
});

test('extracts numbered requirement-like items without any explicit AC heading', () => {
  const criteria = extractAcceptanceCriteriaFromText(
    `Feature details

1. Adm Area filter is required before Add Dataset button becomes enabled
2. Adm Area filter follows the existing Global Area Filter sync
3. Dataset list is shown in the side panel`,
    'ORB-3118 description'
  );

  assert.deepEqual(criteria, [
    {
      text: 'Adm Area filter is required before Add Dataset button becomes enabled',
      source: 'ORB-3118 description',
    },
    {
      text: 'Adm Area filter follows the existing Global Area Filter sync',
      source: 'ORB-3118 description',
    },
    {
      text: 'Dataset list is shown in the side panel',
      source: 'ORB-3118 description',
    },
  ]);
});

test('dedupes acceptance criteria between plain text and rendered HTML list markup', async () => {
  const issues = {
    'ORB-3118': {
      key: 'ORB-3118',
      summary: '[FE] Integrate API - Filter Line Dataset by Admin Area',
      description:
        'AC:\n\n1. Adm Area filter is a required filter like any other BVT datasets before user can add the dataset i.e. Add Dataset button is disabled\n2. Adm Area filter follows the existing Global Area Filter sync',
      renderedDescription:
        '<p>AC:</p><ol><li>Adm Area filter is a required filter like any other BVT datasets before user can add the dataset i.e. Add Dataset button is disabled</li><li>Adm Area filter follows the existing Global Area Filter sync</li></ol>',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      parent: { summary: 'Spatial Analysis', issueType: 'Epic' },
    },
  };

  const client = {
    getIssue: async () => issues['ORB-3118'] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({ id: '1', title: 'unused', body: '' }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3118', { includeComments: true });

  assert.deepEqual(
    context.acceptanceCriteria.map((criterion) => criterion.text),
    [
      'Adm Area filter is a required filter like any other BVT datasets before user can add the dataset i.e. Add Dataset button is disabled',
      'Adm Area filter follows the existing Global Area Filter sync',
    ]
  );
});

test('isolates only the targeted story section from a multi-story PRD page', () => {
  const pageBody = `
1. As a User, I need to filter administrative area level for data spatial type Adm.Area
Acceptance Criteria
1. Unrelated criterion

5. As a PM, I want the filter function can handle data contain multiple administrative area list
The current data architecture assigns geospatial entities...
Acceptance Criteria
1. Matching: A data row is included in the result set if any value in its administrative area array matches any value in the user's filter selection.
2. Integrity: The system must return the complete, original record. No row splitting, duplication, or data transformation shall occur.

6. As a User, another story
Acceptance Criteria
1. Another unrelated criterion
`;

  const section = isolateStorySection(
    pageBody,
    '5.-As-a-PM,-I-want-the-filter-function-can-handle-data-contain-multiple-administrative-area-list',
    'As a PM, I want the filter function can handle data contain multiple administrative area list'
  );

  assert.equal(section.matched, true);
  assert.match(section.body, /Matching:/);
  assert.doesNotMatch(section.body, /Unrelated criterion/);
  assert.doesNotMatch(section.body, /another story/i);
});

test('builds context with parent story precedence and scoped PRD section', async () => {
  const issues = {
    'ORB-3118': {
      key: 'ORB-3118',
      summary: '[FE] Integrate API - Filter Line Dataset by Admin Area',
      description:
        'AC:\n\n1. Adm Area filter is a required filter like any other BVT datasets before user can add the dataset i.e. Add Dataset button is disabled\n2. Adm Area filter follows the existing Global Area Filter sync',
      renderedDescription: '',
      linkedIssues: [
        {
          key: 'ORB-2870',
          relation: 'is child of',
          summary: 'As a PM, I want the filter function can handle data contain multiple administrative area list',
          issueType: 'Story',
        },
        {
          key: 'ORB-2999',
          relation: 'is blocked by',
          summary: '[BE] Dataset Explorer - Enhance Get dataset Data',
          issueType: 'Task',
        },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'Spatial Analysis', issueType: 'Epic' },
    },
    'ORB-2870': {
      key: 'ORB-2870',
      summary: 'As a PM, I want the filter function can handle data contain multiple administrative area list',
      description:
        'PRD https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/897351682/Handling+Administrative+Area+Filter#5.-As-a-PM%2C-I-want-the-filter-function-can-handle-data-contain-multiple-administrative-area-list',
      renderedDescription:
        'PRD https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/897351682/Handling+Administrative+Area+Filter#5.-As-a-PM%2C-I-want-the-filter-function-can-handle-data-contain-multiple-administrative-area-list',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
    'ORB-2999': {
      key: 'ORB-2999',
      summary: '[BE] Dataset Explorer - Enhance Get dataset Data',
      description: 'Tech design https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=1691516938',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Task',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async (key: string) => {
      if (key === 'ORB-2870') {
        return [
          {
            relationship: 'mentioned in',
            object: {
              title: 'Handling Administrative Area Filter',
              url: 'https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=897351682',
            },
          },
        ];
      }
      if (key === 'ORB-2999') {
        return [
          {
            relationship: 'Wiki Page',
            object: {
              title: 'Multiple Administrative Area Per-Row in Dataset',
              url: 'https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=1691516938',
            },
          },
        ];
      }
      return [];
    },
    getConfluencePage: async (pageId: string) => ({
      id: pageId,
      title: pageId === '897351682' ? 'Handling Administrative Area Filter' : 'Multiple Administrative Area Per-Row in Dataset',
      body:
        pageId === '897351682'
          ? `
1. As a User, unrelated story
Acceptance Criteria
1. Unrelated criterion

5. As a PM, I want the filter function can handle data contain multiple administrative area list
Acceptance Criteria
1. Matching: A data row is included in the result set if any value in its administrative area array matches any value in the user's filter selection.
2. Integrity: The system must return the complete, original record. No row splitting, duplication, or data transformation shall occur.
`
          : 'Tech design body',
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3118', { includeComments: true });

  assert.equal(context.scopeParentIssue?.key, 'ORB-2870');
  assert.equal(context.scopeParentRelation, 'is child of');
  assert.equal(context.scopeConfluenceSection?.pageId, '897351682');
  assert.equal(context.scopeConfluenceSection?.matched, true);
  assert.equal(context.linkedIssues.find((issue) => issue.key === 'ORB-2870')?.classification, 'parent story');
  assert.equal(context.linkedIssues.find((issue) => issue.key === 'ORB-2999')?.classification, 'blocking dependency');
  assert.equal(context.confidenceLevel, 'high');
  assert.equal(context.requiresConfidencePermission, false);
  assert.equal(context.acceptanceCriteriaSource, 'main_jira');
  assert.equal(context.acceptanceCriteria.some((criterion) => /Add Dataset button is disabled/.test(criterion.text)), true);
  assert.equal(context.acceptanceCriteria.some((criterion) => /^Matching:/.test(criterion.text)), false);
  assert.equal(context.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaSource, 'main_jira');
  assert.equal(context.acceptanceCriteriaDiagnostics.ignoredSources?.includes('parent_story_confluence_section'), true);
});

test('prefers main Jira AC over parent story feature flag metadata for ORB-3077-style tickets', async () => {
  const issues = {
    'ORB-3077': {
      key: 'ORB-3077',
      summary: '[FE] Integration – Open/Save Project with BVT Polygon Catchment Datasets',
      description: `AC:

1. Create migration from dataset to datasets to spatial settings
2. Save project with BVT Data Polygon Catchment Datasets
3. Open Project with BVT Data Polygon Catchment Datasets
4. Fixing Global Filter with BVT Data POI Catchment Datasets at Save Project
5. Fixing Global Filter with BVT Data POI Catchment Datasets at Open Project`,
      renderedDescription: '',
      linkedIssues: [
        {
          key: 'ORB-2873',
          relation: 'is child of',
          summary: 'As User, I want to select spatial input based on BVT Data',
          issueType: 'Story',
        },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'Spatial Analysis', issueType: 'Epic' },
    },
    'ORB-2873': {
      key: 'ORB-2873',
      summary: 'As User, I want to select spatial input based on BVT Data',
      description: `PRD: https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=1228177422#3.-As-User,-I-want-to-select-spatial-input-based-on-BVT-Data
FF: VITE_FEATURE_FLAG_IS_BVT_DATA_FOR_CATCHMENT_ENABLED`,
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '1228177422',
      title: 'BVT Data PRD',
      body: `
3. As User, I want to select spatial input based on BVT Data
Acceptance Criteria
1. Broad story criterion
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3077', { includeComments: true });

  assert.equal(context.acceptanceCriteriaSource, 'main_jira');
  assert.equal(context.acceptanceCriteria.length, 5);
  assert.equal(context.acceptanceCriteria.some((criterion) => /VITE_FEATURE_FLAG_IS_BVT_DATA_FOR_CATCHMENT_ENABLED/.test(criterion.text)), false);
  assert.equal(context.acceptanceCriteriaDiagnostics.ignoredMetadataLabels?.includes('FF'), true);
  assert.equal(context.confidenceLevel, 'high');
});

test('does not promote story metadata blocks into acceptance criteria during context build', async () => {
  const issues = {
    'ORB-5000': {
      key: 'ORB-5000',
      summary: '[FE] Empty task ticket',
      description: '',
      renderedDescription: '',
      linkedIssues: [
        {
          key: 'ORB-5001',
          relation: 'is child of',
          summary: 'As a User, I want scoped PRD fallback',
          issueType: 'Story',
        },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'Spatial Analysis', issueType: 'Epic' },
    },
    'ORB-5001': {
      key: 'ORB-5001',
      summary: 'As a User, I want scoped PRD fallback',
      description: `FF: VITE_FEATURE_FLAG_IS_BVT_DATA_FOR_CATCHMENT_ENABLED
PRD: https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=5001#1.-As-a-User,-I-want-scoped-PRD-fallback
Figma: https://example.com/figma`,
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '5001',
      title: 'Fallback PRD',
      body: `
1. As a User, I want scoped PRD fallback
Acceptance Criteria
1. The user can open the modal
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-5000', { includeComments: true });

  assert.equal(context.acceptanceCriteria.some((criterion) => /VITE_FEATURE_FLAG_IS_BVT_DATA_FOR_CATCHMENT_ENABLED/.test(criterion.text)), false);
  assert.equal(context.acceptanceCriteriaDiagnostics.ignoredMetadataLabels?.includes('FF'), true);
});

test('falls back to scoped PRD criteria when main ticket description is empty', async () => {
  const issues = {
    'ORB-4000': {
      key: 'ORB-4000',
      summary: '[FE] Empty task ticket',
      description: '',
      renderedDescription: '',
      linkedIssues: [
        {
          key: 'ORB-4001',
          relation: 'is child of',
          summary: 'As a User, I want scoped PRD fallback',
          issueType: 'Story',
        },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'Spatial Analysis', issueType: 'Epic' },
    },
    'ORB-4001': {
      key: 'ORB-4001',
      summary: 'As a User, I want scoped PRD fallback',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=5000#1.-As-a-User,-I-want-scoped-PRD-fallback',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '5000',
      title: 'Fallback PRD',
      body: `
1. As a User, I want scoped PRD fallback
Acceptance Criteria
1. The user can open the modal
2. The modal shows the saved selection
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-4000', { includeComments: true });

  assert.equal(context.acceptanceCriteriaSource, 'parent_story_confluence_section');
  assert.equal(context.acceptanceCriteria.length, 2);
  assert.equal(context.confidenceLevel, 'high');
});

test('uses the thin ticket title to narrow a PRD subsection and cleans junk user-story fragments', async () => {
  const issues = {
    'ORB-3157': {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
      renderedDescription: '',
      linkedIssues: [
        {
          key: 'ORB-1248',
          relation: 'is child of',
          summary: 'AI Assistance Summary Result',
          issueType: 'Story',
        },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'AI Assistance', issueType: 'Epic' },
    },
    'ORB-1248': {
      key: 'ORB-1248',
      summary: 'AI Assistance Summary Result',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=950075398#AI-Assistance-Summary-Result',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '950075398',
      title: 'AI Powered Assistance',
      body: `
1. AI Assistance Summary Result
Overview paragraph.

AI Summary WITH SCORE
Acceptance Criteria
1. The summary compares ranked areas.

AI Summary NO SCORE
Acceptance Criteria
1. The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.
2. The no-score AI Summary uses an absolute profiling-based narrative and describes the area characteristics, defining signals, and zone type.
3. The no-score AI Summary includes landmark context and environment risk indication.
4. Strategic Takeaways remain available for the no-score variant.

- AI:
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3157', { includeComments: true });

  assert.equal(context.acceptanceCriteriaSource, 'parent_story_confluence_section');
  assert.equal(context.scopeConfluenceSection?.matched, true);
  assert.equal(context.scopeConfluenceSection?.matchedHeading, 'AI Summary NO SCORE');
  assert.equal(context.scopeAuthority.type, 'matched_prd_subsection');
  assert.equal(context.scopeAuthority.title, 'AI Summary NO SCORE');
  assert.match(context.scopeAuthority.body, /Strategic Takeaways remain available/i);
  assert.equal(context.acceptanceCriteriaDiagnostics.thinTicketFallbackUsed, true);
  assert.equal(context.acceptanceCriteriaDiagnostics.prdSubsectionMatchQuality, 'confident');
  assert.equal(context.acceptanceCriteria.length, 4);
  assert.equal(context.acceptanceCriteria.some((criterion) => /Strategic Takeaways/i.test(criterion.text)), true);
  assert.equal(context.userStories.some((story) => /- AI:/i.test(story.text)), false);
  assert.equal(context.acceptanceCriteriaDiagnostics.userStoryFragmentsDiscardedCount, 2);
});

test('Fix 1: recovers the precise PRD anchor from the blocking BE twin when the parent Story link is bare', async () => {
  // Real ORB-3157 shape: the parent Story (ORB-1248) references the PRD page
  // WITHOUT an anchor, while the blocking BE twin (ORB-3116) carries the exact
  // pointer #AI-Summary-NO-SCORE to the same page. The resolver must source the
  // anchor from the chain so isolateStorySection locks onto the right section
  // directly — no fragile subsection ranking required.
  const prdBody = `
AI Summary WITH SCORE
Acceptance Criteria
1. The summary compares ranked areas and explains the ranking narrative.

AI Summary NO SCORE
Acceptance Criteria
1. The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.
2. The no-score AI Summary uses an absolute profiling-based narrative describing area characteristics and zone type.
3. The no-score AI Summary includes landmark context and environment risk indication.
4. Strategic Takeaways remain available for the no-score variant.
`;
  const issues = {
    'ORB-3157': {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
      renderedDescription: '',
      linkedIssues: [
        { key: 'ORB-1248', relation: 'is child of', summary: 'AI Assistance Summary Result', issueType: 'Story' },
        { key: 'ORB-3116', relation: 'is blocked by', summary: '[BE] AI Summary - No Score executive summary', issueType: 'Task' },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'AI Assistance', issueType: 'Epic' },
    },
    'ORB-1248': {
      key: 'ORB-1248',
      summary: 'AI Assistance Summary Result',
      // Bare PRD link — no anchor.
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
    'ORB-3116': {
      key: 'ORB-3116',
      summary: '[BE] AI Summary - No Score executive summary',
      // Same page, but with the precise subsection anchor.
      description: 'Spec: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance#AI-Summary-NO-SCORE',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Task',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({ id: '950075398', title: 'AI Powered Assistance', body: prdBody }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3157', { includeComments: true });

  assert.equal(context.scopeConfluenceSection?.anchor, 'AI-Summary-NO-SCORE');
  assert.equal(context.scopeConfluenceSection?.matched, true);
  assert.equal(context.scopeConfluenceSection?.matchedHeading, 'AI Summary NO SCORE');
  assert.equal(context.acceptanceCriteriaDiagnostics.scopeAnchorResolvedFromChain, true);
  assert.equal(context.acceptanceCriteria.length, 4);
  assert.equal(context.acceptanceCriteria.some((criterion) => /Strategic Takeaways/i.test(criterion.text)), true);
  // The WITH SCORE criterion must not leak in.
  assert.equal(context.acceptanceCriteria.some((criterion) => /ranking narrative/i.test(criterion.text)), false);
});

test('Fix 3: the no-score qualifier gates out the higher-overlap WITH SCORE subsection', async () => {
  // The WITH SCORE heading shares MORE generic tokens with the ticket title
  // ("AI", "Summary", "Executive") than the NO SCORE heading does. Without the
  // qualifier gate, generic overlap would let WITH SCORE win. The gate must
  // make the "no scoring" ticket land on the no-score subsection regardless.
  const issues = {
    'ORB-3157': {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
      renderedDescription: '',
      linkedIssues: [{ key: 'ORB-1248', relation: 'is child of', summary: 'AI Assistance Summary Result', issueType: 'Story' }],
      subtasks: [],
      comments: [],
      parent: { summary: 'AI Assistance', issueType: 'Epic' },
    },
    'ORB-1248': {
      key: 'ORB-1248',
      summary: 'AI Assistance Summary Result',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '950075398',
      title: 'AI Powered Assistance',
      body: `
AI Executive Summary WITH SCORE
Acceptance Criteria
1. The AI executive summary ranks and compares areas by score.

Profiling Narrative NO SCORE
Acceptance Criteria
1. Describes the area characteristics with no score and zone type.
2. Includes landmark context and environment risk indication.
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3157', { includeComments: true });

  assert.equal(context.scopeConfluenceSection?.matchedHeading, 'Profiling Narrative NO SCORE');
  assert.equal(context.acceptanceCriteria.some((criterion) => /ranks and compares areas by score/i.test(criterion.text)), false);
  assert.equal(context.acceptanceCriteria.some((criterion) => /environment risk/i.test(criterion.text)), true);
});

test('Fix 4: release-plan pages reached only via "mentioned in" do not pollute the confluence AC pool', async () => {
  const issues = {
    'ORB-3118': {
      key: 'ORB-3118',
      summary: '[FE] Integrate API - Filter Line Dataset by Admin Area',
      description:
        'AC:\n\n1. Adm Area filter is required before Add Dataset button enabled\n2. Adm Area filter follows the existing Global Area Filter sync',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      parent: { summary: 'Spatial Analysis', issueType: 'Epic' },
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [
      {
        relationship: 'mentioned in',
        object: {
          title: 'Q3 Release Plan',
          url: 'https://bvarta-project.atlassian.net/wiki/pages/viewpage.action?pageId=111222333',
        },
      },
    ],
    getConfluencePage: async () => ({
      id: '111222333',
      title: 'Q3 Release Plan',
      body: `
update: 10:00 the team must ship the toggle
FF toggle should display the new banner when enabled
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3118', { includeComments: true });

  assert.equal(context.acceptanceCriteriaSource, 'main_jira');
  // The release-plan noise must be excluded from the diagnostic confluence pool.
  assert.equal(context.acceptanceCriteriaDiagnostics.confluenceCriteria.length, 0);
});

test('Fix 5: thinTicketFallbackUsed reflects that the ranking path ran, and an unconfirmed qualifier fails loud', async () => {
  // Thin ticket whose "no scoring" qualifier cannot be confirmed by any PRD
  // heading: the resolver must flag low confidence rather than report a
  // confident-but-wrong match.
  const issues = {
    'ORB-9000': {
      key: 'ORB-9000',
      summary: '[FE] AI Summary - executive summary with no scoring',
      description: '',
      renderedDescription: '',
      linkedIssues: [{ key: 'ORB-9001', relation: 'is child of', summary: 'AI Assistance Summary Result', issueType: 'Story' }],
      subtasks: [],
      comments: [],
      parent: { summary: 'AI Assistance', issueType: 'Epic' },
    },
    'ORB-9001': {
      key: 'ORB-9001',
      summary: 'AI Assistance Summary Result',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '950075398',
      title: 'AI Powered Assistance',
      body: `
AI Summary WITH SCORE
Acceptance Criteria
1. The summary ranks and compares areas by score.
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-9000', { includeComments: true });

  assert.equal(context.acceptanceCriteriaDiagnostics.thinTicketFallbackUsed, true);
  assert.equal(context.acceptanceCriteriaDiagnostics.scopeQualifierDetected, 'no score');
  assert.equal(context.requiresConfidencePermission, true);
  assert.equal(
    context.confidenceReasons.some((reason) => /did not confirm it/i.test(reason)),
    true
  );
});

// --- Fix 2: ADF heading-hierarchy parsing -----------------------------------
const adfHeading = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const adfPara = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const adfBulletList = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [adfPara(item)] })),
});
const adfTable = (rows: string[][]) => ({
  type: 'table',
  content: rows.map((cells) => ({
    type: 'tableRow',
    content: cells.map((cell) => ({ type: 'tableCell', content: [adfPara(cell)] })),
  })),
});

// Real ORB-3157 PRD shape: H3 subsections with H4 children, plus a Plan
// Management table whose cells ("AI - Summary Analysis") look exactly like
// subheadings once flattened to text.
const aiSummaryAdf = {
  type: 'doc',
  content: [
    adfHeading(2, 'AI Assistance Summary Result'),
    adfPara('Overview of the AI assistance summary result feature.'),
    adfHeading(3, 'AI Summary WITH SCORE'),
    adfPara('The summary compares ranked areas and must explain the ranking narrative.'),
    adfHeading(3, 'AI Summary NO SCORE'),
    adfPara('The AI Summary tab is available and must display an executive summary for results with no score.'),
    adfHeading(4, 'General Summary'),
    adfPara('The summary must describe area characteristics, defining signals, and zone type with no score.'),
    adfHeading(4, 'Strategic Takeaways'),
    adfPara('Strategic Takeaways must remain available for the no-score variant, including landmark context and environment risk indication.'),
    adfTable([
      ['AI - Summary Analysis', 'Toggle on'],
      ['AI - Dataset Recommendation', 'Toggle off'],
    ]),
    adfHeading(2, 'Plan Management'),
    adfPara('Subscription toggles for plan features.'),
  ],
};

test('Fix 2: ADF hierarchy keeps H4 children inside their H3 and never treats table cells as headings', async () => {
  const issues = {
    'ORB-3157': {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
      renderedDescription: '',
      linkedIssues: [{ key: 'ORB-1248', relation: 'is child of', summary: 'AI Assistance Summary Result', issueType: 'Story' }],
      subtasks: [],
      comments: [],
      parent: { summary: 'AI Assistance', issueType: 'Epic' },
    },
    'ORB-1248': {
      key: 'ORB-1248',
      summary: 'AI Assistance Summary Result',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({ id: '950075398', title: 'AI Powered Assistance', body: 'flattened ignored when adf present', adf: aiSummaryAdf }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3157', { includeComments: true });

  // The qualifier gate + ADF hierarchy land on the NO SCORE H3, not a table cell.
  assert.equal(context.scopeConfluenceSection?.matchedHeading, 'AI Summary NO SCORE');
  // The H4 children fold into the H3 body rather than fragmenting into siblings.
  assert.match(context.scopeConfluenceSection?.body || '', /Strategic Takeaways must remain available/i);
  assert.match(context.scopeConfluenceSection?.body || '', /describe area characteristics/i);
  // The WITH SCORE sibling and the Plan Management table cells never leak in.
  assert.doesNotMatch(context.scopeConfluenceSection?.body || '', /ranking narrative/i);
  assert.equal(context.acceptanceCriteria.some((criterion) => /Toggle on/i.test(criterion.text)), false);
  assert.equal(context.acceptanceCriteria.some((criterion) => /environment risk/i.test(criterion.text)), true);
  // Raw ADF must not be shipped on the client-facing context payload.
  assert.equal((context.confluencePages[0] as any).adf, undefined);
});

test('Fix 1 + Fix 2: chain anchor isolates the precise ADF region with children absorbed', async () => {
  const issues = {
    'ORB-3157': {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - executive summary with no scoring',
      description: '',
      renderedDescription: '',
      linkedIssues: [
        { key: 'ORB-1248', relation: 'is child of', summary: 'AI Assistance Summary Result', issueType: 'Story' },
        { key: 'ORB-3116', relation: 'is blocked by', summary: '[BE] AI Summary No Score', issueType: 'Task' },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'AI Assistance', issueType: 'Epic' },
    },
    'ORB-1248': {
      key: 'ORB-1248',
      summary: 'AI Assistance Summary Result',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
    'ORB-3116': {
      key: 'ORB-3116',
      summary: '[BE] AI Summary No Score',
      description: 'Spec: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance#AI-Summary-NO-SCORE',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Task',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({ id: '950075398', title: 'AI Powered Assistance', body: 'flattened ignored', adf: aiSummaryAdf }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3157', { includeComments: true });

  assert.equal(context.scopeConfluenceSection?.anchor, 'AI-Summary-NO-SCORE');
  assert.equal(context.acceptanceCriteriaDiagnostics.scopeAnchorResolvedFromChain, true);
  assert.equal(context.scopeConfluenceSection?.matchedHeading, 'AI Summary NO SCORE');
  assert.match(context.scopeConfluenceSection?.body || '', /Strategic Takeaways must remain available/i);
  // The sibling WITH SCORE section is outside the isolated region.
  assert.doesNotMatch(context.scopeConfluenceSection?.body || '', /ranking narrative/i);
});

test('Fix 2: a PRD table following the AC list does not glue onto the trailing acceptance criterion', async () => {
  // The exact shape that corrupted output: an explicit "Acceptance Criteria"
  // bullet list immediately followed by a Plan Management table. The criteria
  // extractor would otherwise append the flattened table cells onto the last
  // bullet. Tables are excluded from ADF-derived bodies, so each AC stays clean.
  const adf = {
    type: 'doc',
    content: [
      adfHeading(2, 'AI Assistance Summary Result'),
      adfPara('Overview of the AI assistance summary result feature.'),
      adfHeading(3, 'AI Summary WITH SCORE'),
      adfPara('Acceptance Criteria'),
      adfBulletList(['The AI Summary must compare ranked areas and explain the ranking narrative.']),
      adfHeading(3, 'AI Summary NO SCORE'),
      adfPara('Acceptance Criteria'),
      adfBulletList([
        'The AI Summary tab is available and must display an executive summary for results with no score.',
        'The no-score AI Summary must include landmark context and environment risk indication.',
        'Strategic Takeaways must remain available for the no-score variant and summarize recommended actions.',
      ]),
      adfTable([
        ['AI - Summary Analysis', 'Toggle on'],
        ['AI - Dataset Recommendation', 'Toggle off'],
      ]),
      adfHeading(2, 'Plan Management'),
      adfPara('Subscription toggles for plan features.'),
    ],
  };

  const issues = {
    'ORB-3157': {
      key: 'ORB-3157',
      summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
      description: '',
      renderedDescription: '',
      linkedIssues: [{ key: 'ORB-1248', relation: 'is child of', summary: 'AI Assistance Summary Result', issueType: 'Story' }],
      subtasks: [],
      comments: [],
      parent: { summary: 'AI Assistance', issueType: 'Epic' },
    },
    'ORB-1248': {
      key: 'ORB-1248',
      summary: 'AI Assistance Summary Result',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/950075398/AI+Powered+Assistance',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({ id: '950075398', title: 'AI Powered Assistance', body: 'flattened ignored', adf }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3157', { includeComments: true });

  assert.equal(context.scopeConfluenceSection?.matchedHeading, 'AI Summary NO SCORE');
  assert.equal(context.acceptanceCriteria.length, 3);
  // No acceptance criterion carries the trailing table cells.
  assert.equal(
    context.acceptanceCriteria.some((criterion) => /Toggle on|AI - Summary Analysis|AI - Dataset Recommendation/i.test(criterion.text)),
    false
  );
  // The WITH SCORE sibling never leaks in.
  assert.equal(context.acceptanceCriteria.some((criterion) => /ranking narrative/i.test(criterion.text)), false);
  // The genuine criteria survive intact.
  assert.equal(context.acceptanceCriteria.some((criterion) => /environment risk indication\.?$/i.test(criterion.text)), true);
  assert.equal(context.acceptanceCriteria.some((criterion) => /summarize recommended actions\.?$/i.test(criterion.text)), true);
});

test('P1 generic: a non-score negation qualifier ("without pagination") gates out the asserting sibling', async () => {
  // Proves the qualifier gate is generic, not the ORB-3157 score family: the
  // negated token here is "pagination". Both siblings share "dataset list
  // pagination" tokens, so only the polarity gate can disambiguate.
  const issues = {
    'ORB-7001': {
      key: 'ORB-7001',
      summary: '[FE] Dataset Explorer - list datasets without pagination',
      description: '',
      renderedDescription: '',
      linkedIssues: [{ key: 'ORB-7002', relation: 'is child of', summary: 'As a User, I want to browse datasets', issueType: 'Story' }],
      subtasks: [],
      comments: [],
      parent: { summary: 'Dataset Explorer', issueType: 'Epic' },
    },
    'ORB-7002': {
      key: 'ORB-7002',
      summary: 'As a User, I want to browse datasets',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/770000/Dataset+Explorer+Spec',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '770000',
      title: 'Dataset Explorer Spec',
      body: `
Dataset List With Pagination
Acceptance Criteria
1. The dataset list must show pagination controls and load pages on demand.

Dataset List Without Pagination
Acceptance Criteria
1. The dataset list must display all datasets in a single scroll with no pagination controls.
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-7001', { includeComments: true });

  assert.equal(context.scopeConfluenceSection?.matchedHeading, 'Dataset List Without Pagination');
  assert.equal(context.acceptanceCriteriaDiagnostics.scopeQualifierDetected, 'no pagination');
  assert.equal(context.acceptanceCriteria.some((criterion) => /single scroll/i.test(criterion.text)), true);
  assert.equal(context.acceptanceCriteria.some((criterion) => /load pages on demand/i.test(criterion.text)), false);
});

test('P2: a tied/zero-overlap sibling anchor never displaces the parent Story anchor', async () => {
  const issues = {
    'ORB-8001': {
      key: 'ORB-8001',
      // Has its own AC (not thin); title tokens do not overlap either anchor.
      summary: '[FE] Integrate API - Widget Settings',
      description: 'AC:\n\n1. The widget settings panel must persist the selected option on save.',
      renderedDescription: '',
      linkedIssues: [
        { key: 'ORB-8002', relation: 'is child of', summary: 'As a User, I want widget settings', issueType: 'Story' },
        { key: 'ORB-8003', relation: 'is blocked by', summary: '[BE] Widget settings storage', issueType: 'Task' },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'Widgets', issueType: 'Epic' },
    },
    'ORB-8002': {
      key: 'ORB-8002',
      summary: 'As a User, I want widget settings',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/880000/Widget+Spec#Overview-Section',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
    'ORB-8003': {
      key: 'ORB-8003',
      summary: '[BE] Widget settings storage',
      // Same page, different (equally non-overlapping) anchor.
      description: 'Spec: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/880000/Widget+Spec#Details-Section',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Task',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '880000',
      title: 'Widget Spec',
      body: `
Overview Section
Some overview text.

Details Section
Some details text.
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-8001', { includeComments: true });

  // Parent precedence: the sibling's equally-overlapping anchor must not win.
  assert.equal(context.scopeConfluenceSection?.anchor, 'Overview-Section');
  assert.equal(context.acceptanceCriteriaDiagnostics.scopeAnchorResolvedFromChain, false);
});

test('P2: a strictly-higher-overlap sibling anchor does override the parent anchor', async () => {
  const issues = {
    'ORB-8101': {
      key: 'ORB-8101',
      summary: '[FE] Integrate API - Details Widget',
      description: 'AC:\n\n1. The details widget must persist the selected option on save.',
      renderedDescription: '',
      linkedIssues: [
        { key: 'ORB-8102', relation: 'is child of', summary: 'As a User, I want widget settings', issueType: 'Story' },
        { key: 'ORB-8103', relation: 'is blocked by', summary: '[BE] Widget storage', issueType: 'Task' },
      ],
      subtasks: [],
      comments: [],
      parent: { summary: 'Widgets', issueType: 'Epic' },
    },
    'ORB-8102': {
      key: 'ORB-8102',
      summary: 'As a User, I want widget settings',
      description: 'PRD: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/881000/Widget+Spec#Overview-Section',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Story',
    },
    'ORB-8103': {
      key: 'ORB-8103',
      summary: '[BE] Widget storage',
      // Anchor shares the "details" token with the main ticket title.
      description: 'Spec: https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/881000/Widget+Spec#Details-Widget-Section',
      renderedDescription: '',
      linkedIssues: [],
      subtasks: [],
      comments: [],
      issueType: 'Task',
    },
  };

  const client = {
    getIssue: async (key: keyof typeof issues) => issues[key] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({
      id: '881000',
      title: 'Widget Spec',
      body: `
Overview Section
Some overview text.

Details Widget Section
Some details text.
`,
    }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-8101', { includeComments: true });

  assert.equal(context.scopeConfluenceSection?.anchor, 'Details-Widget-Section');
  assert.equal(context.acceptanceCriteriaDiagnostics.scopeAnchorResolvedFromChain, true);
});

test('parses page id and anchor from story PRD links', () => {
  const ref = parseConfluenceReference(
    'https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/897351682/Handling+Administrative+Area+Filter#5.-As-a-PM%2C-I-want-the-filter-function',
    'ORB-2870',
    'story-description'
  );

  assert.equal(ref?.pageId, '897351682');
  assert.equal(ref?.anchor, '5.-As-a-PM,-I-want-the-filter-function');
});

test('backend ticket with an endpoint-list scope extracts its own criteria (main_jira, not parent PRD)', async () => {
  const issues = {
    'ORB-3198': {
      key: 'ORB-3198',
      summary: '[BE] Partner Whitelabel - Partner Dataset Access Validation',
      description:
        'Scope\n\n* Partner dataset access validation on the following APIs\n    * Get dataset list\n    * Get dataset metadata/schema (detail)\n    * Get dataset data (stream & non-stream)\n    * Submit analysis\n    * User dataset export\n    * Forgot password\n    * Reset password',
      renderedDescription: '',
      labels: ['Backend'],
      linkedIssues: [],
      subtasks: [],
      comments: [],
      parent: { summary: 'White label', issueType: 'Epic' },
    },
  };

  const client = {
    getIssue: async () => issues['ORB-3198'] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({ id: '1', title: 'unused', body: '' }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-3198', { includeComments: true });

  // Backend label → api scope.
  assert.equal(context.constraints.scopeType, 'api');
  // The endpoint bullets are captured as the ticket's own criteria, so main_jira wins.
  assert.equal(context.acceptanceCriteriaSource, 'main_jira');
  assert.ok(context.acceptanceCriteria.length >= 5, `expected >=5 criteria, got ${context.acceptanceCriteria.length}`);
  assert.ok(
    context.acceptanceCriteria.some((c) => /dataset list/i.test(c.text)),
    'expected an extracted criterion mentioning the dataset list endpoint'
  );
});

test('frontend ticket does NOT treat an endpoint-list bullet as criteria (control)', async () => {
  const issues = {
    'ORB-9001': {
      key: 'ORB-9001',
      summary: '[FE] Some UI work',
      description: 'Scope\n\n* Get dataset list\n* Submit analysis',
      renderedDescription: '',
      labels: ['frontend'],
      linkedIssues: [],
      subtasks: [],
      comments: [],
      parent: { summary: 'Spatial Analysis', issueType: 'Epic' },
    },
  };

  const client = {
    getIssue: async () => issues['ORB-9001'] as any,
    getRemoteLinks: async () => [],
    getConfluencePage: async () => ({ id: '1', title: 'unused', body: '' }),
    getConfluenceComments: async () => [],
  };

  const context = await buildQaContext(client as any, 'ORB-9001', { includeComments: true });
  assert.equal(context.constraints.scopeType, 'web');
  // Endpoint-name bullets are not FE-testable criteria, so none are extracted from the ticket.
  assert.equal(context.acceptanceCriteria.length, 0);
});
