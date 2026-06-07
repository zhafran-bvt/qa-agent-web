import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanReviewRun, summarizePlans } from '../../src/server/services/testrail-dashboard';
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

test('plan review marks passed latest-result attachments as present', () => {
  const run = buildPlanReviewRun(
    { baseUrl: 'https://example.testrail.io', user: 'u', apiKey: 'k' },
    { id: 10, name: 'Chrome', passed_count: 1 },
    [{ id: 101, case_id: 501, title: 'Evidence case', status_id: 1 }],
    new Map([[101, [{ id: 9001, status_id: 1, created_on: 100 }]]]),
    new Map([[101, [{ id: 'att-1', name: 'screen.png', result_id: 9001 }]]])
  );

  assert.equal(run.tests[0].evidenceStatus, 'present');
  assert.equal(run.tests[0].attachments.length, 1);
  assert.equal(run.evidencePresentCount, 1);
});

test('plan review treats TestRail test_change attachments as result evidence', () => {
  const run = buildPlanReviewRun(
    { baseUrl: 'https://example.testrail.io', user: 'u', apiKey: 'k' },
    { id: 653, name: 'Evidence run', passed_count: 1 },
    [{ id: 345577, case_id: 18594, title: 'Widget evidence', status_id: 1 }],
    new Map([[345577, [{ id: 133456, status_id: 1, created_on: 1780652291 }]]]),
    new Map([[345577, [{ id: 1000003477, name: 'recording.mov', entity_type: 'test_change', entity_id: 133456 }]]])
  );

  assert.equal(run.tests[0].evidenceStatus, 'present');
  assert.equal(run.evidencePresentCount, 1);
});

test('plan review marks passed tests with linked nonmatching attachments as missing', () => {
  const run = buildPlanReviewRun(
    { baseUrl: 'https://example.testrail.io', user: 'u', apiKey: 'k' },
    { id: 10, name: 'Chrome', passed_count: 1 },
    [{ id: 101, case_id: 501, title: 'Evidence case', status_id: 1 }],
    new Map([[101, [{ id: 9002, status_id: 1, created_on: 200 }]]]),
    new Map([[101, [{ id: 'att-1', name: 'old.png', result_id: 9001 }]]])
  );

  assert.equal(run.tests[0].evidenceStatus, 'missing');
  assert.equal(run.evidenceMissingCount, 1);
});

test('plan review marks untested tests as not required', () => {
  const run = buildPlanReviewRun(
    { baseUrl: 'https://example.testrail.io', user: 'u', apiKey: 'k' },
    { id: 10, name: 'Chrome', untested_count: 1 },
    [{ id: 101, case_id: 501, title: 'Todo case', status_id: 3 }],
    new Map(),
    new Map()
  );

  assert.equal(run.tests[0].evidenceStatus, 'not_required');
  assert.equal(run.evidenceNotRequiredCount, 1);
});

test('plan review marks custom obsolete tests as not required', () => {
  const run = buildPlanReviewRun(
    { baseUrl: 'https://example.testrail.io', user: 'u', apiKey: 'k' },
    { id: 649, name: 'Obsolete run' },
    [{ id: 357347, case_id: 18727, title: 'Obsolete case', status_id: 6 }],
    new Map(),
    new Map(),
    new Map(),
    { 1: 'Passed', 2: 'Blocked', 3: 'Untested', 4: 'Retest', 5: 'Failed', 6: 'Obsolete' }
  );

  assert.equal(run.tests[0].status, 'Obsolete');
  assert.equal(run.tests[0].evidenceStatus, 'not_required');
  assert.equal(run.evidenceNotRequiredCount, 1);
  assert.deepEqual(run.statusDistribution, { Obsolete: 1 });
});

test('plan review marks passed evidence as unknown when attachment result linkage is unavailable', () => {
  const run = buildPlanReviewRun(
    { baseUrl: 'https://example.testrail.io', user: 'u', apiKey: 'k' },
    { id: 10, name: 'Chrome', passed_count: 1 },
    [{ id: 101, case_id: 501, title: 'Evidence case', status_id: 1 }],
    new Map([[101, [{ id: 9001, status_id: 1, created_on: 100 }]]]),
    new Map([[101, [{ id: 'att-1', name: 'library.png' }]]])
  );

  assert.equal(run.tests[0].evidenceStatus, 'unknown');
  assert.equal(run.evidenceUnknownCount, 1);
});
