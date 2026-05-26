import type { CoverageSummary, GeneratedTestCase, QaContext, ValidationEntry } from '../../shared/contracts';

interface ReviewPanelProps {
  context: QaContext | null;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary | null;
  coverageEnforced: boolean;
  manualScopeOverride: boolean;
  onCaseChange: (index: number, field: keyof GeneratedTestCase, value: string | string[]) => void;
}

function listToInput(value: string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : '';
}

function evidenceSummary(testCase: GeneratedTestCase): string {
  const criteria = testCase.evidence.acceptanceCriteria || [];
  const ids = criteria.map((criterion) => criterion.id).join(', ');
  return [testCase.evidence.prdSectionTitle || 'No PRD section', ids ? `AC: ${ids}` : 'No AC mapping'].join(' · ');
}

function generatedSummaryText(testCases: GeneratedTestCase[], coverage: CoverageSummary | null, context: QaContext | null): string[] {
  if (!testCases.length) return ['No generated cases yet.'];

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
    `Generated ${testCases.length} case(s).`,
    typeSummary ? `Type mix: ${typeSummary}` : '',
    context?.acceptanceCriteria.length
      ? `Acceptance criteria covered: ${covered.length ? covered.join(', ') : 'none'}${missing.length ? ` · missing ${missing.join(', ')}` : ''}`
      : 'No scoped acceptance criteria detected for this run.',
  ].filter(Boolean);
}

function coverageSummaryText(
  coverage: CoverageSummary | null,
  context: QaContext | null,
  coverageEnforced: boolean,
  manualScopeOverride: boolean
) {
  const criteria = context?.acceptanceCriteria || [];
  if (!criteria.length) {
    return ['No scoped acceptance criteria were extracted for this run.'];
  }

  if (!coverage) {
    return [
      coverageEnforced ? 'AC coverage is enforced for this run.' : 'AC coverage is not enforced for this run.',
      ...(manualScopeOverride ? ['Manual scope override is active.'] : []),
      ...criteria.map((criterion) => `${criterion.id}: ${criterion.text}`),
    ];
  }

  return [
    coverageEnforced
      ? `Acceptance Criteria Coverage: ${coverage.coveredCriteria}/${coverage.totalCriteria} covered`
      : 'Acceptance Criteria Coverage: not enforced for this run',
    ...(manualScopeOverride ? ['Manual scope override is active.'] : []),
    ...coverage.byCriterion.map((criterion) =>
      `${criterion.id}: ${criterion.text} -> ${criterion.coveredBy.length ? `covered by ${criterion.coveredBy.join(', ')}` : coverageEnforced ? 'NOT COVERED' : 'not enforced'}`
    ),
    ...(coverage.unmappedCases.length && coverageEnforced ? [`Unmapped Cases: ${coverage.unmappedCases.join(', ')}`] : []),
  ];
}

export function ReviewPanel({
  context,
  testCases,
  validation,
  coverage,
  coverageEnforced,
  manualScopeOverride,
  onCaseChange,
}: ReviewPanelProps) {
  const invalidCount = validation.filter((item) => !item.valid).length;

  return (
    <section className="panel panel-stack panel-wide">
      <div className="panel-heading">
        <span className="panel-step">3</span>
        <div>
          <h2>Review Test Cases</h2>
          <p>Edit generated cases inline. Validation and AC coverage update automatically.</p>
        </div>
      </div>

      <div className={`summary ${invalidCount ? 'summary-warn' : ''}`}>
        {testCases.length === 0 ? 'No test cases generated.' : invalidCount ? `${invalidCount} case(s) need fixes before approval.` : `${testCases.length} case(s) valid.`}
      </div>

      <div className="summary">
        {generatedSummaryText(testCases, coverage, context).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>

      <div className="summary">
        {coverageSummaryText(coverage, context, coverageEnforced, manualScopeOverride).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>

      <div className="case-list">
        {testCases.map((testCase, index) => {
          const validationEntry = validation[index];
          return (
            <article className="case-card" key={testCase.id || index}>
              <div className="case-header">
                <div className="case-status">{validationEntry?.valid ? 'Valid' : 'Needs fixes'}</div>
                <div className="case-id">{testCase.id}</div>
              </div>

              <div className="case-grid">
                <label className="field">
                  <span>Title</span>
                  <input value={testCase.title} onChange={(event) => onCaseChange(index, 'title', event.target.value)} />
                </label>
                <label className="field">
                  <span>Type</span>
                  <input value={testCase.type} onChange={(event) => onCaseChange(index, 'type', event.target.value)} />
                </label>
                <label className="field">
                  <span>Jira Reference</span>
                  <input value={testCase.jiraReference} onChange={(event) => onCaseChange(index, 'jiraReference', event.target.value)} />
                </label>
              </div>

              <div className="case-grid two-col">
                <label className="field">
                  <span>Covers AC</span>
                  <input value={listToInput(testCase.coversAcceptanceCriteria)} readOnly className="readonly-input" />
                </label>
                <label className="field">
                  <span>Source Scope</span>
                  <input value={listToInput(testCase.sourceScope)} readOnly className="readonly-input" />
                </label>
              </div>

              <details className="evidence-panel">
                <summary className="evidence-summary">{evidenceSummary(testCase)}</summary>
                <div className="evidence-content">
                  <div className="evidence-row">
                    <span className="evidence-label">PRD Section</span>
                    <div>{testCase.evidence.prdSectionTitle || 'No scoped PRD section available.'}</div>
                  </div>

                  <div className="evidence-row">
                    <span className="evidence-label">Acceptance Criteria</span>
                    {testCase.evidence.acceptanceCriteria.length ? (
                      <ul className="evidence-list">
                        {testCase.evidence.acceptanceCriteria.map((criterion) => (
                          <li key={criterion.id}>
                            <strong>{criterion.id}</strong> {criterion.text}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="muted">No resolved acceptance criteria evidence.</div>
                    )}
                  </div>

                  <div className="evidence-row">
                    <span className="evidence-label">Coverage Note</span>
                    {testCase.evidence.coverageNote ? (
                      <div>{testCase.evidence.coverageNote}</div>
                    ) : (
                      <div className="evidence-warning">Coverage note is missing for this case.</div>
                    )}
                  </div>

                  {validationEntry?.warnings.length ? (
                    <div className="evidence-warning">{validationEntry.warnings.join('\n')}</div>
                  ) : null}
                </div>
              </details>

              <label className="field">
                <span>Preconditions</span>
                <textarea value={testCase.preconditions} onChange={(event) => onCaseChange(index, 'preconditions', event.target.value)} />
              </label>

              <label className="field">
                <span>BDD Scenario</span>
                <textarea className="code-area" value={testCase.bddScenario} onChange={(event) => onCaseChange(index, 'bddScenario', event.target.value)} />
              </label>

              <div className={`validation-box ${validationEntry?.valid ? 'validation-ok' : 'validation-error'}`}>
                {validationEntry?.valid ? 'Valid' : validationEntry?.errors.join('\n')}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
