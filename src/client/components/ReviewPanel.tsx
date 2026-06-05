import { useEffect, useRef, useState } from 'react';
import type { CoverageSummary, GeneratedTestCase, QaContext, ValidationEntry } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';
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
}

function listToInput(value: string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : '';
}

function evidenceSummary(testCase: GeneratedTestCase, coverageEnforced: boolean, lang: UiLanguage): string {
  const t = uiText[lang].review;
  const criteria = testCase.evidence.acceptanceCriteria || [];
  const ids = criteria.map((criterion) => criterion.id).join(', ');
  return [
    testCase.evidence.prdSectionTitle || t.noPrdSection,
    ids ? `AC: ${ids}` : coverageEnforced ? t.noAcMapping : t.acMappingNotEnforced,
  ].join(' - ');
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
}: ReviewPanelProps) {
  const t = uiText[lang].review;
  const [selectedCaseIndex, setSelectedCaseIndex] = useState(0);
  const [activeFilter, setActiveFilter] = useState<'all' | 'valid' | 'needsFix' | 'unmapped'>('all');
  const [activeTab, setActiveTab] = useState<'details' | 'validation' | 'mapping' | 'evidence' | 'history'>('details');
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const invalidCount = validation.filter((item) => !item.valid).length;
  const validCount = validation.filter((item) => item.valid).length;
  const unmappedCaseIds = new Set(coverage?.unmappedCases || []);
  const isUnmapped = (testCase: GeneratedTestCase) =>
    unmappedCaseIds.has(testCase.id) || !(testCase.coversAcceptanceCriteria && testCase.coversAcceptanceCriteria.length);
  const unmappedCount = coverage ? coverage.unmappedCases.length : testCases.filter(isUnmapped).length;
  const coveragePercent = coverage?.totalCriteria ? Math.round((coverage.coveredCriteria / coverage.totalCriteria) * 100) : 0;
  const selectedCase = testCases[selectedCaseIndex] || testCases[0] || null;
  const selectedValidation = selectedCase ? validation[selectedCaseIndex] : null;

  const query = searchQuery.trim().toLowerCase();
  const filteredCases = testCases
    .map((testCase, index) => ({ testCase, index, validationEntry: validation[index] }))
    .filter((entry) => {
      if (activeFilter === 'valid' && !entry.validationEntry?.valid) return false;
      if (activeFilter === 'needsFix' && entry.validationEntry?.valid) return false;
      if (activeFilter === 'unmapped' && !isUnmapped(entry.testCase)) return false;
      if (query && !`${entry.testCase.id} ${entry.testCase.title}`.toLowerCase().includes(query)) return false;
      return true;
    });

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

  return (
    <section className="panel review-workspace">
      <div className="review-head">
        <div className="review-title">
          <h3>{t.title}</h3>
          <p>{t.subtitle}</p>
        </div>
        <div className="review-stats">
          <span>{t.statTotal}<strong>{testCases.length}</strong></span>
          <span className="stat-ok">{t.statValid}<strong>{validCount}</strong></span>
          <span className="stat-warn">{t.statNeedsFix}<strong>{invalidCount}</strong></span>
          <span className="stat-danger">{t.statUnmapped}<strong>{unmappedCount}</strong></span>
          <span className="coverage-stat">{t.coverageLabel} <span className="coverage-bar"><span style={{ width: `${coveragePercent}%` }} /></span><strong>{coveragePercent}%</strong></span>
        </div>
      </div>

      {generating || testCases.length > 0 ? (
        <>
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
        </>
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
          <div className="review-table-pane">
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
              <button className={`review-filter ${activeFilter === 'valid' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('valid')}>{t.filterValid} {validCount}</button>
              <button className={`review-filter ${activeFilter === 'needsFix' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('needsFix')}>{t.filterNeedsFix} {invalidCount}</button>
              <button className={`review-filter ${activeFilter === 'unmapped' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('unmapped')}>{t.filterUnmapped} {unmappedCount}</button>
            </div>
            <table className="case-table">
              <thead>
                <tr>
                  <th>{t.colId}</th>
                  <th>{t.titleLabel}</th>
                  <th>{t.colStatus}</th>
                  <th>{t.coversAc}</th>
                </tr>
              </thead>
              <tbody>
                {filteredCases.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">{t.noMatches}</td>
                  </tr>
                ) : null}
                {filteredCases.map(({ testCase, index, validationEntry }) => {
                  const isSelected = index === selectedCaseIndex;
                  return (
                    <tr
                      className={isSelected ? 'selected' : ''}
                      key={testCase.id || index}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedCaseIndex(index)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedCaseIndex(index);
                        }
                      }}
                    >
                      <td>{testCase.id}</td>
                      <td>{testCase.title}</td>
                      <td><span className={`status-badge ${validationEntry?.valid ? 'success' : 'warning'}`}>{validationEntry?.valid ? t.valid : t.needsFixesShort}</span></td>
                      <td>{listToInput(testCase.coversAcceptanceCriteria) || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedCase ? (
            <div className="case-detail-pane">
              <div className="case-detail-head">
                <div>
                  <span className="case-id">{selectedCase.id}</span>
                  <h3>{selectedCase.title}</h3>
                  <p>{evidenceSummary(selectedCase, coverageEnforced, lang)}</p>
                </div>
                <div className="case-detail-head-actions">
                  <span className={`status-badge ${selectedValidation?.valid ? 'success' : 'warning'}`}>{selectedValidation?.valid ? t.valid : t.needsFixesShort}</span>
                  <div className="case-nav">
                    <button type="button" aria-label={t.prevCase} disabled={selectedPosition <= 0} onClick={() => goToOffset(-1)}>{'<'}</button>
                    <button type="button" aria-label={t.nextCase} disabled={selectedPosition < 0 || selectedPosition >= filteredPositions.length - 1} onClick={() => goToOffset(1)}>{'>'}</button>
                  </div>
                </div>
              </div>

              <div className="case-tabs">
                <button className={activeTab === 'details' ? 'active' : ''} type="button" onClick={() => setActiveTab('details')}>{t.tabDetails}</button>
                <button className={activeTab === 'validation' ? 'active' : ''} type="button" onClick={() => setActiveTab('validation')}>{t.tabValidation}</button>
                <button className={activeTab === 'mapping' ? 'active' : ''} type="button" onClick={() => setActiveTab('mapping')}>{t.tabMapping}</button>
                <button className={activeTab === 'evidence' ? 'active' : ''} type="button" onClick={() => setActiveTab('evidence')}>{t.tabEvidence}</button>
                <button className={activeTab === 'history' ? 'active' : ''} type="button" onClick={() => setActiveTab('history')}>{t.tabHistory}</button>
              </div>

              <div className="case-detail-form">
                {activeTab === 'details' ? (
                  <>
                    <label className="field">
                      <span>{t.titleLabel}</span>
                      <input value={selectedCase.title} onChange={(event) => onCaseChange(selectedCaseIndex, 'title', event.target.value)} />
                    </label>
                    <div className="case-detail-grid">
                      <label className="field">
                        <span>{t.typeLabel}</span>
                        <input value={selectedCase.type} onChange={(event) => onCaseChange(selectedCaseIndex, 'type', event.target.value)} />
                      </label>
                      <label className="field">
                        <span>{t.jiraReference}</span>
                        <input value={selectedCase.jiraReference} onChange={(event) => onCaseChange(selectedCaseIndex, 'jiraReference', event.target.value)} />
                      </label>
                    </div>
                    <label className="field">
                      <span>{t.preconditions}</span>
                      <textarea className="review-textarea" value={selectedCase.preconditions} onChange={(event) => onCaseChange(selectedCaseIndex, 'preconditions', event.target.value)} />
                    </label>
                    <div className="field">
                      <span>{t.bddScenario}</span>
                      <BddEditor
                        key={selectedCase.id}
                        value={selectedCase.bddScenario}
                        lang={lang}
                        onChange={(next) => onCaseChange(selectedCaseIndex, 'bddScenario', next)}
                      />
                    </div>
                  </>
                ) : null}

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
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
