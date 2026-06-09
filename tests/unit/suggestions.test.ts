import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSprintBurndownJql, buildTicketSuggestionsJql } from '../../src/server/services/suggestions';

test('ticket suggestions JQL covers active sprint frontend and backend tasks', () => {
  const jql = buildTicketSuggestionsJql('"qa assignee[user picker (single user)]"');
  assert.match(jql, /currentUser\(\)/);
  assert.match(jql, /\btype = Task\b/);
  assert.doesNotMatch(jql, /\bBug\b/);
  assert.match(jql, /\blabels IN \(frontend, backend\)/);
  assert.ok(jql.includes('sprint in openSprints()'));
  assert.match(jql, /\bstatusCategory != Done\b/);
});

test('sprint burndown JQL loads active sprint product work', () => {
  const jql = buildSprintBurndownJql();
  assert.ok(jql.includes('issuetype IN (Bug, Task)'));
  assert.ok(jql.includes('sprint IN openSprints()'));
  assert.ok(jql.includes('project = ORB'));
  assert.ok(jql.includes('type IN (Task, Bug)'));
  assert.ok(jql.includes('ORDER BY updated DESC, created DESC'));
});
