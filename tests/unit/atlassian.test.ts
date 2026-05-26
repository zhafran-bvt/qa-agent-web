import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from '../../src/server/services/atlassian';
import { extractAcceptanceCriteriaFromText } from '../../src/server/services/context-builder';

test('extractText preserves ordered list structure from Jira ADF descriptions', () => {
  const adf = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'AC:' }],
      },
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Create migration from dataset to datasets to spatial settings' }],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Save project with BVT Data Polygon Catchment Datasets' }],
              },
            ],
          },
        ],
      },
    ],
  };

  const extracted = extractText(adf);

  assert.match(extracted, /AC:/);
  assert.match(extracted, /1\. Create migration from dataset to datasets to spatial settings/);
  assert.match(extracted, /2\. Save project with BVT Data Polygon Catchment Datasets/);
});

test('extractAcceptanceCriteriaFromText handles inline AC heading with numbered items on one line', () => {
  const criteria = extractAcceptanceCriteriaFromText(
    'AC: 1. Create migration from dataset to datasets to spatial settings 2. Save project with BVT Data Polygon Catchment Datasets 3. Open Project with BVT Data Polygon Catchment Datasets',
    'ORB-3077 description'
  );

  assert.deepEqual(criteria, [
    {
      text: 'Create migration from dataset to datasets to spatial settings',
      source: 'ORB-3077 description',
    },
    {
      text: 'Save project with BVT Data Polygon Catchment Datasets',
      source: 'ORB-3077 description',
    },
    {
      text: 'Open Project with BVT Data Polygon Catchment Datasets',
      source: 'ORB-3077 description',
    },
  ]);
});
