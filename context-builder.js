const { extractPageId } = require('./atlassian');

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canonicalize(value) {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/[#_*`"]/g, ' ')
    .replace(/[-+/_().,:;|[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeScopedItems(items, prefix) {
  const seen = new Set();
  const output = [];

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

function cleanListLine(line) {
  return normalizeInlineText(
    String(line || '')
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[\.)]\s+/, '')
      .replace(/^[a-z][\.)]\s+/i, '')
      .replace(/^AC[-\s_:]*\d+[\.)]?\s*/i, '')
  );
}

function isLikelyHeading(line) {
  const text = normalizeInlineText(line).replace(/:$/, '');
  if (!text) return false;
  if (/^(acceptance criteria|user story|description|notes|out of scope|definition of done|scope|background)$/i.test(text)) return true;
  return /^[A-Z0-9][A-Za-z0-9 /&()_-]{2,120}$/.test(text);
}

function isCriterionText(text) {
  return (
    text.length >= 8 &&
    /(should|must|required|able|unable|cannot|can not|display|shown|hidden|enabled|disabled|sync|update|prevent|allow|error|match|return|persist|appear)/i.test(text)
  );
}

function extractAcceptanceCriteriaFromText(text, source) {
  const lines = normalizeMultilineText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const criteria = [];
  let inCriteriaSection = false;

  for (const line of lines) {
    if (/^(acceptance criteria|acceptance|ac)[:]?$/i.test(line)) {
      inCriteriaSection = true;
      continue;
    }

    if (inCriteriaSection && isLikelyHeading(line) && !/^AC[-\s_:]*\d+/i.test(line)) {
      inCriteriaSection = false;
    }

    if (!inCriteriaSection) continue;

    const item = cleanListLine(line);
    if (item) criteria.push({ text: item, source });
  }

  if (criteria.length) return criteria;

  return lines
    .filter((line) => /^(\d+[\.)]|[a-z][\.)]|[-*•]|AC[-\s_:]*\d+)/i.test(line))
    .map((line) => cleanListLine(line))
    .filter((line) => isCriterionText(line))
    .map((line) => ({ text: line, source }));
}

function extractUserStoriesFromText(text, source) {
  const stories = [];
  const lines = normalizeMultilineText(text)
    .split('\n')
    .map((line) => normalizeInlineText(line))
    .filter(Boolean);

  for (const line of lines) {
    if (/as a\b/i.test(line) && /i want\b/i.test(line)) {
      stories.push({ text: line.replace(/^#+\s*/, ''), source });
    }
  }

  return stories;
}

function classifyLinkedIssue(linkedIssue) {
  if (!linkedIssue) return 'other';
  const relation = canonicalize(linkedIssue.linkRelation || linkedIssue.relation);
  const issueType = canonicalize(linkedIssue.issueType);
  if (relation === 'is child of' && issueType === 'story') return 'parent story';
  if (relation === 'is blocked by' || relation === 'blocks') return 'blocking dependency';
  if (issueType === 'task' || issueType === 'sub-task') return 'related implementation';
  return 'other';
}

function parseConfluenceReference(url, issueKey, sourceType, relationship) {
  const raw = String(url || '').trim();
  if (!raw || !raw.includes('/wiki/')) return null;
  const pageId = extractPageId(raw);
  if (!pageId) return null;

  let anchor = '';
  try {
    const parsed = new URL(raw);
    anchor = decodeURIComponent(parsed.hash.replace(/^#/, '')).trim();
  } catch (error) {
    const hashIndex = raw.indexOf('#');
    if (hashIndex >= 0) anchor = decodeURIComponent(raw.slice(hashIndex + 1)).trim();
  }

  return {
    pageId,
    url: raw,
    anchor,
    issueKey,
    sourceType,
    relationship: relationship || '',
  };
}

function addPageRef(pageRefs, ref) {
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

function extractConfluencePageRefsFromText(text, issueKey, sourceType) {
  const refs = [];
  const urls = String(text || '').match(/https?:\/\/[^\s"'<>]+/g) || [];
  for (const rawUrl of urls) {
    const cleaned = rawUrl.replace(/[),.;]+$/, '');
    const ref = parseConfluenceReference(cleaned, issueKey, sourceType);
    if (ref) refs.push(ref);
  }
  return refs;
}

function addIssueTextPageRefs(pageRefs, issue, sourceTypePrefix) {
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

async function addRemoteLinkPageRefs(client, pageRefs, issueKey, sourceType) {
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

function mergeIssueMetadata(mainIssue, fetchedIssue) {
  const metaByKey = new Map((mainIssue.linkedIssues || []).map((issue) => [issue.key, issue]));
  return {
    ...fetchedIssue,
    linkRelation: metaByKey.get(fetchedIssue.key) && metaByKey.get(fetchedIssue.key).relation,
    linkSummary: metaByKey.get(fetchedIssue.key) && metaByKey.get(fetchedIssue.key).summary,
  };
}

function extractMainIssueCriteria(mainIssue) {
  return dedupeScopedItems(
    [
      ...extractAcceptanceCriteriaFromText(mainIssue.description, `${mainIssue.key} description`),
      ...extractAcceptanceCriteriaFromText(mainIssue.renderedDescription, `${mainIssue.key} rendered description`),
    ],
    'AC'
  );
}

function extractStoryCriteria(storyIssue) {
  if (!storyIssue) return [];
  return dedupeScopedItems(
    [
      ...extractAcceptanceCriteriaFromText(storyIssue.description, `${storyIssue.key} description`),
      ...extractAcceptanceCriteriaFromText(storyIssue.renderedDescription, `${storyIssue.key} rendered description`),
    ],
    'AC'
  );
}

function isStoryHeadingLine(line) {
  return /^\s*#*\s*\d+\.\s+as a\b/i.test(line) || /^\s*#*\s*as a\b/i.test(line);
}

function cleanHeadingText(line) {
  return normalizeInlineText(String(line || '').replace(/^#+\s*/, ''));
}

function anchorToHeading(anchor) {
  const text = String(anchor || '').replace(/^#/, '').replace(/\+/g, ' ').replace(/-/g, ' ');
  return normalizeInlineText(text);
}

function isolateStorySection(body, anchor, storySummary) {
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
    const headingMatchesAnchor =
      Boolean(anchorCanonical) && (headingCanonical.includes(anchorCanonical) || anchorCanonical.includes(headingCanonical));
    const headingMatchesStory =
      Boolean(storyCanonical) && (headingCanonical.includes(storyCanonical) || storyCanonical.includes(headingCanonical));
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
  };
}

function combineScopedItems(groups) {
  const output = [];
  const seen = new Set();

  for (const group of groups) {
    for (const item of group.items || []) {
      const key = canonicalize(item.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push({
        text: normalizeInlineText(item.text),
        source: item.source || group.source,
      });
    }
  }

  return dedupeScopedItems(output, 'AC');
}

function resolveAcceptanceCriteriaSource(groups) {
  const active = groups.filter((group) => (group.items || []).length > 0).map((group) => group.key);
  if (!active.length) return 'none';
  if (active.length === 1) return active[0];
  return 'combined';
}

function determineConfidence(mainCriteria, scopedSectionCriteria, parentStory, scopeConfluenceSection) {
  const reasons = [];

  if (mainCriteria.length > 0) {
    return {
      confidenceLevel: 'high',
      confidenceReasons: ['Main Jira ticket contains explicit acceptance criteria.'],
      requiresConfidencePermission: false,
    };
  }

  if (scopedSectionCriteria.length > 0 && scopeConfluenceSection && scopeConfluenceSection.matched) {
    return {
      confidenceLevel: 'high',
      confidenceReasons: ['Parent Story was resolved and its linked PRD subsection was matched successfully.'],
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

  return {
    confidenceLevel: parentStory ? 'medium' : 'low',
    confidenceReasons: reasons,
    requiresConfidencePermission: true,
  };
}

function buildContextSummary(mainIssue, linkedIssues, confluencePages) {
  const issueSources = [mainIssue, ...linkedIssues.filter((issue) => !issue.fetchError)];
  return {
    allIssueUserStories: dedupeScopedItems(
      issueSources.flatMap((issue) => [
        ...extractUserStoriesFromText(issue.summary, `${issue.key} summary`),
        ...extractUserStoriesFromText(issue.description, `${issue.key} description`),
      ]),
      'US'
    ),
    allIssueCriteria: dedupeScopedItems(
      issueSources.flatMap((issue) => [
        ...extractAcceptanceCriteriaFromText(issue.description, `${issue.key} description`),
        ...extractAcceptanceCriteriaFromText(issue.renderedDescription, `${issue.key} rendered description`),
      ]),
      'AC'
    ),
    confluenceCriteria: dedupeScopedItems(
      confluencePages
        .filter((page) => !page.fetchError)
        .flatMap((page) => extractAcceptanceCriteriaFromText(page.body, `${page.id} ${page.title || 'Confluence page'}`)),
      'AC'
    ),
  };
}

async function buildQaContext(client, jiraKey, options = {}) {
  const mainIssue = await client.getIssue(jiraKey);
  const linkedIssueKeys = new Set();

  for (const linked of mainIssue.linkedIssues || []) {
    if (linked.key) linkedIssueKeys.add(linked.key);
  }
  for (const subtask of mainIssue.subtasks || []) {
    if (subtask.key) linkedIssueKeys.add(subtask.key);
  }

  const linkedIssues = [];
  for (const key of linkedIssueKeys) {
    try {
      const fetched = await client.getIssue(key);
      linkedIssues.push(mergeIssueMetadata(mainIssue, fetched));
    } catch (error) {
      const meta = (mainIssue.linkedIssues || []).find((issue) => issue.key === key) || {};
      linkedIssues.push({ key, fetchError: error.message, linkRelation: meta.relation, issueType: meta.issueType, summary: meta.summary });
    }
  }

  const pageRefs = new Map();
  addIssueTextPageRefs(pageRefs, mainIssue, 'main');
  await addRemoteLinkPageRefs(client, pageRefs, mainIssue.key, 'main-remote-link');

  for (const issue of linkedIssues) {
    if (issue.fetchError) continue;
    addIssueTextPageRefs(pageRefs, issue, 'linked');
    await addRemoteLinkPageRefs(client, pageRefs, issue.key, 'linked-remote-link');
  }

  const confluencePages = [];
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
        fetchError: error.message,
      });
    }
  }

  const classifiedLinkedIssues = linkedIssues.map((issue) => ({
    ...issue,
    classification: classifyLinkedIssue(issue),
  }));
  const scopeParentIssue = classifiedLinkedIssues.find((issue) => issue.classification === 'parent story' && !issue.fetchError) || null;
  const scopeParentRelation = scopeParentIssue ? scopeParentIssue.linkRelation || 'is child of' : '';

  let scopeConfluenceSection = null;
  let scopedSectionCriteria = [];
  let scopedSectionStories = [];

  if (scopeParentIssue) {
    const storyRefs = [
      ...extractConfluencePageRefsFromText(scopeParentIssue.description, scopeParentIssue.key, 'parent-story-description'),
      ...extractConfluencePageRefsFromText(scopeParentIssue.renderedDescription, scopeParentIssue.key, 'parent-story-rendered-description'),
    ];
    const preferredStoryRef = storyRefs.find((ref) => ref.anchor) || storyRefs[0] || null;
    if (preferredStoryRef) {
      const page = confluencePages.find((candidate) => candidate.id === preferredStoryRef.pageId);
      if (page && !page.fetchError) {
        const section = isolateStorySection(page.body, preferredStoryRef.anchor, scopeParentIssue.summary);
        scopeConfluenceSection = {
          pageId: page.id,
          title: page.title,
          url: preferredStoryRef.url || page.webUrl || '',
          anchor: preferredStoryRef.anchor || '',
          matchedHeading: section.title,
          matched: section.matched,
          reason: section.reason,
          sourceIssueKey: scopeParentIssue.key,
          body: section.body,
        };
        if (section.matched) {
          scopedSectionCriteria = dedupeScopedItems(
            extractAcceptanceCriteriaFromText(section.body, `${page.id} ${section.title || page.title}`),
            'AC'
          );
          scopedSectionStories = dedupeScopedItems(
            [{ text: section.title || scopeParentIssue.summary, source: `${page.id} ${page.title}` }],
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
          reason: 'Story found, but linked PRD page could not be fetched.',
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

  const mainIssueCriteria = extractMainIssueCriteria(mainIssue);
  const parentStoryCriteria = extractStoryCriteria(scopeParentIssue);
  const acceptanceCriteria = combineScopedItems([
    { key: 'main_jira', items: mainIssueCriteria },
    { key: 'parent_story_jira', items: parentStoryCriteria },
    { key: 'parent_story_confluence_section', items: scopedSectionCriteria },
  ]);
  const acceptanceCriteriaSource = resolveAcceptanceCriteriaSource([
    { key: 'main_jira', items: mainIssueCriteria },
    { key: 'parent_story_jira', items: parentStoryCriteria },
    { key: 'parent_story_confluence_section', items: scopedSectionCriteria },
  ]);

  const userStories = dedupeScopedItems(
    [
      ...(scopeParentIssue ? [{ text: scopeParentIssue.summary, source: `${scopeParentIssue.key} summary` }] : []),
      ...scopedSectionStories,
    ],
    'US'
  );

  const confidence = determineConfidence(mainIssueCriteria, scopedSectionCriteria, scopeParentIssue, scopeConfluenceSection);
  const diagnostics = buildContextSummary(mainIssue, classifiedLinkedIssues, confluencePages);
  const epic = mainIssue.parent && mainIssue.parent.issueType === 'Epic' ? mainIssue.parent.summary : mainIssue.parent && mainIssue.parent.summary;

  return {
    ticketKey: mainIssue.key,
    epic: epic || 'Unknown Epic',
    mainIssue,
    linkedIssues: classifiedLinkedIssues,
    confluencePages,
    scopeParentIssue,
    scopeParentRelation,
    scopeConfluenceSection,
    acceptanceCriteria,
    userStories,
    acceptanceCriteriaSource,
    confidenceLevel: confidence.confidenceLevel,
    confidenceReasons: confidence.confidenceReasons,
    requiresConfidencePermission: confidence.requiresConfidencePermission,
    acceptanceCriteriaDiagnostics: diagnostics,
    constraints: {
      feOnly: Boolean(options.feOnly),
      beAlreadyTested: Boolean(options.beAlreadyTested),
      notes: options.notes || '',
    },
    actualDevScopeGuidance:
      'Use the main Jira issue for implementation-specific acceptance criteria, then the linked parent Story and its targeted PRD subsection for canonical scope. Blocking and BE tickets are context only.',
  };
}

module.exports = {
  anchorToHeading,
  buildQaContext,
  canonicalize,
  classifyLinkedIssue,
  extractAcceptanceCriteriaFromText,
  extractConfluencePageRefsFromText,
  extractUserStoriesFromText,
  isolateStorySection,
  parseConfluenceReference,
};
