import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import http from 'node:http';
import { UpstreamTimeoutError, describeNetworkError, requestText } from '../../src/server/services/http';

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

test('a never-responding upstream rejects with UpstreamTimeoutError instead of hanging', async () => {
  // Regression: the timeout callback used to set settled=true then rely on the 'error' handler to
  // reject — but that handler bails on settled, so the promise never settled and the request hung.
  const server = http.createServer(() => {
    /* accept the connection but never write a response */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await assert.rejects(
      requestText({ url: `http://127.0.0.1:${port}/`, upstream: 'StuckUpstream', timeoutMs: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamTimeoutError, 'expected UpstreamTimeoutError');
        assert.match((error as Error).message, /StuckUpstream request timed out after 200ms/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});
