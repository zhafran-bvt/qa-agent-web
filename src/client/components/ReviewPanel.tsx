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
  ].join(' · ');
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
    .join(' · ');

  const covered = coverage?.byCriterion.filter((criterion) => criterion.coveredBy.length).map((criterion) => criterion.id) || [];
  const missing = coverage?.uncoveredCriteria || [];

  return [
    t.generatedCases(testCases.length),
    typeSummary ? t.typeMix(typeSummary) : '',
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
  const invalidCount = validation.filter((item) => !item.valid).length;

  return (
    <section className="panel panel-stack panel-wide panel-review">
      <div className="panel-heading">
        <div className="panel-heading-main">
          <span className="panel-step">3</span>
          <div>
            <h2>{t.title}</h2>
            <p>{t.subtitle}</p>
          </div>
        </div>
      </div>

      <div className={`summary summary-status ${invalidCount ? 'summary-warn' : ''}`}>
        {generating ? t.generatingTitle : testCases.length === 0 ? t.noGeneratedCases : invalidCount ? t.needsFixes(invalidCount) : t.casesValid(testCases.length)}
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
      ) : (
      <div className="case-list">
        {testCases.map((testCase, index) => {
          const validationEntry = validation[index];
          return (
            <article className="case-card" key={testCase.id || index}>
              <div className="case-header">
                <div className="case-title-block">
                  <div className="case-title-meta">
                    <div className="case-id">{testCase.id}</div>
                    <div className="case-reference">{evidenceSummary(testCase, coverageEnforced, lang)}</div>
                  </div>
                  <div className="case-status">{validationEntry?.valid ? t.valid : t.needsFixesShort}</div>
                </div>
              </div>

              <div className="case-grid case-grid-title">
                <label className="field">
                  <span>{t.titleLabel}</span>
                  <input value={testCase.title} onChange={(event) => onCaseChange(index, 'title', event.target.value)} />
                </label>
              </div>

              <div className="case-grid case-grid-meta">
                <label className="field">
                  <span>{t.typeLabel}</span>
                  <input value={testCase.type} onChange={(event) => onCaseChange(index, 'type', event.target.value)} />
                </label>
                <label className="field">
                  <span>{t.jiraReference}</span>
                  <input value={testCase.jiraReference} onChange={(event) => onCaseChange(index, 'jiraReference', event.target.value)} />
                </label>
              </div>

              <details className="evidence-panel">
                <summary className="evidence-summary">{t.traceabilityDetails}</summary>
                <div className="evidence-content">
                  <div className="evidence-grid">
                    <div className="evidence-row">
                      <span className="evidence-label">{t.coversAc}</span>
                      <div className="readonly-block">{listToInput(testCase.coversAcceptanceCriteria) || t.noAcMapping}</div>
                    </div>

                    <div className="evidence-row">
                      <span className="evidence-label">{t.sourceScope}</span>
                      <div className="readonly-block">{listToInput(testCase.sourceScope) || '-'}</div>
                    </div>
                  </div>

                  <div className="evidence-row">
                    <span className="evidence-label">{t.prdSection}</span>
                    <div className="readonly-block">{testCase.evidence.prdSectionTitle || t.noPrdSection}</div>
                  </div>

                  <div className="evidence-row">
                    <span className="evidence-label">{t.acceptanceCriteria}</span>
                    {testCase.evidence.acceptanceCriteria.length ? (
                      <ul className="evidence-list">
                        {testCase.evidence.acceptanceCriteria.map((criterion) => (
                          <li key={criterion.id}>
                            <strong>{criterion.id}</strong> {criterion.text}
                            <SourceExcerpt
                              criterionText={criterion.text}
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
                    {testCase.evidence.coverageNote ? (
                      <div>{testCase.evidence.coverageNote}</div>
                    ) : (
                      <div className="evidence-warning">{t.missingCoverageNote}</div>
                    )}
                  </div>

                  {validationEntry?.warnings.length ? (
                    <div className="evidence-warning">{validationEntry.warnings.join('\n')}</div>
                  ) : null}
                </div>
              </details>

              <label className="field">
                <span>{t.preconditions}</span>
                <textarea className="review-textarea" value={testCase.preconditions} onChange={(event) => onCaseChange(index, 'preconditions', event.target.value)} />
              </label>

              <label className="field">
                <span>{t.bddScenario}</span>
                <textarea className="code-area review-textarea" value={testCase.bddScenario} onChange={(event) => onCaseChange(index, 'bddScenario', event.target.value)} />
              </label>

              {!validationEntry?.valid ? (
                <div className="validation-row">
                  <div className="validation-chip validation-error">{t.needsFixesShort}</div>
                  <div className="validation-detail">{validationEntry.errors.join('\n')}</div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      )}
    </section>
  );
}
