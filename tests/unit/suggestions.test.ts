import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketSuggestionsJql } from '../../src/server/services/suggestions';

test('ticket suggestions JQL is limited to active sprint frontend tasks only', () => {
  const jql = buildTicketSuggestionsJql('"qa assignee[user picker (single user)]"');
  assert.match(jql, /currentUser\(\)/);
  assert.match(jql, /\btype = Task\b/);
  assert.doesNotMatch(jql, /\bBug\b/);
  assert.match(jql, /\blabels = frontend\b/);
  assert.ok(jql.includes('sprint in openSprints()'));
  assert.match(jql, /\bstatusCategory != Done\b/);
});
