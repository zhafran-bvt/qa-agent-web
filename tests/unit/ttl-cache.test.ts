import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache, mapWithConcurrency } from '../../src/server/services/ttl-cache';

test('TtlCache returns a stored value before expiry and undefined after (injectable clock)', () => {
  const cache = new TtlCache<number>(1000);
  cache.set('a', 1, 0);
  assert.equal(cache.get('a', 500), 1); // within TTL
  assert.equal(cache.get('a', 1000), undefined); // expiresAt (0 + 1000) <= now → expired
  assert.equal(cache.size, 0); // expired entry is evicted on read
});

test('TtlCache evicts the least-recently-used entry past capacity', () => {
  const cache = new TtlCache<string>(10_000, 2);
  cache.set('a', 'A', 0);
  cache.set('b', 'B', 0);
  cache.set('c', 'C', 0); // exceeds maxSize=2 → 'a' (oldest) evicted
  assert.equal(cache.get('a', 1), undefined);
  assert.equal(cache.get('b', 1), 'B');
  assert.equal(cache.get('c', 1), 'C');
  assert.equal(cache.size, 2);
});

test('TtlCache get refreshes recency so the just-read key survives eviction', () => {
  const cache = new TtlCache<string>(10_000, 2);
  cache.set('a', 'A', 0);
  cache.set('b', 'B', 0);
  assert.equal(cache.get('a', 1), 'A'); // touch 'a' → now most-recent
  cache.set('c', 'C', 1); // capacity exceeded → 'b' (now oldest) evicted, not 'a'
  assert.equal(cache.get('a', 2), 'A');
  assert.equal(cache.get('b', 2), undefined);
  assert.equal(cache.get('c', 2), 'C');
});

test('TtlCache re-set updates value and recency', () => {
  const cache = new TtlCache<number>(10_000, 2);
  cache.set('a', 1, 0);
  cache.set('a', 2, 0); // overwrite
  assert.equal(cache.get('a', 1), 2);
  assert.equal(cache.size, 1);
});

test('mapWithConcurrency preserves input order regardless of completion order', async () => {
  const delays = [30, 5, 20, 1, 15];
  const out = await mapWithConcurrency(delays, 2, async (ms, index) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return index;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
});

test('mapWithConcurrency never exceeds the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return null;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit 3`);
});

test('mapWithConcurrency handles empty input without spawning workers', async () => {
  const out = await mapWithConcurrency<number, number>([], 4, async () => {
    throw new Error('worker should not run for empty input');
  });
  assert.deepEqual(out, []);
});
