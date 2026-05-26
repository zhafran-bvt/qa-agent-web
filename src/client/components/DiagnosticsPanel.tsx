import type { DiagnosticsResponse } from '../../shared/contracts';

interface DiagnosticsPanelProps {
  diagnostics: DiagnosticsResponse | null;
}

export function DiagnosticsPanel({ diagnostics }: DiagnosticsPanelProps) {
  return (
    <section className="panel panel-stack">
      <div className="panel-heading">
        <span className="panel-step">6</span>
        <div>
          <h2>Diagnostics</h2>
          <p>Internal runtime status for auth, persistence, and recent issues.</p>
        </div>
      </div>

      {!diagnostics ? (
        <div className="summary muted">Diagnostics unavailable.</div>
      ) : (
        <>
          <div className="context-grid">
            <div className="context-item">
              <span className="context-label">Persistence</span>
              <div className="context-value">
                {diagnostics.persistence.mode} · migration {diagnostics.persistence.currentVersion || 'none'}
              </div>
            </div>
            <div className="context-item">
              <span className="context-label">Selected Resource</span>
              <div className="context-value">
                {diagnostics.auth.selectedResource
                  ? `${diagnostics.auth.selectedResource.name || diagnostics.auth.selectedResource.url || diagnostics.auth.selectedResource.cloudId}`
                  : 'No active session'}
              </div>
            </div>
          </div>

          <div className="summary">
            <div>Atlassian: {diagnostics.readiness.atlassian ? 'ready' : 'missing config'}</div>
            <div>LLM: {diagnostics.readiness.llm ? 'ready' : 'missing config'}</div>
            <div>TestRail: {diagnostics.readiness.testrail ? 'ready' : 'missing config'}</div>
            <div>Database: {diagnostics.readiness.database ? 'ready' : 'fallback mode'}</div>
          </div>

          <div className="summary">
            <strong>Recent Issues</strong>
            {diagnostics.recentIssues.length ? (
              <ul>
                {diagnostics.recentIssues.map((issue) => (
                  <li key={`${issue.timestamp}-${issue.message}`}>
                    [{issue.level}] {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">No recent warnings or errors.</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
