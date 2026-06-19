import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import http from 'node:http';
import { UpstreamTimeoutError, describeNetworkError, requestText, withTimeout } from '../../src/server/services/http';

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

test('withTimeout resolves with the value when the work finishes in time', async () => {
  const value = await withTimeout(Promise.resolve(42), 1000, 'fast work');
  assert.equal(value, 42);
});

test('withTimeout rejects with UpstreamTimeoutError when the work stalls past the budget', async () => {
  // Bounds a multi-step operation (paginated fetch / dashboard fan-out) that can be starved under the
  // shared rate limiter — without this, a stalled op hangs the whole request.
  const neverSettles = new Promise<number>(() => {});
  await assert.rejects(withTimeout(neverSettles, 50, 'stalled bulk fetch'), (error: unknown) => {
    assert.ok(error instanceof UpstreamTimeoutError, 'expected UpstreamTimeoutError');
    assert.match((error as Error).message, /stalled bulk fetch request timed out after 50ms/);
    return true;
  });
});

test('withTimeout propagates the underlying rejection (not a timeout) when the work fails fast', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('upstream 500')), 1000, 'failing work'),
    (error: unknown) => {
      assert.ok(!(error instanceof UpstreamTimeoutError), 'should surface the real error, not a timeout');
      assert.match((error as Error).message, /upstream 500/);
      return true;
    }
  );
});
