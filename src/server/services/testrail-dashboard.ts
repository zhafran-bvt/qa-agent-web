import type {
  TrAttachmentSummary,
  TrEvidenceStatus,
  TrPlanReviewResponse,
  TrPlanReviewRun,
  TrPlanReviewTest,
  TrPlanSummary,
  TrSummary,
} from '../../shared/contracts';
import {
  extractRunsFromPlan,
  getAttachmentsForTest,
  getCases,
  getPlan,
  getPlans,
  getResultsForRun,
  getStatuses,
  getTests,
  getUser,
  normalizeRefTokens,
  type TestRailConfig,
} from './testrail';
import {
  DEFAULT_STATUS_MAP,
  calculateCompletionRate,
  calculatePassRate,
  statusDistributionFromCounts,
  type StatusDistribution,
} from './testrail-stats';
import { mapWithConcurrency, TtlCache } from './ttl-cache';

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function distributionTotal(distribution: StatusDistribution): number {
  return Object.values(distribution).reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
}

function planWebUrl(config: TestRailConfig, planId: number): string {
  return `${config.baseUrl.replace(/\/$/, '')}/index.php?/plans/view/${planId}`;
}

function runWebUrl(config: TestRailConfig, runId: number): string {
  return `${config.baseUrl.replace(/\/$/, '')}/index.php?/runs/view/${runId}`;
}

function summarizePlan(config: TestRailConfig, plan: Record<string, unknown>, userMap?: Map<number, string>): TrPlanSummary {
  const distribution = statusDistributionFromCounts(plan);
  const planId = num(plan.id);
  const createdBy = num(plan.created_by, 0);
  return {
    planId,
    planName: typeof plan.name === 'string' && plan.name ? plan.name : `Plan ${planId}`,
    isCompleted: plan.is_completed === true,
    createdOn: num(plan.created_on),
    updatedOn: typeof plan.updated_on === 'number' ? plan.updated_on : null,
    totalRuns: num(plan.run_count, extractRunsFromPlan(plan).length),
    totalTests: distributionTotal(distribution),
    passRate: calculatePassRate(distribution),
    completionRate: calculateCompletionRate(distribution),
    statusDistribution: distribution,
    failedCount: distribution.Failed || 0,
    blockedCount: distribution.Blocked || 0,
    untestedCount: distribution.Untested || 0,
    createdBy: createdBy || undefined,
    createdByName: createdBy ? userMap?.get(createdBy) || '' : '',
    webUrl: planWebUrl(config, planId),
  };
}

function statusName(statusId: number | null, statusMap: Record<number, string>): string {
  if (statusId === null) return 'Untested';
  return statusMap[statusId] || 'Unknown';
}

const usersTtl = Number(process.env.DASHBOARD_USERS_CACHE_TTL_MS || 600_000);
// Per-id name cache. The bulk get_users is admin-only (403 for service accounts),
// so we resolve names one id at a time via get_user/{id}, which non-admins can call.
const userNameCache = new TtlCache<string>(usersTtl, 512);

async function resolveUserNames(config: TestRailConfig, ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const missing: number[] = [];
  for (const id of new Set(ids)) {
    if (!id) continue;
    const cached = userNameCache.get(String(id));
    if (cached !== undefined) map.set(id, cached);
    else missing.push(id);
  }
  await mapWithConcurrency(missing, 6, async (id) => {
    try {
      const u = await getUser(config, id);
      const name = String(u.name || u.email || '');
      userNameCache.set(String(id), name);
      map.set(id, name);
    } catch {
      userNameCache.set(String(id), ''); // remember the failure so we don't refetch
      map.set(id, '');
    }
  });
  return map;
}

const plansTtl = Number(process.env.DASHBOARD_PLANS_CACHE_TTL_MS || 180_000);
const plansCache = new TtlCache<TrPlanSummary[]>(plansTtl, 32);

const coverageTtl = Number(process.env.DASHBOARD_COVERAGE_CACHE_TTL_MS || 120_000);
const coverageCache = new TtlCache<Map<string, number>>(coverageTtl, 4);

/** Map of Jira ref (uppercased) -> number of TestRail cases referencing it, across the suite. */
async function caseRefCounts(config: TestRailConfig): Promise<Map<string, number>> {
  const cacheKey = `refs:${config.projectId || ''}:${config.suiteId || '1'}`;
  const cached = coverageCache.get(cacheKey);
  if (cached) return cached;
  const cases = await getCases(config);
  const counts = new Map<string, number>();
  for (const testCase of cases) {
    for (const token of normalizeRefTokens(String(testCase.refs || ''))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  coverageCache.set(cacheKey, counts);
  return counts;
}

export async function getCoverageForKeys(
  config: TestRailConfig,
  keys: string[]
): Promise<Record<string, { covered: boolean; count: number }>> {
  const counts = await caseRefCounts(config);
  const out: Record<string, { covered: boolean; count: number }> = {};
  for (const key of keys) {
    const count = counts.get(String(key).trim().toUpperCase()) || 0;
    out[key] = { covered: count > 0, count };
  }
  return out;
}

export async function listPlans(config: TestRailConfig, projectId?: string): Promise<TrPlanSummary[]> {
  const pid = String(projectId || config.projectId || '').trim();
  const cacheKey = `plans:${pid}`;
  const cached = plansCache.get(cacheKey);
  if (cached) return cached;
  const plans = await getPlans(config, projectId);
  const userMap = await resolveUserNames(config, plans.map((plan) => num(plan.created_by, 0)).filter(Boolean));
  const summaries = plans
    .map((plan) => summarizePlan(config, plan, userMap))
    .sort((a, b) => b.createdOn - a.createdOn);
  plansCache.set(cacheKey, summaries);
  return summaries;
}

/** Roll up plan summaries into a project-level QA-health summary (pure, testable). */
export function summarizePlans(plans: TrPlanSummary[], projectId: string): TrSummary {
  const distribution: StatusDistribution = {};
  let totalTests = 0;
  let activePlans = 0;
  let completedPlans = 0;
  for (const plan of plans) {
    if (plan.isCompleted) completedPlans++;
    else activePlans++;
    totalTests += plan.totalTests;
    for (const [status, count] of Object.entries(plan.statusDistribution)) {
      distribution[status] = (distribution[status] || 0) + count;
    }
  }
  return {
    projectId,
    plans: plans.length,
    activePlans,
    completedPlans,
    totalTests,
    passRate: calculatePassRate(distribution),
    completionRate: calculateCompletionRate(distribution),
    failed: distribution.Failed || 0,
    blocked: distribution.Blocked || 0,
    untested: distribution.Untested || 0,
    distribution,
  };
}

/** True if a plan name contains the story key as a whole token (so ORB-12 ≠ ORB-123). */
export function planNameMatchesStory(planName: string, storyKey: string): boolean {
  const key = String(storyKey || '').trim();
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(String(planName || ''));
}

/** Find plans whose name contains the story key as a whole token. */
export async function findPlansForStory(config: TestRailConfig, storyKey: string): Promise<TrPlanSummary[]> {
  if (!String(storyKey || '').trim()) return [];
  const plans = await listPlans(config);
  return plans.filter((plan) => planNameMatchesStory(plan.planName, storyKey));
}

const planRunCountTtl = Number(process.env.DASHBOARD_PLAN_RUNS_CACHE_TTL_MS || 180_000);
const planRunCountCache = new TtlCache<number>(planRunCountTtl, 512);

const planReviewTtl = Number(process.env.DASHBOARD_PLAN_REVIEW_CACHE_TTL_MS || 60_000);
const planReviewCache = new TtlCache<TrPlanReviewResponse>(planReviewTtl, 128);
const statusesCache = new TtlCache<Record<number, string>>(Number(process.env.DASHBOARD_STATUSES_CACHE_TTL_MS || 600_000), 32);

async function getStatusMap(config: TestRailConfig): Promise<Record<number, string>> {
  const cacheKey = `statuses:${config.baseUrl}`;
  const cached = statusesCache.get(cacheKey);
  if (cached) return cached;

  try {
    const statuses = await getStatuses(config);
    const statusMap = { ...DEFAULT_STATUS_MAP };
    for (const status of statuses) {
      const id = num(status.id, 0);
      const label = String(status.label || status.name || '').trim();
      if (id && label) statusMap[id] = label;
    }
    statusesCache.set(cacheKey, statusMap);
    return statusMap;
  } catch {
    return DEFAULT_STATUS_MAP;
  }
}

/** Run counts for specific plans, fetched per-plan (detail) with bounded concurrency + cache. */
export async function getPlanRunCounts(config: TestRailConfig, planIds: Array<number | string>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const missing: string[] = [];
  for (const id of planIds) {
    const key = String(id);
    const cached = planRunCountCache.get(key);
    if (cached !== undefined) out[key] = cached;
    else if (!missing.includes(key)) missing.push(key);
  }
  await mapWithConcurrency(missing, 6, async (key) => {
    try {
      const plan = await getPlan(config, key);
      const count = extractRunsFromPlan(plan).length;
      planRunCountCache.set(key, count);
      out[key] = count;
    } catch {
      out[key] = 0;
    }
  });
  return out;
}

export async function getSummary(config: TestRailConfig, projectId?: string): Promise<TrSummary> {
  const pid = String(projectId || config.projectId || '').trim();
  const plans = await listPlans(config, projectId); // cached
  return summarizePlans(plans, pid);
}

function resultId(value: Record<string, unknown> | null | undefined): number | string | null {
  if (!value || typeof value !== 'object') return null;
  const id = value.id ?? value.result_id;
  if (typeof id === 'number' || typeof id === 'string') return id;
  return null;
}

function attachmentLinkedResultId(value: Record<string, unknown>): number | string | null {
  const entityType = String(value.entity_type || '').toLowerCase();
  const raw = value.result_id ?? (entityType === 'result' || entityType === 'test_change' ? value.entity_id : null);
  if (typeof raw === 'number' || typeof raw === 'string') return raw;
  return null;
}

function passedResultsSorted(results: Record<string, unknown>[]): Record<string, unknown>[] {
  const passed = results.filter((result) => num(result.status_id, 0) === 1);
  return passed.sort((left, right) => {
    const createdDelta = num(right.created_on, 0) - num(left.created_on, 0);
    if (createdDelta) return createdDelta;
    return num(right.id ?? right.result_id, 0) - num(left.id ?? left.result_id, 0);
  });
}

// The latest result id of any status (used so non-passed tests that have run still expose a result to
// attach evidence to — evidence isn't required for them, but the reviewer may still upload).
function latestResultId(results: Record<string, unknown>[]): number | string | null {
  if (!results.length) return null;
  const sorted = [...results].sort((left, right) => {
    const createdDelta = num(right.created_on, 0) - num(left.created_on, 0);
    if (createdDelta) return createdDelta;
    return num(right.id ?? right.result_id, 0) - num(left.id ?? left.result_id, 0);
  });
  const top = sorted[0];
  const id = top.id ?? top.result_id;
  return id === undefined || id === null ? null : (id as number | string);
}

function attachmentSummary(raw: Record<string, unknown>): TrAttachmentSummary {
  const id = raw.id ?? raw.attachment_id ?? raw.data_id ?? '';
  return {
    id: String(id),
    name: String(raw.name || raw.filename || raw.id || 'Attachment'),
    createdOn: typeof raw.created_on === 'number' ? raw.created_on : null,
    size: typeof raw.size === 'number' ? raw.size : null,
  };
}

function uniqueAttachmentSummaries(attachments: Record<string, unknown>[]): TrAttachmentSummary[] {
  const seen = new Set<string>();
  const summaries: TrAttachmentSummary[] = [];
  for (const attachment of attachments) {
    const summary = attachmentSummary(attachment);
    const key = summary.id || `${summary.name}:${summary.size || ''}:${summary.createdOn || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(summary);
  }
  return summaries;
}

function evidenceForPassedTest(
  passedResults: Record<string, unknown>[],
  attachments: Record<string, unknown>[]
): { evidenceStatus: TrEvidenceStatus; latestResultId: number | string | null; matchedAttachments: TrAttachmentSummary[] } {
  const latestResultId = resultId(passedResults[0]);
  const passedResultIds = new Set(
    passedResults
      .map(resultId)
      .filter((id): id is number | string => id !== null)
      .map(String)
  );

  if (!passedResultIds.size || latestResultId === null) {
    return { evidenceStatus: 'unknown', latestResultId, matchedAttachments: [] };
  }
  if (!attachments.length) {
    return { evidenceStatus: 'missing', latestResultId, matchedAttachments: [] };
  }

  const linked = attachments.filter((attachment) => {
    const linkedResultId = attachmentLinkedResultId(attachment);
    return linkedResultId !== null && passedResultIds.has(String(linkedResultId));
  });
  if (linked.length) {
    return { evidenceStatus: 'present', latestResultId, matchedAttachments: uniqueAttachmentSummaries(linked) };
  }

  const hasReliableResultLink = attachments.some((attachment) => attachmentLinkedResultId(attachment) !== null);
  return {
    evidenceStatus: hasReliableResultLink ? 'missing' : 'unknown',
    latestResultId,
    matchedAttachments: [],
  };
}

export function buildPlanReviewRun(
  config: TestRailConfig,
  run: Record<string, unknown>,
  tests: Record<string, unknown>[],
  resultsByTestId: Map<number, Record<string, unknown>[]>,
  attachmentsByTestId: Map<number, Record<string, unknown>[]>,
  userMap = new Map<number, string>(),
  statusMap: Record<number, string> = DEFAULT_STATUS_MAP
): TrPlanReviewRun {
  const runId = num(run.id);
  const reviewTests: TrPlanReviewTest[] = tests.map((test) => {
    const testId = num(test.id);
    const caseId = num(test.case_id);
    const statusId = test.status_id === null || test.status_id === undefined ? null : num(test.status_id, 0);
    const status = statusName(statusId, statusMap);
    const assigneeId = test.assignedto_id === null || test.assignedto_id === undefined ? null : num(test.assignedto_id, 0);

    if (status !== 'Passed') {
      return {
        testId,
        runId,
        caseId,
        title: String(test.title || `Test ${testId}`),
        statusId,
        status,
        assigneeId,
        assigneeName: assigneeId ? userMap.get(assigneeId) || '' : '',
        refs: String(test.refs || ''),
        elapsed: String(test.elapsed || ''),
        defects: String(test.defects || ''),
        // Evidence isn't required for non-passed tests, but expose the latest result id so the reviewer
        // can still upload an attachment from Plan Review (untested tests have no result → null).
        latestResultId: latestResultId(resultsByTestId.get(testId) || []),
        evidenceStatus: 'not_required',
        attachments: [],
      };
    }

    const evidence = evidenceForPassedTest(
      passedResultsSorted(resultsByTestId.get(testId) || []),
      attachmentsByTestId.get(testId) || []
    );

    return {
      testId,
      runId,
      caseId,
      title: String(test.title || `Test ${testId}`),
      statusId,
      status,
      assigneeId,
      assigneeName: assigneeId ? userMap.get(assigneeId) || '' : '',
      refs: String(test.refs || ''),
      elapsed: String(test.elapsed || ''),
      defects: String(test.defects || ''),
      latestResultId: evidence.latestResultId,
      evidenceStatus: evidence.evidenceStatus,
      attachments: evidence.matchedAttachments,
    };
  });

  const distribution = calculateReviewDistribution(reviewTests);
  const evidencePresentCount = reviewTests.filter((test) => test.evidenceStatus === 'present').length;
  const evidenceMissingCount = reviewTests.filter((test) => test.evidenceStatus === 'missing').length;
  const evidenceUnknownCount = reviewTests.filter((test) => test.evidenceStatus === 'unknown').length;
  const evidenceNotRequiredCount = reviewTests.filter((test) => test.evidenceStatus === 'not_required').length;
  const passedCount = distribution.Passed || reviewTests.filter((test) => test.status === 'Passed').length;

  return {
    runId,
    runName: String(run.name || `Run ${runId}`),
    isCompleted: run.is_completed === true,
    totalTests: reviewTests.length,
    statusDistribution: distribution,
    passRate: calculatePassRate(distribution),
    completionRate: calculateCompletionRate(distribution),
    passedCount,
    evidencePresentCount,
    evidenceMissingCount,
    evidenceUnknownCount,
    evidenceNotRequiredCount,
    tests: reviewTests,
    webUrl: runWebUrl(config, runId),
  };
}

function calculateReviewDistribution(tests: TrPlanReviewTest[]): StatusDistribution {
  const distribution: StatusDistribution = {};
  for (const test of tests) {
    distribution[test.status] = (distribution[test.status] || 0) + 1;
  }
  return distribution;
}

function summarizeReview(plan: TrPlanSummary, runs: TrPlanReviewRun[]): TrPlanReviewResponse {
  return {
    plan,
    runs,
    summary: {
      totalRuns: runs.length,
      totalTests: runs.reduce((sum, run) => sum + run.totalTests, 0),
      passedCount: runs.reduce((sum, run) => sum + run.passedCount, 0),
      evidencePresentCount: runs.reduce((sum, run) => sum + run.evidencePresentCount, 0),
      evidenceMissingCount: runs.reduce((sum, run) => sum + run.evidenceMissingCount, 0),
      evidenceUnknownCount: runs.reduce((sum, run) => sum + run.evidenceUnknownCount, 0),
      evidenceNotRequiredCount: runs.reduce((sum, run) => sum + run.evidenceNotRequiredCount, 0),
    },
  };
}

export async function getPlanReview(config: TestRailConfig, planId: number | string): Promise<TrPlanReviewResponse> {
  const cacheKey = `review:${config.baseUrl}:${config.projectId || ''}:${planId}`;
  const cached = planReviewCache.get(cacheKey);
  if (cached) return cached;

  const rawPlan = await getPlan(config, planId);
  const plan = summarizePlan(config, rawPlan);
  const rawRuns = extractRunsFromPlan(rawPlan);
  const userIds = new Set<number>();
  const statusMap = await getStatusMap(config);

  const runs = await mapWithConcurrency(rawRuns, 3, async (run) => {
    const runId = num(run.id);
    const tests = await getTests(config, runId);
    for (const test of tests) {
      const assigneeId = num(test.assignedto_id, 0);
      if (assigneeId) userIds.add(assigneeId);
    }
    const passedTests = tests.filter((test) => num(test.status_id, 0) === 1);
    // One results call for the whole run (grouped by test) instead of one per passed test.
    const resultsByTestId = new Map<number, Record<string, unknown>[]>();
    const allResults = await getResultsForRun(config, runId).catch(() => []);
    for (const result of allResults) {
      const testId = num(result.test_id, 0);
      if (!testId) continue;
      const bucket = resultsByTestId.get(testId);
      if (bucket) bucket.push(result);
      else resultsByTestId.set(testId, [result]);
    }
    // Attachments still per passed test (no reliable run-level attachments endpoint).
    const attachmentsByTestId = new Map<number, Record<string, unknown>[]>();
    await mapWithConcurrency(passedTests, 4, async (test) => {
      const testId = num(test.id);
      attachmentsByTestId.set(testId, await getAttachmentsForTest(config, testId).catch(() => []));
    });
    return { run, tests, resultsByTestId, attachmentsByTestId };
  });

  const userMap = await resolveUserNames(config, [...userIds]);
  const reviewRuns = runs.map(({ run, tests, resultsByTestId, attachmentsByTestId }) =>
    buildPlanReviewRun(config, run, tests, resultsByTestId, attachmentsByTestId, userMap, statusMap)
  );
  const review = summarizeReview(plan, reviewRuns);
  planReviewCache.set(cacheKey, review);
  return review;
}

export function clearDashboardCaches(): void {
  plansCache.clear();
  coverageCache.clear();
  planRunCountCache.clear();
  planReviewCache.clear();
  statusesCache.clear();
  userNameCache.clear();
}

/** Invalidate only the caches whose data changes when evidence is uploaded — the plan-review evidence
 *  status and the coverage rollup (passed-with-evidence). Leaves plans/users/statuses caches intact. */
export function invalidateEvidenceCaches(): void {
  planReviewCache.clear();
  coverageCache.clear();
}
