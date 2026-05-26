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
  assert.equal(context.acceptanceCriteriaSource, 'combined');
  assert.equal(context.acceptanceCriteria.some((criterion) => /Add Dataset button is disabled/.test(criterion.text)), true);
  assert.equal(context.acceptanceCriteria.some((criterion) => /^Matching:/.test(criterion.text)), true);
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
