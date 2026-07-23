import { useEffect, useRef, useState } from 'react';
import type { CoverageSummary, GenerateQualityEvaluation, GeneratedTestCase, QaContext, ValidationEntry } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';
import { qualityGateReasons } from '../quality';
import { SourceExcerpt } from './SourceExcerpt';
import { BddEditor } from './BddEditor';

interface ReviewPanelProps {
  context: QaContext | null;
  generating: boolean;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary | null;
  coverageEnforced: boolean;
  manualScopeOverride: boolean;
  lang: UiLanguage;
  onCaseChange: (index: number, field: keyof GeneratedTestCase, value: string | string[]) => void;
  onCaseRemove?: (index: number) => void;
  blockedCaseIds?: string[];
  selectedPushCaseIds?: string[];
  onSelectedPushCaseIdsChange?: (caseIds: string[]) => void;
  approved?: boolean;
  sectionId?: string;
  casesValid?: boolean;
  coverageComplete?: boolean;
  pushBlocker?: string;
  onApprovedChange?: (value: boolean) => void;
  onPush?: (approvalOverride?: boolean) => void;
  pushing?: boolean;
  qualityEvaluation?: GenerateQualityEvaluation | null;
  onRegenerate?: () => void;
}

function listToInput(value: string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : '';
}

function titleWithoutPrefix(title: string): string {
  return title.replace(/^\[[^\]]+\]\[[^\]]+\]\[[^\]]+\]\s*/, '').trim() || title;
}

function parseBddSteps(value: string): Array<{ keyword: string; text: string }> {
  return value
    .split('\n')
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(Given|When|Then|And|But)\s*:?[\s]*(.+)$/i);
      return match ? { keyword: match[1], text: match[2].trim() } : null;
    })
    .filter((step): step is { keyword: string; text: string } => Boolean(step));
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

type CaseIntent = 'positive' | 'negative' | 'edge';

function classifyCaseIntent(testCase: GeneratedTestCase): CaseIntent {
  if (testCase.caseIntent === 'positive' || testCase.caseIntent === 'negative' || testCase.caseIntent === 'edge') {
    return testCase.caseIntent;
  }
  const haystack = [
    testCase.type,
    testCase.title,
    testCase.bddScenario,
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

function generatedSummaryText(
  testCases: GeneratedTestCase[],
  coverage: CoverageSummary | null,
  context: QaContext | null,
  coverageEnforced: boolean,
  lang: UiLanguage
): string[] {
  const t = uiText[lang].review;
  if (!testCases.length) return [t.noGeneratedCasesYet];

  const counts = new Map<string, number>();
  for (const testCase of testCases) {
    const type = testCase.type || 'Unspecified';
    counts.set(type, (counts.get(type) || 0) + 1);
  }

  const typeSummary = Array.from(counts.entries())
    .map(([type, count]) => `${type}: ${count}`)
    .join(' - ');

  const intentCounts: Record<CaseIntent, number> = {
    positive: 0,
    negative: 0,
    edge: 0,
  };
  for (const testCase of testCases) {
    intentCounts[classifyCaseIntent(testCase)] += 1;
  }

  const covered = coverage?.byCriterion.filter((criterion) => criterion.coveredBy.length).map((criterion) => criterion.id) || [];
  const missing = coverage?.uncoveredCriteria || [];

  return [
    t.generatedCases(testCases.length),
    typeSummary ? t.typeMix(typeSummary) : '',
    t.caseIntentMix(intentCounts.positive, intentCounts.negative, intentCounts.edge),
    context?.acceptanceCriteria.length
      ? coverageEnforced
        ? t.acceptanceCriteriaCovered(covered.length ? covered.join(', ') : 'none', missing.join(', '))
        : t.acceptanceCriteriaCoveredNotEnforced
      : t.noScopedAcForRun,
  ].filter(Boolean);
}

function coverageSummaryText(
  coverage: CoverageSummary | null,
  context: QaContext | null,
  coverageEnforced: boolean,
  manualScopeOverride: boolean,
  lang: UiLanguage
) {
  const t = uiText[lang].review;
  const criteria = context?.acceptanceCriteria || [];
  if (!criteria.length) {
    return [t.noScopedAcForRun];
  }

  if (!coverage) {
    return [
      coverageEnforced ? t.acCoverageEnforced : t.acCoverageNotEnforced,
      ...(manualScopeOverride ? [t.manualOverrideActive] : []),
      ...criteria.map((criterion) => `${criterion.id}: ${criterion.text}`),
    ];
  }

  return [
    coverageEnforced
      ? t.acceptanceCriteriaCoverage(coverage.coveredCriteria, coverage.totalCriteria)
      : t.acceptanceCriteriaCoverageNotEnforced,
    ...(manualScopeOverride ? [t.manualOverrideActive] : []),
    ...coverage.byCriterion.map((criterion) =>
      `${criterion.id}: ${criterion.text} -> ${criterion.coveredBy.length ? t.coveredBy(criterion.coveredBy.join(', ')) : coverageEnforced ? t.notCovered : t.notEnforced}`
    ),
    ...(coverage.unmappedCases.length && coverageEnforced ? [t.unmappedCases(coverage.unmappedCases.join(', '))] : []),
    ...(coverage.unsubstantiatedClaims?.length
      ? [t.weakCoverage(coverage.unsubstantiatedClaims.map((claim) => `${claim.caseId}→${claim.criterionId}`).join(', '))]
      : []),
    ...(coverage.singlePolarityCriteria?.length
      ? [t.singlePolarityCoverage(coverage.singlePolarityCriteria.map((item) => `${item.criterionId} (missing ${item.missing.join('/')})`).join(', '))]
      : []),
    ...(context?.acceptanceCriteriaDiagnostics?.crossSourceConflicts?.length
      ? context.acceptanceCriteriaDiagnostics.crossSourceConflicts.map((conflict) =>
          t.crossSourceConflict(conflict.criterionId, conflict.conflictingSource.toUpperCase(), conflict.conflictingExcerpt)
        )
      : []),
  ];
}

export function ReviewPanel({
  context,
  generating,
  testCases,
  validation,
  coverage,
  coverageEnforced,
  manualScopeOverride,
  lang,
  onCaseChange,
  onCaseRemove,
  blockedCaseIds = [],
  selectedPushCaseIds = [],
  onSelectedPushCaseIdsChange,
  approved = false,
  sectionId = '',
  casesValid = false,
  coverageComplete = true,
  pushBlocker = '',
  onApprovedChange,
  onPush,
  pushing = false,
  qualityEvaluation = null,
  onRegenerate,
}: ReviewPanelProps) {
  const t = uiText[lang].review;
  const [selectedCaseIndex, setSelectedCaseIndex] = useState(0);
  const [activeFilter, setActiveFilter] = useState<'all' | 'postman' | 'manualDb' | 'valid' | 'needsFix' | 'unmapped'>('all');
  const [activeTab, setActiveTab] = useState<'details' | 'validation' | 'mapping' | 'evidence' | 'history'>('details');
  const [searchQuery, setSearchQuery] = useState('');
  const [showListTools, setShowListTools] = useState(false);
  const [editingPreview, setEditingPreview] = useState(false);
  const [showAcCoverage, setShowAcCoverage] = useState(true);
  const [removeCandidate, setRemoveCandidate] = useState<{ index: number; id: string; title: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const invalidCount = validation.filter((item) => !item.valid).length;
  const validCount = validation.filter((item) => item.valid).length;
  const unmappedCaseIds = new Set(coverage?.unmappedCases || []);
  const blockedCaseIdSet = new Set(blockedCaseIds);
  const selectedPushCaseIdSet = new Set(selectedPushCaseIds);
  const isUnmapped = (testCase: GeneratedTestCase) =>
    unmappedCaseIds.has(testCase.id) || !(testCase.coversAcceptanceCriteria && testCase.coversAcceptanceCriteria.length);
  const unmappedCount = coverage ? coverage.unmappedCases.length : testCases.filter(isUnmapped).length;
  const postmanCount = testCases.filter((testCase) => testCase.executionType === 'postman').length;
  const manualDbCount = testCases.filter((testCase) => testCase.executionType === 'manual_db').length;
  const coveragePercent = coverage?.totalCriteria ? Math.round((coverage.coveredCriteria / coverage.totalCriteria) * 100) : 0;
  const selectedCase = testCases[selectedCaseIndex] || testCases[0] || null;
  const selectedValidation = selectedCase ? validation[selectedCaseIndex] : null;
  const selectedBddSteps = selectedCase ? parseBddSteps(selectedCase.bddScenario) : [];
  const selectedExpectedResult = selectedCase?.expectedResult || selectedCase?.manualVerification?.expectedResult || '';
  const selectedIsBlocked = Boolean(selectedCase && blockedCaseIdSet.has(selectedCase.id));
  const selectedReady = Boolean(selectedCase && !selectedIsBlocked && selectedValidation?.valid && coverageComplete);
  const selectedForPush = Boolean(selectedCase && selectedPushCaseIdSet.has(selectedCase.id));
  const qualityReasons = qualityEvaluation ? qualityGateReasons(qualityEvaluation) : [];
  const acCoverageRows = (context?.acceptanceCriteria || []).map((criterion) => {
    const coveredBy = coverage?.byCriterion.find((item) => item.id === criterion.id)?.coveredBy || [];
    return { ...criterion, coveredBy, covered: coveredBy.length > 0 };
  });
  const directRequirements = context?.acceptanceCriteriaDiagnostics?.directRequirements || [];
  const clarificationRequirements = directRequirements.filter((requirement) => requirement.disposition === 'needs_clarification');
  const blockersForCase = (testCase: GeneratedTestCase) => {
    if (testCase.clarificationBlockers?.length) return testCase.clarificationBlockers;
    const mappedCriteria = new Set(testCase.coversAcceptanceCriteria || []);
    return clarificationRequirements
      .filter((requirement) => requirement.acceptanceCriteriaIds.some((criterionId) => mappedCriteria.has(criterionId)))
      .map((requirement) => ({
        requirementId: requirement.id,
        reason: requirement.clarificationReason || t.clarificationBlocked,
        sourceLocation: requirement.sourceLocation,
        sourceUrl: requirement.sourceUrl,
      }));
  };
  const selectedClarificationBlockers = selectedCase ? blockersForCase(selectedCase) : [];
  const selectedEndpointDowngrades = selectedCase
    ? (context?.acceptanceCriteriaDiagnostics?.acceptanceCriteriaExecutionPlan || []).filter(
        (plan) => selectedCase.coversAcceptanceCriteria.includes(plan.criterionId) && plan.endpointDowngrade
      )
    : [];
  const readyCaseCount = testCases.length - blockedCaseIds.length;

  const query = searchQuery.trim().toLowerCase();
  const filteredCases = testCases
    .map((testCase, index) => ({ testCase, index, validationEntry: validation[index] }))
    .filter((entry) => {
      if (activeFilter === 'valid' && !entry.validationEntry?.valid) return false;
      if (activeFilter === 'postman' && entry.testCase.executionType !== 'postman') return false;
      if (activeFilter === 'manualDb' && entry.testCase.executionType !== 'manual_db') return false;
      if (activeFilter === 'needsFix' && entry.validationEntry?.valid) return false;
      if (activeFilter === 'unmapped' && !isUnmapped(entry.testCase)) return false;
      if (query && !`${entry.testCase.id} ${entry.testCase.title}`.toLowerCase().includes(query)) return false;
      return true;
    });
  const otherCases = filteredCases.filter((entry) => entry.index !== selectedCaseIndex);

  const filteredPositions = filteredCases.map((entry) => entry.index);
  const selectedPosition = filteredPositions.indexOf(selectedCaseIndex);
  const goToOffset = (offset: number) => {
    if (selectedPosition < 0) return;
    const next = filteredPositions[selectedPosition + offset];
    if (next != null) setSelectedCaseIndex(next);
  };

  useEffect(() => {
    if (selectedCaseIndex >= testCases.length) {
      setSelectedCaseIndex(Math.max(0, testCases.length - 1));
    }
  }, [selectedCaseIndex, testCases.length]);

  useEffect(() => {
    setEditingPreview(false);
  }, [selectedCaseIndex]);

  // Keep a visible case selected when filters/search hide the current one.
  useEffect(() => {
    if (filteredPositions.length && !filteredPositions.includes(selectedCaseIndex)) {
      setSelectedCaseIndex(filteredPositions[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilter, searchQuery, testCases.length]);

  // "/" focuses the case search (unless already typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function requestCaseRemoval(index: number) {
    const candidate = testCases[index];
    if (!candidate || !onCaseRemove) return;
    setRemoveCandidate({ index, id: candidate.id, title: candidate.title });
  }

  function confirmCaseRemoval() {
    if (!removeCandidate || !onCaseRemove) return;
    const removedIndex = removeCandidate.index;
    onCaseRemove(removedIndex);
    setSelectedCaseIndex((current) => {
      if (testCases.length <= 1) return 0;
      if (removedIndex < current) return current - 1;
      if (removedIndex === current) return Math.min(current, testCases.length - 2);
      return current;
    });
    setRemoveCandidate(null);
  }

  function updatePushSelection(caseId: string, selected: boolean) {
    if (!onSelectedPushCaseIdsChange || blockedCaseIdSet.has(caseId)) return;
    const next = new Set(selectedPushCaseIds);
    if (selected) next.add(caseId);
    else next.delete(caseId);
    onSelectedPushCaseIdsChange([...next]);
  }

  return (
    <section className="panel review-workspace">
      <div className="review-head">
        <div className="review-title">
          <h3>{t.title}</h3>
          <p>{t.subtitle}</p>
        </div>
      </div>

      {testCases.length > 0 ? <div className="review-batch-strip">
        <div className="review-batch-main">
          <div className="review-batch-summary">
            <span className="section-eyebrow">{t.batchSummary}</span>
            <strong>{context?.ticketKey || '-'}</strong>
          </div>
          <div className="review-batch-metrics">
            <span>{t.statTotal}<strong>{testCases.length}</strong></span>
            <span className="stat-ok">{t.statValid}<strong>{validCount}</strong></span>
            <span className="stat-warn">{t.statNeedsFix}<strong>{invalidCount}</strong></span>
            <span className="stat-danger">{t.statUnmapped}<strong>{unmappedCount}</strong></span>
            <span className="stat-ok">{t.statReady}<strong>{readyCaseCount}</strong></span>
            {blockedCaseIds.length ? <span className="stat-danger">{t.statBlocked}<strong>{blockedCaseIds.length}</strong></span> : null}
          </div>
          <div className="review-batch-coverage">
            <div>
              <span className="section-eyebrow">{t.acCoverage}</span>
              <small>{t.acCovered(coverage?.coveredCriteria || 0, coverage?.totalCriteria || 0)}</small>
            </div>
            <span className="coverage-bar"><span style={{ width: `${coveragePercent}%` }} /></span>
            <strong>{coveragePercent}%</strong>
          </div>
        </div>
        {qualityEvaluation ? (
          <div className={`review-quality-gate review-quality-${qualityEvaluation.qualityGate}`}>
            <strong>
              {qualityEvaluation.qualityGate === 'pass' ? (
                <span className="review-quality-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                </span>
              ) : null}
              {qualityEvaluation.qualityGate === 'pass'
                ? t.qualityGatePassed
                : qualityEvaluation.qualityGate === 'warn'
                  ? t.qualityGateWarn
                  : t.qualityGateFailed}
            </strong>
            <span>
              {qualityEvaluation.qualityGate === 'pass'
                ? t.qualityGateBody
                : qualityReasons.join(' · ') || `${qualityEvaluation.testCaseCount} cases · ${qualityEvaluation.coveredCriteria}/${qualityEvaluation.totalCriteria} ACs covered`}
            </span>
          </div>
        ) : null}
      </div> : null}

      {testCases.length > 0 && acCoverageRows.length > 0 ? (
        <section className="review-ac-coverage" aria-label={t.acCoverageTitle}>
          <button className="review-ac-coverage-head" type="button" aria-expanded={showAcCoverage} onClick={() => setShowAcCoverage((current) => !current)}>
            <span className="review-ac-chevron" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={showAcCoverage ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
              </svg>
            </span>
            <strong>{t.acCoverageTitle}</strong>
            <span className="review-ac-coverage-total">{t.acCovered(coverage?.coveredCriteria || 0, coverage?.totalCriteria || acCoverageRows.length)}</span>
            <span className="review-ac-chevron review-ac-chevron-end" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={showAcCoverage ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
              </svg>
            </span>
          </button>
          {showAcCoverage ? (
            <div className="review-ac-coverage-table" role="table">
              <div className="review-ac-coverage-row review-ac-coverage-header" role="row">
                <span role="columnheader">{t.acCoverageId}</span>
                <span role="columnheader">{t.acCoverageDescription}</span>
                <span role="columnheader">{t.acCoverageStatus}</span>
                <span role="columnheader">{t.acCoveredBy}</span>
              </div>
              {acCoverageRows.map((criterion) => (
                <div className="review-ac-coverage-row" role="row" key={criterion.id}>
                  <span role="cell"><strong className="review-ac-id">{criterion.id}</strong></span>
                  <span role="cell">{criterion.text}</span>
                  <span role="cell">
                    <span className={`review-ac-status ${criterion.covered ? 'covered' : 'not-covered'}`}>
                      {criterion.covered ? t.acCoveredStatus : t.acNotCoveredStatus}
                    </span>
                  </span>
                  <span role="cell">{criterion.coveredBy.length ? criterion.coveredBy.join(', ') : '-'}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {testCases.length > 0 && directRequirements.length ? (
        <section className="review-spec-traceability" aria-label={t.technicalTraceability}>
          <div className="review-spec-traceability-head">
            <div>
              <strong>{t.technicalTraceability}</strong>
              <span>{t.technicalTraceabilityHint}</span>
            </div>
            <span>{t.readyBlockedSummary(readyCaseCount, blockedCaseIds.length)}</span>
          </div>
          <div className="review-spec-traceability-table" role="table">
            <div className="review-spec-traceability-row review-spec-traceability-header" role="row">
              <span role="columnheader">{t.requirement}</span>
              <span role="columnheader">{t.traceability}</span>
              <span role="columnheader">{t.source}</span>
            </div>
            {directRequirements.map((requirement) => {
              const mappedCases = testCases.filter((testCase) =>
                testCase.coversAcceptanceCriteria.some((criterionId) => requirement.acceptanceCriteriaIds.includes(criterionId))
              );
              return (
                <div className={`review-spec-traceability-row ${requirement.disposition === 'needs_clarification' ? 'blocked' : ''}`} role="row" key={requirement.id}>
                  <span role="cell">
                    <strong>{requirement.id}</strong> {requirement.text}
                    {requirement.disposition === 'needs_clarification' ? <em>{t.clarificationBlocked}</em> : null}
                  </span>
                  <span role="cell">
                    {requirement.acceptanceCriteriaIds.length ? `${requirement.acceptanceCriteriaIds.join(', ')} → ${mappedCases.map((testCase) => testCase.id).join(', ') || '-'}` : '-'}
                  </span>
                  <span role="cell">
                    {requirement.sourceUrl ? <a href={requirement.sourceUrl} target="_blank" rel="noreferrer">{requirement.sourceLocation}</a> : requirement.sourceLocation}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {generating || testCases.length > 0 ? (
        <div className="legacy-review-summary">
          <div className={`summary summary-status ${invalidCount ? 'summary-warn' : ''}`}>
            {generating ? t.generatingTitle : invalidCount ? t.needsFixes(invalidCount) : t.casesValid(testCases.length)}
          </div>

          <div className="summary summary-generated">
            {(generating
              ? [t.generatingBody]
              : generatedSummaryText(testCases, coverage, context, coverageEnforced, lang)
            ).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>

          <details className="summary summary-detail">
            <summary>{t.coverageDetails}</summary>
            <div className="summary-detail-body">
              {(generating
                ? [t.generatingCoverage]
                : coverageSummaryText(coverage, context, coverageEnforced, manualScopeOverride, lang)
              ).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </details>
        </div>
      ) : null}

      {generating && testCases.length === 0 ? (
        <div className="case-list case-list-loading">
          {Array.from({ length: 2 }).map((_, index) => (
            <article className="case-card case-card-loading" key={index}>
              <div className="case-header">
                <div className="case-title-block">
                  <div className="case-title-meta">
                    <div className="case-id skeleton-block skeleton-pill" />
                    <div className="skeleton-block skeleton-line skeleton-line-short" />
                  </div>
                </div>
              </div>
              <div className="skeleton-stack">
                <span className="skeleton-block skeleton-line" />
                <span className="skeleton-block skeleton-line" />
                <span className="skeleton-block skeleton-line skeleton-line-short" />
              </div>
            </article>
          ))}
        </div>
      ) : testCases.length === 0 ? (
        <div className="empty-centered">
          <span className="empty-ic" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3 8-8" />
              <path d="M21 12a9 9 0 1 1-5.6-8.3" />
            </svg>
          </span>
          <div className="empty-title">{context ? t.emptyTitleReady : t.emptyTitleNoScope}</div>
          <p className="empty-hint">{context ? t.emptyBodyReady : t.emptyBodyNoScope}</p>
        </div>
      ) : (
        <div className="review-split">
          {selectedCase ? (
            <div className="case-detail-pane">
              <div className="case-detail-head">
                <div>
                  <div className="case-detail-title-row">
                    <select
                      className="case-selector"
                      aria-label="Selected test case"
                      value={selectedCaseIndex}
                      onChange={(event) => {
                        setSelectedCaseIndex(Number(event.target.value));
                        setActiveTab('details');
                      }}
                    >
                      {testCases.map((testCase, index) => <option key={testCase.id || index} value={index}>{`TC-${index + 1}`}</option>)}
                    </select>
                    <div className="case-nav">
                      <button type="button" aria-label={t.prevCase} disabled={selectedPosition <= 0} onClick={() => goToOffset(-1)}>{'<'}</button>
                      <button type="button" aria-label={t.nextCase} disabled={selectedPosition < 0 || selectedPosition >= filteredPositions.length - 1} onClick={() => goToOffset(1)}>{'>'}</button>
                    </div>
                    <h3>{titleWithoutPrefix(selectedCase.title)}</h3>
                  </div>
                  <div className="case-meta-row">
                    <span className="case-meta-pill">Jira: {selectedCase.jiraReference || '-'}</span>
                    <span className="case-meta-ac">{t.listAcMapping}: <strong>{listToInput(selectedCase.coversAcceptanceCriteria) || '-'}</strong></span>
                    <label className={`case-push-select ${selectedIsBlocked ? 'blocked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selectedPushCaseIdSet.has(selectedCase.id)}
                        disabled={selectedIsBlocked || !onSelectedPushCaseIdsChange}
                        onChange={(event) => updatePushSelection(selectedCase.id, event.target.checked)}
                      />
                      <span>{selectedIsBlocked ? t.clarificationBlocked : t.readyForPush}</span>
                    </label>
                  </div>
                  {selectedClarificationBlockers.map((blocker) => (
                    <div className="case-clarification-blocker" key={blocker.requirementId}>
                      <strong>{t.clarificationBlocked}</strong> {blocker.reason}
                      {blocker.sourceUrl ? <a href={blocker.sourceUrl} target="_blank" rel="noreferrer">{blocker.sourceLocation}</a> : blocker.sourceLocation ? ` ${blocker.sourceLocation}` : ''}
                    </div>
                  ))}
                  {selectedEndpointDowngrades.map((plan) => (
                    <div className="case-endpoint-downgrade" key={plan.criterionId}>
                      <strong>{t.endpointDowngraded}</strong> {plan.endpointDowngrade?.method} {plan.endpointDowngrade?.path} — {plan.endpointDowngrade?.reason}
                    </div>
                  ))}
                </div>
                <div className="case-detail-head-actions">
                  {onCaseRemove ? (
                    <button className="case-remove-button case-remove-header" type="button" aria-label={`${t.removeCase} ${selectedCase.id}`} onClick={() => requestCaseRemoval(selectedCaseIndex)}>
                      <TrashIcon />
                    </button>
                  ) : null}
                  <span className={`status-badge ${selectedValidation?.valid ? 'success' : 'warning'}`}>{selectedValidation?.valid ? t.valid : t.needsFixesShort}</span>
                  <button className="case-mark-fix" type="button" onClick={() => setActiveTab('validation')}>{t.markNeedsFix}</button>
                </div>
              </div>

              <div className="case-tabs">
                <button className={activeTab === 'details' ? 'active' : ''} type="button" onClick={() => setActiveTab('details')}>{t.tabDetails}</button>
                <button className={activeTab === 'validation' ? 'active' : ''} type="button" onClick={() => setActiveTab('validation')}>{t.tabValidation}</button>
                <button className={activeTab === 'mapping' ? 'active' : ''} type="button" onClick={() => setActiveTab('mapping')}>{t.tabMapping}</button>
                <button className={activeTab === 'evidence' ? 'active' : ''} type="button" onClick={() => setActiveTab('evidence')}>{t.tabEvidence}</button>
                <button className={activeTab === 'history' ? 'active' : ''} type="button" onClick={() => setActiveTab('history')}>{t.tabHistory}</button>
              </div>

              <div className="review-table-pane">
                <div className="review-list-heading">
                  <div>
                    <strong>{t.otherGeneratedCases(testCases.length - 1)}</strong>
                    <span>{t.traceabilityDetails}</span>
                  </div>
                  <div className="review-list-heading-actions">
                    {onRegenerate ? (
                      <button className="button button-secondary review-regenerate-button" type="button" disabled={generating} onClick={onRegenerate}>
                        {generating ? t.regeneratingCases : t.regenerateCases}
                      </button>
                    ) : null}
                    <span>{Math.max(0, testCases.length - 1)} total</span>
                  </div>
                </div>
                {showListTools ? (
                  <div className="review-tools">
                    <input
                      ref={searchRef}
                      className="review-search"
                      type="search"
                      value={searchQuery}
                      placeholder={t.searchPlaceholder}
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                    <button className={`review-filter ${activeFilter === 'all' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('all')}>{t.filterAll} {testCases.length}</button>
                    <button className={`review-filter ${activeFilter === 'postman' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('postman')}>{t.filterPostman} {postmanCount}</button>
                    <button className={`review-filter ${activeFilter === 'manualDb' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('manualDb')}>{t.filterManualDb} {manualDbCount}</button>
                    <button className={`review-filter ${activeFilter === 'valid' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('valid')}>{t.filterValid} {validCount}</button>
                    <button className={`review-filter ${activeFilter === 'needsFix' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('needsFix')}>{t.filterNeedsFix} {invalidCount}</button>
                    <button className={`review-filter ${activeFilter === 'unmapped' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('unmapped')}>{t.filterUnmapped} {unmappedCount}</button>
                  </div>
                ) : null}
                <table className="case-table">
                  <thead>
                    <tr>
                      <th>{t.colId}</th>
                      <th>{t.titleLabel}</th>
                      <th>{t.listAcMapping}</th>
                      <th>{t.testIntent}</th>
                      <th>{t.colStatus}</th>
                      <th aria-label={t.removeCase} />
                    </tr>
                  </thead>
                  <tbody>
                    {otherCases.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="muted">{testCases.length <= 1 ? t.noOtherCases : t.noMatches}</td>
                      </tr>
                    ) : null}
                    {otherCases.map(({ testCase, index, validationEntry }) => {
                      const isSelected = index === selectedCaseIndex;
                      const intent = classifyCaseIntent(testCase);
                      const isBlocked = blockedCaseIdSet.has(testCase.id);
                      return (
                        <tr
                          className={isSelected ? 'selected' : ''}
                          key={testCase.id || index}
                          role="button"
                          tabIndex={0}
                          onClick={() => { setSelectedCaseIndex(index); setActiveTab('details'); }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedCaseIndex(index);
                              setActiveTab('details');
                            }
                          }}
                        >
                          <td className="case-id-selection">
                            <input
                              type="checkbox"
                              aria-label={`${t.readyForPush} ${testCase.id}`}
                              checked={selectedPushCaseIdSet.has(testCase.id)}
                              disabled={isBlocked || !onSelectedPushCaseIdsChange}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => updatePushSelection(testCase.id, event.target.checked)}
                            />
                            <span>{testCase.id}</span>
                            {isBlocked ? <small>{t.blocked}</small> : null}
                          </td>
                          <td>{testCase.title}</td>
                          <td>{listToInput(testCase.coversAcceptanceCriteria) || '-'}</td>
                          <td><span className={`case-intent-badge ${intent}`}>{intent}</span></td>
                          <td><span className={`status-badge ${validationEntry?.valid ? 'success' : 'warning'}`}>{validationEntry?.valid ? t.valid : t.needsFixesShort}</span></td>
                          <td>
                            {onCaseRemove ? (
                              <button
                                className="case-remove-button"
                                type="button"
                                aria-label={`${t.removeCase} ${testCase.id}`}
                                onClick={(event) => { event.stopPropagation(); requestCaseRemoval(index); }}
                              >
                                <TrashIcon />
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <button className="review-list-more" type="button" onClick={() => setShowListTools((current) => !current)}>
                  {showListTools ? t.hideFilters : t.viewAll}
                </button>
              </div>

              {activeTab === 'details' ? (
                <div className={`case-detail-main ${editingPreview ? 'preview-editing' : ''}`}>
                  <aside className="testrail-preview-pane" aria-label={t.testRailPreview}>
                    <div className="preview-heading">
                      <div>
                        <span className="section-eyebrow">{t.testRailPreview}</span>
                        <strong>{editingPreview ? t.editing : t.readOnly}</strong>
                      </div>
                      <span>{t.previewingAs}</span>
                    </div>
                    <div className="testrail-preview-table">
                      <div className="preview-row">
                        <span>{t.titleLabel}</span>
                        {editingPreview ? (
                          <input className="preview-edit-control" aria-label={t.titleLabel} value={selectedCase.title} onChange={(event) => onCaseChange(selectedCaseIndex, 'title', event.target.value)} />
                        ) : <strong>{selectedCase.title}</strong>}
                      </div>
                      <div className="preview-row">
                        <span>{t.typeLabel}</span>
                        <div>{selectedCase.type || 'BDD'}</div>
                      </div>
                      <div className="preview-row">
                        <span>{t.preconditions}</span>
                        {editingPreview ? (
                          <textarea className="preview-edit-control preview-edit-textarea" aria-label={t.preconditions} value={selectedCase.preconditions} onChange={(event) => onCaseChange(selectedCaseIndex, 'preconditions', event.target.value)} />
                        ) : <div>{selectedCase.preconditions || '-'}</div>}
                      </div>
                      <div className="preview-row"><span>{t.steps}</span>
                        {editingPreview ? (
                          <div className="preview-bdd-editor">
                            <BddEditor
                              key={selectedCase.id}
                              value={selectedCase.bddScenario}
                              lang={lang}
                              onChange={(next) => onCaseChange(selectedCaseIndex, 'bddScenario', next)}
                            />
                          </div>
                        ) : selectedBddSteps.length ? (
                          <ol className="preview-steps">{selectedBddSteps.slice(0, 6).map((step, index) => <li key={`${step.keyword}-${index}`}><strong>{step.keyword}</strong> {step.text}</li>)}</ol>
                        ) : <div>-</div>}
                      </div>
                      <div className="preview-row preview-row-expected">
                        <span>{t.expectedResult}</span>
                        {editingPreview ? (
                          <textarea className="preview-edit-control preview-edit-textarea preview-edit-expected" aria-label={t.expectedResult} value={selectedExpectedResult} onChange={(event) => onCaseChange(selectedCaseIndex, 'expectedResult', event.target.value)} />
                        ) : <strong>{selectedExpectedResult || '-'}</strong>}
                      </div>
                      <div className="preview-row">
                        <span>{t.customFields}</span>
                        {editingPreview ? (
                          <div className="preview-custom-fields">
                            <label className="preview-custom-field">
                              <strong>{t.jiraReference}</strong>
                              <input className="preview-edit-control" aria-label={t.jiraReference} value={selectedCase.jiraReference || ''} onChange={(event) => onCaseChange(selectedCaseIndex, 'jiraReference', event.target.value)} />
                            </label>
                            <label className="preview-custom-field">
                              <strong>{t.coversAc}</strong>
                              <input className="preview-edit-control" aria-label={t.coversAc} value={listToInput(selectedCase.coversAcceptanceCriteria)} onChange={(event) => onCaseChange(selectedCaseIndex, 'coversAcceptanceCriteria', event.target.value.split(',').map((value) => value.trim()).filter(Boolean))} />
                            </label>
                          </div>
                        ) : <div><strong>{t.jiraReference}</strong> {selectedCase.jiraReference || '-'}<br /><strong>{t.coversAc}</strong> {listToInput(selectedCase.coversAcceptanceCriteria) || '-'}</div>}
                      </div>
                      <div className="preview-row"><span>{t.destination}</span><div><strong>TestRail</strong><br />{t.section}: {sectionId || '-'}</div></div>
                    </div>
                    <div className={`preview-readiness ${selectedReady ? 'ready' : 'pending'}`}>
                      <strong>{selectedReady ? t.looksGood : approved ? t.approvedForTestRail : t.approvalRequired}</strong>
                      <p>{selectedReady ? t.readyToPublish : pushBlocker || t.publishNote}</p>
                    </div>
                    <div className="preview-actions">
                      <button
                        className="button button-primary preview-publish-button"
                        type="button"
                        disabled={!onPush || pushing || selectedIsBlocked || !selectedReady || !selectedForPush}
                        onClick={() => onPush?.(true)}
                      >
                        {pushing ? t.pushing : t.approvePublish}
                      </button>
                      <button className="button button-secondary preview-edit-button" type="button" onClick={() => setEditingPreview((current) => !current)}>
                        {editingPreview ? t.doneEditing : t.editCase}
                      </button>
                    </div>
                    <p className="review-publish-note">{t.publishNote}{selectedCase.jiraReference ? ` ${selectedCase.jiraReference}.` : ''}</p>
                    <label className="review-approval-toggle">
                      <input type="checkbox" checked={approved} disabled={!onApprovedChange || !casesValid || !coverageComplete} onChange={(event) => onApprovedChange?.(event.target.checked)} />
                      <span>{approved ? t.approvedForTestRail : t.approveForTestRail}</span>
                    </label>
                  </aside>
                </div>
              ) : (
                <div className="case-detail-form case-extra-panel">
                  {activeTab === 'validation' ? (
                    <div className="tab-panel">
                      {selectedValidation?.valid ? (
                        <div className="muted">{t.noValidationIssues}</div>
                      ) : (
                        <div className="validation-row">
                          <div className="validation-chip validation-error">{t.needsFixesShort}</div>
                          <div className="validation-detail">{selectedValidation?.errors.join('\n')}</div>
                        </div>
                      )}
                      {selectedValidation?.warnings.length ? (
                        <div className="evidence-row">
                          <span className="evidence-label">{t.warningsLabel}</span>
                          <div className="evidence-warning">{selectedValidation.warnings.join('\n')}</div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {activeTab === 'mapping' ? (
                    <div className="tab-panel">
                      <label className="field">
                        <span>{t.coversAc}</span>
                        <input
                          value={listToInput(selectedCase.coversAcceptanceCriteria)}
                          onChange={(event) =>
                            onCaseChange(
                              selectedCaseIndex,
                              'coversAcceptanceCriteria',
                              event.target.value.split(',').map((value) => value.trim()).filter(Boolean)
                            )
                          }
                        />
                      </label>
                      <div className="evidence-row">
                        <span className="evidence-label">{t.sourceScope}</span>
                        <div className="readonly-block">{listToInput(selectedCase.sourceScope) || '-'}</div>
                      </div>
                      <div className="evidence-row">
                        <span className="evidence-label">{t.caseCoverageStatus}</span>
                        <div className="readonly-block">
                          {selectedCase.coversAcceptanceCriteria.length
                            ? listToInput(selectedCase.coversAcceptanceCriteria)
                            : coverageEnforced
                              ? t.noAcMapping
                              : t.acMappingNotEnforced}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {activeTab === 'evidence' ? (
                    <div className="tab-panel">
                      <div className="evidence-row">
                        <span className="evidence-label">{t.prdSection}</span>
                        <div className="readonly-block">{selectedCase.evidence.prdSectionTitle || t.noPrdSection}</div>
                      </div>
                      <div className="evidence-row">
                        <span className="evidence-label">{t.acceptanceCriteria}</span>
                        {selectedCase.evidence.acceptanceCriteria.length ? (
                          <ul className="evidence-list">
                            {selectedCase.evidence.acceptanceCriteria.map((criterion) => (
                              <li key={criterion.id}>
                                <strong>{criterion.id}</strong> {criterion.text}
                                <SourceExcerpt
                                  criterionText={criterion.text}
                                  excerpts={criterion.sourceExcerpts}
                                  excerpt={criterion.sourceExcerpt}
                                  location={criterion.sourceExcerptLocation}
                                  url={criterion.sourceExcerptUrl}
                                  kind={criterion.sourceExcerptKind}
                                  confidence={criterion.sourceExcerptConfidence}
                                  lang={lang}
                                />
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="muted">{t.noResolvedAcceptanceCriteria}</div>
                        )}
                      </div>
                      <div className="evidence-row">
                        <span className="evidence-label">{t.coverageNote}</span>
                        {selectedCase.evidence.coverageNote ? (
                          <div>{selectedCase.evidence.coverageNote}</div>
                        ) : (
                          <div className="evidence-warning">{t.missingCoverageNote}</div>
                        )}
                      </div>
                    </div>
                  ) : null}

                  {activeTab === 'history' ? (
                    <div className="tab-panel muted">{t.historyEmpty}</div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
      {removeCandidate ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRemoveCandidate(null)}>
          <div className="modal-card case-remove-modal" role="dialog" aria-modal="true" aria-labelledby="remove-case-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="case-remove-icon" aria-hidden="true">!</div>
            <h3 id="remove-case-title">{t.removeCaseTitle(removeCandidate.id)}</h3>
            <p>{t.removeCaseBody}</p>
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={() => setRemoveCandidate(null)}>{t.cancel}</button>
              <button className="button button-danger" type="button" onClick={confirmCaseRemoval}>{t.removeCaseConfirm}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
