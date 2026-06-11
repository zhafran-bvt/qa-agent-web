interface ValidationOptions {
  jiraKey?: string;
  epic?: string;
  feOnly?: boolean;
  scopeType?: 'web' | 'api';
  allowNonMainRefs?: boolean;
  acceptanceCriteria?: Array<{ id: string; text: string }>;
  enforceAcceptanceCriteria?: boolean;
  // Endpoints the API contract actually matched. When provided, postman cases are checked so an
  // apiSpec path that isn't in the contract is flagged as possibly invented (warning, not error).
  matchedEndpoints?: Array<{ method?: string; path?: string }>;
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

// Coverage substantiation: a case should only count as covering an AC if its concrete steps/
// assertions share distinctive vocabulary with the AC — otherwise the claim is inflation (e.g. an
// email-routing AC stapled onto a dataset test that never mentions email). Ubiquitous feature words
// are excluded so only meaningful overlap counts.
const SUBSTANTIATION_STOPWORDS = new Set([
  'the','a','an','and','or','of','to','in','on','for','with','via','only','not','be','is','are','was','were','that','their','this','these','those','each','all','any','when','then','given','should','must','shall','will','can','cannot','its','from','into','per','also','may',
  'system','request','requests','response','responses','api','apis','endpoint','endpoints','partner','partners','url','urls','dataset','datasets','data','access','user','users','org','organization','organizations','general','platform','return','returns','returned','include','includes','included','using','use','used','through','based','assigned','assign','validation','validate','test','case','scenario',
]);

function substantiationTokens(value: string): Set<string> {
  return new Set(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !SUBSTANTIATION_STOPWORDS.has(token))
  );
}

function caseEvidenceText(testCase: GeneratedLikeCase): string {
  const parts: Array<string | undefined> = [testCase.title, testCase.bddScenario, testCase.preconditions || testCase.custom_preconds];
  const api = testCase.apiSpec;
  if (api) parts.push(api.method, api.path, api.samplePayload, api.expectedResponse, ...(Array.isArray(api.assertions) ? api.assertions : []));
  const mv = testCase.manualVerification;
  if (mv) parts.push(mv.target, mv.expectedResult, ...(Array.isArray(mv.steps) ? mv.steps : []));
  return parts.filter(Boolean).join(' ');
}

// Endpoint provenance: a postman case should reference an endpoint that exists in the matched API
// contract. Paths are compared structurally so concrete ids (/datasets/42) match their documented
// template (/datasets/{id}) and trailing slashes / casing don't cause false misses.
export function normalizeEndpointPath(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\{.*\}$/.test(segment) || segment.startsWith(':')) return '{param}';
      if (/^\d+$/.test(segment)) return '{param}';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(segment)) return '{param}';
      return segment;
    })
    .join('/');
}

export function endpointIsDocumented(
  method: string,
  path: string,
  matched: Array<{ method?: string; path?: string }>
): boolean {
  if (!matched.length) return true; // nothing to compare against → don't penalize
  const targetPath = normalizeEndpointPath(path);
  if (!targetPath) return true;
  const targetMethod = String(method || '').toUpperCase();
  return matched.some((endpoint) => {
    if (normalizeEndpointPath(endpoint.path || '') !== targetPath) return false;
    const candidateMethod = String(endpoint.method || '').toUpperCase();
    return !candidateMethod || !targetMethod || candidateMethod === targetMethod;
  });
}

/**
 * True when a case's concrete content plausibly exercises an acceptance criterion — i.e. they share
 * at least one distinctive (non-ubiquitous) token. Criteria with no distinctive tokens cannot be
 * judged, so they are treated as substantiated (no false penalty).
 */
export function isAcceptanceCriterionSubstantiated(criterionText: string, caseText: string): boolean {
  const criterionTokens = substantiationTokens(criterionText);
  if (criterionTokens.size === 0) return true;
  const caseTokens = substantiationTokens(caseText);
  for (const token of criterionTokens) {
    if (caseTokens.has(token)) return true;
  }
  return false;
}

export function validateCase(testCase: GeneratedLikeCase, options: ValidationOptions = {}) {
  // Server-side validation mirrors the UI gates and protects direct API callers before TestRail writes.
  const errors: string[] = [];
  const warnings: string[] = [];
  const jiraKey = normalizeText(options.jiraKey).toUpperCase();
  const epic = normalizeText(options.epic);
  const scopeType = options.scopeType || 'web';
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
  const executionType = testCase.executionType || (scopeType === 'api' ? 'postman' : undefined);
  const matchedEndpoints = Array.isArray(options.matchedEndpoints) ? options.matchedEndpoints : [];

  if (!title) errors.push('Title is required.');
  if (!refs) errors.push('Jira reference is required.');
  if (!preconditions) errors.push('Preconditions are required.');
  if (!type) errors.push('Type is required.');
  if (enforceAcceptanceCriteria && hasDetectedAcceptanceCriteria && !coversAcceptanceCriteria.length) {
    errors.push('Test case must map to at least one acceptance criterion.');
  }

  if (title) {
    const platformPattern =
      scopeType === 'api'
        ? /^\[BE\]\[[^\]]+\]\[[A-Z]+-\d+\]\s.+/
        : /^\[FE\]\[[^\]]+\]\[[A-Z]+-\d+\]\s.+/;
    if (!platformPattern.test(title)) {
      errors.push(
        scopeType === 'api'
          ? 'Title must match [BE][{Epic}][Ticket ID] Title.'
          : 'Title must match [FE][{Epic}][Ticket ID] Title.'
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
    const criterionTextById = new Map(acceptanceCriteria.map((item) => [normalizeAcceptanceCriteriaId(item.id), normalizeText(item.text)]));
    const evidenceText = caseEvidenceText(testCase);
    for (const criterionId of coversAcceptanceCriteria) {
      if (!validAcceptanceCriteriaIds.has(criterionId)) {
        errors.push(`Unknown acceptance criterion ${criterionId}.`);
        continue;
      }
      const criterionText = criterionTextById.get(criterionId);
      if (criterionText && !isAcceptanceCriterionSubstantiated(criterionText, evidenceText)) {
        warnings.push(`Acceptance criterion ${criterionId} is claimed but not substantiated by the case steps/assertions.`);
      }
    }
  }

  if (scopeType === 'api' && executionType === 'postman') {
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
    if (method && path && !endpointIsDocumented(method, path, matchedEndpoints)) {
      warnings.push(
        `apiSpec endpoint ${method} ${path} is not in the matched API contract; verify it against the API docs or note it as assumed in preconditions.`
      );
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

  if (scopeType === 'api' && executionType === 'manual_db') {
    const target = normalizeText(testCase.manualVerification?.target);
    const steps = Array.isArray(testCase.manualVerification?.steps) ? testCase.manualVerification?.steps || [] : [];
    const expectedResult = normalizeText(testCase.manualVerification?.expectedResult);
    if (!target) errors.push('Manual DB case must include manualVerification.target.');
    if (!steps.length && !/\b(select|sql|database|dataset_schema|db)\b/i.test(bdd)) {
      errors.push('Manual DB case must include DB verification steps.');
    }
    if (!expectedResult) errors.push('Manual DB case must include manualVerification.expectedResult.');
  }

  // Cross-field integrity: the structured payload should agree with the claimed executionType, so a
  // case that defines an HTTP endpoint isn't filed as a manual case (or vice versa).
  const apiSpecPopulated = Boolean(normalizeText(testCase.apiSpec?.method) && normalizeText(testCase.apiSpec?.path));
  if (apiSpecPopulated && executionType && executionType !== 'postman') {
    warnings.push(`executionType is ${executionType} but apiSpec defines an HTTP endpoint; set executionType to postman or drop apiSpec.`);
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

/**
 * Criteria that NOTHING substantiates AND nothing even weak-claims — i.e. genuinely uncovered. An AC
 * that is uncovered only because its sole claim was flagged weak is excluded here: that case is
 * overrideable via the weak-coverage acknowledgement, not a hard block. Push/preflight gate on this
 * (true gap → block) rather than raw uncoveredCriteria (which conflates the two).
 */
export function trulyUncoveredCriteria(coverage: {
  uncoveredCriteria: string[];
  unsubstantiatedClaims: Array<{ criterionId: string }>;
}): string[] {
  const weakClaimed = new Set((coverage.unsubstantiatedClaims || []).map((claim) => claim.criterionId));
  return (coverage.uncoveredCriteria || []).filter((id) => !weakClaimed.has(id));
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
  // Claimed (case, AC) pairs whose case content doesn't substantiate the AC — surfaced so coverage
  // isn't silently inflated (e.g. an email-routing AC "covered" by dataset tests that never assert email).
  const unsubstantiatedClaims: Array<{ caseId: string; criterionId: string }> = [];

  for (let index = 0; index < caseList.length; index += 1) {
    const testCase = caseList[index];
    const caseId = testCase.id || `TC-${String(index + 1).padStart(2, '0')}`;
    const mappedCriteria = normalizeList(testCase.coversAcceptanceCriteria).map((item) => normalizeAcceptanceCriteriaId(item));
    if (!mappedCriteria.length) {
      unmappedCases.push(caseId);
      continue;
    }
    const evidenceText = caseEvidenceText(testCase);
    for (const criterionId of mappedCriteria) {
      const entry = entryById.get(criterionId);
      if (!entry) continue;
      if (entry.text && !isAcceptanceCriterionSubstantiated(entry.text, evidenceText)) {
        unsubstantiatedClaims.push({ caseId, criterionId });
        continue;
      }
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
    unsubstantiatedClaims,
  };
}
