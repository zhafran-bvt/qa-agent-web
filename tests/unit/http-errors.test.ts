import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { describeNetworkError } from '../../src/server/services/http';

test('describeNetworkError maps ETIMEDOUT to a readable, upstream-named message', () => {
  const err = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const out = describeNetworkError(err, 'LLM provider (api.openai.com)');
  assert.match(out.message, /LLM provider \(api\.openai\.com\)/);
  assert.match(out.message, /did not respond in time/i);
  assert.doesNotMatch(out.message, /^read ETIMEDOUT$/);
  // original is preserved for debugging
  assert.equal((out as Error & { cause?: unknown }).cause, err);
  assert.equal((out as Error & { code?: string }).code, 'ETIMEDOUT');
});

test('describeNetworkError covers reset / refused / DNS codes', () => {
  assert.match(describeNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'OpenAI').message, /reset/i);
  assert.match(describeNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'OpenAI').message, /connection refused/i);
  assert.match(describeNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'OpenAI').message, /resolve|DNS/i);
});

test('describeNetworkError falls back to upstream-prefixed raw message for unknown codes', () => {
  const out = describeNetworkError(new Error('socket explode'), 'TestRail');
  assert.match(out.message, /TestRail request failed: socket explode/);
});
