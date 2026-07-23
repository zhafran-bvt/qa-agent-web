import { describe, expect, it } from 'vitest';
import { qualityGateReasons } from '../../src/client/quality';
import type { GenerateQualityEvaluation } from '../../src/shared/contracts';

function evaluation(overrides: Partial<GenerateQualityEvaluation> = {}): GenerateQualityEvaluation {
  return {
    mode: 'quality_baseline',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    durationMs: 1000,
    acceptanceCriteriaCount: 9,
    testCaseCount: 13,
    coverageEnforced: true,
    coveredCriteria: 9,
    totalCriteria: 9,
    uncoveredCriteria: [],
    weakCoverageClaims: 0,
    singlePolarityWarnings: 0,
    singlePolarityWarningLimit: 4,
    validationWarningCount: 0,
    broadCoverageWarnings: 0,
    broadCoverageWarningLimit: 2,
    duplicateCaseWarnings: 0,
    endpointAlignmentWarnings: 0,
    executionAlignmentWarnings: 0,
    invalidCaseIds: [],
    minimumFocusedCaseCount: 7,
    tinyBroadSuite: false,
    rawAcceptanceCriteriaQuality: 'strong',
    synthesisUsed: true,
    noisyRawAcceptanceCriteria: false,
    abnormalRequirementInventory: false,
    unmappedRequirementCount: 0,
    falseGreenCoverageRisk: false,
    qualityGate: 'pass',
    ...overrides,
  };
}

describe('qualityGateReasons', () => {
  it('returns no reasons for a clean pass', () => {
    expect(qualityGateReasons(evaluation())).toEqual([]);
  });

  it('surfaces the not-production-ready (noisy raw AC) reason', () => {
    const reasons = qualityGateReasons(evaluation({ noisyRawAcceptanceCriteria: true, qualityGate: 'fail' }));
    expect(reasons.some((r) => /not synthesized \(not production-ready\)/.test(r))).toBe(true);
  });

  it('surfaces unmapped in-scope requirements as a coverage-traceability reason', () => {
    const reasons = qualityGateReasons(evaluation({ unmappedRequirementCount: 3, qualityGate: 'warn' }));
    expect(reasons.some((r) => /3 in-scope source requirement\(s\) not covered/.test(r))).toBe(true);
  });

  it('includes limits in the polarity and broad-coverage reasons', () => {
    const reasons = qualityGateReasons(
      evaluation({ singlePolarityWarnings: 5, broadCoverageWarnings: 3, qualityGate: 'fail' })
    );
    expect(reasons).toContain('5 conditional AC tested in only one polarity (limit 4)');
    expect(reasons).toContain('3 case(s) mapping to >2 acceptance criteria (limit 2)');
  });

  it('orders the most blocking issues first (invalid, then uncovered)', () => {
    const reasons = qualityGateReasons(
      evaluation({
        invalidCaseIds: ['TC-2'],
        uncoveredCriteria: ['AC-3'],
        singlePolarityWarnings: 1,
        qualityGate: 'fail',
      })
    );
    expect(reasons[0]).toMatch(/invalid case/);
    expect(reasons[1]).toMatch(/uncovered acceptance criteria/);
    expect(reasons[reasons.length - 1]).toMatch(/one polarity/);
  });
});
