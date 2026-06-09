interface ValidationOptions {
  jiraKey?: string;
  epic?: string;
  feOnly?: boolean;
  scopeType?: 'web' | 'api' | 'hybrid';
  allowNonMainRefs?: boolean;
  acceptanceCriteria?: Array<{ id: string; text: string }>;
  enforceAcceptanceCriteria?: boolean;
}

interface GeneratedLikeCase {
  id?: string;
  title?: string;
  type?: string;
  executionType?: 'postman' | 'manual_db' | 'manual_other';
  jiraReference?: string;
  refs?: string;
  preconditions?: string;
  custom_preconds?: string;
  bddScenario?: string;
  coversAcceptanceCriteria?: string[] | string;
  sourceScope?: string[] | string;
  apiSpec?: {
    method?: string;
    path?: string;
    samplePayload?: string;
    expectedResponse?: string;
    assertions?: string[];
  };
  manualVerification?: {
    target?: string;
    steps?: string[];
    expectedResult?: string;
  };
  evidence?: {
    coverageNote?: string;
  };
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function extractFeOnlyValidationText(testCase: GeneratedLikeCase): string {
  const preconditions = normalizeText(testCase.preconditions || testCase.custom_preconds);
  const bdd = normalizeText(testCase.bddScenario);
  const bddBehaviorLines = bdd
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(Given|When|Then|And)\b/i.test(line))
    .join(' ');

  return ` ${preconditions} ${bddBehaviorLines} `.toLowerCase();
}

export function normalizeAcceptanceCriteriaId(value: unknown): string {
  const text = normalizeText(value)
    .toUpperCase()
    .replace(/[.:;]+$/, '')
    .replace(/\s+/g, '')
    .replace(/^AC(?=\d)/, 'AC-')
    .replace(/^AC[-_]?(\d+)$/, 'AC-$1');
  return text;
}

export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }
  return normalizeText(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateCase(testCase: GeneratedLikeCase, options: ValidationOptions = {}) {
  // Server-side validation mirrors the UI gates and protects direct API callers before TestRail writes.
  const errors: string[] = [];
  const warnings: string[] = [];
  const jiraKey = normalizeText(options.jiraKey).toUpperCase();
  const epic = normalizeText(options.epic);
  const feOnly = Boolean(options.feOnly);
  const scopeType = options.scopeType || (feOnly ? 'web' : 'web');
  const allowNonMainRefs = Boolean(options.allowNonMainRefs);
  const acceptanceCriteria = Array.isArray(options.acceptanceCriteria) ? options.acceptanceCriteria : [];
  const enforceAcceptanceCriteria = options.enforceAcceptanceCriteria !== false;
  const hasDetectedAcceptanceCriteria = acceptanceCriteria.length > 0;
  const validAcceptanceCriteriaIds = new Set(acceptanceCriteria.map((item) => normalizeAcceptanceCriteriaId(item.id)).filter(Boolean));

  const title = normalizeText(testCase.title);
  const refs = normalizeText(testCase.jiraReference || testCase.refs).toUpperCase();
  const bdd = normalizeText(testCase.bddScenario);
  const preconditions = normalizeText(testCase.preconditions || testCase.custom_preconds);
  const type = normalizeText(testCase.type);
  const coversAcceptanceCriteria = normalizeList(testCase.coversAcceptanceCriteria).map((item) => normalizeAcceptanceCriteriaId(item));
  const sourceScope = normalizeList(testCase.sourceScope);
  const coverageNote = normalizeText(testCase.evidence?.coverageNote);
  const executionType = testCase.executionType || (scopeType === 'api' || scopeType === 'hybrid' ? 'postman' : undefined);

  if (!title) errors.push('Title is required.');
  if (!refs) errors.push('Jira reference is required.');
  if (!preconditions) errors.push('Preconditions are required.');
  if (!type) errors.push('Type is required.');
  if (enforceAcceptanceCriteria && hasDetectedAcceptanceCriteria && !coversAcceptanceCriteria.length) {
    errors.push('Test case must map to at least one acceptance criterion.');
  }

  if (title) {
    const platformPattern =
      scopeType === 'api' || scopeType === 'hybrid'
        ? /^\[(Web|API|DB)\]\[[^\]]+\]\[[A-Z]+-\d+\]\s.+/
        : /^\[Web\]\[[^\]]+\]\[[A-Z]+-\d+\]\s.+/;
    if (!platformPattern.test(title)) {
      errors.push(
        scopeType === 'api' || scopeType === 'hybrid'
          ? 'Title must match [API|DB|Web][{Epic}][Ticket ID] Title.'
          : 'Title must match [Web][{Epic}][Ticket ID] Title.'
      );
    }
  }

  if (epic && title && !title.includes(`[${epic}]`)) {
    errors.push(`Title must include epic [${epic}].`);
  }

  const titleJiraMatch = title.match(/\[([A-Z]+-\d+)\]/);
  if (titleJiraMatch && refs && titleJiraMatch[1] !== refs) {
    errors.push(`Title Jira ID ${titleJiraMatch[1]} does not match refs ${refs}.`);
  }

  if (jiraKey && refs && refs !== jiraKey && !allowNonMainRefs) {
    errors.push(`Jira reference must be the main ticket ${jiraKey}.`);
  }

  for (const keyword of ['Feature:', 'Scenario:', 'Given ', 'When ', 'Then ']) {
    if (!bdd.includes(keyword)) {
      errors.push(`BDD scenario must include ${keyword.trim()}.`);
    }
  }

  if (enforceAcceptanceCriteria && hasDetectedAcceptanceCriteria) {
    for (const criterionId of coversAcceptanceCriteria) {
      if (!validAcceptanceCriteriaIds.has(criterionId)) {
        errors.push(`Unknown acceptance criterion ${criterionId}.`);
      }
    }
  }

  if (feOnly) {
    const lower = extractFeOnlyValidationText(testCase);
    const apiTerms = [' api ', ' endpoint ', ' request body ', ' response body ', ' post /', ' get /', ' put /', ' delete /'];
    if (apiTerms.some((term) => lower.includes(term))) {
      errors.push('FE-only scope cannot include backend/API test coverage.');
    }
  }

  if ((scopeType === 'api' || scopeType === 'hybrid') && executionType === 'postman') {
    const method = normalizeText(testCase.apiSpec?.method).toUpperCase();
    const path = normalizeText(testCase.apiSpec?.path);
    const bddLower = bdd.toLowerCase();
    if (!method || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
      errors.push('Postman API case must include apiSpec.method.');
    }
    if (!path || !path.startsWith('/')) {
      errors.push('Postman API case must include apiSpec.path.');
    }
    if (method && path && !bddLower.includes(method.toLowerCase()) && !bdd.includes(path)) {
      warnings.push('BDD scenario should mention the API method or path from apiSpec.');
    }
    if (/^(POST|PUT|PATCH)$/.test(method)) {
      const payload = normalizeText(testCase.apiSpec?.samplePayload);
      if (!payload && !/payload|request body|with body/i.test(bdd)) {
        errors.push('Write API case must include sample payload in apiSpec or BDD steps.');
      }
    }
    const expectedResponse = normalizeText(testCase.apiSpec?.expectedResponse);
    if (!expectedResponse && !/response status|status should|response body|expected response/i.test(bdd)) {
      errors.push('Postman API case must include expected response or response assertions.');
    }
  }

  if ((scopeType === 'api' || scopeType === 'hybrid') && executionType === 'manual_db') {
    const target = normalizeText(testCase.manualVerification?.target);
    const steps = Array.isArray(testCase.manualVerification?.steps) ? testCase.manualVerification?.steps || [] : [];
    const expectedResult = normalizeText(testCase.manualVerification?.expectedResult);
    if (!target) errors.push('Manual DB case must include manualVerification.target.');
    if (!steps.length && !/\b(select|sql|database|dataset_schema|db)\b/i.test(bdd)) {
      errors.push('Manual DB case must include DB verification steps.');
    }
    if (!expectedResult) errors.push('Manual DB case must include manualVerification.expectedResult.');
  }

  if (!coverageNote) {
    warnings.push('Evidence coverage note is missing.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalized: {
      coversAcceptanceCriteria,
      sourceScope,
    },
  };
}

export function validateCases(testCases: GeneratedLikeCase[], options: ValidationOptions = {}) {
  return (Array.isArray(testCases) ? testCases : []).map((testCase, index) => ({
    index,
    id: testCase.id || `TC-${String(index + 1).padStart(2, '0')}`,
    ...validateCase(testCase, options),
  }));
}

export function buildCoverage(
  testCases: GeneratedLikeCase[],
  acceptanceCriteria: Array<{ id: string; text: string; source?: string }>,
  options: { enforceAcceptanceCriteria?: boolean } = {}
) {
  // Coverage maps generated cases back to AC ids; generation/push uses this to block incomplete scope coverage.
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const enforceAcceptanceCriteria = options.enforceAcceptanceCriteria !== false;
  const caseList = Array.isArray(testCases) ? testCases : [];
  const entries = criteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    source: criterion.source,
    coveredBy: [] as string[],
  }));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const unmappedCases: string[] = [];

  for (let index = 0; index < caseList.length; index += 1) {
    const testCase = caseList[index];
    const caseId = testCase.id || `TC-${String(index + 1).padStart(2, '0')}`;
    const mappedCriteria = normalizeList(testCase.coversAcceptanceCriteria).map((item) => normalizeAcceptanceCriteriaId(item));
    if (!mappedCriteria.length) {
      unmappedCases.push(caseId);
      continue;
    }
    for (const criterionId of mappedCriteria) {
      const entry = entryById.get(criterionId);
      if (!entry) continue;
      entry.coveredBy.push(caseId);
    }
  }

  const uncovered = entries.filter((entry) => entry.coveredBy.length === 0);
  return {
    enforced: enforceAcceptanceCriteria,
    totalCriteria: entries.length,
    coveredCriteria: entries.length - uncovered.length,
    uncoveredCriteria: uncovered.map((entry) => entry.id),
    byCriterion: entries,
    unmappedCases,
  };
}
