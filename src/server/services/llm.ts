import type {
  ApiContractEndpoint,
  DuplicateCaseRecommendation,
  ExistingTestRailCase,
  GeneratedTestCase,
  QaContext,
  ScopeSnapshotTranslation,
} from '../../shared/contracts';
import { buildCoverage } from './validation';
import { normalizeSelectedEndpoints } from './api-docs';
import type { AcceptanceCriteriaSynthesisInput, AcceptanceCriteriaSynthesisResult } from './acceptance-criteria';
import { requestHttpsJson } from './http';
import { TtlCache } from './ttl-cache';
import type { Logger } from './logger';

interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmConfig {
  providers: ProviderConfig[];
}

interface GenerateContext extends QaContext {
  coverageEnforced: boolean;
  manualScopeOverride: boolean;
  manualScopeOverrideReason: string;
}

interface ProviderGenerationResult {
  provider: string;
  model: string;
  testCases: GeneratedTestCase[];
}

interface ProviderSynthesisResult {
  provider: string;
  model: string;
  acceptanceCriteria: AcceptanceCriteriaSynthesisResult['acceptanceCriteria'];
}

interface NormalizedSynthesisCriterion {
  id: string;
  text: string;
  rationale?: string;
}

interface ProviderScopeTranslationResult {
  provider: string;
  model: string;
  translation: ScopeSnapshotTranslation;
}

interface ProviderDuplicateReviewResult {
  provider: string;
  model: string;
  recommendations: DuplicateCaseRecommendation[];
}

function stripAcceptanceCriteriaSections(text: string): string {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n');
  const kept: string[] = [];
  let inAcceptanceSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^(acceptance criteria|acceptance|ac)[:]?$/i.test(line)) {
      inAcceptanceSection = true;
      continue;
    }

    if (inAcceptanceSection && line && !/^(\d+[\.)]|[a-z][\.)]|[-*•]|AC[-\s_:]*\d+)/i.test(line)) {
      inAcceptanceSection = false;
    }

    if (!inAcceptanceSection && line) {
      kept.push(line);
    }
  }

  return kept.join('\n').trim();
}

export function buildScopePriorityContext(context: GenerateContext) {
  // Compress the analyzed context into the authority model the generation prompt uses to avoid scope drift.
  if (context.scopeAuthority && context.scopeAuthority.type !== 'none') {
    return {
      primaryAuthority: context.scopeAuthority.type,
      authorityTitle: context.scopeAuthority.title,
      authorityBody: context.scopeAuthority.body,
      authorityReason: context.scopeAuthority.reason,
      authorityQuality: context.scopeAuthority.quality,
      hasMeaningfulTicketDescription: context.scopeAuthority.type === 'main_jira_description',
      mainTicketDescription: context.scopeAuthority.type === 'main_jira_description' ? context.scopeAuthority.body : '',
      mainTicketAcceptanceCriteria: context.acceptanceCriteria,
      matchedPrdSubsection:
        context.scopeAuthority.type === 'matched_prd_subsection' || context.scopeAuthority.type === 'broad_prd_section'
          ? {
              title: context.scopeAuthority.title,
              body: context.scopeAuthority.body,
              matchQuality: context.scopeAuthority.type === 'broad_prd_section' ? 'broad' : 'confident',
            }
          : undefined,
      supportingContext: {
        parentStorySummary: context.scopeParentIssue?.summary || '',
        scopedPrdSectionTitle: context.scopeConfluenceSection?.matchedHeading || context.scopeConfluenceSection?.title || '',
        scopedPrdSectionBody: context.scopeConfluenceSection?.body || '',
        actualDevScopeGuidance: context.actualDevScopeGuidance,
      },
    };
  }

  const rawDescription = String(context.mainIssue.description || '').trim();
  const descriptionWithoutAc = stripAcceptanceCriteriaSections(rawDescription);
  const hasMeaningfulTicketDescription = descriptionWithoutAc.length >= 20;
  const prdScopedThinTicket =
    context.acceptanceCriteriaSource === 'parent_story_confluence_section' &&
    Boolean(context.acceptanceCriteriaDiagnostics?.thinTicketFallbackUsed) &&
    Boolean(String(context.scopeConfluenceSection?.body || '').trim());

  if (prdScopedThinTicket) {
    return {
      primaryAuthority: 'matched_prd_subsection',
      hasMeaningfulTicketDescription: false,
      mainTicketDescription: '',
      mainTicketAcceptanceCriteria: context.acceptanceCriteria,
      matchedPrdSubsection: {
        title: context.scopeConfluenceSection?.matchedHeading || context.scopeConfluenceSection?.title || '',
        body: context.scopeConfluenceSection?.body || '',
        matchQuality: context.acceptanceCriteriaDiagnostics?.prdSubsectionMatchQuality || 'none',
      },
      supportingContext: {
        parentStorySummary: context.scopeParentIssue?.summary || '',
        scopedPrdSectionTitle: context.scopeConfluenceSection?.matchedHeading || context.scopeConfluenceSection?.title || '',
        scopedPrdSectionBody: context.scopeConfluenceSection?.body || '',
        actualDevScopeGuidance: context.actualDevScopeGuidance,
      },
    };
  }

  return {
    // Use the unified ScopeAuthority vocabulary even on the no-scopeAuthority
    // fallback path, so older/replayed contexts cannot emit a divergent
    // authority name (was main_ticket_* — see ScopeAuthority.type).
    primaryAuthority: hasMeaningfulTicketDescription ? 'main_jira_description' : 'main_jira_acceptance_criteria',
    hasMeaningfulTicketDescription,
    mainTicketDescription: hasMeaningfulTicketDescription ? descriptionWithoutAc : '',
    mainTicketAcceptanceCriteria: context.acceptanceCriteria,
    supportingContext: {
      parentStorySummary: context.scopeParentIssue?.summary || '',
      scopedPrdSectionTitle: context.scopeConfluenceSection?.matchedHeading || context.scopeConfluenceSection?.title || '',
      scopedPrdSectionBody: context.scopeConfluenceSection?.body || '',
      actualDevScopeGuidance: context.actualDevScopeGuidance,
    },
  };
}

function requestJson<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  let host = 'provider';
  try {
    host = new URL(url).host;
  } catch {
    /* keep default */
  }
  return requestHttpsJson<T>({
    url,
    method: 'POST',
    headers,
    body,
    upstream: `LLM provider (${host})`,
    timeoutMs: Number(process.env.LLM_HTTP_TIMEOUT_MS || process.env.UPSTREAM_HTTP_TIMEOUT_MS || 60_000),
  }).then((response) => {
    if (response.statusCode >= 200 && response.statusCode < 300) return response.body;
    const parsedBody = response.body as any;
    const message = parsedBody?.error?.message || `HTTP ${response.statusCode}`;
    // Carry only the status (used by isFallbackError) and a clean message. The raw provider body is
    // deliberately not attached to the error: it's never read, and keeping it off the error object
    // avoids leaking provider response details if an upstream handler ever serializes the error.
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = response.statusCode;
    throw error;
  });
}

function extractJson(text: string): unknown {
  // Providers sometimes wrap JSON in markdown or prose; accept common wrappers but still parse strict JSON.
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('LLM provider returned an empty response.');

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]);
    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }
    throw error;
  }
}

export function providerContent(response: any, label: string): string {
  // Truncation guard (BUG-09): when the model hits the token cap mid-response, finish_reason is
  // 'length' and the JSON is incomplete. extractJson's array-slice fallback would happily parse the
  // truncated remainder into a partial-but-valid array, silently dropping cases/criteria. Treat
  // truncation as a provider error so the fallback/retry path handles it instead.
  const choice = response?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error(`LLM ${label} response was truncated (finish_reason=length); reduce scope or raise the response token limit.`);
  }
  return choice?.message?.content ?? '';
}

export function findCaseArray(value: unknown): unknown[] | null {
  // Be tolerant of provider-specific response keys while requiring an array that looks like test cases.
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  for (const key of ['testCases', 'cases', 'test_cases', 'testcases']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }

  for (const child of Object.values(record)) {
    if (Array.isArray(child) && child.some((item) => item && typeof item === 'object' && ('bddScenario' in (item as object) || 'bdd_scenario' in (item as object)))) {
      return child;
    }
  }

  for (const child of Object.values(record)) {
    const nested = findCaseArray(child);
    if (nested) return nested;
  }

  return null;
}

export function findAcceptanceCriteriaArray(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.acceptanceCriteria)) return record.acceptanceCriteria as unknown[];
  if (Array.isArray(record.acceptance_criteria)) return record.acceptance_criteria as unknown[];
  return null;
}

export function normalizeTextList(value: unknown): string {
  // LLMs sometimes return structured fields (e.g. a JSON request body) as objects rather than
  // strings; stringify those as pretty JSON instead of letting String() yield "[object Object]".
  const stringifyItem = (item: unknown): string => {
    if (item === null || item === undefined) return '';
    if (typeof item === 'object') {
      try {
        return JSON.stringify(item, null, 2);
      } catch {
        return '';
      }
    }
    return String(item).trim();
  };
  if (Array.isArray(value)) {
    return value.map(stringifyItem).map((item) => item.trim()).filter(Boolean).join('\n');
  }
  return stringifyItem(value).trim();
}

export function normalizeJiraReference(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const exactMatch = raw.match(/[A-Z]+-\d+/i);
  return exactMatch ? exactMatch[0].toUpperCase() : raw.toUpperCase();
}

function normalizeCaseIntent(value: unknown): 'positive' | 'negative' | 'edge' | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'positive' || normalized === 'negative' || normalized === 'edge') return normalized;
  return undefined;
}

function normalizeExecutionType(value: unknown): 'postman' | 'manual_db' | 'manual_other' | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'postman' || normalized === 'api') return 'postman';
  if (normalized === 'manual_db' || normalized === 'db' || normalized === 'database') return 'manual_db';
  if (normalized === 'manual_other' || normalized === 'manual') return 'manual_other';
  return undefined;
}

function normalizeComparableText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function recommendationForCaseId(
  recommendations: DuplicateCaseRecommendation[],
  newCaseId: string
): DuplicateCaseRecommendation | undefined {
  return recommendations.find((item) => item.newCaseId === newCaseId);
}

export function buildDeterministicDuplicateRecommendations(
  existingCases: ExistingTestRailCase[],
  generatedCases: GeneratedTestCase[]
): DuplicateCaseRecommendation[] {
  // Exact normalized-title matches are deterministic duplicates and do not need an LLM opinion.
  const existingByTitle = new Map<string, ExistingTestRailCase[]>();
  for (const existingCase of existingCases) {
    const normalizedTitle = normalizeComparableText(existingCase.title);
    if (!normalizedTitle) continue;
    existingByTitle.set(normalizedTitle, [...(existingByTitle.get(normalizedTitle) || []), existingCase]);
  }

  const recommendations: DuplicateCaseRecommendation[] = [];
  generatedCases.forEach((testCase, index) => {
    const newCaseId = testCase.id || `TC-${index + 1}`;
    const exactMatches = existingByTitle.get(normalizeComparableText(testCase.title)) || [];
    if (exactMatches.length) {
      recommendations.push({
        newCaseId,
        recommendation: 'exclude',
        overlap: 'already_covered',
        matchedExistingCaseIds: exactMatches.map((existingCase) => existingCase.caseId),
        reason: 'Existing TestRail case has the same normalized title.',
        deterministic: true,
      });
    }
  });
  return recommendations;
}

function normalizeDuplicateRecommendation(
  raw: Record<string, unknown>,
  generatedCase: GeneratedTestCase,
  index: number
): DuplicateCaseRecommendation {
  const rawRecommendation = String(raw.recommendation || '').toLowerCase();
  const recommendation = rawRecommendation === 'include' || rawRecommendation === 'exclude' || rawRecommendation === 'review' ? rawRecommendation : 'review';
  const rawOverlap = String(raw.overlap || '').toLowerCase();
  const overlap =
    rawOverlap === 'already_covered' || rawOverlap === 'partial_overlap' || rawOverlap === 'new_coverage'
      ? rawOverlap
      : recommendation === 'include'
      ? 'new_coverage'
      : recommendation === 'exclude'
      ? 'already_covered'
      : 'partial_overlap';
  const matchedExistingCaseIds = Array.isArray(raw.matchedExistingCaseIds)
    ? raw.matchedExistingCaseIds.map((item) => String(item || '').trim()).filter(Boolean)
    : Array.isArray(raw.matched_existing_case_ids)
    ? raw.matched_existing_case_ids.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  return {
    newCaseId: String(raw.newCaseId || raw.new_case_id || generatedCase.id || `TC-${index + 1}`),
    recommendation,
    overlap,
    matchedExistingCaseIds,
    reason: String(raw.reason || '').trim() || 'Review suggested because overlap could not be determined confidently.',
    deterministic: false,
  };
}

function findDuplicateRecommendationArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.recommendations)) return record.recommendations;
  if (Array.isArray(record.duplicateCaseRecommendations)) return record.duplicateCaseRecommendations;
  return null;
}

function inferCaseIntent(testCase: Record<string, unknown>): 'positive' | 'negative' | 'edge' {
  const haystack = [
    String(testCase.type || ''),
    String(testCase.title || ''),
    normalizeBddScenario(testCase.bddScenario || testCase.bdd_scenario || testCase.custom_testrail_bdd_scenario || ''),
  ]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();

  if (/\b(edge|boundary|boundaries|limit|limits|maximum|max(?:imum)?|minimum|min(?:imum)?|empty|zero|null|duplicate|overflow|large dataset|single item)\b/.test(haystack)) {
    return 'edge';
  }

  if (/\b(negative|invalid|error|errors|fail(?:s|ed|ure)?|reject(?:ed|s|ion)?|deny|denied|blocked|disabled|unavailable|missing permission|missing field|unauthorized|forbidden)\b/.test(haystack)) {
    return 'negative';
  }

  return 'positive';
}

export function normalizeIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeBddScenario(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return normalizeTextList(value);
  if (typeof value !== 'object') return String(value).trim();

  const record = value as Record<string, unknown>;
  const lines: string[] = [];
  const feature = String(record.Feature || record.feature || '').trim();
  const scenario = String(record.Scenario || record.scenario || '').trim();
  if (feature) lines.push(`Feature: ${feature}`);
  if (scenario) lines.push(`Scenario: ${scenario}`);

  for (const stepName of ['Given', 'When', 'Then', 'And']) {
    const raw = record[stepName] || record[stepName.toLowerCase()];
    if (!raw) continue;
    const steps = Array.isArray(raw) ? raw : [raw];
    for (const step of steps) {
      const text = String(step || '').trim();
      if (!text) continue;
      lines.push(`${stepName} ${text.replace(/^(Given|When|Then|And)\s+/i, '')}`);
    }
  }

  if (lines.length) return lines.join('\n');
  return JSON.stringify(value, null, 2);
}

function normalizeScopedItems(
  value: unknown,
  fallback: Array<{
    id: string;
    text: string;
    sourceExcerpts?: Array<{
      text: string;
      location?: string;
      url?: string;
      kind?: 'jira' | 'prd' | 'spec';
      confidence?: 'verbatim' | 'closest' | 'weak';
    }>;
    sourceExcerpt?: string;
    sourceExcerptLocation?: string;
    sourceExcerptUrl?: string;
    sourceExcerptKind?: 'jira' | 'prd' | 'spec';
    sourceExcerptConfidence?: 'verbatim' | 'closest' | 'weak';
  }>
): Array<{
  id: string;
  text: string;
  sourceExcerpts?: Array<{
    text: string;
    location?: string;
    url?: string;
    kind?: 'jira' | 'prd' | 'spec';
    confidence?: 'verbatim' | 'closest' | 'weak';
  }>;
  sourceExcerpt?: string;
  sourceExcerptLocation?: string;
  sourceExcerptUrl?: string;
  sourceExcerptKind?: 'jira' | 'prd' | 'spec';
}> {
  // Localized scope snapshots must preserve ids and source excerpts from the original English context.
  if (!Array.isArray(value)) return fallback;
  const fallbackById = new Map(fallback.map((item) => [item.id, item]));
  const localizedItems = value.map((item) => ((item || {}) as Record<string, unknown>));

  if (fallback.length) {
    return fallback
      .map((fallbackItem, index) => {
        const byId = localizedItems.find((item) => String(item.id || '').trim() === fallbackItem.id);
        const byIndex = localizedItems[index];
        const localizedText = String((byId?.text ?? byIndex?.text ?? '') || '').trim();
      return {
        id: fallbackItem.id,
        text: localizedText || fallbackItem.text,
        ...(fallbackItem.sourceExcerpt || fallbackItem.sourceExcerpts?.length
          ? {
              sourceExcerpts: fallbackItem.sourceExcerpts,
              sourceExcerpt: fallbackItem.sourceExcerpt,
              sourceExcerptLocation: fallbackItem.sourceExcerptLocation,
              sourceExcerptUrl: fallbackItem.sourceExcerptUrl,
              sourceExcerptKind: fallbackItem.sourceExcerptKind,
              sourceExcerptConfidence: fallbackItem.sourceExcerptConfidence,
            }
          : {}),
      };
      })
      .filter((item) => item.id && item.text);
  }

  return localizedItems
    .map((record, index) => {
      const fallbackId = String(record.id || fallback[index]?.id || '');
      const fallbackItem = fallbackById.get(fallbackId) || fallback[index];
      return {
        id: fallbackId,
        text: String(record.text || '').trim(),
        ...(fallbackItem?.sourceExcerpt || fallbackItem?.sourceExcerpts?.length
          ? {
              sourceExcerpts: fallbackItem.sourceExcerpts,
              sourceExcerpt: fallbackItem.sourceExcerpt,
              sourceExcerptLocation: fallbackItem.sourceExcerptLocation,
              sourceExcerptUrl: fallbackItem.sourceExcerptUrl,
              sourceExcerptKind: fallbackItem.sourceExcerptKind,
              sourceExcerptConfidence: fallbackItem.sourceExcerptConfidence,
            }
          : {}),
      };
    })
    .filter((item) => item.id && item.text);
}

function normalizeLocalizedString(value: unknown, fallback: string): string {
  const localized = String(value || '').trim();
  return localized || fallback;
}

function normalizeLocalizedTextList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const localized = value.map((item) => String(item || '').trim());
  if (fallback.length) {
    return fallback.map((original, index) => localized[index] || original);
  }
  return localized.filter(Boolean);
}

export function normalizeScopeSnapshotTranslation(
  parsed: Record<string, unknown>,
  context: QaContext
): ScopeSnapshotTranslation {
  return {
    mainSummary: normalizeLocalizedString(parsed.mainSummary, context.mainIssue.summary || ''),
    parentStorySummary: normalizeLocalizedString(parsed.parentStorySummary, context.scopeParentIssue?.summary || ''),
    scopedPrdSection: normalizeLocalizedString(
      parsed.scopedPrdSection,
      context.scopeConfluenceSection?.matchedHeading || context.scopeConfluenceSection?.title || ''
    ),
    confidenceReasons: normalizeLocalizedTextList(parsed.confidenceReasons, context.confidenceReasons || []),
    selectedAcceptanceCriteriaReason: normalizeLocalizedString(
      parsed.selectedAcceptanceCriteriaReason,
      context.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaReason || ''
    ) || undefined,
    userStories: normalizeScopedItems(parsed.userStories, context.userStories || []),
    acceptanceCriteria: normalizeScopedItems(parsed.acceptanceCriteria, context.acceptanceCriteria || []),
  };
}

export function normalizeCase(testCase: Record<string, unknown>, index: number): GeneratedTestCase {
  // Normalize several likely LLM/TestRail field names into the app's stable GeneratedTestCase contract.
  const evidenceRecord = (testCase.evidence && typeof testCase.evidence === 'object' ? (testCase.evidence as Record<string, unknown>) : {}) || {};
  const apiSpecRecord = ((testCase.apiSpec || testCase.api_spec) && typeof (testCase.apiSpec || testCase.api_spec) === 'object'
    ? ((testCase.apiSpec || testCase.api_spec) as Record<string, unknown>)
    : {}) || {};
  const manualRecord = ((testCase.manualVerification || testCase.manual_verification) && typeof (testCase.manualVerification || testCase.manual_verification) === 'object'
    ? ((testCase.manualVerification || testCase.manual_verification) as Record<string, unknown>)
    : {}) || {};
  const apiMethod = String(apiSpecRecord.method || testCase.method || '').trim().toUpperCase();
  const apiPath = String(apiSpecRecord.path || testCase.path || testCase.endpoint || '').trim();
  const title = String(testCase.title || '');
  // Titles use a single [BE]/[FE] tag (not [API]/[DB]), so execution type is inferred from the
  // structured payload: an apiSpec ⇒ postman, a manualVerification block ⇒ manual_db.
  const inferredExecutionType = apiMethod || apiPath ? 'postman' : Object.keys(manualRecord).length ? 'manual_db' : undefined;
  const executionType = normalizeExecutionType(testCase.executionType || testCase.execution_type) || inferredExecutionType;
  const manualSteps = Array.isArray(manualRecord.steps)
    ? manualRecord.steps.map((step) => String(step || '').trim()).filter(Boolean)
    : normalizeTextList(manualRecord.steps || '').split('\n').map((step) => step.trim()).filter(Boolean);

  return {
    id: String(testCase.id || testCase.testCaseId || testCase.test_case_id || `TC-${String(index + 1).padStart(2, '0')}`),
    title,
    type: String(testCase.type || ''),
    ...(executionType ? { executionType } : {}),
    caseIntent: normalizeCaseIntent(testCase.caseIntent || testCase.case_intent) || inferCaseIntent(testCase),
    jiraReference: normalizeJiraReference(testCase.jiraReference || testCase.jira_reference || testCase.refs || ''),
    preconditions: normalizeTextList(testCase.preconditions || testCase.custom_preconds || ''),
    bddScenario: normalizeBddScenario(testCase.bddScenario || testCase.bdd_scenario || testCase.custom_testrail_bdd_scenario || ''),
    coversAcceptanceCriteria: normalizeIdList(testCase.coversAcceptanceCriteria || testCase.covers_acceptance_criteria || ''),
    sourceScope: normalizeIdList(testCase.sourceScope || testCase.source_scope || ''),
    ...(apiMethod || apiPath
      ? {
          apiSpec: {
            method: apiMethod,
            path: apiPath,
            samplePayload: normalizeTextList(apiSpecRecord.samplePayload || apiSpecRecord.sample_payload || testCase.samplePayload || ''),
            expectedResponse: normalizeTextList(apiSpecRecord.expectedResponse || apiSpecRecord.expected_response || testCase.expectedResponse || ''),
            assertions: normalizeIdList(apiSpecRecord.assertions || testCase.assertions || ''),
          },
        }
      : {}),
    ...(Object.keys(manualRecord).length
      ? {
          manualVerification: {
            target: String(manualRecord.target || '').trim(),
            steps: manualSteps,
            expectedResult: String(manualRecord.expectedResult || manualRecord.expected_result || '').trim(),
          },
        }
      : {}),
    evidence: {
      prdSectionTitle: String(evidenceRecord.prdSectionTitle || evidenceRecord.prd_section_title || ''),
      acceptanceCriteria: [],
      coverageNote: String(
        evidenceRecord.coverageNote ||
          evidenceRecord.coverage_note ||
          testCase.coverageNote ||
          testCase.coverage_note ||
          ''
      ).trim(),
    },
  };
}

function normalizeSynthesisCriteria(criteria: unknown[]): NormalizedSynthesisCriterion[] {
  return criteria.map((criterion, index) => {
    const record = (criterion || {}) as Record<string, unknown>;
    return {
      id: String(record.id || `AC-${index + 1}`),
      text: String(record.text || '').trim(),
      rationale: String(record.rationale || '').trim() || undefined,
    };
  });
}

function hasOvermergedPayloadCriterion(criteria: NormalizedSynthesisCriterion[]): boolean {
  return criteria.some((criterion) => {
    const text = String(criterion.text || '');
    return /run analysis/i.test(text) && /save config/i.test(text);
  });
}

function needsGranularityRepair(
  input: AcceptanceCriteriaSynthesisInput,
  criteria: NormalizedSynthesisCriterion[]
): boolean {
  if (!criteria.length) return false;
  if (input.targetMinCriteria && criteria.length < input.targetMinCriteria) return true;
  if (hasOvermergedPayloadCriterion(criteria)) return true;
  return false;
}

function dedupeGeneratedCases(testCases: GeneratedTestCase[]): GeneratedTestCase[] {
  const seen = new Set<string>();
  const output: GeneratedTestCase[] = [];

  for (const testCase of testCases) {
    const key = `${String(testCase.title || '').trim().toLowerCase()}|${String(testCase.jiraReference || '').trim().toUpperCase()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(testCase);
  }

  return output;
}

export function buildGenerationPromptContext(context: GenerateContext) {
  return {
    ticketKey: context.ticketKey,
    epic: context.epic,
    mainIssue: {
      key: context.mainIssue.key,
      summary: context.mainIssue.summary || '',
      description: context.mainIssue.description || '',
      status: context.mainIssue.status || '',
      issueType: context.mainIssue.issueType || '',
    },
    linkedIssues: (context.linkedIssues || []).map((issue) => ({
      key: issue.key,
      summary: issue.summary || '',
      issueType: issue.issueType || '',
      status: issue.status || '',
      relation: issue.linkRelation || issue.relation || '',
      classification: issue.classification || '',
    })),
    scopeParentIssue: context.scopeParentIssue
      ? {
          key: context.scopeParentIssue.key,
          summary: context.scopeParentIssue.summary || '',
          issueType: context.scopeParentIssue.issueType || '',
        }
      : null,
    scopeConfluenceSection: context.scopeConfluenceSection
      ? {
          title: context.scopeConfluenceSection.matchedHeading || context.scopeConfluenceSection.title || '',
          body: context.scopeConfluenceSection.body || '',
          matched: context.scopeConfluenceSection.matched,
        }
      : null,
    scopeAuthority: context.scopeAuthority,
    acceptanceCriteria: context.acceptanceCriteria,
    acceptanceCriteriaSource: context.acceptanceCriteriaSource,
    userStories: context.userStories,
    confidenceLevel: context.confidenceLevel,
    confidenceReasons: context.confidenceReasons,
    constraints: context.constraints,
    apiDocsUrl: context.apiDocsUrl || '',
    apiContract: context.apiContract || null,
    actualDevScopeGuidance: context.actualDevScopeGuidance,
    coverageEnforced: context.coverageEnforced,
    manualScopeOverride: context.manualScopeOverride,
    manualScopeOverrideReason: context.manualScopeOverrideReason,
  };
}

async function synthesizeWithProvider(provider: ProviderConfig, input: AcceptanceCriteriaSynthesisInput): Promise<ProviderSynthesisResult> {
  // Synthesis is conservative: it canonicalizes or splits supported requirements, but must not broaden scope.
  const prdScopedThinTicket = input.acceptanceCriteriaSource === 'parent_story_confluence_section' && input.thinTicketFallbackUsed;
  const targetInstruction =
    input.targetMinCriteria && input.targetMaxCriteria
      ? `Target ${input.targetMinCriteria}-${input.targetMaxCriteria} medium-granularity criteria unless the ticket is clearly simpler.`
      : 'Prefer a concise but complete canonical set.';
  const systemPrompt = [
    'You are a senior QA engineer deriving final acceptance criteria from Jira implementation scope.',
    prdScopedThinTicket
      ? 'The main Jira ticket is too thin. Use the matched PRD subsection as the primary authority, with the task title as the scope key and the parent story as routing context only.'
      : 'The main Jira ticket is the authority for implemented scope.',
    prdScopedThinTicket
      ? 'Do not broaden beyond the matched PRD subsection and the thin ticket title.'
      : 'Parent Story and PRD are supporting context only and must not expand scope beyond the main ticket.',
    'Prefer testable behavior and owned payload or data contracts for the resolved ticket scope.',
    'Ignore background, non-goals, unrelated dependency notes, code scaffolding, partial flow-control lines, and duplicate rendered/plain fragments.',
    input.technicalSpecExcerpts
      ? 'A linked Technical Specification is provided in input.technicalSpecExcerpts. Treat it as the authoritative implementation detail for the behaviors already in this ticket\'s scope — it is more precise than the PRD, which only paraphrases intent.'
      : '',
    input.technicalSpecExcerpts
      ? 'Ground each criterion in the spec\'s concrete rules and capture spec-level behavior the PRD merely implies: point-in-time vs per-call access checks, per-endpoint or per-RPC enforcement (each endpoint/RPC that takes an id must be validated individually), exact filter semantics, and backward-compatibility or null-value edges. Derive a distinct criterion for each such rule.'
      : '',
    input.technicalSpecExcerpts
      ? 'Use the spec only to SHARPEN and COMPLETE criteria for behavior already in the ticket scope — do not add features outside the ticket. If the spec marks something deferred, not-done, or out of scope, do not turn it into an active criterion (note it as out of scope instead).'
      : '',
    input.technicalSpecExcerpts && input.scopeBoundary
      ? `The ticket's in-scope operations are exactly: ${input.scopeBoundary}. Derive criteria ONLY for these operations and the behaviors the ticket description lists. The spec describes a broader feature than this one ticket — do NOT promote a spec capability into an active criterion when it has no matching in-scope operation (for example, login / authentication URL isolation when no login or auth-login endpoint is in scope; that belongs to a different ticket). Treat such capabilities as background context only.`
      : '',
    'If the raw acceptance criteria are already strong, preserve them semantically while normalizing wording and deduplicating.',
    targetInstruction,
    input.granularityHint || '',
    prdScopedThinTicket && input.prdSubsectionMatchQuality === 'broad'
      ? 'The PRD subsection match was broad rather than exact, so stay conservative and keep only behavior clearly supported by the matched subsection.'
      : '',
    'Do not over-merge distinct FE behaviors into one criterion.',
    'When present in the main ticket, keep Run Analysis payload mapping, Save Config payload mapping, dataset linkage or datasets[] behavior, and preview or map labeling behavior as separate criteria instead of compressing them into one broad clause.',
    prdScopedThinTicket
      ? 'For thin-ticket PRD fallback, cover every distinct requirement in the matched subsection. If the title narrows the scope to a variant such as no scoring, include that variant-specific behavior explicitly instead of producing only generic summary criteria.'
      : '',
    prdScopedThinTicket
      ? 'When the matched subsection describes an output variant, keep independently testable output responsibilities separate, such as availability, narrative style, content sections, risk or warning information, recommendations or takeaways, and single-item versus comparative framing.'
      : '',
    'Return strict JSON only. No markdown and no explanation.',
    'The JSON must be an object with this exact top-level shape: {"acceptanceCriteria":[{"id":"AC-1","text":"..."},{"id":"AC-2","text":"..."}]}',
    'Use sequential ids AC-1, AC-2, AC-3 in output order.',
    'Do not include any keys other than id, text, and optional rationale inside each acceptance criterion object.',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0, // deterministic AC synthesis: same ticket → stable criteria set run-to-run
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify(
            {
              instruction: 'Produce the final canonical acceptance criteria set.',
              input,
            },
            null,
            2
          ),
        },
      ],
    }
  );

  const content = providerContent(response, 'synthesis');
  const parsed = extractJson(content);
  const criteria = findAcceptanceCriteriaArray(parsed);
  if (!Array.isArray(criteria)) {
    throw new Error('LLM synthesis response JSON must contain an acceptanceCriteria array.');
  }

  let normalizedCriteria = normalizeSynthesisCriteria(criteria);

  if (needsGranularityRepair(input, normalizedCriteria)) {
    const specGrounded = Boolean(input.technicalSpecExcerpts);
    const repairPrompt = [
      specGrounded
        ? 'You are repairing an over-merged acceptance-criteria set for a spec-grounded backend ticket.'
        : 'You are repairing an over-merged FE acceptance-criteria set.',
      'Keep scope identical to the main ticket. Do not invent new behavior.',
      specGrounded
        ? 'Split only criteria that bundle multiple distinct spec rules together (e.g. point-in-time vs per-call access, multiple endpoints/RPCs, separate filter or null-value edges).'
        : 'Split only criteria that bundle multiple distinct FE behaviors or payload contracts together.',
      input.targetMinCriteria && input.targetMaxCriteria
        ? `Return ${input.targetMinCriteria}-${input.targetMaxCriteria} criteria if the ticket supports that many distinct behaviors.`
        : 'Return a medium-granularity canonical set.',
      input.granularityHint || '',
      specGrounded
        ? 'Keep these concerns separate when present: per-endpoint/per-RPC access enforcement, point-in-time vs per-call validation, exact filter semantics (e.g. plan vs partner assignment), backward-compatibility or null-value edges, and transactional email/URL routing.'
        : 'Keep these concerns separate when present: selection and visibility, geometry preservation, Run Analysis payload, Save Config payload with dataset_id linkage, datasets[] versus legacy dataset behavior, and preview or map label behavior.',
      'Return strict JSON only in the shape {"acceptanceCriteria":[{"id":"AC-1","text":"..."}]}.',
    ]
      .filter(Boolean)
      .join('\n');

    const repairResponse = await requestJson<any>(
      `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
      { Authorization: `Bearer ${provider.apiKey}` },
      {
        model: provider.model,
        temperature: 0, // deterministic granularity repair, consistent with the synthesis pass above
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: repairPrompt },
          {
            role: 'user',
            content: JSON.stringify(
              {
                instruction: 'Split any over-merged criteria into a better final canonical set.',
                originalInput: input,
                currentAcceptanceCriteria: normalizedCriteria,
              },
              null,
              2
            ),
          },
        ],
      }
    );

    const repairContent = providerContent(repairResponse, 'synthesis repair');
    const repairParsed = extractJson(repairContent);
    const repairedCriteria = findAcceptanceCriteriaArray(repairParsed);
    if (Array.isArray(repairedCriteria)) {
      normalizedCriteria = normalizeSynthesisCriteria(repairedCriteria);
    }
  }

  return {
    provider: provider.name,
    model: provider.model,
    acceptanceCriteria: normalizedCriteria,
  };
}

async function translateScopeSnapshotWithProvider(
  provider: ProviderConfig,
  context: QaContext,
  targetLanguage: 'id'
): Promise<ProviderScopeTranslationResult> {
  const systemPrompt = [
    'You localize a QA scope snapshot for UI display only.',
    'Translate to natural Indonesian used by internal QA and product teams.',
    'This is not literal translation. Rewrite awkward English into clear Indonesian while preserving the exact meaning.',
    'Prefer short, direct sentences. Split dense sentences when needed.',
    'Avoid stiff, textbook, legalistic, or robotic wording.',
    'Do not change scope, meaning, acceptance-criteria ids, or user-story ids.',
    'Keep technical tokens and identifiers intact when needed: Jira keys, AC ids, US ids, dataset_id, catchment.datasets[], BY_DATASET, Polygon, MultiPolygon, Jira, Confluence, TestRail.',
    'It is acceptable to keep common product and QA terms in English when that reads more naturally, for example: Acceptance Criteria, Scope, Main Jira, Parent Story, Analysis Summary, Strategic Takeaways.',
    'Do not translate generated test case titles or BDD scenarios because they are not part of this task.',
    'Return strict JSON only.',
    'Use this exact top-level shape: {"mainSummary":"","parentStorySummary":"","scopedPrdSection":"","confidenceReasons":[""],"selectedAcceptanceCriteriaReason":"","userStories":[{"id":"US-1","text":""}],"acceptanceCriteria":[{"id":"AC-1","text":""}]}',
  ].join('\n');

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify(
            {
              instruction: `Localize the Scope Snapshot display content to ${targetLanguage} for Indonesian QA users.`,
              source: {
                mainSummary: context.mainIssue.summary || '',
                parentStorySummary: context.scopeParentIssue?.summary || '',
                scopedPrdSection:
                  context.scopeConfluenceSection?.matchedHeading || context.scopeConfluenceSection?.title || '',
                confidenceReasons: context.confidenceReasons || [],
                selectedAcceptanceCriteriaReason: context.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaReason || '',
                userStories: context.userStories || [],
                acceptanceCriteria: context.acceptanceCriteria || [],
              },
            },
            null,
            2
          ),
        },
      ],
    }
  );

  const content = providerContent(response, 'duplicate review');
  const parsed = extractJson(content) as Record<string, unknown>;

  return {
    provider: provider.name,
    model: provider.model,
    translation: normalizeScopeSnapshotTranslation(parsed, context),
  };
}

async function recommendDuplicateCasesWithProvider(
  provider: ProviderConfig,
  jiraKey: string,
  existingCases: ExistingTestRailCase[],
  generatedCases: GeneratedTestCase[],
  deterministicRecommendations: DuplicateCaseRecommendation[]
): Promise<ProviderDuplicateReviewResult> {
  const deterministicIds = new Set(deterministicRecommendations.map((item) => item.newCaseId));
  const casesForLlm = generatedCases.filter((testCase, index) => !deterministicIds.has(testCase.id || `TC-${index + 1}`));
  if (!casesForLlm.length) {
    return { provider: provider.name, model: provider.model, recommendations: [] };
  }

  const systemPrompt = [
    'You are a senior QA reviewer preventing duplicate TestRail pushes.',
    'Compare existing TestRail cases against newly generated candidate cases for the same Jira ticket.',
    'Recommend include only when the candidate adds materially new test coverage.',
    'Recommend exclude when existing cases already cover the same behavior.',
    'Recommend review when there is partial overlap or uncertainty.',
    'Use titles, case intent, covered AC ids, preconditions, and BDD steps. Do not invent existing cases.',
    'Return strict JSON only.',
    'Use this exact top-level shape: {"recommendations":[{"newCaseId":"","recommendation":"include|exclude|review","overlap":"already_covered|partial_overlap|new_coverage","matchedExistingCaseIds":[],"reason":""}]}',
  ].join('\n');

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify(
            {
              instruction: `Review duplicate risk for ${jiraKey}.`,
              existingCases: existingCases.map((testCase) => ({
                caseId: testCase.caseId,
                title: testCase.title,
                refs: testCase.refs,
                preconditions: testCase.preconditions || '',
                bddScenario: testCase.bddScenario || '',
              })),
              generatedCases: casesForLlm.map((testCase, index) => ({
                id: testCase.id || `TC-${index + 1}`,
                title: testCase.title,
                caseIntent: testCase.caseIntent || '',
                coversAcceptanceCriteria: testCase.coversAcceptanceCriteria || [],
                preconditions: testCase.preconditions || '',
                bddScenario: testCase.bddScenario || '',
              })),
            },
            null,
            2
          ),
        },
      ],
    }
  );

  const parsed = extractJson(providerContent(response, 'duplicate recommendations'));
  const recommendations = findDuplicateRecommendationArray(parsed);
  if (!recommendations) throw new Error('LLM duplicate review did not return recommendations.');

  return {
    provider: provider.name,
    model: provider.model,
    recommendations: casesForLlm.map((testCase, index) => {
      const newCaseId = testCase.id || `TC-${index + 1}`;
      const raw = recommendations.find((item) => {
        if (!item || typeof item !== 'object') return false;
        const record = item as Record<string, unknown>;
        return String(record.newCaseId || record.new_case_id || '') === newCaseId;
      });
      return normalizeDuplicateRecommendation((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, testCase, index);
    }),
  };
}

function buildDuplicateFallbackRecommendations(
  deterministicRecommendations: DuplicateCaseRecommendation[],
  generatedCases: GeneratedTestCase[]
): DuplicateCaseRecommendation[] {
  return generatedCases.map((testCase, index) => {
    const newCaseId = testCase.id || `TC-${index + 1}`;
    const deterministic = recommendationForCaseId(deterministicRecommendations, newCaseId);
    if (deterministic) return deterministic;
    return {
      newCaseId,
      recommendation: 'review',
      overlap: 'partial_overlap',
      matchedExistingCaseIds: [],
      reason: 'Review manually because duplicate similarity could not be determined automatically.',
      deterministic: true,
    };
  });
}

export async function recommendDuplicateCases(
  config: LlmConfig,
  jiraKey: string,
  existingCases: ExistingTestRailCase[],
  generatedCases: GeneratedTestCase[]
): Promise<DuplicateCaseRecommendation[]> {
  const deterministicRecommendations = buildDeterministicDuplicateRecommendations(existingCases, generatedCases);
  const providers = config.providers.filter((provider) => provider.apiKey);
  if (!providers.length) return buildDuplicateFallbackRecommendations(deterministicRecommendations, generatedCases);

  let lastError: Error | null = null;
  for (const provider of providers) {
    try {
      const llmResult = await recommendDuplicateCasesWithProvider(
        provider,
        jiraKey,
        existingCases,
        generatedCases,
        deterministicRecommendations
      );
      const merged = generatedCases.map((testCase, index) => {
        const newCaseId = testCase.id || `TC-${index + 1}`;
        return (
          recommendationForCaseId(deterministicRecommendations, newCaseId) ||
          recommendationForCaseId(llmResult.recommendations, newCaseId) ||
          ({
            newCaseId,
            recommendation: 'review',
            overlap: 'partial_overlap',
            matchedExistingCaseIds: [],
            reason: 'Review manually because this case was not classified by duplicate review.',
            deterministic: true,
          } satisfies DuplicateCaseRecommendation)
        );
      });
      return merged;
    } catch (error) {
      lastError = error as Error;
      if (!isFallbackError(error as Error & { statusCode?: number })) break;
    }
  }

  void lastError;
  return buildDuplicateFallbackRecommendations(deterministicRecommendations, generatedCases);
}

function getMissingAcceptanceCriteria(context: GenerateContext, testCases: GeneratedTestCase[]) {
  const coverage = buildCoverage(testCases, context.acceptanceCriteria, { enforceAcceptanceCriteria: true });
  const uncovered = new Set(coverage.uncoveredCriteria);
  return (context.acceptanceCriteria || []).filter((criterion) => uncovered.has(criterion.id));
}

// BUG-10: buildCoverage() already detects conditional criteria covered in only one polarity (e.g. a
// positive case exists but no negative, or vice versa) via singlePolarityCriteria — but that was
// surfaced as a report-only warning with nothing feeding it back into generation, unlike uncovered
// criteria which self-heal via getMissingAcceptanceCriteria + repairMissingCoverageWithProvider. This
// mirrors that pattern for the polarity case: a pure, directly-testable gap detector.
export function getSinglePolarityGaps(
  context: GenerateContext,
  testCases: GeneratedTestCase[]
): Array<{ id: string; text: string; missing: Array<'positive' | 'negative'> }> {
  const coverage = buildCoverage(testCases, context.acceptanceCriteria, { enforceAcceptanceCriteria: true });
  const byId = new Map((context.acceptanceCriteria || []).map((criterion) => [criterion.id, criterion]));
  const gaps: Array<{ id: string; text: string; missing: Array<'positive' | 'negative'> }> = [];
  for (const entry of coverage.singlePolarityCriteria || []) {
    const criterion = byId.get(entry.criterionId);
    if (!criterion) continue;
    gaps.push({ id: criterion.id, text: criterion.text, missing: entry.missing });
  }
  return gaps;
}

export function isFallbackError(error: Error & { statusCode?: number }): boolean {
  const message = String(error && error.message ? error.message : '').toLowerCase();
  return (
    error.statusCode === 429 ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('insufficient_quota') ||
    message.includes('billing') ||
    message.includes('token') ||
    message.includes('context length')
  );
}

// Per-case shape, title, traceability, and endpoint-provenance directives shared by the initial
// generation prompt AND the coverage-repair prompt. Centralized so the two prompts can't drift —
// previously repair silently lacked the apiSpec/traceability/provenance rules, so repaired cases were
// lower quality and could fabricate endpoints. Generation-only expansion rules (per-endpoint happy/
// negative, blocker-as-background) stay inline in generateWithProvider; repair must remain minimal.
function sharedCaseDirectives(opts: { apiMode: boolean; apiContractRelevant: boolean }): string[] {
  const { apiMode, apiContractRelevant } = opts;
  return [
    apiMode
      ? 'Each testCases item must include id, title, type, executionType, caseIntent, jiraReference, preconditions, bddScenario, coversAcceptanceCriteria, sourceScope, evidence, and apiSpec or manualVerification when applicable.'
      : 'Each testCases item must include id, title, type, caseIntent, jiraReference, preconditions, bddScenario, coversAcceptanceCriteria, sourceScope, evidence.',
    'caseIntent must be exactly one of: positive, negative, edge.',
    'jiraReference must be exactly the main Jira ticket key from context.ticketKey, for example ORB-3079. Do not append acceptance criterion ids, slashes, commas, or extra refs.',
    'The evidence object must include coverageNote only. Do not restate PRD section title or acceptance criteria text there.',
    apiMode
      ? 'All titles must follow [BE][{Epic}][{Ticket ID}] Title. Set executionType "postman" for API/endpoint cases and "manual_db" for database/migration/ETL verification cases. Do not put API, DB, or Web in the title — only [BE].'
      : 'Titles must follow [FE][{Epic}][{Ticket ID}] Title.',
    'bddScenario must include Feature, Scenario, Given, When, Then, and useful And steps.',
    apiMode
      ? 'For every postman case, include apiSpec with method, path, samplePayload when the endpoint accepts a body, expectedResponse, and assertions. The bddScenario must also include the sample payload and expected response/assertions in triple-quoted blocks so it is executable from Postman guidance.'
      : '',
    apiMode
      ? 'For migration, backfill, dataset_schema, SQL, or DB verification scope, include manual_db cases with manualVerification target, steps, and expectedResult. Make the BDD clear that the case is not Postman-testable.'
      : '',
    apiMode
      ? 'Use only endpoint paths present in context.apiContract.matchedEndpoints. If a case needs an endpoint not in that matched set, do not fabricate a confident path — note in preconditions that the path is assumed and must be verified against the API docs.'
      : '',
    apiMode && apiContractRelevant
      ? 'Precise traceability: set coversAcceptanceCriteria to ONLY the acceptance criteria a case actually verifies through its When/Then steps. Never staple an unrelated AC onto a case (e.g. a dataset-list or dataset-data test must NOT claim an email-routing or login-restriction AC it does not exercise).'
      : '',
    apiMode && apiContractRelevant
      ? 'Write executable scenarios with concrete, reusable fixtures in the Given steps — name the actors and resources (e.g. a specific partner/org and an assigned vs a non-assigned resource) and reuse them consistently across scenarios — so every case has unambiguous preconditions rather than abstract phrasing.'
      : '',
    apiMode && !apiContractRelevant
      ? 'This backend ticket does NOT change the HTTP API contract (no endpoint references). Do not create Postman/API cases and do not invent endpoints. Produce manual_db cases (manualVerification with target, steps, expectedResult) for data/schema/DB work, or manual_other when DB is not involved.'
      : '',
  ];
}

async function generateWithProvider(provider: ProviderConfig, context: GenerateContext) {
  const enforceCoverage = Boolean(context.coverageEnforced);
  const scopeType = context.constraints?.scopeType || 'web';
  const apiMode = scopeType === 'api';
  // A backend ticket that doesn't change the HTTP API contract (migration/backfill/DB) should
  // produce manual verification cases, not Postman/API cases. Default true for back-compat.
  const apiContractRelevant = context.constraints?.apiContractRelevant !== false;
  const scopePriority = buildScopePriorityContext(context);
  const prdScopedThinTicket =
    scopePriority.primaryAuthority === 'matched_prd_subsection' || scopePriority.primaryAuthority === 'broad_prd_section';
  const systemPrompt = [
    'You are a senior QA engineer.',
    'Generate BDD test cases only from the supplied Jira and Confluence context.',
    'Generate cases from the final canonical acceptance criteria first, then use the selected scope authority as the allowed boundary.',
    'Scope cases to what dev actually built, not the entire PRD.',
    prdScopedThinTicket
      ? 'The main Jira ticket is too thin. Treat the matched PRD subsection as the primary scope authority for generation, using the task title as the scope key.'
      : 'The main Jira ticket is the authority for implemented scope.',
    prdScopedThinTicket
      ? 'Do not generate from adjacent PRD sections. Stay inside the matched subsection and the final acceptance criteria.'
      : scopePriority.hasMeaningfulTicketDescription
      ? 'Treat the main Jira ticket description as the primary coverage authority. Acceptance criteria are completeness checks. Parent Story and PRD are supporting context only and must not expand scope beyond the ticket description.'
      : 'The main Jira ticket description is empty or too thin. Treat the main Jira ticket acceptance criteria as the primary coverage authority. Parent Story and PRD are supporting context only.',
    'Return strict JSON only. No markdown and no explanation.',
    'The JSON must be an object with this exact top-level shape: {"testCases":[...]}',
    ...sharedCaseDirectives({ apiMode, apiContractRelevant }),
    apiMode && apiContractRelevant
      ? 'Give each distinct behavioral rule its own dedicated case that truly verifies it: for an email-routing AC, the Then step must assert the email CTA/body link contains the partner URL (not merely call an endpoint); for an AC that restricts a specific action (e.g. login) to the partner URL, include a case performing that literal action via the general LI URL and asserting the error. Do not consider such an AC covered by tangential endpoint calls.'
      : '',
    apiMode && apiContractRelevant
      ? 'Scope intersection: treat the ticket\'s in-scope endpoints (context.apiContract.matchedEndpoints / the ticket API list) as the operations under test, and apply each behavioral access/validation rule from context.acceptanceCriteria and the scoped PRD context to EACH in-scope endpoint. Produce a happy-path case and a negative case per endpoint, plus edge cases for cross-cutting rules (e.g. multi-partner/shared resources, visibility flags, cross-tenant access). Do NOT generate cases for PRD behavior that falls outside the ticket\'s endpoint scope.'
      : '',
    apiMode && apiContractRelevant
      ? 'Be proportionate, not combinatorial: cover the happy path and the most important negative per in-scope endpoint, plus edge cases for genuinely distinct cross-cutting rules. When the same rule applies identically across several endpoints, write one representative case rather than near-duplicate variants per endpoint. Prefer the smallest set that fully covers every acceptance criterion.'
      : '',
    apiMode && apiContractRelevant
      ? 'Use context.linkedIssues marked as a blocking dependency as background: they often implement the data model or access controls this ticket validates (e.g. a "create access-control tables" blocker the endpoints enforce). Let them inform the rules under test, but do NOT expand scope beyond this ticket\'s endpoints.'
      : '',
    enforceCoverage
      ? 'Use only acceptance criterion ids that exist in context.acceptanceCriteria, such as AC-1.'
      : 'If context.coverageEnforced is false, coversAcceptanceCriteria may be an empty array.',
    enforceCoverage
      ? 'Every acceptance criterion in context.acceptanceCriteria must be covered by at least one test case across the generated set. Generate at least one explicit case for each acceptance criterion before adding extra happy-path, negative, or edge coverage.'
      : 'When coverage is not enforced, focus on scoped FE behavior and keep coversAcceptanceCriteria empty unless the mapping is obvious.',
    enforceCoverage
      ? 'Every test case must list at least one coversAcceptanceCriteria id.'
      : 'Every test case must still include sourceScope referencing the Jira issues or scoped Story source used.',
    enforceCoverage
      ? 'Do not introduce case themes that cannot be traced to one or more final acceptance criteria, even if the broader Story or PRD page mentions them elsewhere.'
      : '',
    enforceCoverage ? 'Do not stop after covering only the first acceptance criterion. Ensure sync, state, and cross-control behavior criteria also receive dedicated coverage when present.' : '',
    prdScopedThinTicket
      ? 'When the matched subsection describes a specific output variant such as no-score analysis, generate cases for that variant-specific behavior instead of broader feature-entry or menu-visibility behavior from surrounding sections.'
      : scopePriority.hasMeaningfulTicketDescription
      ? 'Do not generate extra cases solely because they appear in the Story or PRD if they are not supported by the main ticket description or its acceptance criteria.'
      : 'When relying on acceptance criteria fallback, still keep Story and PRD context supportive only; do not broaden scope beyond what the ticket acceptance criteria imply.',
  ].filter(Boolean).join('\n');

  const userPrompt = JSON.stringify(
    {
      instruction: 'Generate happy path, negative, and edge-case BDD test cases.',
      scopePriority,
      context: buildGenerationPromptContext(context),
    },
    null,
    2
  );

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }
  );

  const content = providerContent(response, 'generation');
  const parsed = extractJson(content);
  const cases = findCaseArray(parsed);
  if (!Array.isArray(cases)) {
    throw new Error('LLM response JSON must contain a testCases array.');
  }
  return {
    provider: provider.name,
    model: provider.model,
    testCases: cases.map((testCase, index) => normalizeCase(testCase as Record<string, unknown>, index)),
  };
}

async function repairMissingCoverageWithProvider(
  provider: ProviderConfig,
  context: GenerateContext,
  existingCases: GeneratedTestCase[],
  missingCriteria: Array<{ id: string; text: string }>
): Promise<ProviderGenerationResult> {
  const scopePriority = buildScopePriorityContext(context);
  const scopeType = context.constraints?.scopeType || 'web';
  const apiMode = scopeType === 'api';
  const apiContractRelevant = context.constraints?.apiContractRelevant !== false;
  const prdScopedThinTicket =
    scopePriority.primaryAuthority === 'matched_prd_subsection' || scopePriority.primaryAuthority === 'broad_prd_section';
  const systemPrompt = [
    'You are a senior QA engineer repairing missing acceptance criteria coverage.',
    prdScopedThinTicket
      ? 'The main Jira ticket is too thin. Use the matched PRD subsection as the primary scope authority while repairing missing coverage.'
      : 'The main Jira ticket is the authority for implemented scope.',
    prdScopedThinTicket
      ? 'Do not pull in behavior from neighboring PRD sections or broader feature-entry flows.'
      : scopePriority.hasMeaningfulTicketDescription
      ? 'Use the main Jira ticket description as the primary scope authority while repairing missing coverage. Story and PRD remain supporting context only.'
      : 'The main Jira ticket description is empty or too thin, so use the main Jira ticket acceptance criteria as the primary scope authority while repairing missing coverage.',
    'Return strict JSON only. No markdown and no explanation.',
    'The JSON must be an object with this exact top-level shape: {"testCases":[...]}',
    'Return only additional test cases needed to cover the missing acceptance criteria.',
    'Do not rewrite or repeat existing cases unless necessary for one of the missing criteria.',
    'Generate repair cases from the same selected scope authority and final acceptance criteria only.',
    ...sharedCaseDirectives({ apiMode, apiContractRelevant }),
    apiMode && apiContractRelevant
      ? 'Reuse the same named actors/resources (assigned vs non-assigned) already established by the existing cases as executable preconditions, so repair cases read consistently with the set.'
      : '',
    'Each returned case must map to at least one missing acceptance criterion id.',
    'Keep the set minimal but sufficient.',
  ].filter(Boolean).join('\n');

  const userPrompt = JSON.stringify(
    {
      instruction: 'Generate only the missing coverage cases.',
      scopePriority,
      missingAcceptanceCriteria: missingCriteria,
      existingCases: existingCases.map((testCase) => ({
        id: testCase.id,
        title: testCase.title,
        type: testCase.type,
        caseIntent: testCase.caseIntent,
        coversAcceptanceCriteria: testCase.coversAcceptanceCriteria,
      })),
      context: buildGenerationPromptContext(context),
    },
    null,
    2
  );

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }
  );

  const content = providerContent(response, 'coverage repair');
  const parsed = extractJson(content);
  const cases = findCaseArray(parsed);
  if (!Array.isArray(cases)) {
    throw new Error('LLM repair response JSON must contain a testCases array.');
  }
  return {
    provider: provider.name,
    model: provider.model,
    testCases: cases.map((testCase, index) => normalizeCase(testCase as Record<string, unknown>, index)),
  };
}

// BUG-10: repair pass that mirrors repairMissingCoverageWithProvider, but for one-sided coverage —
// each listed criterion is already covered, but only in one polarity, leaving a conditional branch
// unexercised. Asks the provider for just the missing-polarity cases.
async function repairSinglePolarityWithProvider(
  provider: ProviderConfig,
  context: GenerateContext,
  existingCases: GeneratedTestCase[],
  polarityGaps: Array<{ id: string; text: string; missing: Array<'positive' | 'negative'> }>
): Promise<ProviderGenerationResult> {
  const scopePriority = buildScopePriorityContext(context);
  const scopeType = context.constraints?.scopeType || 'web';
  const apiMode = scopeType === 'api';
  const apiContractRelevant = context.constraints?.apiContractRelevant !== false;
  const systemPrompt = [
    'You are a senior QA engineer repairing one-sided acceptance-criteria coverage.',
    'Each listed criterion already has at least one test case, but every existing case shares the same polarity, leaving a conditional branch of the criterion unexercised (e.g. only the accepted/enabled path is tested, never the rejected/disabled path, or vice versa).',
    'Return strict JSON only. No markdown and no explanation.',
    'The JSON must be an object with this exact top-level shape: {"testCases":[...]}',
    'Return only the test cases needed to add the missing polarity listed for each criterion. Do not add cases for a polarity that is not listed as missing for that criterion.',
    'Each returned case must set caseIntent to exactly one of the missing polarities requested for that criterion (positive or negative), and must include that criterion id in coversAcceptanceCriteria.',
    ...sharedCaseDirectives({ apiMode, apiContractRelevant }),
    'Reuse the same named actors/resources/fixtures already established by the existing cases so repair cases read consistently with the set, rather than introducing new unrelated fixtures.',
    'Keep the set minimal but sufficient: one case per missing polarity per criterion is normally enough unless the criterion bundles multiple distinct branches for that polarity.',
  ].filter(Boolean).join('\n');

  const userPrompt = JSON.stringify(
    {
      instruction: 'Generate only the missing-polarity repair cases.',
      scopePriority,
      polarityGaps,
      existingCases: existingCases.map((testCase) => ({
        id: testCase.id,
        title: testCase.title,
        caseIntent: testCase.caseIntent,
        coversAcceptanceCriteria: testCase.coversAcceptanceCriteria,
        preconditions: testCase.preconditions,
      })),
      context: buildGenerationPromptContext(context),
    },
    null,
    2
  );

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }
  );

  const content = providerContent(response, 'polarity repair');
  const parsed = extractJson(content);
  const cases = findCaseArray(parsed);
  if (!Array.isArray(cases)) {
    throw new Error('LLM polarity repair response JSON must contain a testCases array.');
  }
  return {
    provider: provider.name,
    model: provider.model,
    testCases: cases.map((testCase, index) => normalizeCase(testCase as Record<string, unknown>, index)),
  };
}

export async function generateTestCases(config: LlmConfig, context: GenerateContext) {
  const providers = (config.providers || []).filter((provider) => provider.apiKey);
  if (!providers.length) {
    throw new Error('No LLM provider API key is configured.');
  }

  let lastError: Error | undefined;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      const initial = await generateWithProvider(provider, context);
      if (!context.coverageEnforced) {
        return initial;
      }

      let mergedCases = dedupeGeneratedCases(initial.testCases);
      const missingCriteria = getMissingAcceptanceCriteria(context, mergedCases);
      if (missingCriteria.length) {
        const repair = await repairMissingCoverageWithProvider(provider, context, mergedCases, missingCriteria);
        mergedCases = dedupeGeneratedCases([...mergedCases, ...repair.testCases]);
      }

      // BUG-10: after full-coverage repair, close single-polarity gaps the same way. Runs after the
      // missing-coverage pass, so it only ever sees criteria that are already covered at all — a
      // criterion still fully uncovered is handled above, not here. No-op when polarityGaps is empty.
      const polarityGaps = getSinglePolarityGaps(context, mergedCases);
      if (polarityGaps.length) {
        const polarityRepair = await repairSinglePolarityWithProvider(provider, context, mergedCases, polarityGaps);
        mergedCases = dedupeGeneratedCases([...mergedCases, ...polarityRepair.testCases]);
      }

      return {
        provider: initial.provider,
        model: initial.model,
        testCases: mergedCases,
      };
    } catch (error) {
      lastError = error as Error;
      const hasFallback = index < providers.length - 1;
      if (!hasFallback || !isFallbackError(lastError as Error & { statusCode?: number })) {
        throw error;
      }
    }
  }

  throw lastError || new Error('LLM generation failed.');
}

export async function synthesizeAcceptanceCriteria(config: LlmConfig, input: AcceptanceCriteriaSynthesisInput): Promise<AcceptanceCriteriaSynthesisResult> {
  const providers = (config.providers || []).filter((provider) => provider.apiKey);
  if (!providers.length) {
    throw new Error('No LLM provider API key is configured.');
  }

  let lastError: Error | undefined;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      const result = await synthesizeWithProvider(provider, input);
      return {
        acceptanceCriteria: result.acceptanceCriteria,
        provider: result.provider,
        model: result.model,
      };
    } catch (error) {
      lastError = error as Error;
      const hasFallback = index < providers.length - 1;
      if (!hasFallback || !isFallbackError(lastError as Error & { statusCode?: number })) {
        throw error;
      }
    }
  }

  throw lastError || new Error('LLM acceptance criteria synthesis failed.');
}

export interface ExcerptRelevanceInput {
  criterion: string;
  excerpt: string;
}

// F3: cache the per-(criterion, excerpt) verdict so repeated candidate lines and re-runs of the same
// ticket never re-pay the token cost. Keyed by criterion + excerpt (NUL-joined so the two fields can't
// collide). Short-lived: stable within a review session, but a prompt change shouldn't be shadowed by
// stale verdicts indefinitely.
const excerptRelevanceCache = new TtlCache<boolean>(Number(process.env.EXCERPT_RELEVANCE_CACHE_TTL_MS || 1_800_000), 512);

function excerptRelevanceCacheKey(input: ExcerptRelevanceInput): string {
  return `${input.criterion} ${input.excerpt}`;
}

async function checkExcerptRelevanceWithProvider(provider: ProviderConfig, input: ExcerptRelevanceInput): Promise<boolean> {
  // A single cheap yes/no: does the candidate source line state the SAME requirement as the criterion?
  // Topic overlap is explicitly not enough — that is exactly what the deterministic token-overlap scorer
  // already rewards, and what lets a same-topic / different-behavior line through.
  // Calibrated against real ORB-3205 evidence (see commit msg): a bare "same requirement?" yes/no was too
  // lenient on the live model — it accepted same-topic/different-phase lines (the reported misattribution).
  // Naming the discriminating axes (feature / phase / condition) and allowing paraphrase makes it reject
  // "config section" vs "story-detail display" while keeping genuine reworded matches.
  const systemPrompt = [
    "You verify QA traceability evidence: does the candidate source line describe the SAME product requirement as the acceptance criterion, so it can serve as that criterion's evidence?",
    'Answer true when the source line specifies the same behavior the criterion requires — even if it uses different wording, names the same control or surface differently, or gives more detail. A paraphrase or a more-specific spec of the same behavior is still the same requirement.',
    'Answer false when, despite shared words, topic, or feature area, they differ on ANY of these axes:',
    '- FEATURE: they are about different settings, controls, or capabilities.',
    '- PHASE: one configures / selects / inputs something during setup, while the other displays / reports / stores it after the action runs (or one is a UI behavior and the other an API or stored-data field).',
    '- CONDITION: opposite polarity — enabled vs. disabled, included vs. excluded, allowed vs. rejected.',
    'Examples:',
    '- Criterion: "Save is disabled until the required field has a value." Source: "The submit CTA stays disabled until the user enters the mandatory value." => true (same behavior, different wording).',
    '- Criterion: "Add a section to choose the analysis mode during setup." Source: "Show the chosen analysis mode on the result detail page." => false (configure-at-setup vs. display-after-run: different phase).',
    '- Criterion: "Add a toggle for setting A." Source: "Add a toggle for setting B." => false (different feature).',
    'Think briefly in "reason", then decide. Return strict JSON only, no markdown: {"reason":"<one short sentence>","sameRequirement":true} or {"reason":"...","sameRequirement":false}.',
  ].join('\n');

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0, // deterministic relevance verdict: same pair → stable yes/no run-to-run
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({ acceptanceCriterion: input.criterion, candidateSourceLine: input.excerpt }, null, 2),
        },
      ],
    }
  );

  const content = providerContent(response, 'excerpt relevance');
  const parsed = extractJson(content) as { sameRequirement?: unknown } | null;
  return parsed?.sameRequirement === true;
}

/**
 * F3 semantic evidence gate: ask the LLM whether a candidate source line states the SAME requirement as
 * the acceptance criterion. Token-overlap scoring rewards topic overlap and cannot separate
 * "displayed in the config UI" from "displays info on the story detail page"; this can. Fail-open: when
 * no provider is configured, or every provider errors, return true so a transient LLM failure can never
 * strip an otherwise-selected excerpt — the deterministic scorer stays the floor. Verdicts are cached
 * per (criterion, excerpt).
 */
export async function isExcerptRelevant(config: LlmConfig, input: ExcerptRelevanceInput, logger?: Logger): Promise<boolean> {
  const providers = (config.providers || []).filter((provider) => provider.apiKey);
  if (!providers.length) return true; // can't check → keep (deterministic fallback)

  const cacheKey = excerptRelevanceCacheKey(input);
  const cached = excerptRelevanceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let lastError: Error | undefined;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      const relevant = await checkExcerptRelevanceWithProvider(provider, input);
      excerptRelevanceCache.set(cacheKey, relevant);
      return relevant;
    } catch (error) {
      lastError = error as Error;
      const hasFallback = index < providers.length - 1;
      if (!hasFallback || !isFallbackError(lastError as Error & { statusCode?: number })) break;
    }
  }

  logger?.warn('context.ac_excerpt_relevance_failed', {
    errorMessage: lastError instanceof Error ? lastError.message : String(lastError),
  });
  return true; // fail-open: never drop evidence because the relevance check itself failed
}

export async function translateScopeSnapshot(config: LlmConfig, context: QaContext, targetLanguage: 'id'): Promise<ScopeSnapshotTranslation> {
  const providers = (config.providers || []).filter((provider) => provider.apiKey);
  if (!providers.length) {
    throw new Error('No LLM provider API key is configured.');
  }

  let lastError: Error | undefined;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      const result = await translateScopeSnapshotWithProvider(provider, context, targetLanguage);
      return result.translation;
    } catch (error) {
      lastError = error as Error;
      const hasFallback = index < providers.length - 1;
      if (!hasFallback || !isFallbackError(lastError as Error & { statusCode?: number })) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Scope snapshot translation failed.');
}

async function selectApiEndpointsWithProvider(
  provider: ProviderConfig,
  input: { scopeText: string; documentedEndpoints: ApiContractEndpoint[] }
): Promise<ApiContractEndpoint[]> {
  const systemPrompt = [
    'You identify which HTTP API endpoints are in scope for a backend QA ticket.',
    'You are given the ticket scope text and a list of documented endpoints (method, path, summary).',
    'Return the endpoints the ticket actually targets. Match references written in prose (e.g. "Get dataset list", "Submit analysis", "Reset password") to the documented endpoints by meaning, not by exact string.',
    'Prefer endpoints that appear in the documented list; copy their exact method and path.',
    'If the ticket clearly references an endpoint that is NOT in the documented list, include it with your best-guess method and an empty path, and put the human phrase in "label".',
    'Do not invent endpoints that the ticket does not reference. If nothing is in scope, return an empty array.',
    'Return strict JSON only with this exact shape: {"endpoints":[{"method":"GET","path":"/v1/...","label":"","summary":""}]}',
  ].join('\n');

  const response = await requestJson<any>(
    `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { Authorization: `Bearer ${provider.apiKey}` },
    {
      model: provider.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify(
            {
              scope: input.scopeText.slice(0, 12_000),
              documentedEndpoints: input.documentedEndpoints
                .slice(0, 400)
                .map((endpoint) => ({ method: endpoint.method, path: endpoint.path, summary: endpoint.summary || '' })),
            },
            null,
            2
          ),
        },
      ],
    }
  );

  const parsed = extractJson(providerContent(response, 'endpoint selection'));
  return normalizeSelectedEndpoints(parsed, input.documentedEndpoints);
}

export async function selectScopedApiEndpoints(
  config: LlmConfig,
  input: { scopeText: string; documentedEndpoints: ApiContractEndpoint[] }
): Promise<ApiContractEndpoint[]> {
  const providers = (config.providers || []).filter((provider) => provider.apiKey);
  if (!providers.length) {
    throw new Error('No LLM provider API key is configured.');
  }

  let lastError: Error | undefined;
  for (let index = 0; index < providers.length; index += 1) {
    try {
      return await selectApiEndpointsWithProvider(providers[index], input);
    } catch (error) {
      lastError = error as Error;
      const hasFallback = index < providers.length - 1;
      if (!hasFallback || !isFallbackError(lastError as Error & { statusCode?: number })) {
        throw error;
      }
    }
  }

  throw lastError || new Error('API endpoint selection failed.');
}
