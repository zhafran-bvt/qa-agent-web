import type { GeneratedTestCase, QaContext, TestCaseEvidence, TestCaseEvidenceAcceptanceCriterion } from '../../shared/contracts';
import { normalizeAcceptanceCriteriaId, normalizeList } from './validation';

function resolvePrdSectionTitle(context: QaContext): string {
  return (
    context.scopeConfluenceSection?.matchedHeading ||
    context.scopeConfluenceSection?.title ||
    context.scopeParentIssue?.summary ||
    context.mainIssue.summary ||
    'Scoped PRD section unavailable'
  );
}

function resolveEvidenceAcceptanceCriteria(testCase: GeneratedTestCase, context: QaContext): TestCaseEvidenceAcceptanceCriterion[] {
  const criteriaById = new Map(
    (context.acceptanceCriteria || []).map((criterion) => [normalizeAcceptanceCriteriaId(criterion.id), { id: criterion.id, text: criterion.text }])
  );

  return normalizeList(testCase.coversAcceptanceCriteria)
    .map((criterionId) => normalizeAcceptanceCriteriaId(criterionId))
    .map((criterionId) => criteriaById.get(criterionId))
    .filter((criterion): criterion is TestCaseEvidenceAcceptanceCriterion => Boolean(criterion));
}

export function buildCaseEvidence(testCase: GeneratedTestCase, context: QaContext): TestCaseEvidence {
  return {
    prdSectionTitle: resolvePrdSectionTitle(context),
    acceptanceCriteria: resolveEvidenceAcceptanceCriteria(testCase, context),
    coverageNote: String(testCase.evidence?.coverageNote || '').trim(),
  };
}

export function hydrateTestCasesWithEvidence(testCases: GeneratedTestCase[], context: QaContext): GeneratedTestCase[] {
  return (testCases || []).map((testCase) => ({
    ...testCase,
    evidence: buildCaseEvidence(testCase, context),
  }));
}
