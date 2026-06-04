import { useEffect, useState } from 'react';
import type { CoverageSummary, GeneratedTestCase, QaContext, ValidationEntry } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';
import { SourceExcerpt } from './SourceExcerpt';

interface ReviewPanelProps {
  context: QaContext | null;
  generating: boolean;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary | null;
  coverageEnforced: boolean;
  manualScopeOverride: boolean;
  generateBlocker: string;
  lang: UiLanguage;
  onGenerate: () => void;
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
  generateBlocker,
  lang,
  onGenerate,
  onCaseChange,
}: ReviewPanelProps) {
  const t = uiText[lang].review;
  const [selectedCaseIndex, setSelectedCaseIndex] = useState(0);
  const [activeFilter, setActiveFilter] = useState<'all' | 'valid' | 'needsFix'>('all');
  const [activeTab, setActiveTab] = useState<'details' | 'validation' | 'mapping' | 'evidence' | 'history'>('details');
  const invalidCount = validation.filter((item) => !item.valid).length;
  const selectedCase = testCases[selectedCaseIndex] || testCases[0] || null;
  const selectedValidation = selectedCase ? validation[selectedCaseIndex] : null;
  const validCount = validation.filter((item) => item.valid).length;
  const unmappedCount = coverage?.unmappedCases.length || 0;
  const coveragePercent = coverage?.totalCriteria ? Math.round((coverage.coveredCriteria / coverage.totalCriteria) * 100) : 0;
  const filteredCases = testCases
    .map((testCase, index) => ({ testCase, index, validationEntry: validation[index] }))
    .filter((entry) => {
      if (activeFilter === 'valid') return entry.validationEntry?.valid;
      if (activeFilter === 'needsFix') return !entry.validationEntry?.valid;
      return true;
    });

  useEffect(() => {
    if (selectedCaseIndex >= testCases.length) {
      setSelectedCaseIndex(Math.max(0, testCases.length - 1));
    }
  }, [selectedCaseIndex, testCases.length]);

  return (
    <section className="panel review-workspace">
      <div className="review-head">
        <div className="review-title">
          <h3>{t.title}</h3>
          <p>{t.subtitle}</p>
        </div>
        <div className="review-stats">
          <span>Total<strong>{testCases.length}</strong></span>
          <span className="stat-ok">Valid<strong>{validCount}</strong></span>
          <span className="stat-warn">Needs Fix<strong>{invalidCount}</strong></span>
          <span className="stat-danger">Unmapped<strong>{unmappedCount}</strong></span>
          <span className="coverage-stat">Coverage <span className="coverage-bar"><span style={{ width: `${coveragePercent}%` }} /></span><strong>{coveragePercent}%</strong></span>
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
        <div className="empty-next-steps review-empty-state">
          <div>
            <strong>{context ? t.emptyTitleReady : t.emptyTitleNoScope}</strong>
            <p>{context ? t.emptyBodyReady : t.emptyBodyNoScope}</p>
          </div>
          <button className="button button-generate review-empty-action" type="button" disabled={Boolean(generateBlocker)} onClick={onGenerate}>
            {t.generateAction}
          </button>
          {generateBlocker ? <div className="action-hint review-empty-hint">{generateBlocker}</div> : null}
          <div className="review-empty-next">
            <span>{t.nextSteps}</span>
            <ol>
              {(context ? t.emptyStepsReady : t.emptyStepsNoScope).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      ) : (
        <div className="review-split">
          <div className="review-table-pane">
            <div className="review-tools">
              <div className="search-shell" aria-hidden="true">Search cases...</div>
              <button className={`review-filter ${activeFilter === 'all' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('all')}>All {testCases.length}</button>
              <button className={`review-filter ${activeFilter === 'valid' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('valid')}>Valid {validCount}</button>
              <button className={`review-filter ${activeFilter === 'needsFix' ? 'active' : ''}`} type="button" onClick={() => setActiveFilter('needsFix')}>Needs Fix {invalidCount}</button>
            </div>
            <table className="case-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{t.titleLabel}</th>
                  <th>Status</th>
                  <th>{t.coversAc}</th>
                </tr>
              </thead>
              <tbody>
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
                <span className={`status-badge ${selectedValidation?.valid ? 'success' : 'warning'}`}>{selectedValidation?.valid ? t.valid : t.needsFixesShort}</span>
              </div>

              <div className="case-tabs">
                <button className={activeTab === 'details' ? 'active' : ''} type="button" onClick={() => setActiveTab('details')}>Details</button>
                <button className={activeTab === 'validation' ? 'active' : ''} type="button" onClick={() => setActiveTab('validation')}>Validation</button>
                <button className={activeTab === 'mapping' ? 'active' : ''} type="button" onClick={() => setActiveTab('mapping')}>AC Mapping</button>
                <button className={activeTab === 'evidence' ? 'active' : ''} type="button" onClick={() => setActiveTab('evidence')}>Evidence</button>
                <button className={activeTab === 'history' ? 'active' : ''} type="button" onClick={() => setActiveTab('history')}>History</button>
              </div>

              <div className="case-detail-form">
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
                <label className="field">
                  <span>{t.bddScenario}</span>
                  <textarea className="code-area review-textarea" value={selectedCase.bddScenario} onChange={(event) => onCaseChange(selectedCaseIndex, 'bddScenario', event.target.value)} />
                </label>

                <details className="evidence-panel" open>
                  <summary className="evidence-summary">{t.traceabilityDetails}</summary>
                  <div className="evidence-content">
                    <div className="evidence-grid">
                      <div className="evidence-row">
                        <span className="evidence-label">{t.coversAc}</span>
                        <div className="readonly-block">{listToInput(selectedCase.coversAcceptanceCriteria) || t.noAcMapping}</div>
                      </div>

                      <div className="evidence-row">
                        <span className="evidence-label">{t.sourceScope}</span>
                        <div className="readonly-block">{listToInput(selectedCase.sourceScope) || '-'}</div>
                      </div>
                    </div>

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

                    {selectedValidation?.warnings.length ? (
                      <div className="evidence-warning">{selectedValidation.warnings.join('\n')}</div>
                    ) : null}
                  </div>
                </details>

                {!selectedValidation?.valid ? (
                  <div className="validation-row">
                    <div className="validation-chip validation-error">{t.needsFixesShort}</div>
                    <div className="validation-detail">{selectedValidation?.errors.join('\n')}</div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
