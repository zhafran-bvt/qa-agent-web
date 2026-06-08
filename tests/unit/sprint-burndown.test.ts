import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSprintBurndown } from '../../src/server/services/sprint-burndown';
import type { SimplifiedIssue } from '../../src/server/services/atlassian';

function issue(input: Partial<SimplifiedIssue> & { key: string; status: string; issueType: string }): SimplifiedIssue {
  return {
    ...input,
    key: input.key,
    description: '',
    renderedDescription: '',
    comments: [],
    subtasks: [],
    linkedIssues: [],
    labels: [],
    components: [],
  };
}

test('summarizes active sprint burndown from Jira issues', () => {
  const summary = summarizeSprintBurndown('sprint in openSprints()', [
    issue({ key: 'ORB-1', summary: 'Finished', status: 'Done', issueType: 'Task' }),
    issue({ key: 'ORB-2', summary: 'Still open', status: 'In Progress', issueType: 'Bug' }),
    issue({ key: 'ORB-3', summary: 'Ready', status: 'To Do', issueType: 'Story' }),
  ]);

  assert.equal(summary.totalIssues, 3);
  assert.equal(summary.doneIssues, 1);
  assert.equal(summary.remainingIssues, 2);
  assert.equal(summary.completionRate, 33);
  assert.deepEqual(summary.statusDistribution, { Done: 1, 'In Progress': 1, 'To Do': 1 });
  assert.deepEqual(summary.issueTypeDistribution, { Task: 1, Bug: 1, Story: 1 });
  assert.equal(summary.issues[0].key, 'ORB-1');
});
