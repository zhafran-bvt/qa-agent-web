import type { GeneratedTestCase, QaContext } from '../../shared/contracts';

function normalizeCriterionId(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

/** Recompute clarification-blocked cases from source-backed diagnostics and current AC mappings. */
export function clarificationBlockedCaseIds(context: QaContext, testCases: GeneratedTestCase[]): string[] {
  const clarificationCriteria = new Set(
    (context.acceptanceCriteriaDiagnostics?.directRequirements || [])
      .filter((requirement) => requirement.disposition === 'needs_clarification')
      .flatMap((requirement) => requirement.acceptanceCriteriaIds)
      .map(normalizeCriterionId)
  );
  if (!clarificationCriteria.size) return [];
  return testCases
    .filter((testCase) =>
      (testCase.coversAcceptanceCriteria || []).some((criterionId) => clarificationCriteria.has(normalizeCriterionId(criterionId)))
    )
    .map((testCase) => testCase.id);
}

/** Missing selectedCaseIds means every ready case; an explicit empty list means select nothing. */
export function resolvePushSelection(
  context: QaContext | undefined,
  testCases: GeneratedTestCase[],
  selectedCaseIds?: string[],
  trustedBlockedCaseIds?: string[]
): { selectedCases: GeneratedTestCase[]; blockedCaseIds: string[]; unknownCaseIds: string[] } {
  const blockedCaseIds = trustedBlockedCaseIds ||
    (context
      ? clarificationBlockedCaseIds(context, testCases)
      : testCases.filter((testCase) => (testCase.clarificationBlockers || []).length > 0).map((testCase) => testCase.id));
  const availableIds = new Set(testCases.map((testCase) => testCase.id));
  const requestedIds = selectedCaseIds === undefined ? null : new Set(selectedCaseIds);
  const unknownCaseIds = requestedIds ? [...requestedIds].filter((id) => !availableIds.has(id)) : [];
  const selectedCases = testCases.filter((testCase) =>
    requestedIds ? requestedIds.has(testCase.id) : !blockedCaseIds.includes(testCase.id)
  );
  return { selectedCases, blockedCaseIds, unknownCaseIds };
}
