import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGetCasesUrl, hasExactJiraRef, normalizeRefTokens } from '../../src/server/services/testrail';

test('normalizes TestRail refs into exact Jira tokens', () => {
  assert.deepEqual(normalizeRefTokens('ORB-123, orb-456 / AC-1; ORB-789'), ['ORB-123', 'ORB-456', 'AC-1', 'ORB-789']);
});

test('matches Jira refs exactly without substring false positives', () => {
  assert.equal(hasExactJiraRef('ORB-123, ORB-456', 'ORB-123'), true);
  assert.equal(hasExactJiraRef('ORB-1234, ORB-456', 'ORB-123'), false);
});

test('builds TestRail get_cases lookup with project, section, and refs filter', () => {
  assert.equal(
    buildGetCasesUrl(
      {
        baseUrl: 'https://example.testrail.io/',
        user: 'qa@example.test',
        apiKey: 'secret',
        projectId: '42',
      },
      '42',
      '69',
      'ORB-123'
    ),
    'https://example.testrail.io/index.php?/api/v2/get_cases/42&section_id=69&refs=ORB-123'
  );
});
