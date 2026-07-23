import type { GenerateQualityEvaluation } from '../shared/contracts';

// Human-readable reasons behind a quality-gate verdict, for the post-generation banner. Order mirrors the
// server's `failed` computation (index.ts buildGenerationQualityEvaluation) so the most blocking issues
// read first. Returns [] when nothing is flagged (a clean pass).
export function qualityGateReasons(q: GenerateQualityEvaluation): string[] {
  const reasons: string[] = [];
  if (q.invalidCaseIds.length) reasons.push(`${q.invalidCaseIds.length} invalid case(s): ${q.invalidCaseIds.join(', ')}`);
  if (q.uncoveredCriteria.length)
    reasons.push(`${q.uncoveredCriteria.length} uncovered acceptance criteria: ${q.uncoveredCriteria.join(', ')}`);
  if (q.unresolvedClarificationCount)
    reasons.push(`${q.blockedCaseIds.length} case(s) blocked by ${q.unresolvedClarificationCount} unresolved technical-spec clarification(s)`);
  if (q.weakCoverageClaims)
    reasons.push(`${q.weakCoverageClaims} acceptance ${q.weakCoverageClaims === 1 ? 'criterion' : 'criteria'} claimed but not substantiated`);
  if (q.noisyRawAcceptanceCriteria)
    reasons.push('Raw acceptance criteria were weak and not synthesized (not production-ready)');
  if (q.abnormalRequirementInventory)
    reasons.push('Abnormal requirement inventory — source extraction likely over-counted; review AC granularity');
  if (q.unmappedRequirementCount)
    reasons.push(`${q.unmappedRequirementCount} in-scope source requirement(s) not covered by any acceptance criterion`);
  if (q.singlePolarityWarnings)
    reasons.push(`${q.singlePolarityWarnings} conditional AC tested in only one polarity (limit ${q.singlePolarityWarningLimit})`);
  if (q.broadCoverageWarnings)
    reasons.push(`${q.broadCoverageWarnings} case(s) mapping to >2 acceptance criteria (limit ${q.broadCoverageWarningLimit})`);
  if (q.endpointAlignmentWarnings)
    reasons.push(`${q.endpointAlignmentWarnings} case(s) exercising an endpoint not represented by apiSpec`);
  if (q.endpointDowngradeCount)
    reasons.push(`${q.endpointDowngradeCount} unverified endpoint(s) downgraded to manual integration`);
  if (q.duplicateCaseWarnings) reasons.push(`${q.duplicateCaseWarnings} potential duplicate case(s)`);
  if (q.tinyBroadSuite) reasons.push(`Too few focused cases for the AC count (expected at least ${q.minimumFocusedCaseCount})`);
  return reasons;
}
