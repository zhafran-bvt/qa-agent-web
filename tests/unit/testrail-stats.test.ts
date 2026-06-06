import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanStatistics,
  buildRunStatistics,
  calculateCompletionRate,
  calculatePassRate,
  calculateStatusDistribution,
  statusDistributionFromCounts,
} from '../../src/server/services/testrail-stats';

test('statusDistributionFromCounts reads built-in *_count fields and omits zeros', () => {
  assert.deepEqual(
    statusDistributionFromCounts({ passed_count: 8, failed_count: 2, untested_count: 5, blocked_count: 0, retest_count: 0 }),
    { Passed: 8, Failed: 2, Untested: 5 }
  );
  assert.deepEqual(statusDistributionFromCounts(null), {});
  // rates from counts match rates from rows for the same shape
  const dist = statusDistributionFromCounts({ passed_count: 8, failed_count: 2, untested_count: 5 });
  assert.equal(calculatePassRate(dist), 80);
});

test('status distribution maps default TestRail status ids to names', () => {
  const tests = [
    { status_id: 1 },
    { status_id: 1 },
    { status_id: 5 },
    { status_id: 2 },
    { status_id: 3 },
    { status_id: 4 },
  ];
  assert.deepEqual(calculateStatusDistribution(tests), {
    Passed: 2,
    Failed: 1,
    Blocked: 1,
    Untested: 1,
    Retest: 1,
  });
});

test('status distribution: missing status_id counts as Untested, unknown id as Unknown', () => {
  const tests = [{}, { status_id: null }, { status_id: 99 }, { status_id: 'x' }];
  assert.deepEqual(calculateStatusDistribution(tests), { Untested: 2, Unknown: 2 });
});

test('status distribution coerces numeric string status_id', () => {
  assert.deepEqual(calculateStatusDistribution([{ status_id: '1' }, { status_id: '5' }]), {
    Passed: 1,
    Failed: 1,
  });
});

test('status distribution skips non-object rows', () => {
  assert.deepEqual(calculateStatusDistribution([null, 5, 'foo', { status_id: 1 }] as never[]), { Passed: 1 });
});

test('pass rate = Passed / (Total - Untested), executed-only denominator', () => {
  // 8 passed, 2 failed, 5 untested -> executed 10 -> 80%
  assert.equal(calculatePassRate({ Passed: 8, Failed: 2, Untested: 5 }), 80);
});

test('pass rate is 0 when nothing executed or distribution empty', () => {
  assert.equal(calculatePassRate({ Untested: 10 }), 0);
  assert.equal(calculatePassRate({}), 0);
});

test('pass rate clamps to 0..100', () => {
  assert.equal(calculatePassRate({ Passed: 5 }), 100);
});

test('completion rate = (Total - Untested) / Total', () => {
  // executed 10 of 15 -> 66.66..%
  const rate = calculateCompletionRate({ Passed: 8, Failed: 2, Untested: 5 });
  assert.ok(Math.abs(rate - (10 / 15) * 100) < 1e-9);
  assert.equal(calculateCompletionRate({}), 0);
  assert.equal(calculateCompletionRate({ Untested: 4 }), 0);
});

test('buildRunStatistics derives metadata, totals, and rates from test rows', () => {
  const stats = buildRunStatistics(1001, [
    { status_id: 1, run_name: 'Smoke', suite_name: 'Web', updated_on: 100 },
    { status_id: 1, updated_on: 250 },
    {}, // no status_id -> Untested, and makes the run not "completed"
  ]);
  assert.equal(stats.runId, 1001);
  assert.equal(stats.runName, 'Smoke');
  assert.equal(stats.suiteName, 'Web');
  assert.equal(stats.totalTests, 3);
  assert.equal(stats.isCompleted, false); // a row has no status_id
  assert.equal(stats.updatedOn, 250);
  assert.equal(stats.passRate, 100); // 2 passed of 2 executed
  assert.ok(Math.abs(stats.completionRate - (2 / 3) * 100) < 1e-9);
});

test('buildRunStatistics falls back to "Run {id}" name with no tests', () => {
  const stats = buildRunStatistics(7, []);
  assert.equal(stats.runName, 'Run 7');
  assert.equal(stats.totalTests, 0);
  assert.equal(stats.passRate, 0);
  assert.equal(stats.completionRate, 0);
  assert.equal(stats.isCompleted, false);
});

test('buildPlanStatistics aggregates distributions and totals across runs', () => {
  const plan = { id: 42, name: 'Release 1', created_on: 1700000000, is_completed: false, updated_on: 1700009999 };
  const stats = buildPlanStatistics(plan, [
    { runId: 1, tests: [{ status_id: 1 }, { status_id: 5 }] },
    { runId: 2, tests: [{ status_id: 1 }, { status_id: 1 }, { status_id: 3 }] },
  ]);
  assert.equal(stats.planId, 42);
  assert.equal(stats.planName, 'Release 1');
  assert.equal(stats.totalRuns, 2);
  assert.equal(stats.totalTests, 5);
  assert.deepEqual(stats.statusDistribution, { Passed: 3, Failed: 1, Untested: 1 });
  assert.equal(stats.failedCount, 1);
  assert.equal(stats.untestedCount, 1);
  assert.equal(stats.blockedCount, 0);
  // executed = 4 (3 passed + 1 failed), passed 3 -> 75%
  assert.equal(stats.passRate, 75);
  // executed 4 of 5 -> 80%
  assert.equal(stats.completionRate, 80);
});

test('buildPlanStatistics falls back to "Plan {id}" name and zero rates when empty', () => {
  const stats = buildPlanStatistics({ id: 9 }, []);
  assert.equal(stats.planName, 'Plan 9');
  assert.equal(stats.totalRuns, 0);
  assert.equal(stats.totalTests, 0);
  assert.equal(stats.passRate, 0);
  assert.equal(stats.completionRate, 0);
});
