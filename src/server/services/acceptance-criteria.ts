import type {
  AcceptanceCriteriaExecutionPlanItem,
  ConfluencePageSummary,
  CrossSourceConflict,
  DirectRequirementTrace,
  QaContext,
  ScopedItem,
} from '../../shared/contracts';
import type { Logger } from './logger';
import { canonicalize } from './context-builder';
import { NEGATION_CUES, POLARITY_AXES, SPEC_PAGE_TITLE_RE } from './keywords';
import { isExcerptRelevant } from './llm';
import type { ExcerptRelevanceInput, LlmConfig } from './llm';
import { mapWithConcurrency } from './ttl-cache';
import { endpointIsDocumented } from './validation';

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
  /** Optional QA-supplied design links; URLs are context only and never treated as verified requirements. */
  figmaReferences?: string[];
  targetMinCriteria?: number;
  targetMaxCriteria?: number;
  granularityHint?: string;
  // BUG-03 step 3 (spike): concrete rules from a linked technical-specification page, surfaced so the
  // synthesizer can ground criteria in implementation detail (point-in-time semantics, per-endpoint
  // enforcement, backward-compat edges) instead of PRD paraphrases. Empty when no spec page is linked.
  technicalSpecExcerpts?: string;
  /** Atomic direct rules collected from Jira, the scoped PRD, and linked technical specs. */
  directRequirements?: Array<Pick<DirectRequirementTrace, 'id' | 'text' | 'sourceKind' | 'sourceLocation' | 'workedExamples'>>;
  /**
   * Concrete source examples are grounding, not a completeness checklist. They remain available when
   * an abnormal inventory forces directRequirements to be withheld from synthesis.
   */
  groundingExamples?: Array<Pick<DirectRequirementTrace, 'id' | 'text' | 'sourceKind' | 'sourceLocation' | 'workedExamples'>>;
  /** Final criteria already accepted before a focused omission-repair call. */
  existingCriteria?: Array<Pick<ScopedItem, 'id' | 'text'>>;
  /** When true, return only criteria that cover directRequirements supplied for this repair call. */
  repairOnlyMissingRequirements?: boolean;
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
  // Optional latency lever. Keep this off for quality-first runs: noisy deterministic AC must be
  // synthesized, and "strong" is intentionally conservative after the implementation-fragment checks below.
  skipStrongLlmSynthesis?: boolean;
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

const HTML_TAG_NAME_RE = /^(?:a|br|code|div|em|h[1-6]|li|ol|p|pre|span|strong|table|tbody|td|th|thead|tr|ul)$/i;
const TEMPLATE_PLACEHOLDER_SIGNAL_RE = /(?:name|value|percentage|percent|coverage|path|hierarchy|id|field|column|attribute)/i;

function stripMarkupPreservingTemplatePlaceholders(value: unknown): string {
  const placeholders: string[] = [];
  const protectedValue = String(value || '').replace(/<([^<>]{2,80})>/g, (match, rawInner: string) => {
    const inner = String(rawInner || '').trim();
    const tagName = inner.replace(/^\//, '').split(/\s+/)[0];
    if (
      !inner ||
      inner.startsWith('/') ||
      /[=/]/.test(inner) ||
      HTML_TAG_NAME_RE.test(tagName) ||
      !TEMPLATE_PLACEHOLDER_SIGNAL_RE.test(inner)
    ) {
      return match;
    }
    const index = placeholders.push(`<${inner}>`) - 1;
    return `__QA_TEMPLATE_PLACEHOLDER_${index}__`;
  });
  return protectedValue.replace(/<[^>]+>/g, ' ').replace(/__QA_TEMPLATE_PLACEHOLDER_(\d+)__/g, (_, index: string) => placeholders[Number(index)] || '');
}

function normalizeInlineText(value: unknown): string {
  return stripMarkupPreservingTemplatePlaceholders(value)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeMultilineText(value: unknown): string {
  const withBreaks = String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/<(?:br|br\/)\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '');
  return stripMarkupPreservingTemplatePlaceholders(withBreaks)
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
  return /(should|must|required|display|shown|hidden|enable|enabled|disable|disabled|render|save|open|select|preserve|payload|dataset|polygon|multipolygon|location|marker|label|popup|traceable|mapped|fallback|gate|prevent|allow|include|exclude|sync|summary|narrative|score|scoring|risk|takeaways|tab|characteristics|signals|zone|api|endpoint|schema|validation|response|request|post|put|get|patch|delete|database|db|migration|backfill|dataset_schema|is_dimension|is_measure)/i.test(
    text
  );
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length || 0;
}

function hasClearExpectedBehaviorSignal(text: string): boolean {
  return /\b(should|shall|must|required|require|when|if|then|ensure|verify|validate|validated|validation|prevent|allow|reject|accept|access|default|preserve|fallback|remain|unchanged|include|return|available|display|displays|shown|hidden|enable|enabled|disable|disabled|render|save|open|select|support|build|create|use|compute|calculate|add|rename|expose|surface|surfaces|gain|gains|map|maps|mapped|traceable|consistent|relies|occurs|follow|follows)\b/i.test(
    text
  );
}

function isNoisyImplementationCriterion(criterion: ScopedItem, text: string): boolean {
  const normalized = normalizeInlineText(text);
  const lower = normalized.toLowerCase();
  const source = String(criterion.source || '').toLowerCase();

  if (!normalized) return true;
  if (normalized.length > 520) return true;
  if (/rendered description/.test(source) && (normalized.length > 220 || /&(?:amp|lt|gt);|implementation\s*\(/i.test(normalized))) {
    return true;
  }

  const sqlKeywordCount = countMatches(
    lower,
    /\b(create|alter|drop|select|insert|update|delete|index|constraint|foreign key|unique index|on conflict|where|include)\b/g
  );
  if (sqlKeywordCount >= 3 && /(?:;|\bddl\b|\bmigration\b|\bpartial\b|\bwhere\b)/i.test(normalized)) return true;

  const sampleNumberCount = countMatches(normalized, /\b\d+(?:[.,]\d+)?%?\b/g);
  if (
    sampleNumberCount >= 6 &&
    /\b(expected output|assumptions?|table|rises|weight=|catchment|dataset after analysis|spatial analysis result)\b/i.test(normalized)
  ) {
    return true;
  }
  if (/^\d+(?:\.\d+)?\s*[x×*]\s*[\d,]+/.test(normalized)) return true;

  const codeTokenCount = countMatches(
    normalized,
    /(?:[A-Za-z0-9_/-]+\.(?:go|proto|sql|tsx?|jsx?)|[A-Za-z0-9_/-]+\/[A-Za-z0-9_/-]+|[A-Za-z][A-Za-z0-9_]*\([^)]*\)|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*|[A-Za-z]+\.[A-Za-z]+)/g
  );
  if (
    codeTokenCount >= 4 &&
    /\b(regenerate|publish|vendor|processor\.go|handler\.go|analysis\.go|message output|internal\/|db\/migration)\b/i.test(normalized)
  ) {
    return true;
  }

  if (!hasClearExpectedBehaviorSignal(normalized)) return true;

  return false;
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
    if (isNoisyImplementationCriterion(criterion, text)) {
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
  if (discarded.some((criterion) => /create|index|expected output|assumptions?|\.go|\.proto|db\/migration|rendered description|implementation\s*\(/i.test(`${criterion.text} ${criterion.source || ''}`))) {
    weakSignals.push('Some extracted acceptance criteria were noisy implementation fragments and require synthesis.');
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

  const explicitlyDelegatesToMatchedPrd =
    Boolean(context.scopeConfluenceSection?.matched && context.scopeConfluenceSection?.body) &&
    /\b(?:see|refer(?:ence)?|refer)\s+(?:to\s+)?(?:the\s+)?(?:us|user\s+story|prd|requirements?)\b/i.test(
      normalizeMultilineText(description)
    );
  if (explicitlyDelegatesToMatchedPrd) {
    return {
      min: 4,
      max: 6,
      hint:
        'The main Jira explicitly delegates requirement detail to the matched PRD or user-story subsection. Keep the Jira endpoint and payload shape as the hard scope boundary, but include each independently testable behavior from the referenced subsection that directly describes that scoped output, including value content, multi-value behavior, and null or unavailable-data behavior when present. Exclude later addenda or UI-only changes that replace or contradict the Jira payload contract.',
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
  return (page.sourceRefs || []).some(
    (ref) => ref.relationship === 'spec-descendant' || SPEC_PAGE_TITLE_RE.test(ref.relationship || '')
  );
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

const DIRECT_REQUIREMENT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'when', 'then', 'must', 'should', 'shall', 'will',
  'into', 'through', 'where', 'which', 'have', 'has', 'are', 'is', 'be', 'a', 'an', 'of', 'to', 'in', 'on', 'or', 'by', 'as',
  'result', 'results', 'analysis', 'data', 'value', 'values', 'field', 'fields', 'system', 'service', 'feature', 'ticket',
]);
const CLARIFICATION_REQUIREMENT_RE = /\b(?:tbd|todo|open question|not defined|undefined|to be decided|needs? clarification|unclear|not specified|pending decision)\b/i;
const OUT_OF_SCOPE_REQUIREMENT_RE = /\b(?:out of scope|non-goal|not in scope|deferred|future work|will not|do not implement)\b/i;

function directRequirementTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const rawToken of String(value || '').toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []) {
    if (DIRECT_REQUIREMENT_STOPWORDS.has(rawToken)) continue;
    const token = rawToken
      .replace(/(?:ed|ing)$/, (suffix) => (rawToken.length - suffix.length >= 5 ? '' : suffix))
      .replace(/ies$/, 'y')
      .replace(/s$/, (suffix) => (rawToken.length >= 6 ? '' : suffix));
    tokens.add(token);
    if (rawToken === 'coverage_pct') {
      tokens.add('coverage');
      tokens.add('percentage');
    }
  }
  return tokens;
}

function requirementWorkedExamples(value: string): string[] {
  const examples = new Set<string>();
  const source = String(value || '');
  // Keep complete templates/examples ahead of isolated entities. This is what lets a compacted prompt
  // retain `Name (X.XX% coverage)` and a concrete PRD example rather than only a place-name fragment.
  const patterns = [
    /[`"“]([^`"”]{2,160})[`"”]/g,
    /(?:\bName|\b[A-Z][A-Za-z0-9,' -]{2,120})\s*\(\s*(?:X(?:\.X+)?|\d+(?:[.,]\d+)?)%\s*coverage\s*\)/g,
    /\b(?:X(?:\.X+)?|\d+(?:[.,]\d+)?)%\s*coverage\b/gi,
    /\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){1,3}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const example = String(match[1] || match[0] || '').trim().replace(/[,:;]$/, '');
      if (example && example.length <= 160) examples.add(example);
    }
  }
  return [...examples].slice(0, 8);
}

// A normative obligation the implementation must satisfy. Used to protect genuine requirements from the
// structural-exclusion heuristics below (a line that states an obligation is never a heading/background).
const NORMATIVE_MODAL_RE = /\b(?:must|shall|should|is required|are required|needs? to|has to|have to|when\b[\s\S]*\bthen\b|if\b[\s\S]*\bthen\b)\b/i;

// Behavior/obligation verbs that mark a requirement even without a modal (declarative spec rules like
// "results are sorted by coverage_pct"). Deliberately verbs/observable-behavior only — NOT bare nouns
// like schema/table/column, whose presence previously let pure DDL and architecture prose through.
const DIRECT_REQUIREMENT_BEHAVIOR_RE =
  /\b(?:adds?|gains?|contains?|sort(?:ed)?|ordered|limited to|top\s+two|displays?|displayed|excludes?|persists?|persisted|stored|streamed|exported|returns?|includes?|renamed?|falls?\s?back|defaults?\s+to|remains?\s+unchanged|exposed?|surfaced?)\b/i;

const DIRECT_CONTRACT_SURFACE_RE =
  /\b(?:requests?|responses?|payloads?|results?|outputs?|fields?|columns?|attributes?|tables?|info\s+panels?|datasets?|exports?|exported|downloads?|streams?|streamed|schema|queryable|agent|mcp|feature\s+flags?|latency|performance|null(?:able)?|coverage(?:_pct)?|percentage|administrative\s+areas?|mapping|intersection|overlap|compatib\w*)\b/i;
const DIRECT_CONTRACT_RULE_RE =
  /\b(?:format|full\s+(?:hierarchy\s+)?path|top[-\s]?(?:2|two)|descending|exactly\s+one|only\s+one|no\s+(?:mapping|intersection)|outside\s+supported|never\s+(?:blocks?|sees)|does\s+not\s+block|clamp(?:ed)?|default\s+off|opt[-\s]?in|unchanged|same\s+as|consistent\s+with|exclude\w*|omit\w*|nullable|native\s+(?:bson\s+)?string)\b/i;
const CALCULATION_CONTRACT_RE =
  /\b(?:coverage_pct|coverage\s+percentage|numerator|denominator|intersection\s+area|relative\s+to|planar\s+area|clamp(?:ed)?\s+to\s+\[?0\s*,\s*100\]?|contains?\s+(?:means|implies|returns?)\s+100)\b/i;
const INTERNAL_IMPLEMENTATION_RE =
  /\b(?:processDatasetsStream|GeometryRows|buildRTreeFromGrids|traverseGridsWithRTree|scoringRows|R-Tree|BulkLoad|saveScoringDatasetBatches|saveBatchRows|ToRawDataset|convertToMongoDBType|BuildDatasetSchema|addProportionColumn|writeExportAnalyticsRows|ConvertDefinedTypeToString|convertString|simplefeatures|GetAreaSizeM2|boundary_p\d+|AdmLevelStepUpThreshold|OutputType|running\s+bbox|server-side\s+cursor|second\s+index|per-row\s+SQL|VALUES\s+JOIN)\b|\bfloor\s*\(|\blen\s*\(/gi;

function internalImplementationTokenCount(text: string): number {
  return text.match(INTERNAL_IMPLEMENTATION_RE)?.length || 0;
}

// Structural / non-normative source lines that must never become a "requirement": diagram syntax, SQL/DDL
// fragments, background/rationale framing, performance assumptions, and section headings. This is the
// precision filter that stops a 12-requirement ticket's spec from inflating into ~100 "requirements".
function isNonRequirementLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Mermaid / diagram syntax and arrows.
  if (/^(?:sequencediagram|classdiagram|erdiagram|flowchart|graph\s+(?:td|lr|rl|bt)|participant\b|subgraph\b|state\b)/i.test(t)) return true;
  if (/(?:--?>>?|==>|-\.->|\|>|:::)/.test(t)) return true;
  // SQL / DDL fragments.
  if (/^(?:create|alter|drop|select|insert|update|delete|with|join|where|from|on|index|constraint|foreign\s+key|primary\s+key|unique)\b/i.test(t)) return true;
  if (/^\)?\s*(?:as\s+\w+|if\s+len\s*\(|for\s+\w+\s*:=|return\s+\w+)\b/i.test(t)) return true;
  if (/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\s*=/i.test(t)) return true;
  if (/^[a-z][a-z0-9_]*\s*\[[^\]]+\]\s*=/i.test(t)) return true;
  if (/\b(?:varchar|integer|bigint|boolean|timestamptz|uuid|double\s+precision|not\s+null|serial|jsonb)\b/i.test(t) && /[(),;]/.test(t) && !NORMATIVE_MODAL_RE.test(t)) return true;
  // Background / rationale / framing intros.
  if (/^(?:background|context|problem(?:\s+statement)?|rationale|motivation|overview|goals?|non-?goals?|assumptions?|notes?|summary|introduction|glossary|terminology|appendix|references?)\b\s*[:.\-—]?/i.test(t)) return true;
  if (/^(?:e\.g\.|i\.e\.|for example|for instance)\b/i.test(t)) return true;
  if (/^(?:this document|previous\s*ly|currently|today\b|users? can only|this makes it difficult|a spatial-analysis result has no\b|the value is already\b|so in the \w+\.data document\b)/i.test(t)) return true;
  if (/^geometry\./i.test(t)) return true;
  if (/^(?:feed|route|pass|wire)\s+(?:the\s+)?(?:accumulator|rows?|values?)\b[\s\S]*\b(?:writer|pipeline|handler|processor)\b/i.test(t)) return true;
  if (/\b(?:model\.AdmAreaIntersection|fmt\.Sprintf|finalize step)\b/i.test(t) && !NORMATIVE_MODAL_RE.test(t)) return true;
  if (/\bRangeSearch\b[\s\S]*\b(?:candidate cells?|accumulator)\b/i.test(t) && !NORMATIVE_MODAL_RE.test(t)) return true;
  if (/^(?:adaptive step|shortcut\b|pick\s+[A-Z]\b|the robust\b|one\s+O\(|same rule\s+[—-]|doing it here|each occupied tile|the flowchart|the pass branches|we use a plain degree grid)\b/i.test(t)) return true;
  if (/\(\s*(?:e\.g\.)?\s*$|\b(?:e\.g\.|for example)\s*$|^true\s*\(/i.test(t)) return true;
  if (/^(?:mcp|approach|how it is persisted|persistence|storage|algorithm)\s*[—:\-]/i.test(t) && !NORMATIVE_MODAL_RE.test(t)) return true;
  if (/^add new attribute\b/i.test(t) && !/\b[a-z][a-z0-9]+_[a-z0-9_]+\b/.test(t)) return true;
  // Performance / capacity assumptions (not testable contracts).
  if (/\b(?:assume|assuming|approximately|for performance|performance assumption|estimated|expected latency|throughput)\b/i.test(t) && !NORMATIVE_MODAL_RE.test(t)) return true;
  // Implementation narration may be useful technical context, but it is not an independently testable
  // contract unless the same sentence states an external surface or a calculation rule.
  if (
    internalImplementationTokenCount(t) >= 2 &&
    !CALCULATION_CONTRACT_RE.test(t) &&
    !(DIRECT_CONTRACT_SURFACE_RE.test(t) && (NORMATIVE_MODAL_RE.test(t) || DIRECT_CONTRACT_RULE_RE.test(t)))
  ) {
    return true;
  }
  // Heading: short, mostly title-cased, unpunctuated, and not stating an obligation.
  const words = t.split(/\s+/);
  if (words.length <= 8 && !/[.:!?]$/.test(t) && !NORMATIVE_MODAL_RE.test(t) && !DIRECT_REQUIREMENT_BEHAVIOR_RE.test(t)) {
    const capitalized = words.filter((word) => /^[A-Z0-9]/.test(word)).length;
    if (capitalized >= Math.ceil(words.length * 0.6)) return true;
  }
  return false;
}

function isDirectRequirementCandidate(text: string): boolean {
  const normalized = normalizeInlineText(text);
  if (normalized.length < 20 || normalized.length > 620) return false;
  if (isFragmentaryCriterion(normalized)) return false;
  if (isNonRequirementLine(normalized)) return false;
  const explicitDisposition = OUT_OF_SCOPE_REQUIREMENT_RE.test(normalized) || CLARIFICATION_REQUIREMENT_RE.test(normalized);
  const normativeContract = NORMATIVE_MODAL_RE.test(normalized) && DIRECT_CONTRACT_SURFACE_RE.test(normalized);
  const declarativeContract =
    DIRECT_CONTRACT_SURFACE_RE.test(normalized) &&
    (DIRECT_REQUIREMENT_BEHAVIOR_RE.test(normalized) || DIRECT_CONTRACT_RULE_RE.test(normalized));
  const calculationContract = CALCULATION_CONTRACT_RE.test(normalized) && hasClearExpectedBehaviorSignal(normalized);
  const compatibilityOrPerformanceContract =
    /\b(?:request(?:s| messages?)? (?:is|are|remains?|remain)?\s*unchanged|backward compatib\w*|compare\b[\s\S]*\blatency|latency\b[\s\S]*\benabled\/disabled)\b/i.test(normalized);
  return explicitDisposition || normativeContract || declarativeContract || calculationContract || compatibilityOrPerformanceContract;
}

function expandCoordinatedSurfaceRequirement(text: string): string[] {
  const match = text.match(/^(?:net:\s*)?(.*?\bcolumns?)\s+are\s+stored,\s*streamed,\s*and\s*exported,\s*but\s+(.+)$/i);
  if (!match) return [text];
  const rawSubject = match[1].trim();
  const subject = rawSubject.charAt(0).toUpperCase() + rawSubject.slice(1);
  const agentClause = match[2].replace(/\bthem\b/gi, rawSubject).replace(/^./, (character) => character.toUpperCase());
  return [`${subject} are stored.`, `${subject} are streamed.`, `${subject} are exported.`, agentClause];
}

function splitDirectRequirementCandidates(value: string): string[] {
  const candidates: string[] = [];
  for (const rawLine of normalizeMultilineText(value).split('\n')) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!line) continue;
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z0-9])|(?<=;)\s+(?=(?:[A-Z0-9]|a cell\b|exactly one\b|format\b|append\b|persist\b|missing\b))/g);
    for (const part of parts) {
      for (const expanded of expandCoordinatedSurfaceRequirement(normalizeInlineText(part))) {
        const normalized = normalizeInlineText(expanded);
        if (isDirectRequirementCandidate(normalized)) candidates.push(normalized);
      }
    }
  }
  return candidates;
}

/**
 * Technical specs are authoritative only when they are explicitly linked to the ticket. We inventory
 * their concrete, testable rules alongside the Jira and matched PRD wording so synthesis cannot make a
 * green AC set by paraphrasing away persistence/export/schema obligations.
 */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (!min) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / min;
}

// Opposite-polarity requirement pairs (flag on vs off, include vs omit, shown vs hidden…) legitimately
// share most of their vocabulary but are DISTINCT contracts — they must never be collapsed as restatements.
const POLARITY_ANTONYMS: Array<[string, string]> = [
  ['enabled', 'disabled'],
  ['enable', 'disable'],
  ['include', 'omit'],
  ['include', 'exclude'],
  ['included', 'omitted'],
  ['add', 'remove'],
  ['added', 'removed'],
  ['shown', 'hidden'],
  ['show', 'hide'],
  ['present', 'absent'],
  ['visible', 'hidden'],
  ['allow', 'reject'],
  ['allowed', 'rejected'],
  ['accept', 'reject'],
  ['on', 'off'],
  ['true', 'false'],
];

function differOnPolarity(a: Set<string>, b: Set<string>): boolean {
  for (const [x, y] of POLARITY_ANTONYMS) {
    if ((a.has(x) && b.has(y)) || (a.has(y) && b.has(x))) return true;
  }
  return false;
}

function directRequirementContractFamily(text: string): string {
  const value = text.toLowerCase();
  // Exclusion wording often repeats the column names. Classify it before the generic "coverage fields"
  // family so queryable/schema exclusions collapse together instead of looking like column-addition rules.
  if (
    /\b(?:queryable fields?|agent schema|dataset schema|builddatasetschema|mcp|qna agent)\b/.test(value) &&
    /\b(?:exclude|must not|never sees|does not spend|not appear|skip)\b/.test(value)
  ) {
    return 'agent_schema_exclusion';
  }
  if (/\bagent\b[\s\S]*\bschema\b|\bschema\b[\s\S]*\bagent\b/.test(value) && /\b(?:never sees|does not spend|exclude|not appear)\b/.test(value)) {
    return 'agent_schema_exclusion';
  }
  if (/\b(?:add|adds|include|includes|expose|exposes|gain|gains|return|returns)\b[\s\S]*\badm_area_coverage_[12]\b|\btwo new result columns\b|\badd\b[\s\S]*\bcoverage attribute\b[\s\S]*\bresult dataset\b/.test(value)) return 'coverage_fields';
  if (/\b(?:exactly|only|touching) one\b|\bonly one administrative area\b/.test(value)) return 'single_area';
  if (/\b(?:no mapping|no intersection|outside supported|unavailable|not been mapped)\b[\s\S]*\bnull\b|\bnull\b[\s\S]*\b(?:no mapping|no intersection|outside supported|unavailable|not been mapped)\b|\bboth (?:fields|columns|attributes) (?:are|must be|return) null\b/.test(value)) return 'no_area';
  if (/\b(?:never|does not|should not|must not) block\b|\bwithout (?:blocking|invalidating)\b/.test(value)) return 'null_non_blocking';
  if (/\b(?:fmt\.sprintf|following format|format each|long_name)\b|\(\s*x\.xx% coverage\s*\)|\bcoverage percentage\b[\s\S]*\bappended\b/.test(value)) return 'coverage_format';
  if (/\b(?:no mincoveragepercent|no minimum coverage|no coverage threshold|coverage_pct\s*>\s*0|boundary-only|real overlap)\b/.test(value)) return 'coverage_threshold';
  if (/\b(?:sort(?:ed)?[\s\S]*(?:desc|descending)|coverage desc|ordered[\s\S]*descending|descending order)\b/.test(value)) return 'coverage_ordering';
  if (/\b(?:top[-\s]?(?:2|two)|index 0[\s\S]*index 1|highest[\s\S]*second-highest|first-highest[\s\S]*second-highest|display all administrative areas)\b/.test(value)) return 'coverage_cardinality';
  // A persistence sentence may mention downstream table/export consumers only to say no recomputation is
  // needed. Its governing contract is still persistence; classify explicit export behavior afterwards.
  if (/\binfo panel\b/.test(value) && /(?:\b(?:consistent|match)\b|\bsame\b[\s\S]*\btable\b)/.test(value)) return 'info_panel_consistency';
  if (/\b(?:persist\w*|stored|save path|native bson string|result document)\b/.test(value)) return 'result_persistence';
  if (/\b(?:export|exported|download dataset|data export file)\b/.test(value)) return 'result_export';
  if (/\b(?:format|full hierarchy|full path|long_name|x\.xx% coverage|\d+(?:\.\d+)?% coverage)\b/.test(value)) return 'coverage_format';
  if (/\b(?:clamp|contains?\s*(?:⇒|means|implies|returns?)?\s*100)\b/.test(value)) return 'coverage_bounds';
  if (/\b(?:planar area|numerator|denominator|intersection area relative|relative to (?:the )?(?:grid(?:\/catchment)?|cell|catchment) area|units cancel)\b/.test(value)) return 'coverage_formula';
  if (/\b(?:compare\b[\s\S]*\blatency|latency\b[\s\S]*\benabled\b[\s\S]*\bdisabled|performance\b[\s\S]*\benabled\b[\s\S]*\bdisabled)\b/.test(value)) {
    return 'performance';
  }
  if (/\b(?:feature flag|adm_area_coverage_enabled|be flag)\b/.test(value)) {
    return /\b(?:defaults?(?:\s+to)?\s+off|disabled|flag is off|opt-in)\b/.test(value) ? 'feature_flag_off' : 'feature_flag_on';
  }
  if (/\b(?:latency|performance)\b/.test(value)) return 'performance';
  if (/\b(?:request messages?[\s\S]{0,80}(?:remain|remains|are|must remain)?\s*unchanged|request untouched|backward compatib)\b/.test(value)) return 'request_compatibility';
  if (/\bstream(?:ed|ing)?\b/.test(value)) return 'result_stream';
  if (/\binfo panel\b/.test(value)) return 'info_panel_display';
  if (/\b(?:table view|result table|shown in table|displayed in the table)\b/.test(value)) return 'result_table';
  return '';
}

function directRequirementCardinality(text: string): 'top_two' | 'all' | '' {
  if (/\b(?:top[-\s]?(?:2|two)|take the top 2|index 0[\s\S]*index 1)\b/i.test(text)) return 'top_two';
  if (/\bdisplay all administrative areas\b/i.test(text)) return 'all';
  return '';
}

function textContainsContractFamily(text: string, family: string): boolean {
  const value = text.toLowerCase();
  if (family === 'coverage_ordering') return /\b(?:sort(?:ed)?[\s\S]*(?:desc|descending)|coverage desc|ordered[\s\S]*descending)\b/.test(value);
  if (family === 'coverage_cardinality') return /\b(?:top[-\s]?(?:2|two)|index 0[\s\S]*index 1|highest[\s\S]*second-highest)\b/.test(value);
  if (family === 'coverage_threshold') return /\b(?:no mincoveragepercent|no minimum coverage|no coverage threshold|coverage_pct\s*>\s*0|boundary-only|real overlap)\b/.test(value);
  if (family === 'result_persistence') return /\b(?:persist\w*|stored|re-read|save path|native bson string|result document)\b/.test(value);
  if (family === 'result_stream') return /\bstream(?:ed|ing)?\b/.test(value);
  if (family === 'result_export') return /\b(?:export|exported|download dataset|data export file)\b/.test(value);
  if (family === 'agent_schema_exclusion') {
    return /\b(?:queryable|agent|qna|mcp|schema)\b/.test(value) && /\b(?:exclude|must not|never sees|does not spend|not appear|skip)\b/.test(value);
  }
  if (family === 'coverage_format') {
    return /\b(?:format|formatted|long_name)\b|\bx\.xx% coverage\b|\b\d+(?:\.\d+)?% coverage\b|\bcoverage percentage\b[\s\S]*\bappended\b/.test(value);
  }
  return false;
}

function mergeWorkedExamples<T extends { workedExamples?: string[] }>(preferred: T, duplicate: T): T {
  const workedExamples = [...new Set([...(preferred.workedExamples || []), ...(duplicate.workedExamples || [])])].slice(0, 12);
  return workedExamples.length ? { ...preferred, workedExamples } : preferred;
}

// Collapse cross-source restatements of the same contract to one representative. Jira/PRD/spec routinely
// describe the same rule in different words ("sort by coverage desc" vs "results ordered by coverage_pct
// descending"); exact-key dedup keeps both and inflates the inventory. Keep the most-specific source
// (spec > prd > jira), then the longer statement, as the representative. Only collapses when BOTH have
// enough distinctive tokens to judge (>=3), so terse distinct rules are never over-merged.
function dedupeDirectRequirements<
  T extends { text: string; sourceKind: DirectRequirementTrace['sourceKind']; workedExamples?: string[] },
>(requirements: T[]): T[] {
  const sourceRank: Record<string, number> = { spec: 0, prd: 1, jira: 2 };
  const ordered = requirements
    .map((requirement, index) => ({ requirement, index }))
    .sort(
      (a, b) =>
        (sourceRank[a.requirement.sourceKind] ?? 9) - (sourceRank[b.requirement.sourceKind] ?? 9) ||
        b.requirement.text.length - a.requirement.text.length ||
        a.index - b.index
    );
  const kept: T[] = [];
  const keptTokens: Set<string>[] = [];
  for (const { requirement } of ordered) {
    const tokens = directRequirementTokens(requirement.text);
    const family = directRequirementContractFamily(requirement.text);
    // Collapse only true restatements: strong token overlap AND not an opposite-polarity pair (a flag-on
    // vs flag-off rule shares most tokens but is a distinct contract that must be kept).
    const duplicateIndex = keptTokens.findIndex((existing, index) => {
      if (differOnPolarity(tokens, existing)) return false;
      const nullBlockingRule = /\bnull\b[\s\S]*\bblocks?\b|\bblocks?\b[\s\S]*\bnull\b/i;
      if (nullBlockingRule.test(requirement.text) && nullBlockingRule.test(kept[index].text)) return true;
      const cardinality = directRequirementCardinality(requirement.text);
      const existingCardinality = directRequirementCardinality(kept[index].text);
      // A lower-authority PRD's older "display all" wording must not survive beside a linked technical
      // spec's explicit top-two contract. Same-source contradictions remain separate for clarification.
      if (
        cardinality &&
        existingCardinality &&
        cardinality !== existingCardinality &&
        requirement.sourceKind !== kept[index].sourceKind
      ) {
        return true;
      }
      const existingFamily = directRequirementContractFamily(kept[index].text);
      if (family && existingFamily === family) return true;
      // A higher-authority spec may state the full threshold -> ordering -> top-two sequence in one
      // contract while the PRD repeats only one step. Collapse that cross-source partial restatement;
      // do not merge independent same-source rules merely because they mention the same sequence.
      if (
        requirement.sourceKind !== kept[index].sourceKind &&
        ((family && textContainsContractFamily(kept[index].text, family)) ||
          (existingFamily && textContainsContractFamily(requirement.text, existingFamily)))
      ) {
        return true;
      }
      // Different observable contracts may share all their domain nouns (the same two response fields),
      // but format, ranking, export, persistence, and null behavior are not duplicates of one another.
      if (family || existingFamily) return false;
      return tokens.size >= 3 && existing.size >= 3 && overlapCoefficient(tokens, existing) >= 0.7;
    });
    if (duplicateIndex >= 0) {
      // The authoritative representative stays, but concrete examples from a PRD restatement are carried
      // forward. Grounding must not disappear merely because its sentence was deduplicated.
      kept[duplicateIndex] = mergeWorkedExamples(kept[duplicateIndex], requirement);
      continue;
    }
    kept.push(requirement);
    keptTokens.push(tokens);
  }
  return kept;
}

export function buildDirectRequirementInventory(context: QaContext): DirectRequirementTrace[] {
  const specPages = (context.confluencePages || []).filter((page) => isTechnicalSpecPage(page, context.scopeConfluenceSection?.pageId));
  if (!specPages.length) return [];

  const prdBody =
    context.scopeAuthority.type === 'matched_prd_subsection' || context.scopeAuthority.type === 'broad_prd_section'
      ? context.scopeAuthority.body
      : context.scopeConfluenceSection?.body || '';
  const sources: Array<{ kind: DirectRequirementTrace['sourceKind']; location: string; url?: string; text: string }> = [
    {
      kind: 'jira',
      location: `Jira: ${context.ticketKey}`,
      url: context.mainIssue.webUrl,
      text: context.mainIssue.description || context.mainIssue.renderedDescription || '',
    },
    ...(prdBody
      ? [{ kind: 'prd' as const, location: `PRD: ${context.scopeAuthority.title || context.scopeConfluenceSection?.title || 'Scoped requirements'}`, url: context.scopeConfluenceSection?.url, text: prdBody }]
      : []),
    // Deliberately NOT mining the technical-spec body as a requirement source. A tech spec describes the
    // "how" (R-Tree reuse, degree-tiling math, SQL, Mongo persistence mechanics); on ORB-2565 ~48 of 51
    // spec-derived "requirements" mapped to no acceptance criterion — pure implementation noise that regex
    // filters can't cleanly separate from behavioral rules. Requirements (the "what") come from Jira + the
    // matched PRD. The spec still (a) gates this inventory (specPages above), (b) supplies worked-example /
    // format grounding via buildSourceGroundingExamples, and (c) reaches synthesis as context via
    // technicalSpecExcerpts — so its concrete formats and details are preserved without inflating the count.
  ];

  const seen = new Set<string>();
  const collected: Array<Omit<DirectRequirementTrace, 'id'>> = [];
  for (const source of sources) {
    for (const text of splitDirectRequirementCandidates(source.text)) {
      const key = canonicalize(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const disposition: DirectRequirementTrace['disposition'] = OUT_OF_SCOPE_REQUIREMENT_RE.test(text)
        ? 'out_of_scope'
        : CLARIFICATION_REQUIREMENT_RE.test(text)
          ? 'needs_clarification'
          : 'in_scope';
      collected.push({
        text,
        disposition,
        sourceKind: source.kind,
        sourceLocation: source.location,
        ...(source.url ? { sourceUrl: source.url } : {}),
        acceptanceCriteriaIds: [],
        workedExamples: requirementWorkedExamples(text),
        ...(disposition === 'needs_clarification'
          ? { clarificationReason: 'The source leaves the required behavior undefined or pending clarification.' }
          : {}),
      });
    }
  }
  // Semantic dedup across sources, then assign contiguous ids so the inventory reflects distinct contracts
  // (not raw restatements) — this count feeds the synthesis target below.
  return dedupeDirectRequirements(collected).map((requirement, index) => ({ ...requirement, id: `REQ-${index + 1}` }));
}

export function buildSourceGroundingExamples(
  context: QaContext
): Array<Pick<DirectRequirementTrace, 'id' | 'text' | 'sourceKind' | 'sourceLocation' | 'workedExamples'>> {
  const specPages = (context.confluencePages || []).filter((page) => isTechnicalSpecPage(page, context.scopeConfluenceSection?.pageId));
  const prdBody =
    context.scopeAuthority.type === 'matched_prd_subsection' || context.scopeAuthority.type === 'broad_prd_section'
      ? context.scopeAuthority.body
      : context.scopeConfluenceSection?.body || '';
  // Grounding is intentionally extracted from the raw source corpus, not from the requirement inventory.
  // That lets us reject a code/mechanics sentence as a checklist item while retaining a format template or
  // worked value embedded in it. Prefer the linked technical spec, then its scoped PRD, then Jira.
  const sources: Array<{ sourceKind: DirectRequirementTrace['sourceKind']; sourceLocation: string; text: string }> = [
    ...specPages.map((page) => ({ sourceKind: 'spec' as const, sourceLocation: `Spec: ${page.title || page.id}`, text: page.body || '' })),
    ...(prdBody
      ? [{ sourceKind: 'prd' as const, sourceLocation: `PRD: ${context.scopeAuthority.title || context.scopeConfluenceSection?.title || 'Scoped requirements'}`, text: prdBody }]
      : []),
    {
      sourceKind: 'jira',
      sourceLocation: `Jira: ${context.ticketKey}`,
      text: context.mainIssue.description || context.mainIssue.renderedDescription || '',
    },
  ];
  const seenExamples = new Set<string>();
  const grounding: Array<Pick<DirectRequirementTrace, 'id' | 'text' | 'sourceKind' | 'sourceLocation' | 'workedExamples'>> = [];
  for (const source of sources) {
    for (const rawLine of normalizeMultilineText(source.text).split('\n')) {
      const text = normalizeInlineText(rawLine).slice(0, 620);
      if (!text) continue;
      const workedExamples = requirementWorkedExamples(text).filter((example) => {
        const key = canonicalize(example);
        if (!key || seenExamples.has(key)) return false;
        seenExamples.add(key);
        return true;
      });
      if (!workedExamples.length) continue;
      grounding.push({
        id: `GROUND-${grounding.length + 1}`,
        text,
        sourceKind: source.sourceKind,
        sourceLocation: source.sourceLocation,
        workedExamples,
      });
      if (grounding.length >= 24) return grounding;
    }
  }
  return grounding;
}

const COVERAGE_FORMAT_CRITERION_RE = /\b(?:administrative area|coverage|percentage)\b[\s\S]*\b(?:format|formatted|decimal places?|hierarchy|full path)\b|\b(?:format|formatted)\b[\s\S]*\b(?:coverage|percentage)\b/i;
const CONCRETE_COVERAGE_FORMAT_RE = /(?:\bName\s*)?\(\s*X(?:\.X+)?%\s*coverage\s*\)|<[^>]+>[\s\S]{0,80}<[^>]+>[\s\S]{0,40}%\s*coverage|[^"“”]{3,120}\(\s*\d+(?:[.,]\d+)?%\s*coverage\s*\)/i;

function formatGroundingScore(example: string): number {
  let score = 0;
  if (/\bName\s*\(\s*X(?:\.X+)?%\s*coverage\s*\)/i.test(example)) score += 100;
  if (/\(\s*X(?:\.X+)?%\s*coverage\s*\)/i.test(example)) score += 60;
  if (/\(\s*\d+(?:[.,]\d+)?%\s*coverage\s*\)/i.test(example)) score += 40;
  if (/,/.test(example)) score += 10;
  return score;
}

function preferredCoverageFormatExample(requirements: Array<{ workedExamples?: string[] }>): string {
  return requirements
    .flatMap((requirement) => requirement.workedExamples || [])
    .filter((example) => /%\s*coverage/i.test(example))
    .sort((left, right) => formatGroundingScore(right) - formatGroundingScore(left) || left.length - right.length)[0] || '';
}

function restoreSourceFormatGrounding(criteria: ScopedItem[], requirements: Array<{ workedExamples?: string[] }>): ScopedItem[] {
  const sourceFormat = preferredCoverageFormatExample(requirements);
  if (!sourceFormat) return criteria;
  return criteria.map((criterion) => {
    if (!COVERAGE_FORMAT_CRITERION_RE.test(criterion.text) || CONCRETE_COVERAGE_FORMAT_RE.test(criterion.text)) return criterion;
    const blankQuotedFormat = /(["“])\s*["”]/;
    const text = blankQuotedFormat.test(criterion.text)
      ? criterion.text.replace(blankQuotedFormat, `"${sourceFormat}"`)
      : `${criterion.text.replace(/[.\s]+$/, '')}. Use the source-defined format "${sourceFormat}".`;
    return { ...criterion, text };
  });
}

export function requirementCriterionMatchScore(requirement: DirectRequirementTrace, criterion: ScopedItem): number {
  const requirementCanonical = canonicalize(requirement.text);
  const criterionCanonical = canonicalize(criterion.text);
  if (!requirementCanonical || !criterionCanonical) return 0;
  if (requirementCanonical.includes(criterionCanonical) || criterionCanonical.includes(requirementCanonical)) {
    return 10;
  }
  const requirementTokens = directRequirementTokens(requirement.text);
  const criterionTokens = directRequirementTokens(criterion.text);
  if (!requirementTokens.size || !criterionTokens.size) return 0;
  const shared = [...requirementTokens].filter((token) => criterionTokens.has(token));
  const requirementFamily = directRequirementContractFamily(requirement.text);
  const criterionFamily = directRequirementContractFamily(criterion.text);
  // Wording changes across source and AC synthesis (top-2 vs highest/second-highest, clamp vs clamped,
  // coverage_pct vs coverage percentage). A shared semantic family plus one domain token is sufficient
  // evidence that the criterion covers the requirement and prevents false omission-repair duplicates.
  if (
    requirementFamily &&
    (requirementFamily === criterionFamily || textContainsContractFamily(criterion.text, requirementFamily)) &&
    shared.length >= 1
  ) {
    return 20 + shared.length;
  }
  // Shared domain identifiers are not interchangeable behavior. A clamp rule and a threshold rule both
  // mention coverage_pct; a flag gate and a latency comparison both mention the same flag. When both
  // sides have known but different contract families, token overlap must not manufacture coverage.
  if (requirementFamily && criterionFamily && requirementFamily !== criterionFamily) return 0;
  const sharedExactIdentifier = shared.some((token) => token.includes('_') || /^v\d+$/.test(token));
  const requiredOverlap = requirementTokens.size <= 3 ? 1 : 2;
  // A shared field/table identifier alone is not enough: several independent contracts commonly refer
  // to the same response field. Require at least one additional behavioral token so one generic AC
  // cannot claim every source rule about that identifier.
  if (sharedExactIdentifier && shared.length < 2) return 0;
  if (shared.length < requiredOverlap) return 0;
  const requirementCoverage = shared.length / requirementTokens.size;
  const criterionCoverage = shared.length / criterionTokens.size;
  if (Math.max(requirementCoverage, criterionCoverage) < 0.45) return 0;
  return shared.length + Math.min(requirementCoverage, criterionCoverage);
}

function mapDirectRequirementsToCriteria(requirements: DirectRequirementTrace[], criteria: ScopedItem[]): DirectRequirementTrace[] {
  const mapped = requirements.map((requirement) => ({ ...requirement, acceptanceCriteriaIds: [] as string[] }));
  const candidates = mapped
    .flatMap((requirement, requirementIndex) =>
      requirement.disposition === 'out_of_scope'
        ? []
        : criteria.map((criterion, criterionIndex) => ({
            requirementIndex,
            criterionIndex,
            score: requirementCriterionMatchScore(requirement, criterion),
          }))
    )
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.requirementIndex - right.requirementIndex || left.criterionIndex - right.criterionIndex);
  // Each requirement maps to its single best-matching criterion. A criterion may be shared by several
  // requirements (many-to-one): equivalent PRD/spec rules describing one contract legitimately map to the
  // same AC. The previous 1:1 matching left the second equivalent requirement "unmapped", which then drove
  // omission repair to synthesize a near-duplicate AC — a primary cause of the count explosion.
  const assignedRequirements = new Set<number>();
  for (const candidate of candidates) {
    if (assignedRequirements.has(candidate.requirementIndex)) continue;
    mapped[candidate.requirementIndex].acceptanceCriteriaIds = [criteria[candidate.criterionIndex].id];
    assignedRequirements.add(candidate.requirementIndex);
  }
  return mapped;
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

export function classifyAcceptanceCriteriaExecution(context: QaContext): AcceptanceCriteriaExecutionPlanItem[] {
  const matchedEndpoints = context.apiContract?.matchedEndpoints || [];
  const scopeType = context.constraints?.scopeType || 'web';
  const endpointSurface = (method: string, path: string): string =>
    `${method.toUpperCase()} ${path}`.trim();
  const firstEndpoint = (matcher: RegExp): string => {
    const matched = matchedEndpoints.find((endpoint) => matcher.test(`${endpoint.method || ''} ${endpoint.path || ''} ${endpoint.summary || ''}`));
    return matched ? endpointSurface(matched.method || '', matched.path || '') : '';
  };
  const firstMentionedCriterionEndpoint = (text: string): { method: string; path: string } | null => {
    const match = text.match(
      /\b(GET|POST|PUT|PATCH|DELETE)\s+((?:\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%{}-]+)|(?:(?:[A-Za-z][A-Za-z0-9_-]*\/)?\/?v\d+\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%{}-]+))/i
    );
    if (!match) return null;
    const rawPath = match[2].replace(/[.,;:)\]]+$/, '');
    const versionedPath = rawPath.match(/(?:^|\/)(v\d+\/.*)$/i)?.[1] || rawPath.replace(/^\/+/, '');
    const normalizedPath = `/${versionedPath}`;
    return { method: match[1].toUpperCase(), path: normalizedPath };
  };
  const firstCriterionEndpoint = (text: string): string => {
    const mentioned = firstMentionedCriterionEndpoint(text);
    if (!mentioned) return '';
    const documented = matchedEndpoints.find(
      (endpoint) =>
        String(endpoint.method || '').toUpperCase() === mentioned.method &&
        String(endpoint.path || '').replace(/\/+$/, '') === mentioned.path.replace(/\/+$/, '')
    );
    return documented ? endpointSurface(documented.method || '', documented.path || '') : '';
  };
  const manualIntegrationPlan = (
    criterionId: string,
    reason: string,
    endpointDowngrade?: { method: string; path: string; reason: string }
  ): AcceptanceCriteriaExecutionPlanItem => ({
    criterionId,
    executionType: 'manual_integration',
    observableSurface: 'Integration behavior requiring reviewer-selected evidence',
    reason,
    coveragePolicy: 'integration_verification',
    ...(endpointDowngrade ? { endpointDowngrade } : {}),
  });
  // A Postman case must always be executable. Do not let broad wording such as "response" or
  // "result stream" manufacture a fictional endpoint when API docs were intentionally skipped or
  // did not yield a matching operation. The generation validator requires method + path, so this
  // guard prevents an otherwise unavoidable provider failure before generation starts.
  const postmanPlan = (
    criterionId: string,
    observableSurface: string,
    reason: string,
    proposedEndpoint?: { method: string; path: string } | null
  ): AcceptanceCriteriaExecutionPlanItem => {
    if (proposedEndpoint && (!matchedEndpoints.length || !endpointIsDocumented(proposedEndpoint.method, proposedEndpoint.path, matchedEndpoints))) {
      const downgradeReason = `Endpoint ${proposedEndpoint.method} ${proposedEndpoint.path} is not present in the fetched API contract; Postman generation is prohibited until the contract is verified.`;
      return manualIntegrationPlan(criterionId, downgradeReason, {
        ...proposedEndpoint,
        reason: downgradeReason,
      });
    }
    if (!/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+/i.test(observableSurface)) {
      return manualIntegrationPlan(
        criterionId,
        'Criterion describes runtime behavior but no concrete HTTP method and path were found; verify it through integration/manual evidence rather than inventing a Postman contract.'
      );
    }
    return {
      criterionId,
      executionType: 'postman',
      observableSurface,
      reason,
      coveragePolicy: 'api_assertion',
    };
  };

  return (context.acceptanceCriteria || []).map((criterion): AcceptanceCriteriaExecutionPlanItem => {
    const text = normalizeInlineText(criterion.text);
    const postEndpoint = firstEndpoint(/^POST\b.*\/v1\/analysis\b/i);
    const streamEndpoint = firstEndpoint(/^GET\b.*(?:\/stream\b|analysis\/\{?id\}?\/stream)/i);
    const summaryEndpoint = firstEndpoint(/^GET\b.*\/v1\/analysis\/\{?id\}?\/summary\b/i);
    const analysisDetailEndpoint = firstEndpoint(/^GET\b.*\/v1\/analysis\/\{?id\}?\/?$/i);
    const resultEndpoint = streamEndpoint || summaryEndpoint || analysisDetailEndpoint;
    const criterionEndpoint = firstCriterionEndpoint(text);
    const proposedCriterionEndpoint = firstMentionedCriterionEndpoint(text);

    if (scopeType !== 'api') {
      if (/\b(database migration|migration|create table|alter table|unique index|covering index|foreign key|sql|schema)\b/i.test(text)) {
        return {
          criterionId: criterion.id,
          executionType: 'manual_other',
          observableSurface: 'Web-scope reviewer verification',
          reason: 'Backend implementation detail appears in a web-scope criterion; do not convert it into a Postman/API case.',
          coveragePolicy: 'manual_verification',
        };
      }

      if (/\b(proto|protobuf|generated code|go mod|vendor|enum|message output)\b/i.test(text)) {
        return {
          criterionId: criterion.id,
          executionType: 'manual_other',
          observableSurface: 'Web-scope reviewer verification',
          reason: 'Code-generation detail appears in a web-scope criterion; do not convert it into a Postman/API case.',
          coveragePolicy: 'manual_verification',
        };
      }

      if (
        criterionEndpoint ||
        proposedCriterionEndpoint ||
        /\b(frontend|front-end|web|ui|screen|render|walkthrough|tour|button|click|global state|local state|app load|opened|next|skip|finish|browser|network|local config|local module)\b/i.test(text)
      ) {
        return {
          criterionId: criterion.id,
          executionType: 'manual_integration',
          observableSurface: criterionEndpoint || proposedCriterionEndpoint
            ? `Web UI / frontend network behavior (${criterionEndpoint || endpointSurface(proposedCriterionEndpoint?.method || '', proposedCriterionEndpoint?.path || '')})`
            : 'Web UI / frontend runtime behavior',
          reason: 'Criterion is web-scope behavior; verify through frontend BDD/browser evidence rather than Postman-only API evidence.',
          coveragePolicy: 'integration_verification',
        };
      }

      return {
        criterionId: criterion.id,
        executionType: 'manual_other',
        observableSurface: 'Manual web-scope reviewer verification',
        reason: 'No deterministic frontend runtime surface was identified for this web-scope criterion.',
        coveragePolicy: 'manual_verification',
      };
    }

    if (/\b(proto|protobuf|orbis-go-proto|generated code|go mod|vendor|message output)\b/i.test(text)) {
      return {
        criterionId: criterion.id,
        executionType: 'manual_code_review',
        observableSurface: 'Source diff / generated protobuf code',
        reason: 'Criterion verifies proto/generated-code contract, not runtime HTTP behavior.',
        coveragePolicy: 'code_review',
      };
    }

    if (/\b(get\s+\/|stream|sse|dataset metadata|output row|dasymetric weight|dasymetric proportion|fallback|response)\b/i.test(text)) {
      return postmanPlan(
        criterion.id,
        criterionEndpoint || resultEndpoint || postEndpoint,
        criterionEndpoint
          ? 'Criterion is observable through its referenced API endpoint.'
          : 'Criterion is observable through the documented analysis result response.',
        proposedCriterionEndpoint
      );
    }

    if (/\b(json\s+array|json\s+object|data_label|response body|http status|status code)\b/i.test(text)) {
      const observableSurfaces = Array.from(new Set([postEndpoint, resultEndpoint].filter(Boolean)));
      return postmanPlan(
        criterion.id,
        criterionEndpoint || observableSurfaces.join(' or '),
        criterionEndpoint
          ? 'Criterion defines a response contract on its referenced API endpoint.'
          : 'Criterion defines an API response or data-shape contract; verify it through the documented submit/result endpoints.',
        proposedCriterionEndpoint
      );
    }

    // Result contracts are API-observable even when synthesized wording does not literally repeat
    // "response" or "JSON array". Examples include a returned array's entry shape/order and an output
    // attribute's single-value/null behavior. Without this guard those criteria fall through to
    // manual_integration, after which a perfectly valid Postman case is relabeled into an impossible
    // manual/API hybrid (the ORB-2564 OpenAI fallback regression).
    const returnedCollectionContract =
      /\b(?:returned?\s+)?array\b/i.test(text) &&
      /\b(?:contain|contains|contained|entries|entry|items|item|ordered|sorted|descending|ascending|single|multiple|length|count|null|empty)\b/i.test(text);
    const nullableResultAttribute =
      /\b(?:result|output|attribute|field|value|array)\b[\s\S]{0,160}\b(?:null|empty|unavailable|not\s+mapped|outside\s+supported)\b/i.test(text);
    const structuredReturnedValue =
      /\b(?:return|returns|returned|result|output)\b/i.test(text) &&
      /\b(?:attribute|field|array|object|entries|entry|hierarchy|percentage|ordered|sorted)\b/i.test(text);
    // A formatted value is also a response contract even when the synthesized AC calls it an
    // "attribute" rather than explicitly saying "response". For example, ORB-2565 requires the
    // returned coverage attribute to contain hierarchy text plus a percentage in one exact format.
    // Keep implementation/storage wording out so schema and runtime criteria still use manual plans.
    const formattedResultAttribute =
      /\b(?:attribute|field|value)\b/i.test(text) &&
      /\b(?:contains?|includes?|format(?:ted)?|representation)\b/i.test(text) &&
      /\b(?:hierarchy|coverage|percentage|path|label|text)\b/i.test(text) &&
      !/\b(?:database|migration|table|column|schema|etl|repository|worker)\b/i.test(text);
    if (
      context.constraints?.apiContractRelevant !== false &&
      (postEndpoint || resultEndpoint) &&
      (returnedCollectionContract || nullableResultAttribute || structuredReturnedValue || formattedResultAttribute)
    ) {
      return postmanPlan(
        criterion.id,
        criterionEndpoint || resultEndpoint || postEndpoint,
        'Criterion defines observable result-field values, format, collection shape/order, or null behavior in the documented API response.',
        proposedCriterionEndpoint
      );
    }

    if (/\b(post\s+(?:[a-z][a-z0-9_-]*\/)?\/?v\d+\/|submit analysis|request body|payload|optional field|proportion_method|enum values?|default)\b/i.test(text)) {
      return postmanPlan(
        criterion.id,
        criterionEndpoint || postEndpoint,
        criterionEndpoint
          ? 'Criterion is observable through its referenced API endpoint.'
          : 'Criterion is observable through the submit-analysis request contract.',
        proposedCriterionEndpoint
      );
    }

    const explicitlyDatabaseScoped =
      /\b(database migration|migration|create table|alter table|unique index|covering index|foreign key|database|db|ddl|schema|sql|double precision|etl|backfill|dasymetric(?:_id)?_h3_level_8)\b/i.test(text);
    const structuredTableOrColumnRule =
      /\b(table|column)\b/i.test(text) && /\b(non[-\s]?null|nullable|precision|index|constraint|primary key|foreign key)\b/i.test(text);
    if (explicitlyDatabaseScoped || structuredTableOrColumnRule) {
      return {
        criterionId: criterion.id,
        executionType: 'manual_db',
        observableSurface: 'Database schema / migration state',
        reason: 'Criterion verifies database structure or indexes that are not directly API-observable.',
        coveragePolicy: 'db_verification',
      };
    }

    if (/\b(prefetch|repository|processrowsparams|processrowgridworker|worker|concurrent|read-only|lock-free|geth3buildingratio|ratio map)\b/i.test(text)) {
      return {
        criterionId: criterion.id,
        executionType: 'manual_integration',
        observableSurface: 'Service integration/runtime behavior',
        reason: 'Criterion verifies internal runtime plumbing; use integration/manual verification unless an endpoint directly exposes it.',
        coveragePolicy: 'integration_verification',
      };
    }

    if (context.constraints?.scopeType === 'api' && context.constraints.apiContractRelevant !== false) {
      // An API-scope criterion that isn't explicitly DB / proto / internal-plumbing (all handled above) is
      // most likely observable in the documented analysis result. Default it to a Postman plan against the
      // result endpoint so generation can actually cover it. postmanPlan still downgrades to manual only
      // when no documented endpoint exists — it never invents one. Previously this fell to a vague
      // manual_integration ("reviewer-selected evidence") plan that generation could NOT cover, which left
      // ACs uncovered, failed the coverage gate, and forced the slow DeepSeek fallback (the ORB-2565
      // generate timeout).
      return postmanPlan(
        criterion.id,
        criterionEndpoint || resultEndpoint || postEndpoint,
        'Backend criterion observable in the documented analysis result; verify via the result endpoint.',
        proposedCriterionEndpoint
      );
    }

    return {
      criterionId: criterion.id,
      executionType: 'manual_other',
      observableSurface: 'Manual reviewer verification',
      reason: 'No deterministic API, DB, code, or integration surface was identified.',
      coveragePolicy: 'manual_verification',
    };
  });
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
  let directRequirements = buildDirectRequirementInventory(context);
  const sourceGroundingExamples = buildSourceGroundingExamples(context);
  if (specExcerpts.pages.length) {
    options.logger?.info('context.ac_spec_grounding', {
      jiraKey: context.ticketKey,
      specPages: specExcerpts.pages,
      excerptChars: specExcerpts.text.length,
      directRequirementCount: directRequirements.length,
    });
  }

  // When a technical spec grounds the criteria, an API / main_jira ticket otherwise has NO granularity
  // target (the deterministic targets only fire for FE design headings or thin-PRD fallback), so
  // synthesis defaults to "concise" and collapses the spec's distinct rules back into a few clauses.
  // Push toward one criterion per concrete spec rule instead.
  let granularityTarget = determineContextGranularityTarget(context, parsedSections, mainIssueBody);
  const actionableDirectRequirementCount = directRequirements.filter((requirement) => requirement.disposition !== 'out_of_scope').length;
  // Abnormal-inventory gate (a gate, NOT a fixed cap): a well-scoped ticket rarely has more than a few
  // dozen distinct direct contracts. If extraction + dedup still yields an implausible count, the inventory
  // is noise, so we must NOT force the model to emit that many ACs. Leave the synthesis target at the
  // deterministic baseline (don't inflate), flag the anomaly for the quality gate, and still generate.
  const ABNORMAL_DIRECT_REQUIREMENT_COUNT = 40;
  const abnormalRequirementInventory = actionableDirectRequirementCount > ABNORMAL_DIRECT_REQUIREMENT_COUNT;
  if (abnormalRequirementInventory) {
    options.logger?.warn('context.ac_abnormal_requirement_inventory', {
      jiraKey: context.ticketKey,
      actionableDirectRequirementCount,
      ceiling: ABNORMAL_DIRECT_REQUIREMENT_COUNT,
    });
  } else if (actionableDirectRequirementCount) {
    granularityTarget = {
      min: actionableDirectRequirementCount,
      max: actionableDirectRequirementCount + 2,
      hint:
        'A linked technical specification provides an atomic direct-requirement inventory. Produce one criterion for every actionable source rule. Do not compress result, feature-flag, persistence, stream, export, schema, compatibility, null-value, or fallback rules into generic clauses. Rules marked needs_clarification must remain visible and traceable instead of being discarded.',
    };
  }

  let finalCriteria = dedupeCriteria(quality.kept.map((criterion) => ({ text: criterion.text, source: criterion.source })));
  let synthesisUsed = false;
  let synthesisFailureReason = '';
  let synthesisInput: AcceptanceCriteriaSynthesisInput | null = null;
  let synthesisReason = quality.quality === 'strong'
    ? 'Deterministic acceptance criteria were preserved after canonical normalization.'
    : 'Deterministic acceptance criteria were weak, so the final set fell back to deterministic quality-gated output.';

  if (options.synthesizer && !(options.skipStrongLlmSynthesis && quality.quality === 'strong')) {
    try {
      synthesisInput = {
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
        figmaReferences: context.figmaReferences || [],
        targetMinCriteria: granularityTarget?.min,
        targetMaxCriteria: granularityTarget?.max,
        granularityHint: granularityTarget?.hint,
        technicalSpecExcerpts: specExcerpts.text,
        // When the inventory is abnormal (extraction over-counted), do NOT hand the model a 60+-item
        // "preserve every rule" checklist — that is what forces one near-duplicate criterion per line.
        // Pass an empty list so synthesis produces a focused set from the raw ACs + spec excerpts instead.
        directRequirements: abnormalRequirementInventory
          ? []
          : directRequirements.map(({ id, text, sourceKind, sourceLocation, workedExamples }) => ({
              id,
              text,
              sourceKind,
              sourceLocation,
              workedExamples,
            })),
        // Grounding is deliberately independent from the completeness checklist. Even if an abnormal
        // inventory suppresses directRequirements, exact source formats and worked values still reach
        // synthesis and cannot collapse into blank placeholders.
        groundingExamples: sourceGroundingExamples,
        scopeBoundary: (context.apiContract?.matchedEndpoints || [])
          .map((endpoint) => `${String(endpoint.method || '').toUpperCase()} ${endpoint.path || ''}`.trim())
          .filter(Boolean)
          .join(', '),
      };
      const synthesis = await options.synthesizer(synthesisInput);
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
      } else {
        // Distinct from a thrown failure below: synthesis ran (and already retried empties internally) but
        // still produced nothing usable. Log it explicitly so a synthesisUsed=false run is diagnosable
        // without guessing, and record the reason that feeds the not-production-ready gate.
        synthesisFailureReason = 'LLM synthesis returned no usable acceptance criteria after retries.';
        options.logger?.warn('context.ac_synthesis_empty', { jiraKey: context.ticketKey });
      }
    } catch (error) {
      synthesisFailureReason = error instanceof Error ? error.message : String(error);
      options.logger?.warn('context.ac_synthesis_failed', {
        jiraKey: context.ticketKey,
        errorMessage: synthesisFailureReason,
      });
    }
  }

  // Not-production-ready gate. Two triggers: (a) raw ACs were not strong AND synthesis produced nothing
  // usable (reduced fallback); or (b) the requirement inventory was abnormal — extraction over-counted, so
  // the AC set can't be trusted even though generation still produced one. Both block push (overridable)
  // and surface in the UI, rather than an abnormal run staying silently production-eligible.
  const acceptanceCriteriaNotProductionReady = (quality.quality !== 'strong' && !synthesisUsed) || abnormalRequirementInventory;
  const acceptanceCriteriaNotProductionReadyReason = !acceptanceCriteriaNotProductionReady
    ? ''
    : abnormalRequirementInventory
      ? `Source extraction produced an abnormal requirement inventory (${actionableDirectRequirementCount} items); the acceptance criteria are likely over-generated and must be reviewed before use.`
      : synthesisFailureReason
        ? `Raw acceptance criteria were ${quality.quality} and LLM synthesis failed (${synthesisFailureReason}); the final set is a reduced deterministic fallback.`
        : `Raw acceptance criteria were ${quality.quality} and LLM synthesis did not produce a usable set; the final set is a reduced deterministic fallback.`;

  finalCriteria = repairOverMergedCriteria(finalCriteria, granularityTarget);

  // Source inventory is a completeness contract, not merely prompt context. Repair omissions with a
  // focused re-synthesis pass, then retain the source rule verbatim as a last-resort AC so a model can
  // never make the suite appear complete by silently dropping a direct technical requirement.
  directRequirements = mapDirectRequirementsToCriteria(directRequirements, finalCriteria);
  const missingDirectRequirements = directRequirements.filter(
    (requirement) => requirement.disposition !== 'out_of_scope' && !requirement.acceptanceCriteriaIds.length
  );
  // Skip omission repair when the inventory is abnormal: re-synthesizing for 40+ "missing" noisy rules is
  // exactly what re-inflates the AC count. The run is already flagged not-production-ready for review.
  if (!abnormalRequirementInventory && missingDirectRequirements.length && options.synthesizer && synthesisInput) {
    try {
      const repair = await options.synthesizer({
        ...synthesisInput,
        directRequirements: missingDirectRequirements.map(({ id, text, sourceKind, sourceLocation, workedExamples }) => ({
          id,
          text,
          sourceKind,
          sourceLocation,
          workedExamples,
        })),
        repairOnlyMissingRequirements: true,
        existingCriteria: finalCriteria.map(({ id, text }) => ({ id, text })),
        targetMinCriteria: missingDirectRequirements.length,
        targetMaxCriteria: missingDirectRequirements.length,
        granularityHint:
          'Return exactly one focused criterion per omitted direct requirement. State only the missing observable clause and do not repeat behavior already present in existingCriteria.',
      });
      const repairedCandidates = dedupeCriteria(
        (repair.acceptanceCriteria || []).map((criterion) => ({
          text: criterion.text,
          source: `${context.ticketKey} direct-requirement repair`,
        }))
      );
      const usedRepairIndexes = new Set<number>();
      const repaired = missingDirectRequirements.flatMap((requirement) => {
        const best = repairedCandidates
          .map((criterion, index) => ({ criterion, index, score: requirementCriterionMatchScore(requirement, criterion) }))
          .filter((candidate) => !usedRepairIndexes.has(candidate.index) && candidate.score > 0)
          .sort((left, right) => right.score - left.score || left.criterion.text.length - right.criterion.text.length)[0];
        if (!best) return [];
        usedRepairIndexes.add(best.index);
        return [best.criterion];
      });
      if (repaired.length) {
        finalCriteria = repairOverMergedCriteria(
          dedupeCriteria([...finalCriteria, ...repaired].map((criterion) => ({ text: criterion.text, source: criterion.source }))),
          granularityTarget
        );
      }
    } catch (error) {
      options.logger?.warn('context.ac_direct_requirement_repair_failed', {
        jiraKey: context.ticketKey,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  directRequirements = mapDirectRequirementsToCriteria(directRequirements, finalCriteria);
  const remainingDirectRequirements = directRequirements.filter(
    (requirement) => requirement.disposition !== 'out_of_scope' && !requirement.acceptanceCriteriaIds.length
  );
  if (remainingDirectRequirements.length) {
    // Do NOT append the raw source line as an AC — that fabricated near-duplicate "ACs" and was the final
    // amplifier of the count explosion. Leave the requirement unmapped: it stays visible in the traceability
    // diagnostics and reads as a genuine coverage gap, to be closed by sharpening a real AC rather than by
    // pasting source prose. The focused repair pass above already had its chance to cover true omissions.
    options.logger?.warn('context.ac_direct_requirements_unmapped', {
      jiraKey: context.ticketKey,
      requirementIds: remainingDirectRequirements.map((requirement) => requirement.id),
    });
  }

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
  // Output hygiene: strip empty parentheticals ("X ( )") the model emits when it leaves a value slot blank,
  // and drop any criterion left effectively empty — prevents a malformed " ( )" AC from shipping.
  finalCriteria = finalCriteria
    .map((criterion) => ({ ...criterion, text: criterion.text.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim() }))
    .filter((criterion) => criterion.text.replace(/[^a-z0-9]/gi, '').length >= 5);
  finalCriteria = restoreSourceFormatGrounding(finalCriteria, sourceGroundingExamples);
  // The scope-boundary filter can remove an over-broad criterion. Rebuild the inventory mapping from
  // the final criterion set so diagnostics and later per-case blockers never point to a removed AC.
  directRequirements = mapDirectRequirementsToCriteria(directRequirements, finalCriteria);
  // An in-scope requirement that maps to no criterion is a genuine coverage gap the numeric AC count hides.
  // (needs_clarification requirements are expected to be unmapped — they are handled by the blocker path.)
  const unmappedRequirementCount = directRequirements.filter(
    (requirement) => requirement.disposition === 'in_scope' && !requirement.acceptanceCriteriaIds.length
  ).length;
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
      synthesisFailureReason,
      acceptanceCriteriaNotProductionReady,
      acceptanceCriteriaNotProductionReadyReason,
      abnormalRequirementInventory,
      unmappedRequirementCount,
      rawAcceptanceCriteriaQuality: quality.quality,
      rawAcceptanceCriteriaWeakSignals: quality.weakSignals,
      discardedFragmentCount: quality.discarded.length,
      discardedFragmentExamples: quality.discarded.slice(0, 5).map((criterion) => criterion.text),
      crossSourceConflicts,
      directRequirements,
    },
  };
}
