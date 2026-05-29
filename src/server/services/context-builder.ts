import { extractPageId, type SimplifiedIssue } from './atlassian';
import type { Logger } from './logger';
import type { AcceptanceCriteriaDiagnostics, ConfluencePageSummary, LinkedIssueSummary, QaContext, ScopedItem, ScopeConfluenceSection } from '../../shared/contracts';

interface QaContextOptions {
  feOnly?: boolean;
  beAlreadyTested?: boolean;
  includeComments?: boolean;
  notes?: string;
  logger?: Logger;
}

interface PageRefSource {
  issueKey: string;
  sourceType: string;
  relationship?: string;
  anchor?: string;
}

interface PageRef {
  pageId: string;
  title?: string;
  url?: string;
  sources: PageRefSource[];
}

interface ConfluenceReference {
  pageId: string;
  url: string;
  anchor: string;
  issueKey: string;
  sourceType: string;
  relationship: string;
}

interface StorySection {
  matched: boolean;
  title: string;
  body: string;
  reason: string;
  matchQuality?: 'confident' | 'broad' | 'none';
  confidence?: number;
}

type CriteriaExtractionMode = 'main' | 'story' | 'scoped';

interface CriteriaExtractionResult {
  items: Array<{ text: string; source: string }>;
  ignoredMetadataLabels: string[];
}

interface CriteriaSelectionResult {
  acceptanceCriteria: ScopedItem[];
  acceptanceCriteriaSource: string;
  selectionReason: string;
  ignoredSources: string[];
  ignoredMetadataLabels: string[];
}

interface QaClient {
  getIssue(issueKey: string): Promise<SimplifiedIssue>;
  getRemoteLinks(issueKey: string): Promise<Array<Record<string, any>>>;
  getConfluencePage(pageId: string): Promise<{ id: string; title?: string; status?: string; webUrl?: string | null; body: string }>;
  getConfluenceComments(pageId: string): Promise<Array<{ id: string; body: string }>>;
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

function stripBracketPrefixes(value: string): string {
  return String(value || '')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .trim();
}

export function canonicalize(value: unknown): string {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/[#_*`"]/g, ' ')
    .replace(/[-+/_().,:;|[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMatchText(value: unknown): string {
  return canonicalize(value)
    .replace(/\bscoring\b/g, ' score ')
    .replace(/\bscored\b/g, ' score ')
    .replace(/\bscores\b/g, ' score ')
    .replace(/\bresults\b/g, ' result ')
    .replace(/\bexecutive\b/g, ' executive ')
    .replace(/\bsummary\b/g, ' summary ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeMatchText(value: string): string[] {
  return normalizeMatchText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function dedupeScopedItems(items: Array<{ text: string; source?: string }>, prefix: string): ScopedItem[] {
  const seen = new Set<string>();
  const output: ScopedItem[] = [];

  for (const item of items || []) {
    const key = canonicalize(item.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({
      id: `${prefix}-${output.length + 1}`,
      text: normalizeInlineText(item.text),
      source: item.source,
    });
  }

  return output;
}

function cleanListLine(line: string): string {
  return normalizeInlineText(
    String(line || '')
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[\.)]\s+/, '')
      .replace(/^[a-z][\.)]\s+/i, '')
      .replace(/^AC[-\s_:]*\d+[\.)]?\s*/i, '')
  );
}

function metadataLabelForLine(line: string): string | null {
  const match = normalizeInlineText(line).match(/^([A-Za-z][A-Za-z /_-]{0,40}|FF)\s*:/);
  if (!match) return null;
  return normalizeInlineText(match[1]).toUpperCase() || null;
}

function isIgnoredStoryMetadataLabel(label: string | null): boolean {
  if (!label) return false;
  return /^(FF|FEATURE FLAG|PRD|FIGMA|DESIGN|TECH DESIGN|WIKI|COMMENT|COMMENTS|LINK|LINKS|NOTE|NOTES)$/i.test(label);
}

function isLikelyHeading(line: string): boolean {
  const text = normalizeInlineText(line).replace(/:$/, '');
  if (!text) return false;
  if (/^(acceptance criteria|user story|description|notes|out of scope|definition of done|scope|background)$/i.test(text)) return true;
  return /^[A-Z0-9][A-Za-z0-9 /&()_-]{2,120}$/.test(text);
}

function isCriterionText(text: string): boolean {
  return (
    text.length >= 8 &&
    /(should|must|required|able|unable|cannot|can not|display|shown|hidden|enabled|disabled|sync|update|prevent|allow|error|match|return|persist|appear)/i.test(text)
  );
}

function isListItemStart(line: string): boolean {
  return /^(\d+[\.)]|[a-z][\.)]|[-*•]|AC[-\s_:]*\d+)/i.test(line);
}

function shouldEndCriteriaSection(line: string): boolean {
  return isLikelyHeading(line) && !/^AC[-\s_:]*\d+/i.test(line);
}

function isExplicitRequirementHeading(line: string): boolean {
  return /^(acceptance criteria|acceptance|ac|requirements|requirement|expected result|expected behavior|behaviour|behavior|rules)[:]?$/i.test(
    normalizeInlineText(line)
  );
}

function extractListBlockCriteria(lines: string[], source: string): Array<{ text: string; source: string }> {
  const criteria: Array<{ text: string; source: string }> = [];
  let currentItem = '';

  for (const line of lines) {
    if (isListItemStart(line)) {
      if (currentItem && isCriterionText(cleanListLine(currentItem))) {
        criteria.push({ text: cleanListLine(currentItem), source });
      }
      currentItem = line;
      continue;
    }

    if (currentItem) {
      if (shouldEndCriteriaSection(line)) {
        if (isCriterionText(cleanListLine(currentItem))) {
          criteria.push({ text: cleanListLine(currentItem), source });
        }
        currentItem = '';
        continue;
      }
      currentItem = `${currentItem} ${line}`.trim();
    }
  }

  if (currentItem && isCriterionText(cleanListLine(currentItem))) {
    criteria.push({ text: cleanListLine(currentItem), source });
  }

  return criteria;
}

function expandInlineRequirementLines(lines: string[]): string[] {
  const expanded: string[] = [];

  for (const rawLine of lines) {
    let line = String(rawLine || '').trim();
    if (!line) continue;

    const explicitHeadingMatch = line.match(/^((?:acceptance criteria|acceptance|ac|requirements|requirement|expected result|expected behavior|behaviour|behavior|rules)[:]?)(\s+.+)$/i);
    if (explicitHeadingMatch && /(?:^|\s)\d+[\.)]\s+/.test(explicitHeadingMatch[2])) {
      expanded.push(normalizeInlineText(explicitHeadingMatch[1]));
      line = explicitHeadingMatch[2].trim();
    }

    if (/^\d+[\.)]\s+/.test(line)) {
      const pieces = line.split(/(?=\s+\d+[\.)]\s+)/).map((piece) => normalizeInlineText(piece));
      expanded.push(...pieces.filter(Boolean));
      continue;
    }

    expanded.push(line);
  }

  return expanded;
}

function extractCriteriaByMode(text: string, source: string, mode: CriteriaExtractionMode): CriteriaExtractionResult {
  const lines = expandInlineRequirementLines(
    normalizeMultilineText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  );
  const criteria: Array<{ text: string; source: string }> = [];
  const ignoredMetadataLabels = new Set<string>();
  let inCriteriaSection = false;
  let currentItem = '';

  for (const line of lines) {
    const metadataLabel = metadataLabelForLine(line);
    if (mode === 'story' && isIgnoredStoryMetadataLabel(metadataLabel)) {
      if (metadataLabel) ignoredMetadataLabels.add(metadataLabel);
      if (currentItem) {
        criteria.push({ text: cleanListLine(currentItem), source });
        currentItem = '';
      }
      inCriteriaSection = false;
      continue;
    }

    if (isExplicitRequirementHeading(line)) {
      inCriteriaSection = true;
      if (currentItem) {
        criteria.push({ text: cleanListLine(currentItem), source });
        currentItem = '';
      }
      continue;
    }

    if (inCriteriaSection && shouldEndCriteriaSection(line) && !currentItem) {
      inCriteriaSection = false;
    }

    if (!inCriteriaSection) continue;

    if (isListItemStart(line)) {
      if (currentItem) {
        criteria.push({ text: cleanListLine(currentItem), source });
      }
      currentItem = line;
      continue;
    }

    if (currentItem) {
      currentItem = `${currentItem} ${line}`.trim();
      continue;
    }

    if (shouldEndCriteriaSection(line)) {
      inCriteriaSection = false;
    }
  }

  if (currentItem) {
    criteria.push({ text: cleanListLine(currentItem), source });
  }

  if (criteria.length) {
    return {
      items: criteria,
      ignoredMetadataLabels: [...ignoredMetadataLabels],
    };
  }

  if (mode === 'story') {
    return {
      items: [],
      ignoredMetadataLabels: [...ignoredMetadataLabels],
    };
  }

  const listBlockCriteria = extractListBlockCriteria(lines, source);
  if (listBlockCriteria.length) {
    return {
      items: listBlockCriteria,
      ignoredMetadataLabels: [...ignoredMetadataLabels],
    };
  }

  const inferred = lines
    .map((line) => cleanListLine(line))
    .filter((line) => isCriterionText(line))
    .map((line) => ({ text: line, source }));

  return {
    items: inferred,
    ignoredMetadataLabels: [...ignoredMetadataLabels],
  };
}

export function extractAcceptanceCriteriaFromText(text: string, source: string): Array<{ text: string; source: string }> {
  return extractCriteriaByMode(text, source, 'main').items;
}

export function extractUserStoriesFromText(text: string, source: string): Array<{ text: string; source: string }> {
  const stories: Array<{ text: string; source: string }> = [];
  const lines = normalizeMultilineText(text)
    .split('\n')
    .map((line) => normalizeInlineText(line))
    .filter(Boolean);

  for (const line of lines) {
    if (isDisplayableUserStory(line)) {
      stories.push({ text: line.replace(/^#+\s*/, ''), source });
    }
  }

  return stories;
}

export function classifyLinkedIssue(linkedIssue?: LinkedIssueSummary): string {
  if (!linkedIssue) return 'other';
  const relation = canonicalize(linkedIssue.linkRelation || linkedIssue.relation);
  const issueType = canonicalize(linkedIssue.issueType);
  if (relation === 'is child of' && issueType === 'story') return 'parent story';
  if (relation === 'is blocked by' || relation === 'blocks') return 'blocking dependency';
  if (issueType === 'task' || issueType === 'sub task' || issueType === 'sub-task') return 'related implementation';
  return 'other';
}

export function parseConfluenceReference(url: string, issueKey: string, sourceType: string, relationship = ''): ConfluenceReference | null {
  const raw = String(url || '').trim();
  if (!raw || !raw.includes('/wiki/')) return null;
  const pageId = extractPageId(raw);
  if (!pageId) return null;

  let anchor = '';
  try {
    const parsed = new URL(raw);
    anchor = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim();
  } catch {
    const hashIndex = raw.indexOf('#');
    if (hashIndex >= 0) anchor = decodeURIComponent(raw.slice(hashIndex + 1)).trim();
  }

  return {
    pageId,
    url: raw,
    anchor,
    issueKey,
    sourceType,
    relationship,
  };
}

function addPageRef(pageRefs: Map<string, PageRef>, ref: (ConfluenceReference & { title?: string }) | null): void {
  if (!ref || !ref.pageId) return;
  const existing = pageRefs.get(ref.pageId);
  if (!existing) {
    pageRefs.set(ref.pageId, {
      pageId: ref.pageId,
      title: ref.title || '',
      url: ref.url || '',
      sources: [
        {
          issueKey: ref.issueKey,
          sourceType: ref.sourceType,
          relationship: ref.relationship || '',
          anchor: ref.anchor || '',
        },
      ],
    });
    return;
  }

  if (!existing.title && ref.title) existing.title = ref.title;
  if (!existing.url && ref.url) existing.url = ref.url;
  const duplicate = existing.sources.some(
    (source) =>
      source.issueKey === ref.issueKey &&
      source.sourceType === ref.sourceType &&
      source.relationship === (ref.relationship || '') &&
      source.anchor === (ref.anchor || '')
  );
  if (!duplicate) {
    existing.sources.push({
      issueKey: ref.issueKey,
      sourceType: ref.sourceType,
      relationship: ref.relationship || '',
      anchor: ref.anchor || '',
    });
  }
}

export function extractConfluencePageRefsFromText(text: string, issueKey: string, sourceType: string): ConfluenceReference[] {
  const refs: ConfluenceReference[] = [];
  const urls = String(text || '').match(/https?:\/\/[^\s"'<>]+/g) || [];
  for (const rawUrl of urls) {
    const cleaned = rawUrl.replace(/[),.;]+$/, '');
    const ref = parseConfluenceReference(cleaned, issueKey, sourceType);
    if (ref) refs.push(ref);
  }
  return refs;
}

function addIssueTextPageRefs(pageRefs: Map<string, PageRef>, issue: SimplifiedIssue, sourceTypePrefix: string): void {
  for (const ref of extractConfluencePageRefsFromText(issue.description, issue.key, `${sourceTypePrefix}-description`)) {
    addPageRef(pageRefs, ref);
  }
  for (const ref of extractConfluencePageRefsFromText(issue.renderedDescription, issue.key, `${sourceTypePrefix}-rendered-description`)) {
    addPageRef(pageRefs, ref);
  }
  for (const comment of issue.comments || []) {
    for (const ref of extractConfluencePageRefsFromText(comment, issue.key, `${sourceTypePrefix}-comment`)) {
      addPageRef(pageRefs, ref);
    }
  }
}

async function addRemoteLinkPageRefs(client: QaClient, pageRefs: Map<string, PageRef>, issueKey: string, sourceType: string): Promise<void> {
  const remoteLinks = await client.getRemoteLinks(issueKey).catch(() => []);
  for (const link of remoteLinks || []) {
    const object = link.object || {};
    const ref = parseConfluenceReference(object.url, issueKey, sourceType, link.relationship);
    if (!ref) continue;
    addPageRef(pageRefs, {
      ...ref,
      title: object.title,
    });
  }
}

function mergeIssueMetadata(mainIssue: SimplifiedIssue, fetchedIssue: SimplifiedIssue): SimplifiedIssue & LinkedIssueSummary {
  const metaByKey = new Map<string, { relation?: string; summary?: string; issueType?: string }>((mainIssue.linkedIssues || []).map((issue) => [issue.key, issue]));
  const meta = metaByKey.get(fetchedIssue.key);
  return {
    ...fetchedIssue,
    linkRelation: meta?.relation,
    linkSummary: meta?.summary,
  };
}

function extractMainIssueCriteria(mainIssue: SimplifiedIssue): ScopedItem[] {
  const descriptionResult = extractCriteriaByMode(mainIssue.description, `${mainIssue.key} description`, 'main');
  const renderedDescriptionResult = extractCriteriaByMode(mainIssue.renderedDescription, `${mainIssue.key} rendered description`, 'main');
  return dedupeScopedItems(
    [
      ...descriptionResult.items,
      ...renderedDescriptionResult.items,
    ],
    'AC'
  );
}

function extractStoryCriteria(storyIssue?: SimplifiedIssue | null): ScopedItem[] {
  if (!storyIssue) return [];
  const descriptionResult = extractCriteriaByMode(storyIssue.description, `${storyIssue.key} description`, 'story');
  const renderedDescriptionResult = extractCriteriaByMode(storyIssue.renderedDescription, `${storyIssue.key} rendered description`, 'story');
  return dedupeScopedItems(
    [
      ...descriptionResult.items,
      ...renderedDescriptionResult.items,
    ],
    'AC'
  );
}

function isStoryHeadingLine(line: string): boolean {
  return /^\s*#*\s*\d+\.\s+as a\b/i.test(line) || /^\s*#*\s*as a\b/i.test(line);
}

function cleanHeadingText(line: string): string {
  return normalizeInlineText(String(line || '').replace(/^#+\s*/, ''));
}

function isDisplayableUserStory(text: string): boolean {
  const normalized = normalizeInlineText(text);
  if (!normalized) return false;
  if (!/^as\b/i.test(normalized) && !/^\d+\.\s+as\b/i.test(normalized)) return false;
  if (!/i want\b/i.test(normalized)) return false;
  if (normalized.length < 18) return false;
  if (/^[^A-Za-z]*AI:?$/i.test(normalized)) return false;
  return true;
}

function isThinMainIssue(mainIssue: SimplifiedIssue, mainIssueCriteria: ScopedItem[]): boolean {
  if (mainIssueCriteria.length > 0) return false;
  const description = normalizeMultilineText([mainIssue.summary || '', mainIssue.description || '', mainIssue.renderedDescription || ''].join('\n'));
  const stripped = stripBracketPrefixes(description);
  if (stripped.length < 80) return true;
  const meaningfulLines = stripped
    .split('\n')
    .map((line) => normalizeInlineText(line))
    .filter((line) => line.length >= 20);
  return meaningfulLines.length <= 1;
}

function deriveTitleSignals(mainIssue: SimplifiedIssue, storySummary: string): string[] {
  const rawSegments = [
    stripBracketPrefixes(mainIssue.summary || ''),
    ...stripBracketPrefixes(mainIssue.summary || '')
      .split(/\s+[–-]\s+/)
      .map((segment) => segment.trim())
      .filter(Boolean),
    storySummary || '',
  ];

  const output: string[] = [];
  const seen = new Set<string>();

  for (const segment of rawSegments) {
    const normalized = normalizeMatchText(segment);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(segment.trim());
  }

  return output;
}

interface RankedPrdSection {
  heading: string;
  body: string;
  score: number;
  confidence: number;
}

function isPrdSubheading(line: string): boolean {
  const text = cleanHeadingText(line).replace(/:$/, '');
  if (!text) return false;
  if (isStoryHeadingLine(text)) return false;
  if (/^(acceptance criteria|requirements|expected result|expected behavior|goals|non-goals|feature flag|data flow|background|ui behavior|scope)$/i.test(text)) {
    return false;
  }
  if (/^[-*•]/.test(line)) return false;
  if (/^\d+[\.)]\s+/.test(line) && /\bAs a\b/i.test(text)) return false;
  if (text.length > 90) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 /&()_-]*$/.test(text);
}

function parsePrdSubsections(body: string): Array<{ heading: string; body: string }> {
  const lines = normalizeMultilineText(body)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = '';
  let currentBody: string[] = [];

  const flush = () => {
    if (!currentHeading || !currentBody.length) return;
    sections.push({
      heading: currentHeading,
      body: currentBody.join('\n').trim(),
    });
  };

  for (const line of lines) {
    if (isPrdSubheading(line)) {
      flush();
      currentHeading = cleanHeadingText(line).replace(/:$/, '');
      currentBody = [];
      continue;
    }

    if (currentHeading) currentBody.push(line);
  }

  flush();
  return sections;
}

function scorePrdSubsection(heading: string, body: string, titleSignals: string[]): RankedPrdSection {
  const headingNormalized = normalizeMatchText(heading);
  const bodyNormalized = normalizeMatchText(body.slice(0, 800));
  const headingTokens = new Set(tokenizeMatchText(heading));
  let score = 0;

  for (const signal of titleSignals) {
    const normalizedSignal = normalizeMatchText(signal);
    if (!normalizedSignal) continue;
    const signalTokens = tokenizeMatchText(signal);
    const overlap = signalTokens.filter((token) => headingTokens.has(token)).length;

    if (headingNormalized === normalizedSignal) score += 12;
    else if (headingNormalized.includes(normalizedSignal) || normalizedSignal.includes(headingNormalized)) score += 9;
    else if (bodyNormalized.includes(normalizedSignal)) score += 4;

    score += overlap * 2;

    if (/no score/.test(normalizedSignal) && /no score/.test(headingNormalized)) score += 6;
    if (/ai summary/.test(normalizedSignal) && /ai summary/.test(headingNormalized)) score += 4;
    if (/executive summary/.test(normalizedSignal) && /summary/.test(headingNormalized)) score += 3;
  }

  const confidence = Math.min(1, score / 18);
  return { heading, body, score, confidence };
}

function rankPrdSubsection(
  baseSection: StorySection,
  mainIssue: SimplifiedIssue,
  storySummary: string
): StorySection | null {
  const subsections = parsePrdSubsections(baseSection.body || '');
  if (!subsections.length) return null;

  const titleSignals = deriveTitleSignals(mainIssue, storySummary);
  const ranked = subsections
    .map((section) => scorePrdSubsection(section.heading, section.body, titleSignals))
    .filter((section) => section.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.body.length - right.body.length;
    });

  if (!ranked.length) return null;

  const best = ranked[0];
  const second = ranked[1];
  const closeMatch = second && Math.abs(best.score - second.score) <= 2;
  const matchQuality: 'confident' | 'broad' = best.score >= 10 && !closeMatch ? 'confident' : 'broad';

  return {
    matched: true,
    title: best.heading,
    body: best.body,
    reason: '',
    matchQuality,
    confidence: Number(best.confidence.toFixed(2)),
  };
}

export function anchorToHeading(anchor: string): string {
  const text = String(anchor || '').replace(/^#/, '').replace(/\+/g, ' ').replace(/-/g, ' ');
  return normalizeInlineText(text);
}

export function isolateStorySection(body: string, anchor: string, storySummary: string): StorySection {
  const lines = normalizeMultilineText(body)
    .split('\n')
    .map((line) => line.trim());
  const anchorText = anchorToHeading(anchor);
  const anchorCanonical = canonicalize(anchorText);
  const storyCanonical = canonicalize(storySummary);

  let start = -1;
  let matchedHeading = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const heading = cleanHeadingText(line);
    const headingCanonical = canonicalize(heading);
    const headingMatchesAnchor = Boolean(anchorCanonical) && (headingCanonical.includes(anchorCanonical) || anchorCanonical.includes(headingCanonical));
    const headingMatchesStory = Boolean(storyCanonical) && (headingCanonical.includes(storyCanonical) || storyCanonical.includes(headingCanonical));
    if ((isStoryHeadingLine(line) || headingMatchesAnchor || headingMatchesStory) && (headingMatchesAnchor || headingMatchesStory)) {
      start = index;
      matchedHeading = heading;
      break;
    }
  }

  if (start < 0) {
    return {
      matched: false,
      title: '',
      body: '',
      reason: anchor
        ? 'Story found, but PRD anchor did not resolve to a unique section.'
        : 'Story found, but PRD section could not be matched from the linked story title.',
      matchQuality: 'none',
      confidence: 0,
    };
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isStoryHeadingLine(lines[index])) {
      end = index;
      break;
    }
  }

  return {
    matched: true,
    title: matchedHeading,
    body: lines.slice(start, end).join('\n').trim(),
    reason: '',
    matchQuality: 'confident',
    confidence: 1,
  };
}

function hasExplicitRequirementSection(text: string): boolean {
  return /(?:^|\n)\s*(acceptance criteria|acceptance|ac|requirements|requirement|expected result|expected behavior|behaviour|behavior|rules)\s*:?\s*(?:\n|$)/i.test(
    String(text || '')
  );
}

function selectAcceptanceCriteria(
  mainIssueCriteria: ScopedItem[],
  parentStoryCriteria: ScopedItem[],
  scopedSectionCriteria: ScopedItem[],
  mainIssue: SimplifiedIssue,
  scopeConfluenceSection: ScopeConfluenceSection | null,
  storyMetadataLabels: string[],
  mainIssueThin: boolean
): CriteriaSelectionResult {
  if (mainIssueCriteria.length > 0) {
    return {
      acceptanceCriteria: mainIssueCriteria,
      acceptanceCriteriaSource: 'main_jira',
      selectionReason: hasExplicitRequirementSection(mainIssue.description) || hasExplicitRequirementSection(mainIssue.renderedDescription)
        ? 'Main Jira explicit AC detected.'
        : 'Main Jira requirements inferred from numbered description items.',
      ignoredSources: [
        ...(parentStoryCriteria.length > 0 ? ['parent_story_jira'] : []),
        ...(scopedSectionCriteria.length > 0 ? ['parent_story_confluence_section'] : []),
      ],
      ignoredMetadataLabels: storyMetadataLabels,
    };
  }

  if (scopedSectionCriteria.length > 0) {
    return {
      acceptanceCriteria: scopedSectionCriteria,
      acceptanceCriteriaSource: 'parent_story_confluence_section',
      selectionReason: mainIssueThin
        ? scopeConfluenceSection?.matched
          ? scopeConfluenceSection?.reason || 'Main Jira scope was insufficient, so the matched PRD subsection was used.'
          : 'Main Jira scope was insufficient, so the scoped PRD subsection was used.'
        : scopeConfluenceSection?.matched
          ? 'Main Jira scope was insufficient, so the matched PRD subsection was used.'
          : 'Main Jira scope was insufficient, so the scoped PRD subsection was used.',
      ignoredSources: parentStoryCriteria.length > 0 ? ['parent_story_jira'] : [],
      ignoredMetadataLabels: storyMetadataLabels,
    };
  }

  if (parentStoryCriteria.length > 0) {
    return {
      acceptanceCriteria: parentStoryCriteria,
      acceptanceCriteriaSource: 'parent_story_jira',
      selectionReason: 'Main Jira scope was insufficient, so explicit parent Story acceptance criteria were used.',
      ignoredSources: [],
      ignoredMetadataLabels: storyMetadataLabels,
    };
  }

  return {
    acceptanceCriteria: [],
    acceptanceCriteriaSource: 'none',
    selectionReason: 'No trustworthy acceptance criteria were extracted from the main Jira ticket, parent Story, or scoped PRD section.',
    ignoredSources: [],
    ignoredMetadataLabels: storyMetadataLabels,
  };
}

function determineConfidence(
  mainCriteria: ScopedItem[],
  scopedSectionCriteria: ScopedItem[],
  parentStory: LinkedIssueSummary | null,
  scopeConfluenceSection: ScopeConfluenceSection | null,
  mainIssueThin: boolean
) {
  const reasons: string[] = [];

  if (mainCriteria.length > 0) {
    return {
      confidenceLevel: 'high' as const,
      confidenceReasons: ['Main Jira ticket contains explicit acceptance criteria.'],
      requiresConfidencePermission: false,
    };
  }

  if (scopedSectionCriteria.length > 0 && scopeConfluenceSection && scopeConfluenceSection.matched) {
    const confidenceLevel: 'high' | 'medium' = scopeConfluenceSection.reason.includes('broadly') ? 'medium' : 'high';
    return {
      confidenceLevel,
      confidenceReasons: [
        scopeConfluenceSection.reason || 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
        ...(mainIssueThin ? ['Main Jira scope was insufficient, so the matched PRD subsection was used.'] : []),
      ],
      requiresConfidencePermission: false,
    };
  }

  if (!parentStory) {
    reasons.push('No parent Story linked via is child of.');
  } else if (!scopeConfluenceSection || !scopeConfluenceSection.pageId) {
    reasons.push('Parent Story found, but no linked PRD section was found in the Story description.');
  } else if (!scopeConfluenceSection.matched) {
    reasons.push(scopeConfluenceSection.reason || 'Story found, but PRD anchor did not resolve to a unique section.');
  } else {
    reasons.push('Parent Story was resolved, but no scoped acceptance criteria were found in the matched section.');
  }

  const confidenceLevel: 'medium' | 'low' = parentStory ? 'medium' : 'low';
  return {
    confidenceLevel,
    confidenceReasons: reasons,
    requiresConfidencePermission: true,
  };
}

function buildContextSummary(mainIssue: SimplifiedIssue, linkedIssues: LinkedIssueSummary[], confluencePages: ConfluencePageSummary[]): AcceptanceCriteriaDiagnostics {
  const issueSources = [mainIssue, ...linkedIssues.filter((issue) => !issue.fetchError)] as Array<SimplifiedIssue | LinkedIssueSummary>;
  return {
    allIssueUserStories: dedupeScopedItems(
      issueSources.flatMap((issue) => [
        ...extractUserStoriesFromText(issue.summary || '', `${issue.key} summary`),
        ...extractUserStoriesFromText((issue as SimplifiedIssue).description || '', `${issue.key} description`),
      ]),
      'US'
    ),
    allIssueCriteria: dedupeScopedItems(
      issueSources.flatMap((issue) => [
        ...extractAcceptanceCriteriaFromText((issue as SimplifiedIssue).description || '', `${issue.key} description`),
        ...extractAcceptanceCriteriaFromText((issue as SimplifiedIssue).renderedDescription || '', `${issue.key} rendered description`),
      ]),
      'AC'
    ),
    confluenceCriteria: dedupeScopedItems(
      confluencePages
        .filter((page) => !page.fetchError)
        .flatMap((page) => extractAcceptanceCriteriaFromText(page.body || '', `${page.id} ${page.title || 'Confluence page'}`)),
      'AC'
    ),
  };
}

export async function buildQaContext(client: QaClient, jiraKey: string, options: QaContextOptions = {}): Promise<QaContext> {
  const log = options.logger;
  const mainIssue = await client.getIssue(jiraKey);
  const linkedIssueKeys = new Set<string>();

  for (const linked of mainIssue.linkedIssues || []) {
    if (linked.key) linkedIssueKeys.add(linked.key);
  }
  for (const subtask of mainIssue.subtasks || []) {
    if (subtask.key) linkedIssueKeys.add(subtask.key);
  }

  const linkedIssues: LinkedIssueSummary[] = [];
  for (const key of linkedIssueKeys) {
    try {
      const fetched = await client.getIssue(key);
      linkedIssues.push(mergeIssueMetadata(mainIssue, fetched));
    } catch (error) {
      const meta = (mainIssue.linkedIssues || []).find((issue) => issue.key === key);
      linkedIssues.push({
        key,
        fetchError: (error as Error).message,
        linkRelation: meta?.relation,
        issueType: meta?.issueType,
        summary: meta?.summary,
      });
    }
  }

  const pageRefs = new Map<string, PageRef>();
  addIssueTextPageRefs(pageRefs, mainIssue, 'main');
  await addRemoteLinkPageRefs(client, pageRefs, mainIssue.key, 'main-remote-link');

  for (const issue of linkedIssues) {
    if (issue.fetchError) continue;
    addIssueTextPageRefs(pageRefs, issue as SimplifiedIssue, 'linked');
    await addRemoteLinkPageRefs(client, pageRefs, issue.key, 'linked-remote-link');
  }

  const confluencePages: ConfluencePageSummary[] = [];
  for (const ref of pageRefs.values()) {
    try {
      const page = await client.getConfluencePage(ref.pageId);
      const comments = options.includeComments ? await client.getConfluenceComments(ref.pageId) : [];
      confluencePages.push({ ...page, sourceRefs: ref.sources, sourceUrl: ref.url, comments });
    } catch (error) {
      confluencePages.push({
        id: ref.pageId,
        title: ref.title,
        sourceRefs: ref.sources,
        sourceUrl: ref.url,
        fetchError: (error as Error).message,
      });
    }
  }

  const classifiedLinkedIssues = linkedIssues.map((issue) => ({
    ...issue,
    classification: classifyLinkedIssue(issue),
  }));
  const mainIssueCriteria = extractMainIssueCriteria(mainIssue);
  const mainIssueThin = isThinMainIssue(mainIssue, mainIssueCriteria);
  const scopeParentIssue = classifiedLinkedIssues.find((issue) => issue.classification === 'parent story' && !issue.fetchError) || null;
  const scopeParentRelation = scopeParentIssue ? scopeParentIssue.linkRelation || 'is child of' : '';

  let scopeConfluenceSection: ScopeConfluenceSection | null = null;
  let scopedSectionCriteria: ScopedItem[] = [];
  let scopedSectionStories: ScopedItem[] = [];

  if (scopeParentIssue) {
    const storyRefs = [
      ...extractConfluencePageRefsFromText((scopeParentIssue as unknown as SimplifiedIssue).description || '', scopeParentIssue.key, 'parent-story-description'),
      ...extractConfluencePageRefsFromText((scopeParentIssue as unknown as SimplifiedIssue).renderedDescription || '', scopeParentIssue.key, 'parent-story-rendered-description'),
    ];
    const preferredStoryRef = storyRefs.find((ref) => ref.anchor) || storyRefs[0] || null;
    if (preferredStoryRef) {
      const page = confluencePages.find((candidate) => candidate.id === preferredStoryRef.pageId);
      if (page && !page.fetchError) {
        const section = isolateStorySection(page.body || '', preferredStoryRef.anchor, scopeParentIssue.summary || '');
        const subsectionBase = section.matched
          ? section
          : {
              matched: true,
              title: page.title || scopeParentIssue.summary || '',
              body: page.body || '',
              reason: '',
              matchQuality: 'broad' as const,
              confidence: 0.4,
            };
        const thinFallbackCandidate = mainIssueThin ? rankPrdSubsection(subsectionBase, mainIssue, scopeParentIssue.summary || '') : null;
        const effectiveSection = thinFallbackCandidate || section;
        scopeConfluenceSection = {
          pageId: page.id,
          title: page.title || '',
          url: preferredStoryRef.url || page.webUrl || '',
          anchor: preferredStoryRef.anchor || '',
          matchedHeading: effectiveSection.title,
          matched: effectiveSection.matched,
          reason:
            effectiveSection.matchQuality === 'broad'
              ? `Parent Story was resolved and a PRD subsection was matched broadly from the thin ticket title.`
              : effectiveSection.reason,
          sourceIssueKey: scopeParentIssue.key,
          body: effectiveSection.body,
        };
        if (effectiveSection.matched) {
          scopedSectionCriteria = dedupeScopedItems(
            extractAcceptanceCriteriaFromText(effectiveSection.body, `${page.id} ${effectiveSection.title || page.title}`),
            'AC'
          );
          scopedSectionStories = dedupeScopedItems(
            [
              ...(isDisplayableUserStory(scopeParentIssue.summary || '')
                ? [{ text: scopeParentIssue.summary || '', source: `${scopeParentIssue.key} summary` }]
                : []),
              ...(isDisplayableUserStory(effectiveSection.title || '') ? [{ text: effectiveSection.title || '', source: `${page.id} ${page.title}` }] : []),
            ],
            'US'
          );
        }
      } else {
        scopeConfluenceSection = {
          pageId: preferredStoryRef.pageId,
          title: '',
          url: preferredStoryRef.url || '',
          anchor: preferredStoryRef.anchor || '',
          matchedHeading: '',
          matched: false,
          reason: page?.fetchError
            ? `Story found, but linked PRD page fetch failed: ${page.fetchError}`
            : 'Story found, but linked PRD page could not be fetched.',
          sourceIssueKey: scopeParentIssue.key,
          body: '',
        };
      }
    } else {
      scopeConfluenceSection = {
        pageId: '',
        title: '',
        url: '',
        anchor: '',
        matchedHeading: '',
        matched: false,
        reason: 'Parent Story found, but no linked PRD section was found in the Story description.',
        sourceIssueKey: scopeParentIssue.key,
        body: '',
      };
    }
  }

  const storyDescriptionResult = extractCriteriaByMode(
    (scopeParentIssue as unknown as SimplifiedIssue | null)?.description || '',
    scopeParentIssue ? `${scopeParentIssue.key} description` : '',
    'story'
  );
  const storyRenderedDescriptionResult = extractCriteriaByMode(
    (scopeParentIssue as unknown as SimplifiedIssue | null)?.renderedDescription || '',
    scopeParentIssue ? `${scopeParentIssue.key} rendered description` : '',
    'story'
  );
  const parentStoryCriteria = dedupeScopedItems(
    [...storyDescriptionResult.items, ...storyRenderedDescriptionResult.items],
    'AC'
  );
  const selection = selectAcceptanceCriteria(
    mainIssueCriteria,
    parentStoryCriteria,
    scopedSectionCriteria,
    mainIssue,
    scopeConfluenceSection,
    [...new Set([...storyDescriptionResult.ignoredMetadataLabels, ...storyRenderedDescriptionResult.ignoredMetadataLabels])],
    mainIssueThin
  );
  log?.info('context.scope_selection', {
    jiraKey: mainIssue.key,
    mainIssueCriteriaCount: mainIssueCriteria.length,
    parentStoryCriteriaCount: parentStoryCriteria.length,
    scopedSectionCriteriaCount: scopedSectionCriteria.length,
    acceptanceCriteriaSource: selection.acceptanceCriteriaSource,
    acceptanceCriteriaCount: selection.acceptanceCriteria.length,
    scopeParentIssueKey: scopeParentIssue?.key || '',
    scopeConfluencePageId: scopeConfluenceSection?.pageId || '',
    scopeConfluenceMatched: scopeConfluenceSection?.matched || false,
    ignoredSources: selection.ignoredSources,
    ignoredMetadataLabels: selection.ignoredMetadataLabels,
  });
  if (scopeConfluenceSection && !scopeConfluenceSection.matched) {
    log?.warn('context.prd_scope_unmatched', {
      jiraKey: mainIssue.key,
      scopeParentIssueKey: scopeParentIssue?.key || '',
      pageId: scopeConfluenceSection.pageId,
      reason: scopeConfluenceSection.reason,
    });
  }

  const userStories = dedupeScopedItems(
    [
      ...(scopeParentIssue && isDisplayableUserStory(scopeParentIssue.summary || '')
        ? [{ text: scopeParentIssue.summary || '', source: `${scopeParentIssue.key} summary` }]
        : []),
      ...scopedSectionStories,
    ],
    'US'
  );

  const allUserStoryCandidates = [
    ...(scopeParentIssue ? [{ text: scopeParentIssue.summary || '', source: `${scopeParentIssue.key} summary` }] : []),
    ...(scopeConfluenceSection?.matchedHeading ? [{ text: scopeConfluenceSection.matchedHeading, source: `${scopeConfluenceSection.pageId} heading` }] : []),
  ];
  const discardedUserStoryFragments = allUserStoryCandidates.filter((candidate) => !isDisplayableUserStory(candidate.text));

  const confidence = determineConfidence(mainIssueCriteria, scopedSectionCriteria, scopeParentIssue, scopeConfluenceSection, mainIssueThin);
  const diagnostics = buildContextSummary(mainIssue, classifiedLinkedIssues, confluencePages);
  const epic = mainIssue.parent && mainIssue.parent.summary;

  return {
    ticketKey: mainIssue.key,
    epic: epic || 'Unknown Epic',
    mainIssue,
    linkedIssues: classifiedLinkedIssues,
    confluencePages,
    scopeParentIssue,
    scopeParentRelation,
    scopeConfluenceSection,
    acceptanceCriteria: selection.acceptanceCriteria,
    userStories,
    acceptanceCriteriaSource: selection.acceptanceCriteriaSource,
    confidenceLevel: confidence.confidenceLevel,
    confidenceReasons: [
      ...confidence.confidenceReasons,
      ...(selection.selectionReason && !confidence.confidenceReasons.includes(selection.selectionReason) ? [selection.selectionReason] : []),
      ...selection.ignoredSources.map((source) =>
        source === 'parent_story_jira'
          ? 'Parent Story AC ignored because main Jira AC exists.'
          : 'Scoped PRD AC ignored because main Jira AC exists.'
      ),
      ...selection.ignoredMetadataLabels.map((label) => `Story metadata ignored: ${label}.`),
    ],
    requiresConfidencePermission: confidence.requiresConfidencePermission,
    acceptanceCriteriaDiagnostics: {
      ...diagnostics,
      selectedAcceptanceCriteriaSource: selection.acceptanceCriteriaSource,
      selectedAcceptanceCriteriaReason: selection.selectionReason,
      ignoredSources: selection.ignoredSources,
      ignoredMetadataLabels: selection.ignoredMetadataLabels,
      thinTicketFallbackUsed: mainIssueThin && selection.acceptanceCriteriaSource === 'parent_story_confluence_section',
      prdSubsectionMatchQuality: scopeConfluenceSection?.matched ? (scopeConfluenceSection.reason.includes('broadly') ? 'broad' : 'confident') : 'none',
      matchedPrdSubsectionHeading: scopeConfluenceSection?.matchedHeading || '',
      matchedPrdSubsectionConfidence: scopeConfluenceSection?.matched ? (scopeConfluenceSection.reason.includes('broadly') ? 0.6 : 1) : 0,
      userStoryFragmentsDiscardedCount: discardedUserStoryFragments.length,
    },
    constraints: {
      feOnly: Boolean(options.feOnly),
      beAlreadyTested: Boolean(options.beAlreadyTested),
      notes: options.notes || '',
    },
    actualDevScopeGuidance:
      'Use the main Jira issue for implementation-specific acceptance criteria, then the linked parent Story and its targeted PRD subsection for canonical scope. Blocking and BE tickets are context only.',
  };
}
