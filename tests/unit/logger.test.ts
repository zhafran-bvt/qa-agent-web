import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from '../../src/server/services/logger';

test('redacts genuine credential keys', () => {
  const out = sanitize({
    accessToken: 'abc',
    refresh_token: 'def',
    api_key: 'ghi',
    authorization: 'Bearer x',
    cookie: 'sid=1',
    password: 'p',
    token: 'raw',
  }) as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    assert.equal(out[key], '[redacted]', `${key} should be redacted`);
  }
});

test('does NOT redact token-count metric fields', () => {
  const usage = {
    promptTokens: 4820,
    cachedPromptTokens: 0,
    cachedPromptTokenPct: 0,
    completionTokens: 1752,
    totalTokens: 6572,
    calls: 3,
    byTask: { generation: { promptTokens: 2922, completionTokens: 1200, totalTokens: 4122 } },
  };
  const out = sanitize(usage) as typeof usage;
  assert.equal(out.promptTokens, 4820);
  assert.equal(out.cachedPromptTokens, 0);
  assert.equal(out.cachedPromptTokenPct, 0);
  assert.equal(out.completionTokens, 1752);
  assert.equal(out.totalTokens, 6572);
  // nested metric objects survive too
  assert.equal(out.byTask.generation.promptTokens, 2922);
});
