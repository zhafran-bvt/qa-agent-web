import type { AnalyzeRequest } from '../../shared/contracts';

interface AnalyzePanelProps {
  form: AnalyzeRequest;
  busy: boolean;
  onChange: (patch: Partial<AnalyzeRequest>) => void;
  onAnalyze: () => void;
}

export function AnalyzePanel({ form, busy, onChange, onAnalyze }: AnalyzePanelProps) {
  return (
    <section className="panel panel-stack">
      <div className="panel-heading">
        <span className="panel-step">1</span>
        <div>
          <h2>Analyze Jira</h2>
          <p>Pull the implementation scope from the main ticket, linked Story, and scoped PRD section.</p>
        </div>
      </div>

      <label className="field">
        <span>Jira Ticket Key</span>
        <input value={form.jiraKey} placeholder="ORB-3118" onChange={(event) => onChange({ jiraKey: event.target.value })} />
      </label>

      <div className="toggle-row">
        <label className="checkbox">
          <input type="checkbox" checked={form.feOnly} onChange={(event) => onChange({ feOnly: event.target.checked })} />
          <span>FE-only scope</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.beAlreadyTested} onChange={(event) => onChange({ beAlreadyTested: event.target.checked })} />
          <span>BE already tested</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.includeComments} onChange={(event) => onChange({ includeComments: event.target.checked })} />
          <span>Include comments</span>
        </label>
      </div>

      <label className="field">
        <span>Scope Notes</span>
        <textarea
          value={form.notes}
          placeholder="Optional constraints, exclusions, or QA notes"
          onChange={(event) => onChange({ notes: event.target.value })}
        />
      </label>

      <button className="button" type="button" disabled={busy} onClick={onAnalyze}>
        {busy ? 'Analyzing...' : 'Analyze Jira + Confluence'}
      </button>
    </section>
  );
}
