import type { WorkflowHistoryDetail, WorkflowHistorySummary } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface HistoryPanelProps {
  runs: WorkflowHistorySummary[];
  selectedRun: WorkflowHistoryDetail | null;
  busy: boolean;
  lang: UiLanguage;
  onOpenRun: (id: string) => void;
}

function runLabel(run: WorkflowHistorySummary, lang: UiLanguage): string {
  const t = uiText[lang].history;
  const parts = [run.entryType.toUpperCase(), run.jiraKey, run.user];
  if (run.caseCount != null) parts.push(t.cases(run.caseCount));
  if (run.entryType === 'push') parts.push(t.pushSummary(run.pushed || 0, (run.pushed || 0) + (run.failed || 0)));
  return parts.join(' · ');
}

export function HistoryPanel({ runs, selectedRun, busy, lang, onOpenRun }: HistoryPanelProps) {
  const t = uiText[lang].history;
  return (
    <section className="panel panel-stack panel-secondary">
      <div className="panel-heading">
        <div>
          <h2>{t.title}</h2>
          <p>{t.subtitle}</p>
        </div>
      </div>

      <div className="history-grid">
        <div className="history-list">
          {runs.length ? (
            runs.map((run) => (
              <button className="history-item" key={run.id} type="button" onClick={() => onOpenRun(run.id)}>
                <strong>{runLabel(run, lang)}</strong>
                <span>{new Date(run.createdAt).toLocaleString()}</span>
              </button>
            ))
          ) : (
            <div className="summary muted">{t.noRuns}</div>
          )}
        </div>

        <div className="history-detail">
          {busy ? (
            <div className="summary">{t.loadingDetails}</div>
          ) : selectedRun ? (
            <div className="summary">
              <div>
                <strong>{selectedRun.entryType.toUpperCase()}</strong> · {selectedRun.jiraKey} · {selectedRun.user}
              </div>
              <div>{new Date(selectedRun.createdAt).toLocaleString()}</div>
              {selectedRun.provider ? <div>{t.llm(selectedRun.provider, selectedRun.model || '')}</div> : null}
              <div>{t.casesLabel(selectedRun.testCases.length)}</div>
              {selectedRun.push ? (
                <div>
                  {t.pushLabel(selectedRun.push.summary.pushed, selectedRun.push.summary.failed, selectedRun.push.sectionId)}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="summary muted">{t.selectRun}</div>
          )}
        </div>
      </div>
    </section>
  );
}
