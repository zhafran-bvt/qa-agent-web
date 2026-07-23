import type { AcceptanceCriteriaExecutionPlanItem, DirectRequirementTrace, TestExecutionType } from '../../shared/contracts';

interface ValidationOptions {
  jiraKey?: string;
  epic?: string;
  feOnly?: boolean;
  scopeType?: 'web' | 'api';
  allowNonMainRefs?: boolean;
  acceptanceCriteria?: Array<{ id: string; text: string }>;
  enforceAcceptanceCriteria?: boolean;
  // Endpoints the API contract actually matched. When provided, a Postman case whose method/path
  // is absent from the contract is rejected; the execution planner should already have downgraded it.
  matchedEndpoints?: Array<{ method?: string; path?: string }>;
  acceptanceCriteriaExecutionPlan?: AcceptanceCriteriaExecutionPlanItem[];
  directRequirements?: DirectRequirementTrace[];
}

interface CoverageOptions {
  enforceAcceptanceCriteria?: boolean;
  scopeType?: 'web' | 'api';
  acceptanceCriteriaExecutionPlan?: AcceptanceCriteriaExecutionPlanItem[];
}

interface HttpReference {
  method: string;
  path: string;
}

interface GeneratedLikeCase {
  id?: string;
  title?: string;
  goal?: string;
  type?: string;
  executionType?: TestExecutionType;
  caseIntent?: 'positive' | 'negative' | 'edge';
  jiraReference?: string;
  refs?: string;
  preconditions?: string;
  custom_preconds?: string;
  inputs?: string;
  expectedResult?: string;
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

function normalizeExecutionType(value: unknown): TestExecutionType | undefined {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'postman' || normalized === 'api') return 'postman';
  if (normalized === 'manual_db' || normalized === 'db' || normalized === 'database') return 'manual_db';
  if (normalized === 'manual_code_review' || normalized === 'code_review' || normalized === 'manual_code' || normalized === 'code') return 'manual_code_review';
  if (normalized === 'manual_integration' || normalized === 'integration' || normalized === 'manual_runtime') return 'manual_integration';
  if (normalized === 'manual_other' || normalized === 'manual') return 'manual_other';
  return undefined;
}

function inferExecutionType(testCase: GeneratedLikeCase, scopeType: 'web' | 'api'): TestExecutionType | undefined {
  const explicit = normalizeExecutionType(testCase.executionType);
  if (explicit) return explicit;
  if (normalizeText(testCase.apiSpec?.method) || normalizeText(testCase.apiSpec?.path)) return 'postman';
  if (testCase.manualVerification) return 'manual_other';
  return scopeType === 'api' ? 'postman' : undefined;
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function uniqueValues<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
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

function bddAssertionText(value: string): string {
  const raw = String(value || '');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const thenIndex = lines.findIndex((line) => /^Then\b/i.test(line));
  if (thenIndex >= 0) return lines.slice(thenIndex).join(' ');
  const inlineThen = raw.search(/\bThen\b/i);
  return inlineThen >= 0 ? raw.slice(inlineThen).trim() : '';
}

/**
 * Coverage must be proven by observable outcomes, not by a title, goal, Given/precondition, or a
 * coverage note that merely repeats the AC. This prevents a case from becoming green because it names
 * the requirement while its Then/assertions verify something else.
 */
function caseEvidenceText(testCase: GeneratedLikeCase): string {
  const parts: Array<string | undefined> = [testCase.expectedResult, bddAssertionText(testCase.bddScenario || '')];
  const api = testCase.apiSpec;
  if (api) parts.push(api.expectedResponse, ...(Array.isArray(api.assertions) ? api.assertions : []));
  const mv = testCase.manualVerification;
  if (mv) parts.push(mv.target, mv.expectedResult, ...(Array.isArray(mv.steps) ? mv.steps : []));
  return parts.filter(Boolean).join(' ');
}

const PRESENCE_REQUIREMENT_RE = /\b(?:return|returns|returned|include|includes|included|contain|contains|contained|expose|exposes|provide|provides|populate|populates|present|exists?|represented)\b/i;
const PRESENCE_ASSERTION_RE = /\b(?:return|returns|returned|include|includes|included|contain|contains|contained|expose|exposes|provide|provides|populate|populates|present|exists?|represented)\b/i;

function exactCriterionIdentifiers(value: string): string[] {
  return uniqueValues(
    Array.from(String(value || '').matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g)).map((match) => match[0].toLowerCase()),
    (item) => item
  );
}

/** Deterministic contract checks for details that token overlap cannot safely approximate. */
function hasRequiredCriterionSemantics(criterionText: string, assertionText: string): boolean {
  const criterion = String(criterionText || '').toLowerCase();
  const assertion = String(assertionText || '').toLowerCase();
  if (!assertion.trim()) return false;

  // Exact identifiers become mandatory when the AC defines a response/schema contract. Do not apply
  // this to every conditional identifier: a separate edge case may legitimately prove the "0 when no
  // match" branch without repeating the happy-path calculation field name.
  const identifiers = exactCriterionIdentifiers(criterion);
  const definesExactContract = /\b(?:field|column|attribute|property|key|named|value\s+of|equals?|set\s+to|contains?|includes?|including)\b/i.test(
    criterion
  );
  if (definesExactContract) {
    for (const identifier of identifiers) {
      if (!assertion.includes(identifier)) return false;
    }
  }
  if (/\bjson\s+array\b/i.test(criterion)) {
    // A schema hint such as `data_type: array` does not prove that the returned business value is an
    // actual JSON array. Remove metadata-only declarations before looking for an observable value
    // assertion. This prevents a case from claiming array coverage while checking only renderer/schema
    // metadata (the exact false-green seen on ORB-2564).
    const valueAssertion = assertion
      .replace(/\bdata[_\s-]?type\b\s*(?:is|equals?|=|:)\s*["']?(?:json\s+)?array["']?/gi, ' ')
      .replace(/["']?(?:data[_-]?type|schema[_-]?type)["']?\s*:\s*["']?(?:json\s+)?array["']?/gi, ' ');
    if (!/\b(?:json\s+)?array\b/i.test(valueAssertion)) return false;

    // When the criterion explicitly exists to support more than one value, require an observable
    // cardinality assertion. Merely naming an array still does not prove the multi-value behavior.
    if (/\b(?:multiple|more\s+than\s+one|two\s+or\s+more)\b/i.test(criterion)) {
      const assertsMultipleValues =
        /\b(?:multiple|more\s+than\s+one|two\s+or\s+more|at\s+least\s+(?:two|2))\b/i.test(assertion) ||
        /\b(?:length|count|size)\b[\s\S]{0,30}(?:>=|greater\s+than\s+or\s+equal\s+to|is|equals?)\s*(?:2|two)\b/i.test(assertion);
      if (!assertsMultipleValues) return false;
    }
  }
  if (/\bjson\s+object\b/i.test(criterion) && !/\b(?:json\s+)?object\b/i.test(assertion)) return false;
  if (/\bdouble\s+precision\b/i.test(criterion) && !/\bdouble\s+precision\b/i.test(assertion)) return false;
  if (/\bnon[-\s]?null\b/i.test(criterion) && !/\bnon[-\s]?null\b|\bnot\s+null\b/i.test(assertion)) return false;
  if (/\bdescending\b/i.test(criterion) && !/\bdescending\b|\bhighest\b[\s\S]{0,80}\bfirst\b/i.test(assertion)) return false;
  if (/\bascending\b/i.test(criterion) && !/\bascending\b|\blowest\b[\s\S]{0,80}\bfirst\b/i.test(assertion)) return false;
  if (PRESENCE_REQUIREMENT_RE.test(criterion) && !PRESENCE_ASSERTION_RE.test(assertion)) return false;
  return true;
}

function isSmokeOrEndToEndCase(testCase: GeneratedLikeCase): boolean {
  return /\b(smoke|e2e|end[-\s]?to[-\s]?end|full workflow|full flow|happy path suite|regression suite)\b/i.test(
    [testCase.title, testCase.type, testCase.bddScenario].filter(Boolean).join(' ')
  );
}

function extractHttpReferences(value: string): HttpReference[] {
  const refs: HttpReference[] = [];
  const re = /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:request\s+to\s+)?["'`]?((?:\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%{}-]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    refs.push({
      method: match[1].toUpperCase(),
      path: match[2].replace(/[.,;:)\]}]+$/, ''),
    });
  }
  return uniqueValues(refs, (ref) => `${ref.method} ${normalizeEndpointPath(ref.path)}`);
}

function httpMethodMentions(value: string): string[] {
  return uniqueValues(
    Array.from(String(value || '').matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\b/gi)).map((match) => match[1].toUpperCase()),
    (item) => item
  );
}

function bddActionText(value: string): string {
  const raw = String(value || '');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const whenIndex = lines.findIndex((line) => /^When\b/i.test(line));
  if (whenIndex >= 0) {
    const actionLines: string[] = [];
    for (const line of lines.slice(whenIndex)) {
      if (/^Then\b/i.test(line)) break;
      actionLines.push(line);
    }
    return actionLines.join(' ');
  }
  const inlineWhen = raw.search(/\bWhen\b/i);
  if (inlineWhen < 0) return '';
  const action = raw.slice(inlineWhen);
  const inlineThen = action.search(/\bThen\b/i);
  return inlineThen >= 0 ? action.slice(0, inlineThen) : action;
}

function sameHttpReference(a: HttpReference, b: HttpReference): boolean {
  if (a.method !== b.method) return false;
  // Compare structurally, not by string equality: a placeholder segment ({param}, after normalization) on
  // EITHER side matches any concrete segment on the other. So a documented template like
  // /v1/analysis/{id}/stream and a BDD reference that substituted a real id (/v1/analysis/abc123/stream)
  // count as the same endpoint — avoiding a false "additional endpoint" alignment warning. Literal segments
  // must still match, and differing segment counts never match, so a genuinely different endpoint (or a
  // second endpoint in a multi-step BDD) is still flagged.
  const segsA = normalizeEndpointPath(a.path).split('/');
  const segsB = normalizeEndpointPath(b.path).split('/');
  if (segsA.length !== segsB.length) return false;
  return segsA.every((segA, index) => {
    const segB = segsB[index];
    return segA === '{param}' || segB === '{param}' || segA === segB;
  });
}

const DUPLICATE_STOPWORDS = new Set([
  'feature', 'scenario', 'given', 'when', 'then', 'and', 'with', 'without', 'using', 'should', 'must', 'case', 'test',
  'spatial', 'analysis', 'user', 'request', 'response', 'result', 'results', 'data', 'dataset', 'output', 'method',
  'field', 'value', 'values', 'valid', 'same', 'existing', 'new', 'the', 'this', 'that', 'from', 'into',
]);

function duplicateTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/\b[A-Z]+-\d+\b/gi, ' ')
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3 && !DUPLICATE_STOPWORDS.has(token))
  );
}

function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  const minSize = Math.min(a.size, b.size);
  if (!minSize) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / minSize;
}

function normalizedCoverageSet(testCase: GeneratedLikeCase): Set<string> {
  return new Set(normalizeList(testCase.coversAcceptanceCriteria).map((item) => normalizeAcceptanceCriteriaId(item)));
}

function hasCoverageOverlap(a: GeneratedLikeCase, b: GeneratedLikeCase): boolean {
  const aSet = normalizedCoverageSet(a);
  const bSet = normalizedCoverageSet(b);
  if (!aSet.size || !bSet.size) return false;
  let intersection = 0;
  for (const id of aSet) {
    if (bSet.has(id)) intersection += 1;
  }
  return intersection / Math.min(aSet.size, bSet.size) >= 0.5;
}

export function casesLookDuplicative(a: GeneratedLikeCase, b: GeneratedLikeCase): boolean {
  if (!hasCoverageOverlap(a, b)) return false;
  const aEndpoint = `${a.apiSpec?.method || ''} ${normalizeEndpointPath(a.apiSpec?.path || '')}`.trim();
  const bEndpoint = `${b.apiSpec?.method || ''} ${normalizeEndpointPath(b.apiSpec?.path || '')}`.trim();
  if (aEndpoint && bEndpoint && aEndpoint !== bEndpoint) return false;

  // Similar titles are expected when two cases exercise the same AC in different ways. Treat cases as
  // duplicates only when their executable setup/action AND their observable assertions are materially
  // the same. This preserves valid variants while still catching reworded copies of the same test.
  const setupAndAction = (testCase: GeneratedLikeCase): string =>
    [
      testCase.preconditions,
      testCase.custom_preconds,
      testCase.inputs,
      testCase.bddScenario,
      testCase.apiSpec?.samplePayload,
      ...(testCase.manualVerification?.steps || []),
    ]
      .filter(Boolean)
      .join(' ');
  const observableAssertions = (testCase: GeneratedLikeCase): string =>
    [
      testCase.expectedResult,
      bddAssertionText(testCase.bddScenario || ''),
      testCase.apiSpec?.expectedResponse,
      ...(testCase.apiSpec?.assertions || []),
      testCase.manualVerification?.expectedResult,
    ]
      .filter(Boolean)
      .join(' ');
  const setupOverlap = overlapCoefficient(duplicateTokens(setupAndAction(a)), duplicateTokens(setupAndAction(b)));
  const assertionOverlap = overlapCoefficient(
    duplicateTokens(observableAssertions(a)),
    duplicateTokens(observableAssertions(b))
  );
  return setupOverlap >= 0.9 && assertionOverlap >= 0.92;
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
  if (!hasRequiredCriterionSemantics(criterionText, caseText)) return false;
  const criterionTokens = substantiationTokens(criterionText);
  if (criterionTokens.size === 0) return true;
  const caseTokens = substantiationTokens(caseText);
  let overlap = 0;
  for (const token of criterionTokens) {
    if (caseTokens.has(token)) overlap += 1;
  }
  // One distinctive assertion token is sufficient for a focused branch case; exact response/schema
  // obligations above still require every contract detail (for example JSON array and data_label value).
  return overlap >= 1;
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
  const executionType = inferExecutionType(testCase, scopeType);
  const matchedEndpoints = Array.isArray(options.matchedEndpoints) ? options.matchedEndpoints : [];
  const executionPlanById = new Map(
    (options.acceptanceCriteriaExecutionPlan || []).map((item) => [normalizeAcceptanceCriteriaId(item.criterionId), item])
  );

  if (!title) errors.push('Title is required.');
  if (!refs) errors.push('Jira reference is required.');
  if (!preconditions) errors.push('Preconditions are required.');
  if (!type) errors.push('Type is required.');
  if (type && type !== 'BDD') errors.push("Type must be the fixed 'BDD' value; use caseIntent for Positive, Negative, or Edge.");
  if (enforceAcceptanceCriteria && hasDetectedAcceptanceCriteria && !coversAcceptanceCriteria.length) {
    errors.push('Test case must map to at least one acceptance criterion.');
  }
  if (enforceAcceptanceCriteria && coversAcceptanceCriteria.length > 2 && !isSmokeOrEndToEndCase(testCase)) {
    warnings.push(
      `Test case maps to ${coversAcceptanceCriteria.length} acceptance criteria; split into focused cases or mark it as an explicit smoke/end-to-end case.`
    );
  }

  if (title) {
    // M1 (canonical): test-case titles use [FE]/[BE][{Epic}][Ticket ID] — the format the agent emits and
    // every existing TestRail case follows. This deliberately supersedes the older [Web][{Epic}][Ticket ID]
    // wording in the external workflow spec doc (which loses the FE/BE distinction); the doc is the stale side.
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
      const plannedExecution = executionPlanById.get(criterionId);
      if (scopeType === 'api' && plannedExecution && executionType && plannedExecution.executionType !== executionType) {
        warnings.push(
          `Acceptance criterion ${criterionId} is classified as ${plannedExecution.executionType} (${plannedExecution.observableSurface}) but this case is ${executionType}.`
        );
      }
      if (scopeType === 'api' && plannedExecution?.executionType === 'postman' && executionType === 'postman') {
        const method = normalizeText(testCase.apiSpec?.method).toUpperCase();
        const path = normalizeText(testCase.apiSpec?.path);
        const plannedRefs = extractHttpReferences(plannedExecution.observableSurface || '');
        if (method && path && plannedRefs.length && !plannedRefs.some((ref) => sameHttpReference(ref, { method, path }))) {
          errors.push(
            `Acceptance criterion ${criterionId} must be asserted on ${plannedRefs.map((ref) => `${ref.method} ${ref.path}`).join(' or ')}, but apiSpec uses ${method} ${path}.`
          );
        }
      }
      if (criterionText && !isAcceptanceCriterionSubstantiated(criterionText, evidenceText)) {
        warnings.push(`Acceptance criterion ${criterionId} is claimed but not substantiated by the case steps/assertions.`);
      }
    }
  }

  const mappedDirectRequirements = (options.directRequirements || []).filter(
    (requirement) =>
      requirement.disposition !== 'out_of_scope' &&
      requirement.acceptanceCriteriaIds.some((criterionId) => coversAcceptanceCriteria.includes(normalizeAcceptanceCriteriaId(criterionId)))
  );
  const fixtureAndAssertionText = [
    testCase.title,
    testCase.preconditions,
    testCase.custom_preconds,
    testCase.inputs,
    testCase.bddScenario,
    testCase.apiSpec?.samplePayload,
    caseEvidenceText(testCase),
    ...(testCase.manualVerification?.steps || []),
  ]
    .filter(Boolean)
    .join(' ');
  const workedExamples = mappedDirectRequirements.flatMap((requirement) => requirement.workedExamples || []);
  if (workedExamples.length) {
    const caseText = fixtureAndAssertionText.toLowerCase();
    const reusesSourceExample = workedExamples.some((example) => caseText.includes(String(example || '').trim().toLowerCase()));
    if (!reusesSourceExample) {
      errors.push(`Case must reuse an applicable worked example from the mapped source requirement (${workedExamples.slice(0, 3).join(', ')}).`);
    }
  }
  const directSourceText = mappedDirectRequirements.map((requirement) => requirement.text).join(' ');
  const syntheticBrand = fixtureAndAssertionText.match(/\b(?:Acme|Northwind|Globex|Initech|Umbrella|Contoso|Fabrikam)(?:\s+[A-Z][A-Za-z0-9-]+)?\b/i)?.[0];
  if (syntheticBrand && !directSourceText.toLowerCase().includes(syntheticBrand.toLowerCase())) {
    errors.push(`Case uses invented fixture name "${syntheticBrand}"; reuse a source example or a neutral API-contract identifier.`);
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
    if (method) {
      const titleMethods = httpMethodMentions(title);
      const contradictoryTitleMethods = titleMethods.filter((titleMethod) => titleMethod !== method);
      if (contradictoryTitleMethods.length) {
        errors.push(
          `Title references ${contradictoryTitleMethods.join(', ')} but apiSpec uses ${method}; use one consistent HTTP method.`
        );
      }
    }
    // A fetched API contract is authoritative for a Postman case. The execution planner downgrades
    // these criteria before generation; keep this server-side error as a direct-call safety net.
    if (method && path && Array.isArray(options.matchedEndpoints) && !endpointIsDocumented(method, path, matchedEndpoints)) {
      errors.push(
        `apiSpec endpoint ${method} ${path} is not in the matched API contract; use manual integration until the endpoint is verified.`
      );
    }
    if (method && path) {
      const apiSpecRef = { method, path };
      const bddRefs = extractHttpReferences(bdd);
      const unmatchedRefs = bddRefs.filter((ref) => !sameHttpReference(ref, apiSpecRef));
      if (unmatchedRefs.length) {
        errors.push(
          `BDD scenario exercises additional endpoint(s) ${unmatchedRefs.map((ref) => `${ref.method} ${ref.path}`).join(', ')} not represented by apiSpec; split the case or add multi-step API metadata before push.`
        );
      }
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

  if (scopeType === 'api' && (executionType === 'manual_db' || executionType === 'manual_code_review' || executionType === 'manual_integration')) {
    const target = normalizeText(testCase.manualVerification?.target);
    const steps = Array.isArray(testCase.manualVerification?.steps) ? testCase.manualVerification?.steps || [] : [];
    const expectedResult = normalizeText(testCase.manualVerification?.expectedResult);
    const label =
      executionType === 'manual_db' ? 'Manual DB' : executionType === 'manual_code_review' ? 'Manual code review' : 'Manual integration';
    if (!target) errors.push(`${label} case must include manualVerification.target.`);
    if (!steps.length) {
      errors.push(`${label} case must include manualVerification.steps.`);
    }
    if (!expectedResult) errors.push(`${label} case must include manualVerification.expectedResult.`);
    const titleMethods = httpMethodMentions(title);
    const actionRefs = extractHttpReferences(bddActionText(bdd));
    if (titleMethods.length || actionRefs.length) {
      const mentioned = uniqueValues(
        [
          ...titleMethods,
          ...actionRefs.map((ref) => `${ref.method} ${ref.path}`),
        ],
        (item) => item
      );
      errors.push(
        `${label} case explicitly exercises API ${mentioned.join(', ')}; use executionType postman with a matching apiSpec method/path.`
      );
    }
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
  const caseList = Array.isArray(testCases) ? testCases : [];
  const entries = caseList.map((testCase, index) => ({
    index,
    id: testCase.id || `TC-${String(index + 1).padStart(2, '0')}`,
    ...validateCase(testCase, options),
  }));
  for (let right = 0; right < caseList.length; right += 1) {
    for (let left = 0; left < right; left += 1) {
      if (!casesLookDuplicative(caseList[left], caseList[right])) continue;
      entries[right].warnings.push(`Potential duplicate of ${entries[left].id}; merge the cases or make the setup/assertions materially different.`);
      break;
    }
  }
  return entries;
}

/**
 * Criteria that NOTHING substantiates AND nothing even weak-claims — i.e. genuinely uncovered. An AC
 * that is uncovered only because its sole claim was flagged weak is excluded here: that case is
 * overrideable via the weak-coverage acknowledgement, not a hard block. Push/preflight gate on this
 * (true gap → block) rather than raw uncoveredCriteria (which conflates the two).
 */
export function trulyUncoveredCriteria(coverage: {
  uncoveredCriteria: string[];
  unsubstantiatedClaims: Array<{ criterionId: string; reason?: 'weak_evidence' | 'execution_mismatch' }>;
}): string[] {
  const weakClaimed = new Set(
    (coverage.unsubstantiatedClaims || [])
      .filter((claim) => claim.reason !== 'execution_mismatch')
      .map((claim) => claim.criterionId)
  );
  return (coverage.uncoveredCriteria || []).filter((id) => !weakClaimed.has(id));
}

// A polarity gap is only meaningful for observable behavior with an actual branch: disabled/enabled,
// valid/invalid, success/failure, fallback/no-data, etc. "When X happens, return Y" is not enough on its
// own; many ACs are single-direction requirements. Manual DB/code/internal verification items are also not
// branch matrices, so execution-plan metadata is used to avoid false polarity failures.
const ADVERSE_BRANCH_RE =
  /\b(?:disabled|missing|empty|invalid|blank|reject(?:ed|s)?|fail(?:s|ed|ure)?|error|denied|unauthori[sz]ed|forbidden|not\s+found|not\s+accessible|inaccessible|zero|null|none|fallback|without)\b|\b0\b/i;
const NO_DATA_BRANCH_RE = /\bno\s+(?:cell|cells|record|records|result|results|data|match|matches|row|rows|item|items|module|modules|access|token|payload|body|value|values|area|artifact|artifacts)\b/i;
const EXPLICIT_TWO_SIDED_BRANCH_RE =
  /\b(?:otherwise|else)\b|(?:\bvalid\b[\s\S]{0,120}\binvalid\b)|(?:\binvalid\b[\s\S]{0,120}\bvalid\b)|(?:\bsuccess(?:ful)?\b[\s\S]{0,120}\bfail(?:s|ed|ure)?\b)|(?:\bfail(?:s|ed|ure)?\b[\s\S]{0,120}\bsuccess(?:ful)?\b)|(?:\benabled\b[\s\S]{0,120}\bdisabled\b)|(?:\bdisabled\b[\s\S]{0,120}\benabled\b)|(?:\bmatch(?:es|ed)?\b[\s\S]{0,120}\bmismatch(?:es|ed)?\b)|(?:\bmismatch(?:es|ed)?\b[\s\S]{0,120}\bmatch(?:es|ed)?\b)|(?:\bpresent\b[\s\S]{0,120}\babsent\b)|(?:\babsent\b[\s\S]{0,120}\bpresent\b)|(?:\bwith\b[\s\S]{0,120}\bwithout\b)|(?:\bwithout\b[\s\S]{0,120}\bwith\b)/i;
const EXPLICIT_PAIRED_CONDITION_RE = /\b(?:when|if)\b[\s\S]{0,180}\b(?:when|if)\b/i;

function hasPolaritySensitiveSemantics(text: string): boolean {
  // A single branch such as "when there is one area, return the second field empty" is an edge
  // requirement, not proof that a second polarity belongs to the SAME AC.
  if (EXPLICIT_TWO_SIDED_BRANCH_RE.test(text)) return true;
  return EXPLICIT_PAIRED_CONDITION_RE.test(text) && (ADVERSE_BRANCH_RE.test(text) || NO_DATA_BRANCH_RE.test(text));
}

function requiresSinglePolarityCoverage(entry: { text: string }, plannedExecution?: AcceptanceCriteriaExecutionPlanItem): boolean {
  const text = normalizeText(entry.text);
  if (!text || !hasPolaritySensitiveSemantics(text)) return false;

  if (!plannedExecution) return true;
  if (plannedExecution.executionType === 'postman') return true;

  // Manual cases verify artifacts or internal behavior. Requiring synthetic positive/negative pairs here
  // makes the model fabricate extra cases without improving executable API coverage.
  return false;
}

export function buildCoverage(
  testCases: GeneratedLikeCase[],
  acceptanceCriteria: Array<{ id: string; text: string; source?: string }>,
  options: CoverageOptions = {}
) {
  // Coverage maps generated cases back to AC ids; generation/push uses this to block incomplete scope coverage.
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const enforceAcceptanceCriteria = options.enforceAcceptanceCriteria !== false;
  const scopeType = options.scopeType || 'web';
  const caseList = Array.isArray(testCases) ? testCases : [];
  const entries = criteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    source: criterion.source,
    coveredBy: [] as string[],
  }));
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const executionPlanById = new Map(
    (options.acceptanceCriteriaExecutionPlan || []).map((item) => [normalizeAcceptanceCriteriaId(item.criterionId), item])
  );
  const unmappedCases: string[] = [];
  // Claimed (case, AC) pairs whose case content doesn't substantiate the AC — surfaced so coverage
  // isn't silently inflated (e.g. an email-routing AC "covered" by dataset tests that never assert email).
  const unsubstantiatedClaims: Array<{ caseId: string; criterionId: string; reason: 'weak_evidence' | 'execution_mismatch' }> = [];
  // Polarity (positive/negative/edge) of the cases that actually substantiate each AC — used below to
  // detect conditional ACs tested in only one direction. Keyed by criterion id, separate from `entries`
  // so the serialized byCriterion shape (CoverageCriterion) is unchanged.
  const intentsByCriterion = new Map<string, Set<'positive' | 'negative' | 'edge'>>();

  for (let index = 0; index < caseList.length; index += 1) {
    const testCase = caseList[index];
    const caseId = testCase.id || `TC-${String(index + 1).padStart(2, '0')}`;
    const mappedCriteria = normalizeList(testCase.coversAcceptanceCriteria).map((item) => normalizeAcceptanceCriteriaId(item));
    if (!mappedCriteria.length) {
      unmappedCases.push(caseId);
      continue;
    }
    const evidenceText = caseEvidenceText(testCase);
    const intent = testCase.caseIntent;
    const executionType = inferExecutionType(testCase, scopeType);
    for (const criterionId of mappedCriteria) {
      const entry = entryById.get(criterionId);
      if (!entry) continue;
      const plannedExecution = executionPlanById.get(criterionId);
      if (scopeType === 'api' && plannedExecution && executionType && plannedExecution.executionType !== executionType) {
        unsubstantiatedClaims.push({ caseId, criterionId, reason: 'execution_mismatch' });
        continue;
      }
      if (entry.text && !isAcceptanceCriterionSubstantiated(entry.text, evidenceText)) {
        unsubstantiatedClaims.push({ caseId, criterionId, reason: 'weak_evidence' });
        continue;
      }
      entry.coveredBy.push(caseId);
      if (intent === 'positive' || intent === 'negative' || intent === 'edge') {
        let set = intentsByCriterion.get(criterionId);
        if (!set) {
          set = new Set();
          intentsByCriterion.set(criterionId, set);
        }
        set.add(intent);
      }
    }
  }

  // A conditional AC that is covered but tested in only one polarity (missing positive or negative) is a
  // hidden gap behind a green number. Uncovered ACs are handled by uncoveredCriteria above, not here.
  const singlePolarityCriteria: Array<{
    criterionId: string;
    have: Array<'positive' | 'negative' | 'edge'>;
    missing: Array<'positive' | 'negative'>;
  }> = [];
  for (const entry of entries) {
    const plannedExecution = executionPlanById.get(normalizeAcceptanceCriteriaId(entry.id));
    if (!entry.coveredBy.length || !requiresSinglePolarityCoverage(entry, plannedExecution)) continue;
    const have = Array.from(intentsByCriterion.get(entry.id) || []);
    // Two dimensions must both be exercised: an affirming (happy-path) case and an opposing (off-nominal)
    // case. 'positive' fills affirming; 'negative' OR 'edge' fills opposing (an edge case tests the
    // boundary/three-state branch, which is the opposing behavior the check exists to guarantee). So a
    // positive+edge suite passes, while positive-only (missing opposing) and negative/edge-only (missing
    // affirming) are still correctly flagged. 'missing' keeps its positive/negative shape for callers.
    const missing: Array<'positive' | 'negative'> = [];
    if (!have.includes('positive')) missing.push('positive');
    if (!have.includes('negative') && !have.includes('edge')) missing.push('negative');
    if (missing.length) singlePolarityCriteria.push({ criterionId: entry.id, have, missing });
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
    singlePolarityCriteria,
  };
}
