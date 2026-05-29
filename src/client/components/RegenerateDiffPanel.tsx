import type { CoverageSummary, GeneratedTestCase, ValidationEntry } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface PendingGeneration {
  runId?: string;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary;
  coverageEnforced: boolean;
  manualScopeOverride: boolean;
  provider: string;
  model: string;
}

interface RegenerateDiffPanelProps {
  currentCases: GeneratedTestCase[];
  candidate: PendingGeneration;
  lang: UiLanguage;
  onReplace: () => void;
  onCancel: () => void;
}

function compareCases(currentCases: GeneratedTestCase[], candidateCases: GeneratedTestCase[]) {
  const max = Math.max(currentCases.length, candidateCases.length);
  const rows: Array<{ key: string; status: string; current?: GeneratedTestCase; candidate?: GeneratedTestCase }> = [];
  for (let index = 0; index < max; index += 1) {
    const current = currentCases[index];
    const candidate = candidateCases[index];
    if (current && !candidate) rows.push({ key: `removed-${index}`, status: 'removed', current });
    else if (!current && candidate) rows.push({ key: `added-${index}`, status: 'added', candidate });
    else if (current && candidate) {
      const changed =
        current.title !== candidate.title ||
        current.bddScenario !== candidate.bddScenario ||
        current.evidence.coverageNote !== candidate.evidence.coverageNote ||
        current.coversAcceptanceCriteria.join(',') !== candidate.coversAcceptanceCriteria.join(',');
      rows.push({ key: `compare-${index}`, status: changed ? 'changed' : 'unchanged', current, candidate });
    }
  }
  return rows;
}

export function RegenerateDiffPanel({ currentCases, candidate, lang, onReplace, onCancel }: RegenerateDiffPanelProps) {
  const t = uiText[lang].regenerate;
  const rows = compareCases(currentCases, candidate.testCases);
  return (
    <section className="panel panel-stack">
      <div className="panel-heading">
        <div className="panel-heading-main">
          <span className="panel-step">R</span>
          <div>
            <h2>{t.title}</h2>
            <p>{t.subtitle}</p>
          </div>
        </div>
      </div>

      <div className="summary">
        <div>{t.currentCases(currentCases.length)}</div>
        <div>{t.candidateCases(candidate.testCases.length)}</div>
        <div>{t.generatedWith(candidate.provider, candidate.model)}</div>
      </div>

      <div className="diff-list">
        {rows.map((row) => (
          <div className={`diff-item diff-${row.status}`} key={row.key}>
            <strong>{row.status.toUpperCase()}</strong>
            <div>{t.current}: {row.current?.title || '-'}</div>
            <div>{t.candidate}: {row.candidate?.title || '-'}</div>
          </div>
        ))}
      </div>

      <div className="diff-actions">
        <button className="button" type="button" onClick={onReplace}>
          {t.replace}
        </button>
        <button className="button button-secondary" type="button" onClick={onCancel}>
          {t.keep}
        </button>
      </div>
    </section>
  );
}
