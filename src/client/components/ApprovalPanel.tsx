interface ApprovalPanelProps {
  approved: boolean;
  sectionId: string;
  pushDisabled: boolean;
  busy: boolean;
  results: string;
  onApprovedChange: (value: boolean) => void;
  onSectionIdChange: (value: string) => void;
  onPush: () => void;
}

export function ApprovalPanel({
  approved,
  sectionId,
  pushDisabled,
  busy,
  results,
  onApprovedChange,
  onSectionIdChange,
  onPush,
}: ApprovalPanelProps) {
  return (
    <section className="panel panel-stack approval-panel">
      <div className="panel-heading">
        <span className="panel-step">4</span>
        <div>
          <h2>Approve + Push</h2>
          <p>Approval stays blocked until validation passes and coverage requirements are satisfied.</p>
        </div>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={approved} onChange={(event) => onApprovedChange(event.target.checked)} />
        <span>I approve these test cases for TestRail</span>
      </label>

      <label className="field">
        <span>TestRail Section ID</span>
        <input value={sectionId} placeholder="69" onChange={(event) => onSectionIdChange(event.target.value)} />
      </label>

      <button className="button button-danger" type="button" disabled={busy || pushDisabled} onClick={onPush}>
        {busy ? 'Pushing...' : 'Push to TestRail'}
      </button>

      <pre className="results">{results || 'Push results will appear here.'}</pre>
    </section>
  );
}
