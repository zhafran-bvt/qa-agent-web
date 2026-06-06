/**
 * TestRail dashboard statistics — faithful port of the Python app's
 * `app/dashboard_stats.py`. Pure functions over already-fetched TestRail data so
 * they can be unit-tested for parity without network access.
 *
 * Status IDs (TestRail defaults): 1=Passed, 2=Blocked, 3=Untested, 4=Retest, 5=Failed.
 * - Pass rate       = Passed / (Total - Untested) * 100   (0 if nothing executed)
 * - Completion rate = (Total - Untested) / Total * 100     (0 if no tests)
 */

export const DEFAULT_STATUS_MAP: Record<number, string> = {
  1: 'Passed',
  2: 'Blocked',
  3: 'Untested',
  4: 'Retest',
  5: 'Failed',
};

export type StatusDistribution = Record<string, number>;

export interface RunStatistics {
  runId: number;
  runName: string;
  suiteName: string | null;
  isCompleted: boolean;
  totalTests: number;
  statusDistribution: StatusDistribution;
  passRate: number;
  completionRate: number;
  updatedOn: number | null;
}

export interface PlanStatistics {
  planId: number;
  planName: string;
  createdOn: number;
  isCompleted: boolean;
  updatedOn: number | null;
  totalRuns: number;
  totalTests: number;
  statusDistribution: StatusDistribution;
  passRate: number;
  completionRate: number;
  failedCount: number;
  blockedCount: number;
  untestedCount: number;
}

type TestRow = Record<string, unknown>;

function coerceInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Aggregate test rows by status name. Mirrors `calculate_status_distribution`:
 * null/missing status_id -> "Untested"; un-coercible -> "Unknown"; unknown id -> "Unknown".
 */
export function calculateStatusDistribution(
  tests: TestRow[],
  statusMap: Record<number, string> = DEFAULT_STATUS_MAP
): StatusDistribution {
  if (!Array.isArray(tests)) throw new Error('tests must be an array');
  const distribution: StatusDistribution = {};
  for (const test of tests) {
    if (!test || typeof test !== 'object') continue;
    const rawStatus = (test as TestRow).status_id;
    let statusName: string;
    if (rawStatus === null || rawStatus === undefined) {
      statusName = 'Untested';
    } else {
      const statusId = coerceInt(rawStatus);
      statusName = statusId === null ? 'Unknown' : statusMap[statusId] || 'Unknown';
    }
    distribution[statusName] = (distribution[statusName] || 0) + 1;
  }
  return distribution;
}

/**
 * Build a distribution from a TestRail plan/run object's built-in `*_count` fields
 * (passed_count, failed_count, ...). Lets the list/detail views skip the per-run
 * get_tests fan-out while keeping the same rate math. Zero buckets are omitted.
 */
export function statusDistributionFromCounts(obj: Record<string, unknown> | null | undefined): StatusDistribution {
  const source = obj && typeof obj === 'object' ? obj : {};
  const buckets: Array<[string, string]> = [
    ['Passed', 'passed_count'],
    ['Blocked', 'blocked_count'],
    ['Untested', 'untested_count'],
    ['Retest', 'retest_count'],
    ['Failed', 'failed_count'],
  ];
  const distribution: StatusDistribution = {};
  for (const [name, field] of buckets) {
    const value = coerceInt((source as Record<string, unknown>)[field]) || 0;
    if (value > 0) distribution[name] = value;
  }
  return distribution;
}

function distributionTotal(distribution: StatusDistribution): number {
  let total = 0;
  for (const count of Object.values(distribution)) {
    const value = coerceInt(count);
    if (value !== null) total += value;
  }
  return total;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Pass rate = Passed / (Total - Untested) * 100. 0 when nothing executed. */
export function calculatePassRate(distribution: StatusDistribution): number {
  const total = distributionTotal(distribution);
  if (total === 0) return 0;
  const untested = coerceInt(distribution.Untested) || 0;
  const executed = total - untested;
  if (executed <= 0) return 0;
  const passed = coerceInt(distribution.Passed) || 0;
  return clampPercent((passed / executed) * 100);
}

/** Completion rate = (Total - Untested) / Total * 100. 0 when no tests. */
export function calculateCompletionRate(distribution: StatusDistribution): number {
  const total = distributionTotal(distribution);
  if (total === 0) return 0;
  const untested = coerceInt(distribution.Untested) || 0;
  const executed = total - untested;
  return clampPercent((executed / total) * 100);
}

/**
 * Build run statistics from the run's test rows (TestRail `get_tests/{run_id}`),
 * mirroring `calculate_run_statistics`. Metadata is read from the first test row.
 */
export function buildRunStatistics(
  runId: number,
  tests: TestRow[],
  statusMap: Record<number, string> = DEFAULT_STATUS_MAP
): RunStatistics {
  if (!Array.isArray(tests)) throw new Error(`Invalid tests data for run ${runId}`);
  const statusDistribution = calculateStatusDistribution(tests, statusMap);

  let runName = `Run ${runId}`;
  let suiteName: string | null = null;
  let isCompleted = false;
  let updatedOn: number | null = null;

  if (tests.length) {
    const first = (tests[0] && typeof tests[0] === 'object' ? tests[0] : {}) as TestRow;
    runName = (first.run_name as string) || runName;
    suiteName = (first.suite_name as string) ?? null;
    isCompleted = tests.every((t) => t && typeof t === 'object' && (t as TestRow).status_id != null);
    const timestamps: number[] = [];
    for (const t of tests) {
      if (t && typeof t === 'object') {
        const ts = (t as TestRow).updated_on;
        if (typeof ts === 'number' && Number.isFinite(ts)) timestamps.push(ts);
      }
    }
    updatedOn = timestamps.length ? Math.max(...timestamps) : null;
  }

  return {
    runId,
    runName,
    suiteName,
    isCompleted,
    totalTests: tests.length,
    statusDistribution,
    passRate: calculatePassRate(statusDistribution),
    completionRate: calculateCompletionRate(statusDistribution),
    updatedOn,
  };
}

export interface PlanMeta {
  id: number;
  name?: unknown;
  created_on?: unknown;
  is_completed?: unknown;
  updated_on?: unknown;
}

/**
 * Aggregate plan statistics across the provided per-run test rows, mirroring
 * `calculate_plan_statistics`. `runTests` maps runId -> that run's test rows;
 * the caller is responsible for fetching them (with bounded concurrency).
 */
export function buildPlanStatistics(
  plan: PlanMeta,
  runTests: Array<{ runId: number; tests: TestRow[] }>,
  statusMap: Record<number, string> = DEFAULT_STATUS_MAP
): PlanStatistics {
  const planId = plan.id;
  const planName = typeof plan.name === 'string' && plan.name ? plan.name : `Plan ${planId}`;
  const createdOn = coerceInt(plan.created_on) || 0;
  const isCompleted = plan.is_completed === true;
  const updatedOn = typeof plan.updated_on === 'number' ? plan.updated_on : null;

  let totalTests = 0;
  const combined: StatusDistribution = {};
  for (const { tests } of runTests) {
    if (!Array.isArray(tests)) continue;
    totalTests += tests.length;
    const runDistribution = calculateStatusDistribution(tests, statusMap);
    for (const [status, count] of Object.entries(runDistribution)) {
      combined[status] = (combined[status] || 0) + count;
    }
  }

  return {
    planId,
    planName,
    createdOn,
    isCompleted,
    updatedOn,
    totalRuns: runTests.length,
    totalTests,
    statusDistribution: combined,
    passRate: calculatePassRate(combined),
    completionRate: calculateCompletionRate(combined),
    failedCount: combined.Failed || 0,
    blockedCount: combined.Blocked || 0,
    untestedCount: combined.Untested || 0,
  };
}
