import type { WorkflowHistoryDetail, WorkflowHistorySummary } from '../../shared/contracts';

interface HistoryPanelProps {
  runs: WorkflowHistorySummary[];
  selectedRun: WorkflowHistoryDetail | null;
  busy: boolean;
  onOpenRun: (id: string) => void;
}

function runLabel(run: WorkflowHistorySummary): string {
  const parts = [run.entryType.toUpperCase(), run.jiraKey, run.user];
  if (run.caseCount != null) parts.push(`${run.caseCount} cases`);
  if (run.entryType === 'push') parts.push(`push ${run.pushed || 0}/${(run.pushed || 0) + (run.failed || 0)}`);
  return parts.join(' · ');
}

export function HistoryPanel({ runs, selectedRun, busy, onOpenRun }: HistoryPanelProps) {
  return (
    <section className="panel panel-stack">
      <div className="panel-heading">
        <span className="panel-step">5</span>
        <div>
          <h2>Workflow History</h2>
          <p>Browse persisted analyze, generate, and push runs across QA users.</p>
        </div>
      </div>

      <div className="history-grid">
        <div className="history-list">
          {runs.length ? (
            runs.map((run) => (
              <button className="history-item" key={run.id} type="button" onClick={() => onOpenRun(run.id)}>
                <strong>{runLabel(run)}</strong>
                <span>{new Date(run.createdAt).toLocaleString()}</span>
              </button>
            ))
          ) : (
            <div className="summary muted">No persisted runs yet.</div>
          )}
        </div>

        <div className="history-detail">
          {busy ? (
            <div className="summary">Loading run details...</div>
          ) : selectedRun ? (
            <div className="summary">
              <div>
                <strong>{selectedRun.entryType.toUpperCase()}</strong> · {selectedRun.jiraKey} · {selectedRun.user}
              </div>
              <div>{new Date(selectedRun.createdAt).toLocaleString()}</div>
              {selectedRun.provider ? <div>LLM: {selectedRun.provider} / {selectedRun.model}</div> : null}
              <div>Cases: {selectedRun.testCases.length}</div>
              {selectedRun.push ? (
                <div>
                  Push: {selectedRun.push.summary.pushed} pushed / {selectedRun.push.summary.failed} failed · section {selectedRun.push.sectionId}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="summary muted">Select a run to inspect details.</div>
          )}
        </div>
      </div>
    </section>
  );
}
