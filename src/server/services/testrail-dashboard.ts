import type { TrPlanSummary, TrSummary } from '../../shared/contracts';
import { extractRunsFromPlan, getPlans, type TestRailConfig } from './testrail';
import {
  calculateCompletionRate,
  calculatePassRate,
  statusDistributionFromCounts,
  type StatusDistribution,
} from './testrail-stats';
import { TtlCache } from './ttl-cache';

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

function summarizePlan(config: TestRailConfig, plan: Record<string, unknown>): TrPlanSummary {
  const distribution = statusDistributionFromCounts(plan);
  const planId = num(plan.id);
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
    webUrl: planWebUrl(config, planId),
  };
}

const plansTtl = Number(process.env.DASHBOARD_PLANS_CACHE_TTL_MS || 180_000);
const plansCache = new TtlCache<TrPlanSummary[]>(plansTtl, 32);

export async function listPlans(config: TestRailConfig, projectId?: string): Promise<TrPlanSummary[]> {
  const pid = String(projectId || config.projectId || '').trim();
  const cacheKey = `plans:${pid}`;
  const cached = plansCache.get(cacheKey);
  if (cached) return cached;
  const plans = await getPlans(config, projectId);
  const summaries = plans
    .map((plan) => summarizePlan(config, plan))
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

export async function getSummary(config: TestRailConfig, projectId?: string): Promise<TrSummary> {
  const pid = String(projectId || config.projectId || '').trim();
  const plans = await listPlans(config, projectId); // cached
  return summarizePlans(plans, pid);
}

export function clearDashboardCaches(): void {
  plansCache.clear();
}
