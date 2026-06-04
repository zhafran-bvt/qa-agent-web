import { useState } from 'react';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface ApprovalPanelProps {
  approved: boolean;
  sectionId: string;
  casesValid: boolean;
  coverageComplete: boolean;
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
  casesValid,
  coverageComplete,
  busy,
  results,
  lang,
  onApprovedChange,
  onSectionIdChange,
  onPush,
}: ApprovalPanelProps) {
  const t = uiText[lang].approval;
  const s = uiText[lang].stepper;
  const [collapsed, setCollapsed] = useState(false);

  const gates = [
    { ok: casesValid, label: t.gateCasesValid },
    { ok: coverageComplete, label: t.gateCoverage },
    { ok: approved, label: t.gateApproved },
    { ok: sectionId.trim().length > 0, label: t.gateSection },
  ];
  const allGatesMet = gates.every((gate) => gate.ok);

  return (
    <section className={`panel panel-stack approval-panel panel-control${collapsed ? ' panel-collapsed' : ''}`}>
      <div className="panel-heading">
        <div className="panel-heading-main">
          <span className="panel-step">4</span>
          <div>
            <h2>{t.title}</h2>
            <p>{t.subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          className="panel-collapse-toggle"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? s.expand : s.collapse} ${t.title}`}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={approved} onChange={(event) => onApprovedChange(event.target.checked)} />
        <span>{t.approveForTestrail}</span>
      </label>

      <label className="field">
        <span>{t.sectionId}</span>
        <input value={sectionId} placeholder="69" onChange={(event) => onSectionIdChange(event.target.value)} />
      </label>
      <p className="field-hint">{t.sectionHint}</p>

      <div className="push-gates">
        <div className="push-gates-title">{t.gatesTitle}</div>
        <ul>
          {gates.map((gate) => (
            <li key={gate.label} className={gate.ok ? 'gate-ok' : 'gate-bad'}>
              <span className="gate-mark" aria-hidden="true">{gate.ok ? '✓' : '✗'}</span>
              <span>{gate.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <button className="button button-danger" type="button" disabled={busy || !allGatesMet} onClick={onPush}>
        {busy ? t.pushing : t.action}
      </button>
      {!busy ? <p className={`gate-hint${allGatesMet ? ' gate-hint-ready' : ''}`}>{allGatesMet ? t.gateReady : t.gateBlocked}</p> : null}

      <pre className="results">{results || t.emptyResults}</pre>
    </section>
  );
}
