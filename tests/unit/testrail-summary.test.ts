import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePlans } from '../../src/server/services/testrail-dashboard';
import type { TrPlanSummary } from '../../src/shared/contracts';

function plan(overrides: Partial<TrPlanSummary>): TrPlanSummary {
  return {
    planId: 1,
    planName: 'P',
    isCompleted: false,
    createdOn: 0,
    updatedOn: null,
    totalRuns: 1,
    totalTests: 0,
    passRate: 0,
    completionRate: 0,
    statusDistribution: {},
    failedCount: 0,
    blockedCount: 0,
    untestedCount: 0,
    webUrl: '',
    ...overrides,
  };
}

test('summarizePlans aggregates distributions, plan counts, and rates', () => {
  const summary = summarizePlans(
    [
      plan({ isCompleted: false, totalTests: 10, statusDistribution: { Passed: 8, Failed: 1, Untested: 1 } }),
      plan({ isCompleted: true, totalTests: 5, statusDistribution: { Passed: 3, Blocked: 2 } }),
    ],
    '69'
  );
  assert.equal(summary.projectId, '69');
  assert.equal(summary.plans, 2);
  assert.equal(summary.activePlans, 1);
  assert.equal(summary.completedPlans, 1);
  assert.equal(summary.totalTests, 15);
  assert.deepEqual(summary.distribution, { Passed: 11, Failed: 1, Untested: 1, Blocked: 2 });
  assert.equal(summary.failed, 1);
  assert.equal(summary.blocked, 2);
  assert.equal(summary.untested, 1);
  // executed = 15 - 1 untested = 14; passed 11 -> 78.57%
  assert.ok(Math.abs(summary.passRate - (11 / 14) * 100) < 1e-9);
  // executed 14 of 15 -> 93.33%
  assert.ok(Math.abs(summary.completionRate - (14 / 15) * 100) < 1e-9);
});

test('summarizePlans handles an empty project', () => {
  const summary = summarizePlans([], '69');
  assert.equal(summary.plans, 0);
  assert.equal(summary.passRate, 0);
  assert.equal(summary.completionRate, 0);
  assert.deepEqual(summary.distribution, {});
});
