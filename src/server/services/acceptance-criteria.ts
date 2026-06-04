import type { QaContext, ScopedItem } from '../../shared/contracts';
import type { Logger } from './logger';
import { canonicalize } from './context-builder';

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
}

export interface AcceptanceCriteriaSynthesisResult {
  acceptanceCriteria: Array<{ id?: string; text: string; rationale?: string }>;
  provider?: string;
  model?: string;
}

export interface AcceptanceCriteriaFinalizationOptions {
  synthesizer?: (input: AcceptanceCriteriaSynthesisInput) => Promise<AcceptanceCriteriaSynthesisResult>;
  logger?: Logger;
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
  return /(should|must|required|display|shown|hidden|enabled|disabled|render|save|open|select|preserve|payload|dataset|polygon|multipolygon|location|marker|label|popup|traceable|mapped|fallback|gate|prevent|allow|include|exclude|sync|summary|narrative|score|scoring|risk|takeaways|tab|characteristics|signals|zone)/i.test(
    text
  );
}

export function parseMainIssueSections(text: string): ParsedIssueSection[] {
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

function resolveAuthorityExcerptSource(context: QaContext): { body: string; location: string; url?: string; kind: 'jira' | 'prd' } | null {
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

function attachSourceExcerpts(criteria: ScopedItem[], context: QaContext, logger?: Logger): ScopedItem[] {
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

  const candidates = splitAuthorityIntoExcerptCandidates(authority.body);
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

    const excerptMatches: NonNullable<ScopedItem['sourceExcerpts']> = (selected.length ? selected : weakFallback).map((entry) => ({
      text: trimExcerpt(entry.candidate),
      location: authority.location,
      url: authority.url,
      kind: authority.kind,
      confidence: selected.length ? (entry.verbatim ? 'verbatim' : 'closest') : 'weak',
    }));
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

  return result;
}

export async function finalizeAcceptanceCriteria(
  context: QaContext,
  options: AcceptanceCriteriaFinalizationOptions = {}
): Promise<QaContext> {
  const quality = assessAcceptanceCriteriaQuality(context.acceptanceCriteria || []);
  const mainIssueBody = context.mainIssue.description || context.mainIssue.renderedDescription || '';
  const parsedSections = parseMainIssueSections(mainIssueBody);
  const granularityTarget = determineContextGranularityTarget(context, parsedSections, mainIssueBody);

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
  finalCriteria = attachSourceExcerpts(finalCriteria, context, options.logger);

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
    },
  };
}
