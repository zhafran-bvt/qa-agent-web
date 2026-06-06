import type { TrPlanSummary, TrSummary } from '../../shared/contracts';
import { extractRunsFromPlan, getCases, getPlan, getPlans, getUsers, normalizeRefTokens, type TestRailConfig } from './testrail';
import {
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

const usersTtl = Number(process.env.DASHBOARD_USERS_CACHE_TTL_MS || 600_000);
const usersCache = new TtlCache<Map<number, string>>(usersTtl, 1);

async function getUserMap(config: TestRailConfig): Promise<Map<number, string>> {
  const cached = usersCache.get('users');
  if (cached) return cached;
  let map = new Map<number, string>();
  try {
    const users = await getUsers(config);
    map = new Map(users.map((u) => [num(u.id), String(u.name || u.email || '')]));
  } catch {
    // get_users may be restricted; fall back to empty names
  }
  usersCache.set('users', map);
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
  const [plans, userMap] = await Promise.all([getPlans(config, projectId), getUserMap(config)]);
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

export function clearDashboardCaches(): void {
  plansCache.clear();
  coverageCache.clear();
  planRunCountCache.clear();
  usersCache.clear();
}
