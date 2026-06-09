import { extractPageId, extractText, type SimplifiedIssue } from './atlassian';
import { resolveScopeType } from './api-docs';
import type { Logger } from './logger';
import type { AcceptanceCriteriaDiagnostics, ConfluencePageSummary, LinkedIssueSummary, QaContext, QaScopeType, ScopeAuthority, ScopedItem, ScopeConfluenceSection } from '../../shared/contracts';

interface QaContextOptions {
  feOnly?: boolean;
  scopeType?: QaScopeType;
  apiDocsUrl?: string;
  beAlreadyTested?: boolean;
  includeComments?: boolean;
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

interface AdfBlock {
  kind: 'heading' | 'block';
  level: number;
  text: string;
  nodeType: string;
}

interface StorySection {
  matched: boolean;
  title: string;
  body: string;
  reason: string;
  matchQuality?: 'confident' | 'broad' | 'none';
  confidence?: number;
  candidates?: Array<{ heading: string; score: number; confidence: number }>;
  regionBlocks?: AdfBlock[];
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
  getConfluencePage(pageId: string): Promise<{ id: string; title?: string; status?: string; webUrl?: string | null; body: string; adf?: unknown }>;
  getConfluenceComments(pageId: string): Promise<Array<{ id: string; body: string }>>;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, iteratee: (item: T, index: number) => Promise<R>): Promise<R[]> {
  // Fetch linked Jira/Confluence data in parallel without opening an unbounded number of upstream requests.
  const safeLimit = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  return results;
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

    if (!inAcceptanceSection && line) kept.push(line);
  }

  return kept.join('\n').trim();
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
  // Prefer explicit AC/requirements sections; broader inference is a fallback and is stricter for parent stories.
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
  // Pull Confluence links from Jira descriptions/comments where remote-link metadata is often missing.
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

async function getRemoteLinkPageRefs(client: QaClient, issueKey: string, sourceType: string): Promise<ConfluenceReference[]> {
  // Remote links are the most reliable place to get the PRD title and relationship label.
  const remoteLinks = await client.getRemoteLinks(issueKey).catch(() => []);
  const refs: Array<ConfluenceReference & { title?: string }> = [];
  for (const link of remoteLinks || []) {
    const object = link.object || {};
    const ref = parseConfluenceReference(object.url, issueKey, sourceType, link.relationship);
    if (!ref) continue;
    refs.push({
      ...ref,
      title: object.title,
    });
  }
  return refs;
}

async function addRemoteLinkPageRefs(client: QaClient, pageRefs: Map<string, PageRef>, issueKey: string, sourceType: string): Promise<void> {
  const refs = await getRemoteLinkPageRefs(client, issueKey, sourceType);
  for (const ref of refs) addPageRef(pageRefs, ref);
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

function isJunkScopeFragment(text: string): boolean {
  const normalized = normalizeInlineText(text).replace(/:$/, '');
  if (!normalized) return true;
  if (/^[-*•]?\s*(ai|prd|ff|feature flag|notes?|comments?)$/i.test(normalized)) return true;
  if (/^[^A-Za-z]*$/.test(normalized)) return true;
  return false;
}

function isThinMainIssue(mainIssue: SimplifiedIssue, mainIssueCriteria: ScopedItem[]): boolean {
  // Thin implementation tasks borrow scope from the parent story or matched PRD section instead of inventing it.
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
  if (isJunkScopeFragment(text)) return false;
  if (isStoryHeadingLine(text)) return false;
  if (/^(acceptance criteria|requirements|expected result|expected behavior|goals|non-goals|feature flag|data flow|background|ui behavior|scope)$/i.test(text)) {
    return false;
  }
  if (/^[-*•]/.test(line)) return false;
  if (/^\d+[\.)]\s+/.test(line) && /\bAs a\b/i.test(text)) return false;
  if (text.length > 90) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 1 && !/score/i.test(text)) return false;
  if (wordCount > 8) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 /&()_-]*$/.test(text);
}

// ADF heading-hierarchy parsing keeps PRD sections accurate when flattened text
// would confuse table cells for headings or split H4 children away from their H3.

function flattenAdfBlocks(adf: unknown): AdfBlock[] {
  const doc = adf && typeof adf === 'object' ? (adf as Record<string, unknown>) : null;
  const content = doc && Array.isArray(doc.content) ? doc.content : [];
  const blocks: AdfBlock[] = [];

  for (const node of content) {
    if (!node || typeof node !== 'object') continue;
    const type = String((node as Record<string, unknown>).type || '');
    if (type === 'heading') {
      const attrs = (node as Record<string, any>).attrs || {};
      const level = Number(attrs.level) || 1;
      const text = normalizeInlineText(extractText(node));
      if (text) blocks.push({ kind: 'heading', level, text, nodeType: 'heading' });
      continue;
    }
    const text = normalizeMultilineText(extractText(node));
    if (text) blocks.push({ kind: 'block', level: 0, text, nodeType: type || 'block' });
  }

  return blocks;
}

// Tables in these PRDs are plan/toggle matrices (layout), not acceptance
// criteria. Their flattened cells would otherwise glue onto the trailing list
// item during criteria extraction, so they are excluded from section bodies.
function isBodyContributingBlock(block: AdfBlock): boolean {
  return block.nodeType !== 'table';
}

function isScopeExcludedHeading(heading: string): boolean {
  return /^(acceptance criteria|requirements|expected result|expected behavior|behaviour|goals|non-goals|feature flag|data flow|background|ui behavior|scope|out of scope|definition of done)$/i.test(
    heading
  );
}

// Build ranking candidates from a block stream. Every meaningful heading is a
// candidate whose body spans until the next heading of equal-or-shallower level
// — so an H3's H4 children and lists fold into the H3 body, while the H3 stays a
// first-class candidate. Table cells are never candidates (they are not heading
// nodes).
function parseSectionsFromBlocks(blocks: AdfBlock[]): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind !== 'heading') continue;
    const heading = cleanHeadingText(block.text).replace(/:$/, '');
    if (!heading || isJunkScopeFragment(heading) || isScopeExcludedHeading(heading)) continue;

    const bodyParts: string[] = [];
    for (let next = index + 1; next < blocks.length; next += 1) {
      const nextBlock = blocks[next];
      if (nextBlock.kind === 'heading' && nextBlock.level <= block.level) break;
      if (isBodyContributingBlock(nextBlock) && !isJunkScopeFragment(nextBlock.text)) bodyParts.push(nextBlock.text);
    }

    const body = bodyParts.filter(Boolean).join('\n').trim();
    if (body) sections.push({ heading, body });
  }

  return sections;
}

function isolateStorySectionFromBlocks(blocks: AdfBlock[], anchor: string, storySummary: string): StorySection {
  const anchorCanonical = canonicalize(anchorToHeading(anchor));
  const storyCanonical = canonicalize(storySummary);

  let start = -1;
  let matchedHeading = '';
  let matchedLevel = 1;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind !== 'heading') continue;
    const heading = cleanHeadingText(block.text);
    const headingCanonical = canonicalize(heading);
    const matchesAnchor = Boolean(anchorCanonical) && (headingCanonical.includes(anchorCanonical) || anchorCanonical.includes(headingCanonical));
    const matchesStory = Boolean(storyCanonical) && (headingCanonical.includes(storyCanonical) || storyCanonical.includes(headingCanonical));
    if (matchesAnchor || matchesStory) {
      start = index;
      matchedHeading = heading;
      matchedLevel = block.level;
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

  let end = blocks.length;
  for (let index = start + 1; index < blocks.length; index += 1) {
    if (blocks[index].kind === 'heading' && blocks[index].level <= matchedLevel) {
      end = index;
      break;
    }
  }

  const regionBlocks = blocks.slice(start, end);
  const body = regionBlocks
    .filter(isBodyContributingBlock)
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n')
    .trim();

  return {
    matched: true,
    title: matchedHeading,
    body,
    reason: '',
    matchQuality: 'confident',
    confidence: 1,
    regionBlocks,
  };
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

    if (currentHeading && !isJunkScopeFragment(line)) currentBody.push(line);
  }

  flush();
  return sections;
}

// A "qualifier" is a discriminating polarity in the ticket title that plain
// token overlap cannot see: a negated token such as "no scoring", "without
// ranking", or "non-comparative". The negated token (here "score", "ranking",
// "comparative") must match the chosen subsection's polarity for that same
// token. This is GENERIC — it works for any "no/without/non <token>" pair, not
// a fixed score family — and acts as a gate: a subsection of the opposite
// polarity is rejected so generic overlap can never let it win.
//
// Residual limit: antonym pairs with no shared negation word (e.g. "single"
// vs "comparative") still need a lexicon and are intentionally NOT gated here;
// they fall back to token overlap.
const NEGATION_TOKEN_PATTERN = /\b(?:no|without|non)\s+([a-z0-9]+)/g;
const NEGATION_STOPWORDS = new Set(['one', 'longer', 'more', 'less', 'op', 'the', 'a', 'an']);

function negatedTokens(normalizedText: string): Set<string> {
  const tokens = new Set<string>();
  let match: RegExpExecArray | null;
  NEGATION_TOKEN_PATTERN.lastIndex = 0;
  while ((match = NEGATION_TOKEN_PATTERN.exec(normalizedText))) {
    const token = match[1];
    if (token.length >= 2 && !NEGATION_STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

type QualifierVerdict = 'match' | 'opposite' | 'neutral';

function qualifierVerdict(titleSignals: string[], heading: string): QualifierVerdict {
  const titleText = normalizeMatchText(titleSignals.join(' '));
  const headingText = normalizeMatchText(heading);
  const titleNegated = negatedTokens(titleText);
  const headingNegated = negatedTokens(headingText);
  const titleTokens = new Set(tokenizeMatchText(titleText));
  const headingTokens = new Set(tokenizeMatchText(headingText));

  let matched = false;
  // The title negates a token: a heading that mentions that token must also
  // negate it; if it asserts the token plainly, the heading is opposite polarity.
  for (const token of titleNegated) {
    if (!headingTokens.has(token)) continue;
    if (headingNegated.has(token)) matched = true;
    else return 'opposite';
  }
  // Symmetric case: the heading negates a token the title asserts plainly
  // (e.g. a "no score" heading for a plain "score" title) -> opposite polarity.
  for (const token of headingNegated) {
    if (titleTokens.has(token) && !titleNegated.has(token)) return 'opposite';
  }
  return matched ? 'match' : 'neutral';
}

function qualifierGateScore(titleSignals: string[], heading: string): number {
  const verdict = qualifierVerdict(titleSignals, heading);
  if (verdict === 'opposite') return -10;
  if (verdict === 'match') return 8;
  return 0;
}

function qualifierMatches(titleSignals: string[], heading: string): boolean {
  return qualifierVerdict(titleSignals, heading) === 'match';
}

// Human-readable summary of the title's negation qualifier, for diagnostics.
function describeTitleQualifier(titleSignals: string[]): string | undefined {
  const negated = [...negatedTokens(normalizeMatchText(titleSignals.join(' ')))];
  return negated.length ? negated.map((token) => `no ${token}`).join(' / ') : undefined;
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
  }

  // Apply the discriminating qualifier once, as a decisive gate.
  score += qualifierGateScore(titleSignals, heading);

  const confidence = Math.min(1, Math.max(0, score) / 18);
  return { heading, body, score, confidence };
}

function rankPrdSubsection(
  baseSection: StorySection,
  mainIssue: SimplifiedIssue,
  storySummary: string,
  precomputedSubsections?: Array<{ heading: string; body: string }> | null
): StorySection | null {
  // Rank PRD subsections against title/story signals so thin tasks use the closest scoped subsection, not the whole PRD.
  const subsections =
    precomputedSubsections && precomputedSubsections.length
      ? precomputedSubsections
      : parsePrdSubsections(baseSection.body || '');
  if (!subsections.length) return null;

  const titleSignals = deriveTitleSignals(mainIssue, storySummary);
  const ranked = subsections
    .map((section) => scorePrdSubsection(section.heading, section.body, titleSignals))
    .filter((section) => section.score > 0)
    // Hard gate: a subsection whose polarity is the OPPOSITE of a negated title
    // qualifier is disqualified outright — generic token overlap must never let
    // it win. Matching and neutral (no-polarity) headings are kept.
    .filter((section) => qualifierVerdict(titleSignals, section.heading) !== 'opposite')
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      // Tie-break on the discriminating qualifier before falling back to the
      // shortest body, so a qualifier match always beats a generic short cell.
      const leftQualifier = qualifierMatches(titleSignals, left.heading) ? 1 : 0;
      const rightQualifier = qualifierMatches(titleSignals, right.heading) ? 1 : 0;
      if (leftQualifier !== rightQualifier) return rightQualifier - leftQualifier;
      return left.body.length - right.body.length;
    });

  if (!ranked.length) return null;

  const best = ranked[0];
  const second = ranked[1];
  const closeMatch = second && Math.abs(best.score - second.score) <= 2;
  const matchQuality: 'confident' | 'broad' = best.score >= 10 && !closeMatch && !isJunkScopeFragment(best.heading) ? 'confident' : 'broad';

  return {
    matched: true,
    title: best.heading,
    body: best.body,
    reason: '',
    matchQuality,
    confidence: Number(best.confidence.toFixed(2)),
    candidates: ranked.slice(0, 5).map((section) => ({
      heading: section.heading,
      score: section.score,
      confidence: Number(section.confidence.toFixed(2)),
    })),
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
  // Authority order is deliberate: main Jira AC wins, then scoped PRD subsection, then parent Story AC.
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

function buildScopeAuthority(
  mainIssue: SimplifiedIssue,
  selection: CriteriaSelectionResult,
  scopeConfluenceSection: ScopeConfluenceSection | null,
  scopeParentIssue: LinkedIssueSummary | null
): ScopeAuthority {
  // ScopeAuthority is the single source of truth the LLM sees for "what counts as in scope".
  if (selection.acceptanceCriteriaSource === 'main_jira') {
    const descriptionWithoutAc = stripAcceptanceCriteriaSections(mainIssue.description || mainIssue.renderedDescription || '');
    const meaningfulDescription = normalizeInlineText(descriptionWithoutAc);
    if (meaningfulDescription.length >= 20) {
      return {
        type: 'main_jira_description',
        title: mainIssue.summary || mainIssue.key,
        body: descriptionWithoutAc,
        reason: selection.selectionReason,
        quality: 'high',
        sourceIssueKey: mainIssue.key,
      };
    }

    return {
      type: 'main_jira_acceptance_criteria',
      title: mainIssue.summary || mainIssue.key,
      body: selection.acceptanceCriteria.map((criterion) => `${criterion.id}. ${criterion.text}`).join('\n'),
      reason: selection.selectionReason,
      quality: 'high',
      sourceIssueKey: mainIssue.key,
    };
  }

  if (selection.acceptanceCriteriaSource === 'parent_story_confluence_section' && scopeConfluenceSection) {
    const broad = scopeConfluenceSection.reason.includes('broadly');
    return {
      type: broad ? 'broad_prd_section' : 'matched_prd_subsection',
      title: scopeConfluenceSection.matchedHeading || scopeConfluenceSection.title || scopeParentIssue?.summary || mainIssue.summary || mainIssue.key,
      body: scopeConfluenceSection.body || '',
      reason: selection.selectionReason || scopeConfluenceSection.reason,
      quality: broad ? 'medium' : 'high',
      sourceIssueKey: scopeConfluenceSection.sourceIssueKey || scopeParentIssue?.key,
      pageId: scopeConfluenceSection.pageId || undefined,
    };
  }

  if (selection.acceptanceCriteriaSource === 'parent_story_jira' && scopeParentIssue) {
    return {
      type: 'parent_story_jira',
      title: scopeParentIssue.summary || scopeParentIssue.key,
      body: selection.acceptanceCriteria.map((criterion) => `${criterion.id}. ${criterion.text}`).join('\n'),
      reason: selection.selectionReason,
      quality: 'medium',
      sourceIssueKey: scopeParentIssue.key,
    };
  }

  return {
    type: 'none',
    title: mainIssue.summary || mainIssue.key,
    body: '',
    reason: selection.selectionReason,
    quality: 'low',
    sourceIssueKey: mainIssue.key,
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

// The most useful PRD anchor can live on a sibling implementation ticket rather
// than the parent Story, so recover the best anchor from every issue in the chain.
function scoreAnchorOverlap(anchor: string, mainIssue: SimplifiedIssue, storySummary: string): number {
  const headingTokens = new Set(tokenizeMatchText(anchorToHeading(anchor)));
  if (!headingTokens.size) return 0;
  const titleTokens = [
    ...tokenizeMatchText(stripBracketPrefixes(mainIssue.summary || '')),
    ...tokenizeMatchText(storySummary || ''),
  ];
  let overlap = 0;
  for (const token of new Set(titleTokens)) {
    if (headingTokens.has(token)) overlap += 1;
  }
  const qualifierBonus = qualifierMatches([stripBracketPrefixes(mainIssue.summary || ''), storySummary || ''], anchorToHeading(anchor)) ? 3 : 0;
  return overlap + qualifierBonus;
}

// Source precedence for anchor tie-breaking: the parent Story is the canonical
// scope source, then the main ticket, then linked siblings.
function anchorSourcePrecedence(sourceType: string): number {
  const value = sourceType || '';
  if (/parent/i.test(value)) return 3;
  if (/main/i.test(value)) return 2;
  return 1;
}

interface ResolvedAnchor {
  anchor: string;
  fromChain: boolean;
}

interface AnchorCandidate {
  anchor: string;
  precedence: number;
  overlap: number;
}

// P2: anchor selection must be deterministic and respect source quality, not
// fall through to Set-insertion order on a tie. Candidates are ranked by title
// overlap, then source precedence, then a stable string compare. The parent
// Story's own anchor is only overridden when a chain/page anchor scores
// STRICTLY higher overlap — so a zero or tied overlap never moves us onto an
// arbitrary sibling anchor.
function resolveBestAnchorForPage(
  pageId: string,
  parentAnchor: string,
  chainRefs: ConfluenceReference[],
  pageSourceRefs: PageRefSource[] | undefined,
  chainIssueKeys: Set<string>,
  mainIssue: SimplifiedIssue,
  storySummary: string
): ResolvedAnchor {
  const byAnchor = new Map<string, number>();
  const add = (anchor: string, precedence: number) => {
    if (!anchor) return;
    const existing = byAnchor.get(anchor);
    if (existing === undefined || precedence > existing) byAnchor.set(anchor, precedence);
  };

  for (const ref of chainRefs) {
    if (ref.pageId === pageId && ref.anchor && chainIssueKeys.has(ref.issueKey)) add(ref.anchor, anchorSourcePrecedence(ref.sourceType));
  }
  for (const source of pageSourceRefs || []) {
    if (source.anchor && (!source.issueKey || chainIssueKeys.has(source.issueKey))) add(source.anchor, anchorSourcePrecedence(source.sourceType || ''));
  }
  if (parentAnchor) add(parentAnchor, 4);

  if (!byAnchor.size) return { anchor: '', fromChain: false };

  const candidates: AnchorCandidate[] = [...byAnchor.entries()].map(([anchor, precedence]) => ({
    anchor,
    precedence,
    overlap: scoreAnchorOverlap(anchor, mainIssue, storySummary),
  }));
  candidates.sort((left, right) => {
    if (right.overlap !== left.overlap) return right.overlap - left.overlap;
    if (right.precedence !== left.precedence) return right.precedence - left.precedence;
    return left.anchor < right.anchor ? -1 : left.anchor > right.anchor ? 1 : 0;
  });

  if (parentAnchor) {
    const parentOverlap = scoreAnchorOverlap(parentAnchor, mainIssue, storySummary);
    const bestNonParent = candidates.find((candidate) => candidate.anchor !== parentAnchor);
    if (bestNonParent && bestNonParent.overlap > parentOverlap) {
      return { anchor: bestNonParent.anchor, fromChain: true };
    }
    return { anchor: parentAnchor, fromChain: false };
  }

  return { anchor: candidates[0].anchor, fromChain: true };
}

// Fix 4: pages that only reach us via "mentioned in" remote links, or that are
// clearly release/version planning artifacts, are context — not scope. They
// must not feed the acceptance-criteria candidate pool.
function isContextOnlyConfluencePage(page: ConfluencePageSummary): boolean {
  const title = normalizeInlineText(page.title || '');
  if (/release plan|version plan|tech version|sprint plan|delivery plan|roadmap/i.test(title)) return true;
  const refs = page.sourceRefs || [];
  if (refs.length && refs.every((ref) => /mentioned in/i.test(ref.relationship || ''))) return true;
  return false;
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
        .filter((page) => !page.fetchError && !isContextOnlyConfluencePage(page))
        .flatMap((page) => extractAcceptanceCriteriaFromText(page.body || '', `${page.id} ${page.title || 'Confluence page'}`)),
      'AC'
    ),
  };
}

export async function buildQaContext(client: QaClient, jiraKey: string, options: QaContextOptions = {}): Promise<QaContext> {
  const log = options.logger;
  const linkedIssueFetchConcurrency = Number(process.env.QA_CONTEXT_ISSUE_CONCURRENCY || 4);
  const confluenceFetchConcurrency = Number(process.env.QA_CONTEXT_CONFLUENCE_CONCURRENCY || 4);
  const mainIssue = await client.getIssue(jiraKey);
  const resolvedScopeType = resolveScopeType({
    requestedScopeType: options.scopeType || 'auto',
    feOnly: options.feOnly,
    title: mainIssue.summary || '',
    text: [mainIssue.description || '', mainIssue.renderedDescription || '', ...(mainIssue.comments || [])].join('\n'),
    labels: mainIssue.labels || [],
  });
  const linkedIssueKeys = new Set<string>();

  for (const linked of mainIssue.linkedIssues || []) {
    if (linked.key) linkedIssueKeys.add(linked.key);
  }
  for (const subtask of mainIssue.subtasks || []) {
    if (subtask.key) linkedIssueKeys.add(subtask.key);
  }

  const linkedIssues = await mapWithConcurrency(Array.from(linkedIssueKeys), linkedIssueFetchConcurrency, async (key) => {
    try {
      const fetched = await client.getIssue(key);
      return mergeIssueMetadata(mainIssue, fetched);
    } catch (error) {
      const meta = (mainIssue.linkedIssues || []).find((issue) => issue.key === key);
      return {
        key,
        fetchError: (error as Error).message,
        linkRelation: meta?.relation,
        issueType: meta?.issueType,
        summary: meta?.summary,
      } as LinkedIssueSummary;
    }
  });

  const pageRefs = new Map<string, PageRef>();
  addIssueTextPageRefs(pageRefs, mainIssue, 'main');
  for (const ref of await getRemoteLinkPageRefs(client, mainIssue.key, 'main-remote-link')) addPageRef(pageRefs, ref);

  for (const issue of linkedIssues) {
    if (issue.fetchError) continue;
    addIssueTextPageRefs(pageRefs, issue as SimplifiedIssue, 'linked');
  }
  const linkedRemoteLinkRefs = await mapWithConcurrency(
    linkedIssues.filter((issue) => !issue.fetchError),
    linkedIssueFetchConcurrency,
    async (issue) => getRemoteLinkPageRefs(client, issue.key, 'linked-remote-link')
  );
  for (const refs of linkedRemoteLinkRefs) {
    for (const ref of refs) addPageRef(pageRefs, ref);
  }

  const confluencePages: ConfluencePageSummary[] = [];
  // Raw ADF is kept server-side only (keyed by page id) for heading-hierarchy
  // scope resolution; it is intentionally NOT attached to confluencePages so it
  // never bloats the client-facing context payload.
  const pageAdfById = new Map<string, unknown>();
  const fetchedConfluencePages = await mapWithConcurrency(Array.from(pageRefs.values()), confluenceFetchConcurrency, async (ref) => {
    try {
      const page = await client.getConfluencePage(ref.pageId);
      const comments = options.includeComments ? await client.getConfluenceComments(ref.pageId) : [];
      return { ref, page, comments, error: null as Error | null };
    } catch (error) {
      return { ref, page: null, comments: [] as Array<{ id: string; body: string }>, error: error as Error };
    }
  });
  for (const entry of fetchedConfluencePages) {
    if (entry.page) {
      const { adf, ...pageRest } = entry.page as typeof entry.page & { adf?: unknown };
      if (adf) pageAdfById.set(String(entry.page.id), adf);
      confluencePages.push({ ...pageRest, sourceRefs: entry.ref.sources, sourceUrl: entry.ref.url, comments: entry.comments });
    } else {
      confluencePages.push({
        id: entry.ref.pageId,
        title: entry.ref.title,
        sourceRefs: entry.ref.sources,
        sourceUrl: entry.ref.url,
        fetchError: entry.error?.message || 'Failed to fetch Confluence page',
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
  let thinFallbackUsed = false;
  let anchorResolvedFromChain = false;
  let rankedScopeCandidates: Array<{ heading: string; score: number; confidence: number }> = [];

  // Fix 1: gather PRD references from the whole implementation chain (main
  // ticket, every linked issue, and the parent Story) so a precise anchor on a
  // sibling — typically the blocking BE twin — can be recovered even when the
  // parent Story's own PRD link is bare.
  const chainIssueKeys = new Set<string>([mainIssue.key, ...linkedIssues.map((issue) => issue.key)]);
  const chainPageRefs: ConfluenceReference[] = [
    ...extractConfluencePageRefsFromText(mainIssue.description || '', mainIssue.key, 'main-description'),
    ...extractConfluencePageRefsFromText(mainIssue.renderedDescription || '', mainIssue.key, 'main-rendered-description'),
    ...linkedIssues
      .filter((issue) => !issue.fetchError)
      .flatMap((issue) => [
        ...extractConfluencePageRefsFromText((issue as unknown as SimplifiedIssue).description || '', issue.key, 'linked-description'),
        ...extractConfluencePageRefsFromText((issue as unknown as SimplifiedIssue).renderedDescription || '', issue.key, 'linked-rendered-description'),
      ]),
  ];

  if (scopeParentIssue) {
    const storyRefs = [
      ...extractConfluencePageRefsFromText((scopeParentIssue as unknown as SimplifiedIssue).description || '', scopeParentIssue.key, 'parent-story-description'),
      ...extractConfluencePageRefsFromText((scopeParentIssue as unknown as SimplifiedIssue).renderedDescription || '', scopeParentIssue.key, 'parent-story-rendered-description'),
    ];
    const preferredStoryRef = storyRefs.find((ref) => ref.anchor) || storyRefs[0] || null;
    if (preferredStoryRef) {
      const page = confluencePages.find((candidate) => candidate.id === preferredStoryRef.pageId);
      if (page && !page.fetchError) {
        const resolvedAnchor = resolveBestAnchorForPage(
          preferredStoryRef.pageId,
          preferredStoryRef.anchor,
          chainPageRefs,
          page.sourceRefs,
          chainIssueKeys,
          mainIssue,
          scopeParentIssue.summary || ''
        );
        anchorResolvedFromChain = resolvedAnchor.fromChain;
        // Fix 2: prefer the ADF heading hierarchy when raw ADF is available, so
        // table cells never become headings and an H3's H4 children fold into
        // it. Fall back to flattened-text parsing when ADF is absent.
        const adfBlocks = pageAdfById.has(page.id) ? flattenAdfBlocks(pageAdfById.get(page.id)) : null;
        const section = adfBlocks
          ? isolateStorySectionFromBlocks(adfBlocks, resolvedAnchor.anchor, scopeParentIssue.summary || '')
          : isolateStorySection(page.body || '', resolvedAnchor.anchor, scopeParentIssue.summary || '');
        const subsectionBase: StorySection = section.matched
          ? section
          : {
              matched: true,
              title: page.title || scopeParentIssue.summary || '',
              body: page.body || '',
              reason: '',
              matchQuality: 'broad' as const,
              confidence: 0.4,
              regionBlocks: adfBlocks || undefined,
            };
        // Build ranking candidates from the relevant ADF region: the matched
        // section's own blocks when an anchor locked on (so its H3 stays a
        // candidate with H4 children as body), otherwise the whole page.
        const adfRankCandidates = adfBlocks
          ? parseSectionsFromBlocks(subsectionBase.regionBlocks || adfBlocks)
          : null;
        const thinFallbackCandidate = mainIssueThin
          ? rankPrdSubsection(subsectionBase, mainIssue, scopeParentIssue.summary || '', adfRankCandidates)
          : null;
        // Fix 5: record that the thin-ticket ranking path actually executed,
        // independent of which AC source ultimately won, so telemetry matches
        // reality. Also surface the ranked candidates for QA review.
        if (mainIssueThin) {
          thinFallbackUsed = true;
          rankedScopeCandidates = thinFallbackCandidate?.candidates || [];
        }
        const effectiveSection = thinFallbackCandidate || section;
        scopeConfluenceSection = {
          pageId: page.id,
          title: page.title || '',
          url: preferredStoryRef.url || page.webUrl || '',
          anchor: resolvedAnchor.anchor || '',
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

  // Fix 5 (fail loud): if the ticket title carries a discriminating qualifier
  // (e.g. "no scoring") but the matched PRD scope does not confirm that
  // polarity, say so explicitly instead of letting confident-looking but wrong
  // acceptance criteria through.
  const scopeQualifierTitleSignals = [mainIssue.summary || '', scopeParentIssue?.summary || ''];
  const detectedScopeQualifier = describeTitleQualifier(scopeQualifierTitleSignals);
  const qualifierUnconfirmed = Boolean(
    detectedScopeQualifier &&
      scopeConfluenceSection &&
      (!scopeConfluenceSection.matched || qualifierVerdict(scopeQualifierTitleSignals, scopeConfluenceSection.matchedHeading) !== 'match')
  );

  const confidence = determineConfidence(mainIssueCriteria, scopedSectionCriteria, scopeParentIssue, scopeConfluenceSection, mainIssueThin);
  const diagnostics = buildContextSummary(mainIssue, classifiedLinkedIssues, confluencePages);
  const scopeAuthority = buildScopeAuthority(mainIssue, selection, scopeConfluenceSection, scopeParentIssue);
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
    scopeAuthority,
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
      ...(qualifierUnconfirmed
        ? [
            `Scope qualifier "${detectedScopeQualifier}" was detected in the ticket title, but the matched PRD scope did not confirm it. Review the ranked scope candidates before trusting acceptance criteria coverage.`,
          ]
        : []),
    ],
    requiresConfidencePermission: confidence.requiresConfidencePermission || qualifierUnconfirmed,
    acceptanceCriteriaDiagnostics: {
      ...diagnostics,
      selectedAcceptanceCriteriaSource: selection.acceptanceCriteriaSource,
      selectedAcceptanceCriteriaReason: selection.selectionReason,
      ignoredSources: selection.ignoredSources,
      ignoredMetadataLabels: selection.ignoredMetadataLabels,
      thinTicketFallbackUsed: thinFallbackUsed,
      prdSubsectionMatchQuality: scopeConfluenceSection?.matched ? (scopeConfluenceSection.reason.includes('broadly') ? 'broad' : 'confident') : 'none',
      matchedPrdSubsectionHeading: scopeConfluenceSection?.matchedHeading || '',
      matchedPrdSubsectionConfidence: scopeConfluenceSection?.matched ? (scopeConfluenceSection.reason.includes('broadly') ? 0.6 : 1) : 0,
      userStoryFragmentsDiscardedCount: discardedUserStoryFragments.length,
      scopeQualifierDetected: detectedScopeQualifier,
      scopeCandidatesRanked: rankedScopeCandidates.length ? rankedScopeCandidates : undefined,
      scopeAnchorResolvedFromChain: anchorResolvedFromChain,
    },
    constraints: {
      feOnly: resolvedScopeType === 'web' ? options.feOnly !== false : false,
      beAlreadyTested: Boolean(options.beAlreadyTested),
      scopeType: resolvedScopeType,
      requestedScopeType: options.scopeType || (options.feOnly === false ? 'hybrid' : 'web'),
    },
    apiDocsUrl: options.apiDocsUrl,
    actualDevScopeGuidance:
      resolvedScopeType === 'api'
        ? 'Use the main Jira issue for implementation-specific API and backend acceptance criteria, then linked technical design and API docs for endpoint contracts. UI-only PRD behavior is supporting context only.'
        : 'Use the main Jira issue for implementation-specific acceptance criteria, then the linked parent Story and its targeted PRD subsection for canonical scope. Blocking and BE tickets are context only.',
  };
}
