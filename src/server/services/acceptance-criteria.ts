import type { ConfluencePageSummary, CrossSourceConflict, QaContext, ScopedItem } from '../../shared/contracts';
import type { Logger } from './logger';
import { canonicalize } from './context-builder';
import { NEGATION_CUES, POLARITY_AXES, SPEC_PAGE_TITLE_RE } from './keywords';
import { isExcerptRelevant } from './llm';
import type { ExcerptRelevanceInput, LlmConfig } from './llm';
import { mapWithConcurrency } from './ttl-cache';

export interface ParsedIssueSection {
  heading: string;
  body: string;
}

export interface AcceptanceCriteriaSynthesisInput {
  ticketKey: string;
  mainIssueSummary: string;
  mainIssueDescription: string;
  parsedSections: ParsedIssueSection[];
  rawSelectedAcceptanceCriteria: ScopedItem[];
  acceptanceCriteriaSource: string;
  parentStorySummary: string;
  prdSectionTitle: string;
  prdSectionBody: string;
  thinTicketFallbackUsed?: boolean;
  prdSubsectionMatchQuality?: 'confident' | 'broad' | 'none';
  actualDevScopeGuidance: string;
  targetMinCriteria?: number;
  targetMaxCriteria?: number;
  granularityHint?: string;
  // BUG-03 step 3 (spike): concrete rules from a linked technical-specification page, surfaced so the
  // synthesizer can ground criteria in implementation detail (point-in-time semantics, per-endpoint
  // enforcement, backward-compat edges) instead of PRD paraphrases. Empty when no spec page is linked.
  technicalSpecExcerpts?: string;
  // The ticket's concrete in-scope operations (matched API endpoints). Used as a hard boundary so spec
  // grounding sharpens criteria for these operations without promoting unrelated spec capabilities
  // (e.g. login isolation when no login endpoint is in scope) into active criteria. Empty when unknown.
  scopeBoundary?: string;
}

export interface AcceptanceCriteriaSynthesisResult {
  acceptanceCriteria: Array<{ id?: string; text: string; rationale?: string }>;
  provider?: string;
  model?: string;
}

// F3 semantic evidence gate: yes/no relevance check for a single (criterion, excerpt) pair.
export type ExcerptRelevanceCheck = (input: ExcerptRelevanceInput) => Promise<boolean>;

export interface AcceptanceCriteriaFinalizationOptions {
  synthesizer?: (input: AcceptanceCriteriaSynthesisInput) => Promise<AcceptanceCriteriaSynthesisResult>;
  logger?: Logger;
  // F3: config for the LLM excerpt-relevance gate. The gate runs only when EXCERPT_RELEVANCE_LLM is
  // enabled (so per-excerpt token cost/latency is strictly opt-in); off → the deterministic token-overlap
  // scorer remains the sole selector. `excerptRelevanceCheck` overrides `llm` and runs regardless of the
  // env flag — it is the seam tests use to stub the yes/no without HTTP.
  llm?: LlmConfig;
  excerptRelevanceCheck?: ExcerptRelevanceCheck;
}

interface GranularityTarget {
  min: number;
  max: number;
  hint: string;
}

interface CriteriaQualityAssessment {
  quality: 'none' | 'weak' | 'strong';
  kept: ScopedItem[];
  discarded: ScopedItem[];
  weakSignals: string[];
}

function normalizeInlineText(value: unknown): string {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeMultilineText(value: unknown): string {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/<(?:br|br\/)\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dedupeCriteria(items: Array<{ text: string; source?: string }>, prefix = 'AC'): ScopedItem[] {
  const seen = new Set<string>();
  const output: ScopedItem[] = [];

  for (const item of items || []) {
    const text = normalizeInlineText(item.text);
    const key = canonicalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({
      id: `${prefix}-${output.length + 1}`,
      text,
      source: item.source,
    });
  }

  return output;
}

function isFragmentaryCriterion(text: string): boolean {
  const normalized = normalizeInlineText(text);
  const lower = normalized.toLowerCase();

  if (!normalized) return true;
  if (normalized.length < 18) return true;
  if (/^[\W_]+$/.test(normalized)) return true;
  if (/^(if|when|then|given|and)\b/i.test(normalized) && normalized.split(/\s+/).length < 5) return true;
  if (/^[└├│]/.test(normalized)) return true;
  if (/^(feature flag|ff|prd|tech design|background|goals|non-goals|ui behavior|data flow|geometry handling)[:]?$/i.test(normalized)) return true;
  if (/^feature flag\b/i.test(lower) && /(gate|gating|path)[:.]?$/i.test(normalized)) return true;
  if (/^(isbvtdataforcatchmentenabled|vite_feature_flag_)/i.test(lower)) return true;
  if (/^[a-z0-9_.-]+\(\)$/.test(lower)) return true;
  if (/^\d+(?:\.\d+)*\s+[A-Z][A-Za-z ]+$/.test(normalized) && normalized.split(/\s+/).length <= 4) return true;

  return false;
}

function isFeTestableRequirement(text: string): boolean {
  return /(should|must|required|display|shown|hidden|enabled|disabled|render|save|open|select|preserve|payload|dataset|polygon|multipolygon|location|marker|label|popup|traceable|mapped|fallback|gate|prevent|allow|include|exclude|sync|summary|narrative|score|scoring|risk|takeaways|tab|characteristics|signals|zone|api|endpoint|schema|validation|response|request|post|put|get|patch|delete|database|db|migration|backfill|dataset_schema|is_dimension|is_measure)/i.test(
    text
  );
}

export function parseMainIssueSections(text: string): ParsedIssueSection[] {
  // Parse known Jira section headings so synthesis can reason over design-ticket structure.
  const lines = normalizeMultilineText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sections: ParsedIssueSection[] = [];
  let currentHeading = 'Overview';
  let currentBody: string[] = [];

  const flush = () => {
    if (!currentBody.length && !sections.length) return;
    sections.push({
      heading: currentHeading,
      body: currentBody.join('\n').trim(),
    });
  };

  for (const line of lines) {
    const headingMatch =
      line.match(/^(?:\d+(?:\.\d+)?[\.)]?\s+)?(Background|Goals|Non-Goals|Feature Flag|Data Flow|Geometry Handling|UI Behavior|Acceptance Criteria|Requirements)\s*:?\s*$/i) ||
      line.match(/^(?:\d+(?:\.\d+)?[\.)]?\s+)(Run Analysis Payload|Save Config Payload|Multi-Dataset Payload)\s*$/i);

    if (headingMatch) {
      flush();
      currentHeading = normalizeInlineText(headingMatch[1]);
      currentBody = [];
      continue;
    }

    currentBody.push(line);
  }

  flush();
  return sections.filter((section) => section.body || section.heading !== 'Overview');
}

export function assessAcceptanceCriteriaQuality(criteria: ScopedItem[]): CriteriaQualityAssessment {
  // Gate deterministic extraction before synthesis; noisy fragments should not become canonical AC.
  if (!criteria.length) {
    return {
      quality: 'none',
      kept: [],
      discarded: [],
      weakSignals: ['No deterministic acceptance criteria were extracted.'],
    };
  }

  const kept: ScopedItem[] = [];
  const discarded: ScopedItem[] = [];
  const weakSignals: string[] = [];

  for (const criterion of criteria) {
    const text = normalizeInlineText(criterion.text);
    if (isFragmentaryCriterion(text)) {
      discarded.push({ ...criterion, text });
      continue;
    }
    if (!isFeTestableRequirement(text)) {
      discarded.push({ ...criterion, text });
      continue;
    }
    kept.push({ ...criterion, text });
  }

  if (!kept.length) {
    weakSignals.push('All extracted acceptance criteria were discarded as weak or fragmentary.');
  }
  if (discarded.length > 0) {
    weakSignals.push('Some extracted acceptance criteria were discarded as weak or fragmentary.');
  }
  if (kept.length > 0 && kept.length <= 2 && criteria.length >= 4) {
    weakSignals.push('Most extracted acceptance criteria were weak relative to the raw candidate set.');
  }
  if (kept.some((criterion) => criterion.text.length < 28)) {
    weakSignals.push('Deterministic acceptance criteria include unusually short requirement statements.');
  }

  return {
    quality: weakSignals.length ? 'weak' : 'strong',
    kept,
    discarded,
    weakSignals,
  };
}

function determineGranularityTarget(parsedSections: ParsedIssueSection[], description: string): GranularityTarget | null {
  const headings = new Set(
    (parsedSections || [])
      .map((section) => normalizeInlineText(section.heading).toLowerCase())
      .filter(Boolean)
  );
  const technicalSections = ['goals', 'feature flag', 'data flow', 'geometry handling', 'ui behavior'];
  const presentTechnicalSections = technicalSections.filter((heading) => headings.has(heading));
  const normalizedDescription = normalizeMultilineText(description).toLowerCase();
  const hasPayloadSubsections =
    headings.has('run analysis payload') ||
    headings.has('save config payload') ||
    headings.has('multi-dataset payload') ||
    /run analysis payload/.test(normalizedDescription) ||
    /save config payload/.test(normalizedDescription) ||
    /multi-dataset payload/.test(normalizedDescription);

  if (presentTechnicalSections.length >= 3 || (presentTechnicalSections.length >= 2 && hasPayloadSubsections)) {
    return {
      min: 5,
      max: 6,
      hint:
        'Use medium granularity. Prefer 5-6 canonical criteria for technical-design tickets. Keep selection and visibility behavior, geometry preservation, Run Analysis payload mapping, Save Config payload mapping with dataset linkage, feature-flag datasets[] versus legacy dataset behavior, and preview or map label behavior as separate criteria when they are present in the ticket.',
    };
  }

  return null;
}

function determineContextGranularityTarget(context: QaContext, parsedSections: ParsedIssueSection[], description: string): GranularityTarget | null {
  // Some ticket shapes need medium granularity to avoid one broad AC hiding several testable behaviors.
  const technicalTarget = determineGranularityTarget(parsedSections, description);
  if (technicalTarget) return technicalTarget;

  const prdScopedThinTicket =
    context.acceptanceCriteriaSource === 'parent_story_confluence_section' &&
    context.acceptanceCriteriaDiagnostics.thinTicketFallbackUsed;

  if (prdScopedThinTicket) {
    return {
      min: 4,
      max: 6,
      hint:
        'Use medium granularity for thin-ticket PRD subsection fallback. Cover each distinct behavior in the matched subsection. When present, keep entry-point availability, variant framing, output narrative style, content sections, risk or warning information, recommendations or takeaways, and single-item versus comparative behavior as separate criteria.',
    };
  }

  return null;
}

function splitCompoundCriterion(text: string): string[] {
  const normalized = normalizeInlineText(text);
  if (!normalized) return [];

  const labelStarts =
    '(?:Availability|Entry-point availability|Variant framing|Narrative style|Output narrative|Content sections?|General Summary|Risk warnings?|Warning information|Recommendations?|Takeaways?|Strategic Takeaways|Single-item framing|Comparative framing|Single-item versus comparative framing)';
  const splitters = [
    new RegExp(`\\s+(?=${labelStarts}\\s*:)`, 'gi'),
    /;\s+(?=(?:Run Analysis|Save Config|When|The|Strategic|General|Landmark|Environment|No-score|Single-area|Availability|Narrative|Risk|Recommendations|Takeaways)\b)/g,
    /\.\s+(?=(?:Run Analysis|Save Config|When|The|Strategic|General|Landmark|Environment|No-score|Single-area|Availability|Narrative|Risk|Recommendations|Takeaways)\b)/g,
  ];

  let pieces = [normalized];
  for (const splitter of splitters) {
    pieces = pieces.flatMap((piece) => piece.split(splitter).map((part) => normalizeInlineText(part)).filter(Boolean));
  }

  const independentPieces = pieces.filter((piece) => piece.length >= 45 && isFeTestableRequirement(piece));
  return independentPieces.length >= 2 ? independentPieces : [normalized];
}

function repairOverMergedCriteria(criteria: ScopedItem[], target: GranularityTarget | null): ScopedItem[] {
  if (!target || criteria.length >= target.min) return criteria;

  const expanded: Array<{ text: string; source?: string }> = [];
  for (const criterion of criteria) {
    const pieces = splitCompoundCriterion(criterion.text);
    for (const piece of pieces) {
      expanded.push({ text: piece, source: criterion.source });
    }
  }

  const repaired = dedupeCriteria(expanded);
  if (repaired.length > criteria.length && repaired.length <= target.max + 2) return repaired;
  return criteria;
}

function mergeConfidenceReasons(context: QaContext, synthesisUsed: boolean, synthesisReason: string): string[] {
  const existing = (context.confidenceReasons || []).filter((reason) => {
    if (!synthesisUsed) return true;
    return !/main jira ticket contains explicit acceptance criteria/i.test(reason);
  });
  const merged = synthesisUsed ? [synthesisReason, ...existing] : existing;
  return Array.from(new Set(merged));
}

function tokenizeExcerptText(value: string): string[] {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s[\]_-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'must', 'when']).has(token));
}

function overlapExcerptTokens(criterionText: string, candidate: string): string[] {
  const criterionTokens = new Set(tokenizeExcerptText(criterionText));
  return Array.from(new Set(tokenizeExcerptText(candidate))).filter((token) => criterionTokens.has(token));
}

function trimExcerpt(value: string, maxLength = 200): string {
  const text = normalizeInlineText(value);
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const boundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('; '), slice.lastIndexOf(', '), slice.lastIndexOf(' '));
  const cut = boundary > maxLength * 0.6 ? slice.slice(0, boundary) : slice;
  return `${cut.trimEnd().replace(/[,;:]$/, '')}…`;
}

// Schema dumps, table/tree diagrams, and code-like lines are layout, not
// requirements — they must never be offered as evidence.
function isStructuralNoise(line: string): boolean {
  const text = String(line || '');
  if (!text.trim()) return true;
  if (/[├└│┌┐┘┤┬┴┼─←→↔↦]/.test(text)) return true;
  if (/\b(primary key|foreign key|unique id|nullable|varchar|integer|boolean|enum)\b/i.test(text)) return true;
  if (/\b[a-z][a-z0-9]*_(table|id|key|column|schema|flag)\b/i.test(text)) return true;
  const symbols = (text.match(/["'`/|<>{}()=]/g) || []).length;
  if (symbols >= 5) return true;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const compact = text.replace(/\s/g, '').length;
  if (compact > 0 && letters / compact < 0.55) return true;
  return false;
}

function splitAuthorityIntoExcerptCandidates(text: string): string[] {
  const normalized = normalizeMultilineText(text);
  if (!normalized) return [];

  const candidates: string[] = [];
  const lines = normalized
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (isStructuralNoise(line)) continue;
    const stripped = normalizeInlineText(line.replace(/^[-*•]\s*/, '').replace(/^\d+[\.)]\s*/, ''));
    if (!stripped || isStructuralNoise(stripped)) continue;
    candidates.push(stripped);
    // A long line may pack several requirements; offer each sentence on its own
    // so the most specific one can win, but never the whole joined paragraph.
    if (stripped.length > 120) {
      const sentences = stripped.split(/(?<=[.!?])\s+/).map((value) => normalizeInlineText(value)).filter(Boolean);
      for (const sentence of sentences) {
        if (sentence && !isStructuralNoise(sentence)) candidates.push(sentence);
      }
    }
  }

  return Array.from(new Set(candidates.map((value) => normalizeInlineText(value)).filter(Boolean)));
}

function withAnchor(url?: string, anchor?: string): string | undefined {
  const base = String(url || '').trim();
  const fragment = String(anchor || '').trim().replace(/^#/, '');
  if (!base) return undefined;
  if (!fragment) return base;
  return `${base.replace(/#.*$/, '')}#${fragment}`;
}

function resolveAuthorityExcerptSource(context: QaContext): { body: string; location: string; url?: string; kind: 'jira' | 'prd' | 'spec' } | null {
  switch (context.scopeAuthority.type) {
    case 'main_jira_description':
      return {
        body: context.mainIssue.description || context.mainIssue.renderedDescription || context.scopeAuthority.body || '',
        location: 'Main Jira',
        url: context.mainIssue.webUrl || undefined,
        kind: 'jira',
      };
    case 'main_jira_acceptance_criteria':
      return {
        body: context.mainIssue.description || context.mainIssue.renderedDescription || context.scopeAuthority.body || '',
        location: 'Main Jira',
        url: context.mainIssue.webUrl || undefined,
        kind: 'jira',
      };
    case 'matched_prd_subsection':
      return {
        body: context.scopeAuthority.body || '',
        location: context.scopeAuthority.title ? `PRD: ${context.scopeAuthority.title}` : 'PRD',
        url: withAnchor(context.scopeConfluenceSection?.url, context.scopeConfluenceSection?.anchor),
        kind: 'prd',
      };
    case 'broad_prd_section':
      return {
        body: context.scopeAuthority.body || '',
        location: context.scopeAuthority.title ? `PRD: ${context.scopeAuthority.title}` : 'PRD',
        url: withAnchor(context.scopeConfluenceSection?.url, context.scopeConfluenceSection?.anchor),
        kind: 'prd',
      };
    case 'parent_story_jira': {
      const parentIssue = context.scopeParentIssue as unknown as { description?: string; renderedDescription?: string; summary?: string; webUrl?: string } | null;
      return {
        body: parentIssue?.description || parentIssue?.renderedDescription || context.scopeAuthority.body || '',
        location: context.scopeParentIssue?.key ? `Parent Story Jira: ${context.scopeParentIssue.key}` : 'Parent Story Jira',
        url: parentIssue?.webUrl || undefined,
        kind: 'jira',
      };
    }
    default:
      return null;
  }
}

// Score by F1 of token overlap, not raw count: a long block is a token superset
// of any single line and would always win on raw overlap (the "schema dump"
// failure). F1 rewards a candidate that is both on-point (precision) and covers
// the criterion (recall), so the specific justifying line wins.
function scoreExcerptCandidate(criterionText: string, candidate: string): number {
  if (isStructuralNoise(candidate)) return 0;
  const criterionTokens = new Set(tokenizeExcerptText(criterionText));
  const candidateTokens = new Set(tokenizeExcerptText(candidate));
  if (!criterionTokens.size || !candidateTokens.size) return 0;

  let overlap = 0;
  for (const token of candidateTokens) {
    if (criterionTokens.has(token)) overlap += 1;
  }
  if (!overlap) return 0;

  const precision = overlap / candidateTokens.size;
  const recall = overlap / criterionTokens.size;
  let score = (2 * precision * recall) / (precision + recall);

  const criterionNormalized = canonicalize(criterionText);
  const candidateNormalized = canonicalize(candidate);
  if (criterionNormalized.includes(candidateNormalized) || candidateNormalized.includes(criterionNormalized)) {
    score = Math.min(1, score + 0.15);
  }

  const overlapTokens = overlapExcerptTokens(criterionText, candidate);
  if (candidateTokens.size <= 10 && overlapTokens.length >= 3) {
    score = Math.min(1, score + 0.08);
  }
  return score;
}

const EXCERPT_SCORE_GATE = 0.34;
const EXCERPT_SUPPORT_GATE = 0.2;
const EXCERPT_MULTI_COVERAGE_GATE = 0.4;
const MAX_SOURCE_EXCERPTS_PER_CRITERION = 3;

type ScoredExcerptCandidate = {
  candidate: string;
  score: number;
  overlapTokens: string[];
  verbatim: boolean;
};

function selectSourceExcerptMatches(
  criterionText: string,
  scoredCandidates: ScoredExcerptCandidate[],
  sharedCandidateCounts: Map<string, number>
): ScoredExcerptCandidate[] {
  const criterionTokens = new Set(tokenizeExcerptText(criterionText));
  if (!criterionTokens.size) return [];

  const viable = scoredCandidates.filter((entry) => entry.score >= EXCERPT_SUPPORT_GATE);
  if (!viable.length) return [];

  const selected: ScoredExcerptCandidate[] = [];
  const coveredTokens = new Set<string>();

  for (const entry of viable) {
    if (selected.length >= MAX_SOURCE_EXCERPTS_PER_CRITERION) break;
    if ((sharedCandidateCounts.get(entry.candidate) || 0) > 1) continue;
    const newOverlap = entry.overlapTokens.filter((token) => !coveredTokens.has(token));
    if (!newOverlap.length) continue;
    selected.push(entry);
    for (const token of newOverlap) coveredTokens.add(token);
    if (entry.score >= EXCERPT_SCORE_GATE) continue;
    const coverage = coveredTokens.size / criterionTokens.size;
    if (selected.length >= 2 && coverage >= EXCERPT_MULTI_COVERAGE_GATE) break;
  }

  if (!selected.length) return [];

  const hasStrongSingle = selected.some((entry) => entry.score >= EXCERPT_SCORE_GATE);
  const coverage = coveredTokens.size / criterionTokens.size;
  if (!hasStrongSingle && !(selected.length >= 2 && coverage >= EXCERPT_MULTI_COVERAGE_GATE)) {
    return [];
  }

  return selected;
}

type ExcerptSourceMeta = { location: string; url?: string; kind: 'jira' | 'prd' | 'spec' };

async function attachSourceExcerpts(
  criteria: ScopedItem[],
  context: QaContext,
  options: { logger?: Logger; llm?: LlmConfig; relevanceCheck?: ExcerptRelevanceCheck } = {}
): Promise<ScopedItem[]> {
  // Attach small source excerpts for traceability without letting generic boilerplate become evidence.
  const logger = options.logger;
  const authority = resolveAuthorityExcerptSource(context);
  if (!authority || !normalizeInlineText(authority.body)) {
    logger?.info('context.ac_excerpt_selection', {
      jiraKey: context.ticketKey,
      authority: context.scopeAuthority?.type || 'none',
      reason: 'no_authority_body',
      items: [],
    });
    return criteria;
  }

  // Search the scope authority AND the scoped parent PRD section. Synthesized ACs (e.g. behaviour
  // inferred for a terse backend ticket) often trace to the PRD even when the authority is the Jira
  // ticket — so include the PRD section as a second corpus. Authority candidates take priority on ties.
  const sources: Array<{ body: string } & ExcerptSourceMeta> = [authority];
  const section = context.scopeConfluenceSection;

  // BUG-03 step 2: a linked technical-specification page is a more precise source than the PRD
  // paraphrase, so add its body as an excerpt corpus ranked ABOVE the PRD section (earlier sources win
  // ties in candidate dedup). This labels spec-derived criteria with kind 'spec' and a "Spec: <title>"
  // location instead of the prd/jira mislabel the step-3 spike left behind.
  for (const page of context.confluencePages || []) {
    if (!isTechnicalSpecPage(page, section?.pageId)) continue;
    if (!normalizeInlineText(page.body || '')) continue;
    sources.push({
      body: page.body || '',
      location: page.title ? `Spec: ${page.title}` : 'Technical Specification',
      url: page.webUrl || undefined,
      kind: 'spec',
    });
  }

  if (section?.body && normalizeInlineText(section.body) && canonicalize(section.body) !== canonicalize(authority.body)) {
    const sectionTitle = section.matchedHeading || section.title || '';
    sources.push({
      body: section.body,
      location: sectionTitle ? `PRD: ${sectionTitle}` : 'PRD',
      url: withAnchor(section.url, section.anchor),
      kind: 'prd',
    });
  }

  const candidateSources = new Map<string, ExcerptSourceMeta>();
  const candidates: string[] = [];
  for (const source of sources) {
    for (const text of splitAuthorityIntoExcerptCandidates(source.body)) {
      if (candidateSources.has(text)) continue;
      candidateSources.set(text, { location: source.location, url: source.url, kind: source.kind });
      candidates.push(text);
    }
  }
  if (!candidates.length) {
    logger?.info('context.ac_excerpt_selection', {
      jiraKey: context.ticketKey,
      authority: authority.kind,
      reason: 'no_candidates',
      candidateCount: 0,
      items: [],
    });
    return criteria;
  }

  // Pass 1: rank all candidates per criterion.
  const ranked = criteria.map((criterion) =>
    candidates
      .map((candidate) => {
        const score = scoreExcerptCandidate(criterion.text, candidate);
        const overlapTokens = score > 0 ? overlapExcerptTokens(criterion.text, candidate) : [];
        const criterionNormalized = canonicalize(criterion.text);
        const candidateNormalized = canonicalize(candidate);
        const verbatim = Boolean(candidateNormalized && (criterionNormalized.includes(candidateNormalized) || candidateNormalized.includes(criterionNormalized)));
        return {
          candidate,
          score,
          overlapTokens,
          verbatim,
        } satisfies ScoredExcerptCandidate;
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.candidate.length - right.candidate.length)
  );

  // Pass 2: a line that looks useful for many criteria is still generic boilerplate.
  const sharedCandidateCounts = new Map<string, number>();
  for (const entries of ranked) {
    const topViable = entries.find((item) => item.score >= EXCERPT_SUPPORT_GATE);
    if (!topViable) continue;
    sharedCandidateCounts.set(topViable.candidate, (sharedCandidateCounts.get(topViable.candidate) || 0) + 1);
  }

  const trace: Array<{ id: string; score: number; reason: string; bestCandidate: string }> = [];

  const result: ScopedItem[] = criteria.map((criterion, index) => {
    const entries = ranked[index] || [];
    const best = entries[0];
    const selected = selectSourceExcerptMatches(criterion.text, entries, sharedCandidateCounts);
    let reason: 'attached' | 'below_gate' | 'deduped' | 'no_candidate';
    if (!best || best.score <= 0) reason = 'no_candidate';
    else if (selected.length) reason = 'attached';
    else if ((sharedCandidateCounts.get(best.candidate) || 0) > 1) reason = 'deduped';
    else reason = 'below_gate';

    trace.push({
      id: criterion.id,
      score: Number((best?.score || 0).toFixed(2)),
      reason,
      bestCandidate: best?.candidate ? trimExcerpt(best.candidate, 90) : '',
    });

    const weakFallback =
      !selected.length &&
      best &&
      best.score >= EXCERPT_SUPPORT_GATE &&
      (sharedCandidateCounts.get(best.candidate) || 0) <= 1
        ? [best]
        : [];

    if (!selected.length && !weakFallback.length) return criterion;

    const excerptMatches: NonNullable<ScopedItem['sourceExcerpts']> = (selected.length ? selected : weakFallback).map((entry) => {
      const source = candidateSources.get(entry.candidate) || { location: authority.location, url: authority.url, kind: authority.kind };
      return {
        text: trimExcerpt(entry.candidate),
        location: source.location,
        url: source.url,
        kind: source.kind,
        confidence: selected.length ? (entry.verbatim ? 'verbatim' : 'closest') : 'weak',
      };
    });
    const primary = excerptMatches[0];

    return {
      ...criterion,
      sourceExcerpts: excerptMatches,
      sourceExcerpt: primary?.text,
      sourceExcerptLocation: primary?.location,
      sourceExcerptUrl: primary?.url,
      sourceExcerptKind: primary?.kind,
      sourceExcerptConfidence: primary?.confidence,
    };
  });

  logger?.info('context.ac_excerpt_selection', {
    jiraKey: context.ticketKey,
    authority: authority.kind,
    candidateCount: candidates.length,
    gate: EXCERPT_SCORE_GATE,
    items: trace,
  });

  // F3: the deterministic pass above ranks by token overlap, which rewards topic overlap and lets a
  // same-topic / different-behavior line clear EXCERPT_SCORE_GATE as a "closest" excerpt. An explicit
  // check (tests) wins outright; otherwise the LLM gate runs only when opted in via EXCERPT_RELEVANCE_LLM.
  const relevanceCheck =
    options.relevanceCheck ||
    (options.llm && excerptRelevanceLlmEnabled()
      ? (input: ExcerptRelevanceInput) => isExcerptRelevant(options.llm as LlmConfig, input, logger)
      : undefined);
  if (!relevanceCheck) return result;

  return applyExcerptRelevanceGate(result, relevanceCheck, logger, context.ticketKey);
}

// F3: the LLM excerpt-relevance gate is opt-in — it adds a per-excerpt model call to every generation,
// so it only runs when EXCERPT_RELEVANCE_LLM is explicitly enabled. Off → the deterministic token-overlap
// scorer is the sole selector and behavior is unchanged.
function excerptRelevanceLlmEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.EXCERPT_RELEVANCE_LLM || '').trim());
}

const EXCERPT_RELEVANCE_CONCURRENCY = Math.max(1, Number(process.env.EXCERPT_RELEVANCE_LLM_CONCURRENCY || 4));

function withoutSourceExcerptFields(criterion: ScopedItem): ScopedItem {
  const next: ScopedItem = { ...criterion };
  delete next.sourceExcerpts;
  delete next.sourceExcerpt;
  delete next.sourceExcerptLocation;
  delete next.sourceExcerptUrl;
  delete next.sourceExcerptKind;
  delete next.sourceExcerptConfidence;
  return next;
}

/**
 * F3 semantic evidence gate. Re-checks each "closest" excerpt — one that cleared EXCERPT_SCORE_GATE on
 * token overlap but is NOT a verbatim containment match — through the relevance check, and drops the ones
 * that share the criterion's topic without stating its requirement. Deliberately scoped to "closest":
 * "verbatim" is already an exact textual match (nothing to second-guess) and the lower "weak" fallback
 * tier is a separate concern left untouched. Calls are concurrency-limited; a criterion whose every
 * excerpt fails the gate loses its excerpt entirely (no near-miss shown). Flag-free and additive — the
 * gate can only remove a same-topic mismatch, never add or alter an excerpt.
 */
async function applyExcerptRelevanceGate(
  result: ScopedItem[],
  relevanceCheck: ExcerptRelevanceCheck,
  logger: Logger | undefined,
  ticketKey: string
): Promise<ScopedItem[]> {
  const pairs: Array<{ criterionIndex: number; excerptIndex: number }> = [];
  result.forEach((criterion, criterionIndex) => {
    (criterion.sourceExcerpts || []).forEach((excerpt, excerptIndex) => {
      if (excerpt.confidence === 'closest') pairs.push({ criterionIndex, excerptIndex });
    });
  });
  if (!pairs.length) return result;

  const verdicts = await mapWithConcurrency(pairs, EXCERPT_RELEVANCE_CONCURRENCY, async (pair) => {
    const criterion = result[pair.criterionIndex];
    const excerpt = (criterion.sourceExcerpts || [])[pair.excerptIndex];
    const relevant = await relevanceCheck({ criterion: criterion.text, excerpt: excerpt.text });
    return { ...pair, relevant };
  });

  const dropped = new Set<string>();
  for (const verdict of verdicts) {
    if (!verdict.relevant) dropped.add(`${verdict.criterionIndex}:${verdict.excerptIndex}`);
  }
  logger?.info('context.ac_excerpt_relevance_gate', {
    jiraKey: ticketKey,
    checked: pairs.length,
    dropped: dropped.size,
  });
  if (!dropped.size) return result;

  return result.map((criterion, criterionIndex) => {
    const excerpts = criterion.sourceExcerpts;
    if (!excerpts || !excerpts.length) return criterion;
    const kept = excerpts.filter((_, excerptIndex) => !dropped.has(`${criterionIndex}:${excerptIndex}`));
    if (kept.length === excerpts.length) return criterion;
    // Every excerpt failed the gate → show no evidence rather than a same-topic near-miss.
    if (!kept.length) return withoutSourceExcerptFields(criterion);
    const primary = kept[0];
    return {
      ...criterion,
      sourceExcerpts: kept,
      sourceExcerpt: primary.text,
      sourceExcerptLocation: primary.location,
      sourceExcerptUrl: primary.url,
      sourceExcerptKind: primary.kind,
      sourceExcerptConfidence: primary.confidence,
    };
  });
}

// BUG-03: a linked technical-spec page is fetched into context (buildQaContext pulls Confluence links
// out of linked-issue descriptions) but would otherwise only be background — its concrete rules never
// becoming trackable criteria, so coverage reads green against PRD paraphrases. We surface spec-like
// pages to the synthesizer here; attachSourceExcerpts (step 2) then labels spec-derived criteria with
// the distinct 'spec' kind so their provenance is accurate, not mislabeled jira/prd.
const SPEC_EXCERPT_TOTAL_CAP = 9000;
const SPEC_EXCERPT_PER_PAGE_CAP = 6000;

function isTechnicalSpecPage(page: ConfluencePageSummary, scopePageId?: string): boolean {
  if (page.fetchError || !page.body) return false;
  if (scopePageId && page.id === scopePageId) return false; // already used as the PRD scope authority
  if (SPEC_PAGE_TITLE_RE.test(page.title || '')) return true;
  // A page fetched as an immediate child of a spec page (BUG-06 descendant expansion) inherits spec
  // treatment even when its own title doesn't say "specification".
  return (page.sourceRefs || []).some((ref) => ref.relationship === 'spec-descendant');
}

function collectTechnicalSpecExcerpts(context: QaContext): { text: string; pages: string[] } {
  const scopePageId = context.scopeConfluenceSection?.pageId;
  const specPages = (context.confluencePages || []).filter((page) => isTechnicalSpecPage(page, scopePageId));
  if (!specPages.length) return { text: '', pages: [] };
  const used: string[] = [];
  const blocks: string[] = [];
  let remaining = SPEC_EXCERPT_TOTAL_CAP;
  for (const page of specPages) {
    if (remaining <= 0) break;
    const body = normalizeMultilineText(page.body || '').slice(0, Math.min(SPEC_EXCERPT_PER_PAGE_CAP, remaining));
    if (!body) continue;
    blocks.push(`# ${page.title || 'Technical Specification'}\n${body}`);
    used.push(page.title || page.id);
    remaining -= body.length;
  }
  return { text: blocks.join('\n\n'), pages: used };
}

// Even with the scope-boundary directive, the spec's prominent "Login Isolation" capability leaks into
// synthesis as an active criterion run-to-run (temp 0 isn't fully deterministic). Deterministically drop
// login / authentication-session criteria when NO login/session endpoint is actually in the ticket's
// matched endpoints — that capability belongs to a different ticket. This is the "verify, don't trust the
// model" guard. It deliberately does NOT touch password-reset / activation / email-routing criteria:
// the detector requires an explicit login/authenticate verb AND partner-URL-isolation framing, which the
// password/email criteria don't carry.
const LOGIN_VERB_RE = /\b(log[\s-]?in|login|sign[\s-]?in|authenticat\w*)\b/i;
const LOGIN_URL_ISOLATION_RE = /(partner url|partner subdomain|general li url|only through (their )?partner|log[\s-]?in only|authenticate (only )?via|url guard|url isolation)/i;

function scopeHasLoginEndpoint(matchedEndpoints: Array<{ path?: string }>): boolean {
  return matchedEndpoints.some((endpoint) =>
    /(\blogin\b|sign[-_]?in|issue[-_]?token|auth\/(login|token|session)|\/sessions?\b)/i.test(String(endpoint.path || ''))
  );
}

function isLoginSessionIsolationCriterion(text: string): boolean {
  const value = normalizeInlineText(text);
  if (!LOGIN_VERB_RE.test(value)) return false;
  return LOGIN_URL_ISOLATION_RE.test(value);
}

function dropOutOfScopeLoginCriteria(
  criteria: ScopedItem[],
  matchedEndpoints: Array<{ path?: string }>,
  logger: Logger | undefined,
  ticketKey: string
): ScopedItem[] {
  if (scopeHasLoginEndpoint(matchedEndpoints)) return criteria; // login genuinely in scope — keep
  const kept = criteria.filter((criterion) => !isLoginSessionIsolationCriterion(criterion.text));
  const droppedCount = criteria.length - kept.length;
  if (droppedCount) {
    logger?.info('context.ac_out_of_scope_dropped', {
      jiraKey: ticketKey,
      reason: 'login_session_isolation_no_endpoint_in_scope',
      droppedCount,
      dropped: criteria.filter((criterion) => isLoginSessionIsolationCriterion(criterion.text)).map((c) => c.text).slice(0, 5),
    });
  }
  return kept.length ? kept : criteria; // never drop the entire set
}

// Ultra-common UI/spec nouns that would create spurious "shared subject" matches between unrelated
// statements. The polarity terms themselves are excluded separately. Distinctive domain words
// (radius, dataset, polygon, address, …) are deliberately NOT here — they are what makes a shared
// subject meaningful.
const CONFLICT_SUBJECT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'via', 'only', 'not', 'be', 'is', 'are', 'was', 'were',
  'that', 'this', 'these', 'those', 'when', 'then', 'if', 'given', 'should', 'must', 'shall', 'will', 'can', 'cannot', 'its',
  'from', 'into', 'per', 'also', 'may', 'as', 'at', 'by', 'it', 'they', 'their', 'has', 'have', 'but',
  'button', 'field', 'page', 'user', 'users', 'value', 'values', 'system', 'form', 'screen', 'section', 'input', 'option',
  'options', 'state', 'feature', 'flag', 'data', 'default', 'text', 'label', 'click', 'clicks', 'select', 'selects',
]);

const POLARITY_TERM_AXIS = (() => {
  const map = new Map<string, { axis: string; sign: 'positive' | 'negative' }>();
  for (const { axis, positive, negative } of POLARITY_AXES) {
    for (const term of positive) map.set(term, { axis, sign: 'positive' });
    for (const term of negative) map.set(term, { axis, sign: 'negative' });
  }
  return map;
})();

/** First polarity term in a clause and its sign, flipping on a nearby (≤3 tokens back) negation cue. */
function clausePolarity(text: string): { axis: string; sign: 'positive' | 'negative'; term: string } | null {
  const tokens = String(text || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const hit = POLARITY_TERM_AXIS.get(tokens[i]);
    if (!hit) continue;
    const negated = tokens.slice(Math.max(0, i - 3), i).some((token) => NEGATION_CUES.has(token));
    const sign = negated ? (hit.sign === 'positive' ? 'negative' : 'positive') : hit.sign;
    return { axis: hit.axis, sign, term: tokens[i] };
  }
  return null;
}

function conflictSubjectTokens(text: string, polarityTerm: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && token !== polarityTerm && !CONFLICT_SUBJECT_STOPWORDS.has(token))
  );
}

function splitSourceSentences(text: string): string[] {
  return String(text || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Deterministic cross-source conflict scan (F1). Flags a synthesized criterion when a source line
 * describes the same subject (≥1 shared distinctive token) but resolves to the OPPOSITE sign on the
 * SAME polarity axis. Flag-only — never removes a criterion; opposite requirements are for a human to
 * adjudicate (a Jira AC may intentionally supersede a stale PRD). One conflict per criterion is enough
 * to surface for review, so we stop at the first match per criterion.
 */
export function detectCrossSourceConflicts(
  criteria: ScopedItem[],
  corpora: Array<{ source: 'jira' | 'prd' | 'spec'; text: string }>,
  logger?: Logger,
  ticketKey = ''
): CrossSourceConflict[] {
  const corpusLines = corpora.flatMap(({ source, text }) =>
    splitSourceSentences(text)
      .map((line) => ({ source, line, polarity: clausePolarity(line) }))
      .filter((entry): entry is { source: 'jira' | 'prd' | 'spec'; line: string; polarity: NonNullable<ReturnType<typeof clausePolarity>> } =>
        entry.line.length >= 12 && entry.polarity !== null
      )
  );
  const conflicts: CrossSourceConflict[] = [];
  for (const criterion of criteria) {
    const criterionPolarity = clausePolarity(criterion.text);
    if (!criterionPolarity) continue;
    const criterionSubjects = conflictSubjectTokens(criterion.text, criterionPolarity.term);
    if (!criterionSubjects.size) continue;
    for (const entry of corpusLines) {
      if (entry.polarity.axis !== criterionPolarity.axis || entry.polarity.sign === criterionPolarity.sign) continue;
      const lineSubjects = conflictSubjectTokens(entry.line, entry.polarity.term);
      const shared = [...criterionSubjects].filter((token) => lineSubjects.has(token));
      if (!shared.length) continue;
      conflicts.push({
        criterionId: criterion.id,
        criterionText: criterion.text,
        axis: criterionPolarity.axis,
        criterionSign: criterionPolarity.sign,
        conflictingSource: entry.source,
        conflictingExcerpt: trimExcerpt(entry.line, 200),
        sharedSubjects: shared.slice(0, 5),
      });
      break;
    }
  }
  if (conflicts.length) {
    logger?.info('context.ac_cross_source_conflicts', {
      jiraKey: ticketKey,
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 5).map((conflict) => ({
        criterionId: conflict.criterionId,
        axis: conflict.axis,
        source: conflict.conflictingSource,
        shared: conflict.sharedSubjects,
      })),
    });
  }
  return conflicts;
}

export async function finalizeAcceptanceCriteria(
  context: QaContext,
  options: AcceptanceCriteriaFinalizationOptions = {}
): Promise<QaContext> {
  // Finalization is the last chance to dedupe, repair granularity, synthesize weak AC, and attach traceability.
  const quality = assessAcceptanceCriteriaQuality(context.acceptanceCriteria || []);
  const mainIssueBody = context.mainIssue.description || context.mainIssue.renderedDescription || '';
  const parsedSections = parseMainIssueSections(mainIssueBody);
  const specExcerpts = collectTechnicalSpecExcerpts(context);
  if (specExcerpts.pages.length) {
    options.logger?.info('context.ac_spec_grounding', {
      jiraKey: context.ticketKey,
      specPages: specExcerpts.pages,
      excerptChars: specExcerpts.text.length,
    });
  }

  // When a technical spec grounds the criteria, an API / main_jira ticket otherwise has NO granularity
  // target (the deterministic targets only fire for FE design headings or thin-PRD fallback), so
  // synthesis defaults to "concise" and collapses the spec's distinct rules back into a few clauses.
  // Push toward one criterion per concrete spec rule instead.
  let granularityTarget = determineContextGranularityTarget(context, parsedSections, mainIssueBody);
  if (!granularityTarget && specExcerpts.pages.length) {
    granularityTarget = {
      min: 5,
      max: 9,
      hint:
        'A technical specification grounds these criteria. Produce one distinct criterion per concrete spec rule for the in-scope endpoints/behaviors — keep point-in-time vs per-call access checks, per-endpoint or per-RPC enforcement, exact filter semantics, backward-compatibility or null-value edges, and transactional email/URL routing as separate criteria. Do not merge distinct rules into one broad clause.',
    };
  }

  let finalCriteria = dedupeCriteria(quality.kept.map((criterion) => ({ text: criterion.text, source: criterion.source })));
  let synthesisUsed = false;
  let synthesisReason = quality.quality === 'strong'
    ? 'Deterministic acceptance criteria were preserved after canonical normalization.'
    : 'Deterministic acceptance criteria were weak, so the final set fell back to deterministic quality-gated output.';

  if (options.synthesizer) {
    try {
      const synthesis = await options.synthesizer({
        ticketKey: context.ticketKey,
        mainIssueSummary: context.mainIssue.summary || '',
        mainIssueDescription: normalizeMultilineText(context.mainIssue.description || context.mainIssue.renderedDescription || ''),
        parsedSections,
        rawSelectedAcceptanceCriteria: quality.kept,
        acceptanceCriteriaSource: context.acceptanceCriteriaSource,
        parentStorySummary: context.scopeParentIssue?.summary || '',
        prdSectionTitle:
          context.scopeAuthority.type === 'matched_prd_subsection' || context.scopeAuthority.type === 'broad_prd_section'
            ? context.scopeAuthority.title
            : context.scopeConfluenceSection?.matchedHeading || context.scopeConfluenceSection?.title || context.scopeParentIssue?.summary || '',
        prdSectionBody:
          context.scopeAuthority.type === 'matched_prd_subsection' || context.scopeAuthority.type === 'broad_prd_section'
            ? context.scopeAuthority.body
            : context.scopeConfluenceSection?.body || '',
        thinTicketFallbackUsed: context.acceptanceCriteriaDiagnostics.thinTicketFallbackUsed || false,
        prdSubsectionMatchQuality: context.acceptanceCriteriaDiagnostics.prdSubsectionMatchQuality || 'none',
        actualDevScopeGuidance: context.actualDevScopeGuidance,
        targetMinCriteria: granularityTarget?.min,
        targetMaxCriteria: granularityTarget?.max,
        granularityHint: granularityTarget?.hint,
        technicalSpecExcerpts: specExcerpts.text,
        scopeBoundary: (context.apiContract?.matchedEndpoints || [])
          .map((endpoint) => `${String(endpoint.method || '').toUpperCase()} ${endpoint.path || ''}`.trim())
          .filter(Boolean)
          .join(', '),
      });
      const synthesized = dedupeCriteria(
        (synthesis.acceptanceCriteria || []).map((criterion) => ({
          text: criterion.text,
          source: context.acceptanceCriteriaSource === 'main_jira' ? `${context.ticketKey} synthesized` : `${context.acceptanceCriteriaSource} synthesized`,
        }))
      );
      if (synthesized.length) {
        finalCriteria = repairOverMergedCriteria(synthesized, granularityTarget);
        synthesisUsed = true;
        synthesisReason =
          quality.quality === 'strong'
            ? 'Acceptance criteria were normalized through LLM-assisted canonical synthesis.'
            : 'Acceptance criteria were synthesized from structured technical design because deterministic extraction was weak.';
      }
    } catch (error) {
      options.logger?.warn('context.ac_synthesis_failed', {
        jiraKey: context.ticketKey,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  finalCriteria = repairOverMergedCriteria(finalCriteria, granularityTarget);
  // Spec-grounded tickets can pull the spec's broader capabilities (e.g. login isolation) into the
  // criteria even when out of this ticket's endpoint scope — drop those deterministically.
  if (specExcerpts.pages.length) {
    finalCriteria = dropOutOfScopeLoginCriteria(
      finalCriteria,
      context.apiContract?.matchedEndpoints || [],
      options.logger,
      context.ticketKey
    );
  }
  finalCriteria = await attachSourceExcerpts(finalCriteria, context, {
    logger: options.logger,
    llm: options.llm,
    relevanceCheck: options.excerptRelevanceCheck,
  });

  // Cross-source conflict scan (F1): compare the finalized criteria against the same Jira / PRD / spec
  // corpora the synthesizer saw, and flag opposite-polarity contradictions for human adjudication.
  const prdBody =
    context.scopeAuthority.type === 'matched_prd_subsection' || context.scopeAuthority.type === 'broad_prd_section'
      ? context.scopeAuthority.body
      : context.scopeConfluenceSection?.body || '';
  const crossSourceConflicts = detectCrossSourceConflicts(
    finalCriteria,
    [
      { source: 'jira' as const, text: normalizeMultilineText(mainIssueBody) },
      { source: 'prd' as const, text: normalizeMultilineText(prdBody) },
      { source: 'spec' as const, text: specExcerpts.text },
    ].filter((corpus) => corpus.text.trim().length > 0),
    options.logger,
    context.ticketKey
  );

  return {
    ...context,
    acceptanceCriteria: finalCriteria,
    confidenceReasons: mergeConfidenceReasons(context, synthesisUsed, synthesisReason),
    acceptanceCriteriaDiagnostics: {
      ...context.acceptanceCriteriaDiagnostics,
      selectedAcceptanceCriteriaReason: synthesisUsed
        ? synthesisReason
        : context.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaReason,
      synthesisUsed,
      synthesisReason,
      rawAcceptanceCriteriaQuality: quality.quality,
      rawAcceptanceCriteriaWeakSignals: quality.weakSignals,
      discardedFragmentCount: quality.discarded.length,
      discardedFragmentExamples: quality.discarded.slice(0, 5).map((criterion) => criterion.text),
      crossSourceConflicts,
    },
  };
}
