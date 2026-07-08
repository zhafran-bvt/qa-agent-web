import type { GenerateQualityEvaluation } from '../shared/contracts';

// Human-readable reasons behind a quality-gate verdict, for the post-generation banner. Order mirrors the
// server's `failed` computation (index.ts buildGenerationQualityEvaluation) so the most blocking issues
// read first. Returns [] when nothing is flagged (a clean pass).
export function qualityGateReasons(q: GenerateQualityEvaluation): string[] {
  const reasons: string[] = [];
  if (q.invalidCaseIds.length) reasons.push(`${q.invalidCaseIds.length} invalid case(s): ${q.invalidCaseIds.join(', ')}`);
  if (q.uncoveredCriteria.length)
    reasons.push(`${q.uncoveredCriteria.length} uncovered acceptance criteria: ${q.uncoveredCriteria.join(', ')}`);
  if (q.weakCoverageClaims) reasons.push(`${q.weakCoverageClaims} acceptance criteria claimed but not substantiated`);
  if (q.noisyRawAcceptanceCriteria)
    reasons.push('Raw acceptance criteria were weak and not synthesized (not production-ready)');
  if (q.singlePolarityWarnings)
    reasons.push(`${q.singlePolarityWarnings} conditional AC tested in only one polarity (limit ${q.singlePolarityWarningLimit})`);
  if (q.broadCoverageWarnings)
    reasons.push(`${q.broadCoverageWarnings} case(s) mapping to >2 acceptance criteria (limit ${q.broadCoverageWarningLimit})`);
  if (q.endpointAlignmentWarnings)
    reasons.push(`${q.endpointAlignmentWarnings} case(s) exercising an endpoint not represented by apiSpec`);
  if (q.duplicateCaseWarnings) reasons.push(`${q.duplicateCaseWarnings} potential duplicate case(s)`);
  if (q.tinyBroadSuite) reasons.push(`Too few focused cases for the AC count (expected at least ${q.minimumFocusedCaseCount})`);
  return reasons;
}
