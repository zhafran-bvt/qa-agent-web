import test from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterMs } from '../../src/server/services/testrail';

test('retryAfterMs reads the Retry-After header (seconds → ms, capped at 60s)', () => {
  assert.equal(retryAfterMs({ 'retry-after': '45' }, {}), 45_000);
  assert.equal(retryAfterMs({ 'retry-after': ['10'] }, {}), 10_000);
  assert.equal(retryAfterMs({ 'retry-after': '999' }, {}), 60_000); // capped
});

test('retryAfterMs falls back to parsing the TestRail body message', () => {
  const body = { error: 'API Rate Limit Exceeded - 180 per minute maximum allowed. Retry after 45 seconds.' };
  assert.equal(retryAfterMs({}, body), 45_000);
});

test('retryAfterMs returns 0 when neither header nor message is present', () => {
  assert.equal(retryAfterMs({}, { error: 'something else' }), 0);
  assert.equal(retryAfterMs({}, null), 0);
});
