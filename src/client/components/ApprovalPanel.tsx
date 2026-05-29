import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface ApprovalPanelProps {
  approved: boolean;
  sectionId: string;
  pushDisabled: boolean;
  busy: boolean;
  results: string;
  lang: UiLanguage;
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
  lang,
  onApprovedChange,
  onSectionIdChange,
  onPush,
}: ApprovalPanelProps) {
  const t = uiText[lang].approval;
  return (
    <section className="panel panel-stack approval-panel panel-control">
      <div className="panel-heading">
        <div className="panel-heading-main">
          <span className="panel-step">4</span>
          <div>
            <h2>{t.title}</h2>
            <p>{t.subtitle}</p>
          </div>
        </div>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={approved} onChange={(event) => onApprovedChange(event.target.checked)} />
        <span>{t.approveForTestrail}</span>
      </label>

      <label className="field">
        <span>{t.sectionId}</span>
        <input value={sectionId} placeholder="69" onChange={(event) => onSectionIdChange(event.target.value)} />
      </label>

      <button className="button button-danger" type="button" disabled={busy || pushDisabled} onClick={onPush}>
        {busy ? t.pushing : t.action}
      </button>

      <pre className="results">{results || t.emptyResults}</pre>
    </section>
  );
}
