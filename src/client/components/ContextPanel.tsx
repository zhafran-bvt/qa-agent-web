import type { QaContext } from '../../shared/contracts';

interface ContextPanelProps {
  context: QaContext | null;
  permissionApproved: boolean;
  overrideReason: string;
  busy: boolean;
  onPermissionApprovedChange: (value: boolean) => void;
  onOverrideReasonChange: (value: string) => void;
  onGenerate: () => void;
}

function renderKeyValueRows(context: QaContext) {
  return [
    ['Ticket', context.ticketKey],
    ['Epic', context.epic],
    ['Main Summary', context.mainIssue.summary || '-'],
    [
      'Parent Story',
      context.scopeParentIssue ? `${context.scopeParentIssue.key}: ${context.scopeParentIssue.summary || ''}` : 'No parent Story detected',
    ],
    [
      'Scoped PRD Section',
      context.scopeConfluenceSection?.pageId
        ? `${context.scopeConfluenceSection.pageId}: ${context.scopeConfluenceSection.matchedHeading || context.scopeConfluenceSection.title}`
        : 'No scoped PRD section detected',
    ],
    ['AC Source', context.acceptanceCriteriaSource || 'none'],
  ];
}

export function ContextPanel({
  context,
  permissionApproved,
  overrideReason,
  busy,
  onPermissionApprovedChange,
  onOverrideReasonChange,
  onGenerate,
}: ContextPanelProps) {
  return (
    <section className="panel panel-stack">
      <div className="panel-heading">
        <span className="panel-step">2</span>
        <div>
          <h2>Context</h2>
          <p>Review the resolved Story scope, confidence level, and extracted acceptance criteria before generation.</p>
        </div>
      </div>

      {!context ? (
        <div className="summary muted">No context loaded.</div>
      ) : (
        <>
          <div className="context-grid">
            {renderKeyValueRows(context).map(([label, value]) => (
              <div className="context-item" key={label}>
                <span className="context-label">{label}</span>
                <div className="context-value">{value}</div>
              </div>
            ))}
          </div>

          <div className={`summary ${context.requiresConfidencePermission ? 'summary-warn' : ''}`}>
            <strong>Confidence: {context.confidenceLevel.toUpperCase()}</strong>
            <ul>
              {context.confidenceReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <div>{context.requiresConfidencePermission ? 'QA permission is required before generation.' : 'No confidence override is required.'}</div>
          </div>

          {context.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaReason || context.acceptanceCriteriaDiagnostics.ignoredMetadataLabels?.length ? (
            <div className="summary">
              <strong>Scope Resolution</strong>
              <ul>
                {context.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaReason ? (
                  <li>{context.acceptanceCriteriaDiagnostics.selectedAcceptanceCriteriaReason}</li>
                ) : null}
                {(context.acceptanceCriteriaDiagnostics.ignoredSources || []).map((source) => (
                  <li key={source}>Ignored source: {source}</li>
                ))}
                {(context.acceptanceCriteriaDiagnostics.ignoredMetadataLabels || []).map((label) => (
                  <li key={label}>Ignored story metadata: {label}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="details-grid">
            <div className="detail-card">
              <h3>User Stories</h3>
              {context.userStories.length ? (
                <ul>
                  {context.userStories.map((story) => (
                    <li key={story.id}>
                      <strong>{story.id}</strong> {story.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No user stories extracted.</p>
              )}
            </div>

            <div className="detail-card">
              <h3>Acceptance Criteria</h3>
              {context.acceptanceCriteria.length ? (
                <ul>
                  {context.acceptanceCriteria.map((criterion) => (
                    <li key={criterion.id}>
                      <strong>{criterion.id}</strong> {criterion.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No scoped acceptance criteria extracted.</p>
              )}
            </div>
          </div>

          {context.requiresConfidencePermission ? (
            <div className="override-box">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={permissionApproved}
                  onChange={(event) => onPermissionApprovedChange(event.target.checked)}
                />
                <span>I understand the scope-confidence warning and want to continue generating test cases</span>
              </label>
              <label className="field compact">
                <span>Manual Override Reason</span>
                <textarea
                  value={overrideReason}
                  placeholder="Optional note for why generation should proceed with low-confidence scope"
                  onChange={(event) => onOverrideReasonChange(event.target.value)}
                />
              </label>
            </div>
          ) : null}

          <button className="button" type="button" disabled={busy || (context.requiresConfidencePermission && !permissionApproved)} onClick={onGenerate}>
            {busy ? 'Generating...' : 'Generate BDD with AI'}
          </button>
        </>
      )}
    </section>
  );
}
