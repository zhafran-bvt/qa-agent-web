import type { CoverageSummary, GeneratedTestCase, QaContext, ValidationEntry } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface ReviewPanelProps {
  context: QaContext | null;
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

function evidenceSummary(testCase: GeneratedTestCase, lang: UiLanguage): string {
  const t = uiText[lang].review;
  const criteria = testCase.evidence.acceptanceCriteria || [];
  const ids = criteria.map((criterion) => criterion.id).join(', ');
  return [testCase.evidence.prdSectionTitle || t.noPrdSection, ids ? `AC: ${ids}` : 'No AC mapping'].join(' · ');
}

function generatedSummaryText(testCases: GeneratedTestCase[], coverage: CoverageSummary | null, context: QaContext | null, lang: UiLanguage): string[] {
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
      ? t.acceptanceCriteriaCovered(covered.length ? covered.join(', ') : 'none', missing.join(', '))
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
        {testCases.length === 0 ? t.noGeneratedCases : invalidCount ? t.needsFixes(invalidCount) : t.casesValid(testCases.length)}
      </div>

      <div className="summary summary-generated">
        {generatedSummaryText(testCases, coverage, context, lang).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>

      <details className="summary summary-detail">
        <summary>{t.coverageDetails}</summary>
        <div className="summary-detail-body">
        {coverageSummaryText(coverage, context, coverageEnforced, manualScopeOverride, lang).map((line) => (
          <div key={line}>{line}</div>
        ))}
        </div>
      </details>

      <div className="case-list">
        {testCases.map((testCase, index) => {
          const validationEntry = validation[index];
          return (
            <article className="case-card" key={testCase.id || index}>
              <div className="case-header">
                <div className="case-title-block">
                  <div className="case-id">{testCase.id}</div>
                  <div className="case-status">{validationEntry?.valid ? t.valid : t.needsFixesShort}</div>
                </div>
                <div className="case-reference">{evidenceSummary(testCase, lang)}</div>
              </div>

              <div className="case-grid">
                <label className="field">
                  <span>{t.titleLabel}</span>
                  <input value={testCase.title} onChange={(event) => onCaseChange(index, 'title', event.target.value)} />
                </label>
                <label className="field">
                  <span>{t.typeLabel}</span>
                  <input value={testCase.type} onChange={(event) => onCaseChange(index, 'type', event.target.value)} />
                </label>
                <label className="field">
                  <span>{t.jiraReference}</span>
                  <input value={testCase.jiraReference} onChange={(event) => onCaseChange(index, 'jiraReference', event.target.value)} />
                </label>
              </div>

              <div className="case-grid two-col">
                <label className="field">
                  <span>{t.coversAc}</span>
                  <input value={listToInput(testCase.coversAcceptanceCriteria)} readOnly className="readonly-input" />
                </label>
                <label className="field">
                  <span>{t.sourceScope}</span>
                  <input value={listToInput(testCase.sourceScope)} readOnly className="readonly-input" />
                </label>
              </div>

              <details className="evidence-panel">
                <summary className="evidence-summary">{t.traceabilityDetails}</summary>
                <div className="evidence-content">
                  <div className="evidence-row">
                    <span className="evidence-label">{t.prdSection}</span>
                    <div>{testCase.evidence.prdSectionTitle || t.noPrdSection}</div>
                  </div>

                  <div className="evidence-row">
                    <span className="evidence-label">{t.acceptanceCriteria}</span>
                    {testCase.evidence.acceptanceCriteria.length ? (
                      <ul className="evidence-list">
                        {testCase.evidence.acceptanceCriteria.map((criterion) => (
                          <li key={criterion.id}>
                            <strong>{criterion.id}</strong> {criterion.text}
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
                <textarea value={testCase.preconditions} onChange={(event) => onCaseChange(index, 'preconditions', event.target.value)} />
              </label>

              <label className="field">
                <span>{t.bddScenario}</span>
                <textarea className="code-area" value={testCase.bddScenario} onChange={(event) => onCaseChange(index, 'bddScenario', event.target.value)} />
              </label>

              <div className={`validation-box ${validationEntry?.valid ? 'validation-ok' : 'validation-error'}`}>
                {validationEntry?.valid ? t.valid : validationEntry?.errors.join('\n')}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
