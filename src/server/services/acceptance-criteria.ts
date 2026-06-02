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
