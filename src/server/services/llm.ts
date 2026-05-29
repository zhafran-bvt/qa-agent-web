import https from 'node:https';
import type { GeneratedTestCase, QaContext, ScopeSnapshotTranslation } from '../../shared/contracts';
import { buildCoverage } from './validation';
import type { AcceptanceCriteriaSynthesisInput, AcceptanceCriteriaSynthesisResult } from './acceptance-criteria';

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
  const rawDescription = String(context.mainIssue.description || '').trim();
  const descriptionWithoutAc = stripAcceptanceCriteriaSections(rawDescription);
  const hasMeaningfulTicketDescription = descriptionWithoutAc.length >= 20;

  return {
    primaryAuthority: hasMeaningfulTicketDescription ? 'main_ticket_description' : 'main_ticket_acceptance_criteria',
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
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsedBody: any;
          try {
            parsedBody = data ? JSON.parse(data) : {};
          } catch {
            reject(new Error(`Invalid JSON from LLM provider: ${data.slice(0, 500)}`));
            return;
          }
          if ((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300) {
            resolve(parsedBody as T);
            return;
          }
          const message = parsedBody.error && parsedBody.error.message ? parsedBody.error.message : `HTTP ${res.statusCode}`;
          const error = new Error(message) as Error & { statusCode?: number; response?: unknown };
          error.statusCode = res.statusCode;
          error.response = parsedBody;
          reject(error);
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractJson(text: string): unknown {
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

export function findCaseArray(value: unknown): unknown[] | null {
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
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).join('\n');
  }
  return String(value || '').trim();
}

export function normalizeJiraReference(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const exactMatch = raw.match(/[A-Z]+-\d+/i);
  return exactMatch ? exactMatch[0].toUpperCase() : raw.toUpperCase();
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

function normalizeScopedItems(value: unknown, fallback: Array<{ id: string; text: string }>): Array<{ id: string; text: string }> {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((item, index) => {
      const record = (item || {}) as Record<string, unknown>;
      return {
        id: String(record.id || fallback[index]?.id || ''),
        text: String(record.text || '').trim(),
      };
    })
    .filter((item) => item.id && item.text);
}

export function normalizeCase(testCase: Record<string, unknown>, index: number): GeneratedTestCase {
  const evidenceRecord = (testCase.evidence && typeof testCase.evidence === 'object' ? (testCase.evidence as Record<string, unknown>) : {}) || {};

  return {
    id: String(testCase.id || testCase.testCaseId || testCase.test_case_id || `TC-${String(index + 1).padStart(2, '0')}`),
    title: String(testCase.title || ''),
    type: String(testCase.type || ''),
    jiraReference: normalizeJiraReference(testCase.jiraReference || testCase.jira_reference || testCase.refs || ''),
    preconditions: normalizeTextList(testCase.preconditions || testCase.custom_preconds || ''),
    bddScenario: normalizeBddScenario(testCase.bddScenario || testCase.bdd_scenario || testCase.custom_testrail_bdd_scenario || ''),
    coversAcceptanceCriteria: normalizeIdList(testCase.coversAcceptanceCriteria || testCase.covers_acceptance_criteria || ''),
    sourceScope: normalizeIdList(testCase.sourceScope || testCase.source_scope || ''),
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
    acceptanceCriteria: context.acceptanceCriteria,
    acceptanceCriteriaSource: context.acceptanceCriteriaSource,
    userStories: context.userStories,
    confidenceLevel: context.confidenceLevel,
    confidenceReasons: context.confidenceReasons,
    constraints: context.constraints,
    actualDevScopeGuidance: context.actualDevScopeGuidance,
    coverageEnforced: context.coverageEnforced,
    manualScopeOverride: context.manualScopeOverride,
    manualScopeOverrideReason: context.manualScopeOverrideReason,
  };
}

async function synthesizeWithProvider(provider: ProviderConfig, input: AcceptanceCriteriaSynthesisInput): Promise<ProviderSynthesisResult> {
  const prdScopedThinTicket = input.acceptanceCriteriaSource === 'parent_story_confluence_section' && input.thinTicketFallbackUsed;
  const targetInstruction =
    input.targetMinCriteria && input.targetMaxCriteria
      ? `Target ${input.targetMinCriteria}-${input.targetMaxCriteria} medium-granularity criteria unless the ticket is clearly simpler.`
      : 'Prefer a concise but complete canonical set.';
  const systemPrompt = [
    'You are a senior QA engineer deriving final FE acceptance criteria from Jira implementation scope.',
    prdScopedThinTicket
      ? 'The main Jira ticket is too thin. Use the matched PRD subsection as the primary authority, with the task title as the scope key and the parent story as routing context only.'
      : 'The main Jira ticket is the authority for implemented scope.',
    prdScopedThinTicket
      ? 'Do not broaden beyond the matched PRD subsection and the thin ticket title.'
      : 'Parent Story and PRD are supporting context only and must not expand scope beyond the main ticket.',
    'Prefer FE-testable behavior and FE-owned payload contracts.',
    'Ignore background, non-goals, BE-only dependency notes, code scaffolding, partial flow-control lines, and duplicate rendered/plain fragments.',
    'If the raw acceptance criteria are already strong, preserve them semantically while normalizing wording and deduplicating.',
    targetInstruction,
    input.granularityHint || '',
    prdScopedThinTicket && input.prdSubsectionMatchQuality === 'broad'
      ? 'The PRD subsection match was broad rather than exact, so stay conservative and keep only behavior clearly supported by the matched subsection.'
      : '',
    'Do not over-merge distinct FE behaviors into one criterion.',
    'When present in the main ticket, keep Run Analysis payload mapping, Save Config payload mapping, dataset linkage or datasets[] behavior, and preview or map labeling behavior as separate criteria instead of compressing them into one broad clause.',
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
      temperature: 0.1,
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

  const content = response.choices?.[0]?.message?.content;
  const parsed = extractJson(content);
  const criteria = findAcceptanceCriteriaArray(parsed);
  if (!Array.isArray(criteria)) {
    throw new Error('LLM synthesis response JSON must contain an acceptanceCriteria array.');
  }

  let normalizedCriteria = normalizeSynthesisCriteria(criteria);

  if (needsGranularityRepair(input, normalizedCriteria)) {
    const repairPrompt = [
      'You are repairing an over-merged FE acceptance-criteria set.',
      'Keep scope identical to the main ticket. Do not invent new behavior.',
      'Split only criteria that bundle multiple distinct FE behaviors or payload contracts together.',
      input.targetMinCriteria && input.targetMaxCriteria
        ? `Return ${input.targetMinCriteria}-${input.targetMaxCriteria} criteria if the ticket supports that many distinct behaviors.`
        : 'Return a medium-granularity canonical set.',
      input.granularityHint || '',
      'Keep these concerns separate when present: selection and visibility, geometry preservation, Run Analysis payload, Save Config payload with dataset_id linkage, datasets[] versus legacy dataset behavior, and preview or map label behavior.',
      'Return strict JSON only in the shape {"acceptanceCriteria":[{"id":"AC-1","text":"..."}]}.',
    ]
      .filter(Boolean)
      .join('\n');

    const repairResponse = await requestJson<any>(
      `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`,
      { Authorization: `Bearer ${provider.apiKey}` },
      {
        model: provider.model,
        temperature: 0.1,
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

    const repairContent = repairResponse.choices?.[0]?.message?.content;
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
    'You translate a QA scope snapshot for UI display only.',
    'Translate to casual, friendly, clear Indonesian.',
    'Do not change scope, meaning, acceptance-criteria ids, or user-story ids.',
    'Keep technical tokens and identifiers intact when needed: Jira keys, AC ids, US ids, dataset_id, catchment.datasets[], BY_DATASET, Polygon, MultiPolygon, Jira, Confluence, TestRail.',
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
              instruction: `Translate the Scope Snapshot display content to ${targetLanguage}.`,
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

  const content = response.choices?.[0]?.message?.content;
  const parsed = extractJson(content) as Record<string, unknown>;

  return {
    provider: provider.name,
    model: provider.model,
    translation: {
      mainSummary: String(parsed.mainSummary || '').trim(),
      parentStorySummary: String(parsed.parentStorySummary || '').trim(),
      scopedPrdSection: String(parsed.scopedPrdSection || '').trim(),
      confidenceReasons: Array.isArray(parsed.confidenceReasons)
        ? parsed.confidenceReasons.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      selectedAcceptanceCriteriaReason: String(parsed.selectedAcceptanceCriteriaReason || '').trim() || undefined,
      userStories: normalizeScopedItems(parsed.userStories, context.userStories || []),
      acceptanceCriteria: normalizeScopedItems(parsed.acceptanceCriteria, context.acceptanceCriteria || []),
    },
  };
}

function getMissingAcceptanceCriteria(context: GenerateContext, testCases: GeneratedTestCase[]) {
  const coverage = buildCoverage(testCases, context.acceptanceCriteria, { enforceAcceptanceCriteria: true });
  const uncovered = new Set(coverage.uncoveredCriteria);
  return (context.acceptanceCriteria || []).filter((criterion) => uncovered.has(criterion.id));
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

async function generateWithProvider(provider: ProviderConfig, context: GenerateContext) {
  const enforceCoverage = Boolean(context.coverageEnforced);
  const scopePriority = buildScopePriorityContext(context);
  const systemPrompt = [
    'You are a senior QA engineer.',
    'Generate BDD test cases only from the supplied Jira and Confluence context.',
    'Scope cases to what dev actually built, not the entire PRD.',
    'The main Jira ticket is the authority for implemented scope.',
    scopePriority.hasMeaningfulTicketDescription
      ? 'Treat the main Jira ticket description as the primary coverage authority. Acceptance criteria are completeness checks. Parent Story and PRD are supporting context only and must not expand scope beyond the ticket description.'
      : 'The main Jira ticket description is empty or too thin. Treat the main Jira ticket acceptance criteria as the primary coverage authority. Parent Story and PRD are supporting context only.',
    'Return strict JSON only. No markdown and no explanation.',
    'The JSON must be an object with this exact top-level shape: {"testCases":[...]}',
    'Each testCases item must include id, title, type, jiraReference, preconditions, bddScenario, coversAcceptanceCriteria, sourceScope, evidence.',
    'jiraReference must be exactly the main Jira ticket key from context.ticketKey, for example ORB-3079. Do not append acceptance criterion ids, slashes, commas, or extra refs.',
    'The evidence object must include coverageNote only. Do not restate PRD section title or acceptance criteria text there.',
    'Titles must follow [Web][{Epic}][{Ticket ID}] Title.',
    'bddScenario must include Feature, Scenario, Given, When, Then, and useful And steps.',
    enforceCoverage
      ? 'Use only acceptance criterion ids that exist in context.acceptanceCriteria, such as AC-1.'
      : 'If context.coverageEnforced is false, coversAcceptanceCriteria may be an empty array.',
    enforceCoverage
      ? 'Every acceptance criterion in context.acceptanceCriteria must be covered by at least one test case across the generated set. Generate at least one explicit case for each acceptance criterion before adding extra happy-path, negative, or edge coverage.'
      : 'When coverage is not enforced, focus on scoped FE behavior and keep coversAcceptanceCriteria empty unless the mapping is obvious.',
    enforceCoverage
      ? 'Every test case must list at least one coversAcceptanceCriteria id.'
      : 'Every test case must still include sourceScope referencing the Jira issues or scoped Story source used.',
    enforceCoverage ? 'Do not stop after covering only the first acceptance criterion. Ensure sync, state, and cross-control behavior criteria also receive dedicated coverage when present.' : '',
    scopePriority.hasMeaningfulTicketDescription
      ? 'Do not generate extra cases solely because they appear in the Story or PRD if they are not supported by the main ticket description or its acceptance criteria.'
      : 'When relying on acceptance criteria fallback, still keep Story and PRD context supportive only; do not broaden scope beyond what the ticket acceptance criteria imply.',
  ].join('\n');

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

  const content = response.choices?.[0]?.message?.content;
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
  const systemPrompt = [
    'You are a senior QA engineer repairing missing acceptance criteria coverage.',
    'The main Jira ticket is the authority for implemented scope.',
    scopePriority.hasMeaningfulTicketDescription
      ? 'Use the main Jira ticket description as the primary scope authority while repairing missing coverage. Story and PRD remain supporting context only.'
      : 'The main Jira ticket description is empty or too thin, so use the main Jira ticket acceptance criteria as the primary scope authority while repairing missing coverage.',
    'Return strict JSON only. No markdown and no explanation.',
    'The JSON must be an object with this exact top-level shape: {"testCases":[...]}',
    'Return only additional test cases needed to cover the missing acceptance criteria.',
    'Do not rewrite or repeat existing cases unless necessary for one of the missing criteria.',
    'Each testCases item must include id, title, type, jiraReference, preconditions, bddScenario, coversAcceptanceCriteria, sourceScope, evidence.',
    'jiraReference must be exactly the main Jira ticket key from context.ticketKey, not an AC id or combined ref string.',
    'The evidence object must include coverageNote only.',
    'Each returned case must map to at least one missing acceptance criterion id.',
    'Keep the set minimal but sufficient.',
  ].join('\n');

  const userPrompt = JSON.stringify(
    {
      instruction: 'Generate only the missing coverage cases.',
      scopePriority,
      missingAcceptanceCriteria: missingCriteria,
      existingCases: existingCases.map((testCase) => ({
        id: testCase.id,
        title: testCase.title,
        type: testCase.type,
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

  const content = response.choices?.[0]?.message?.content;
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
