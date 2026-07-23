import { useState } from 'react';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface ApprovalPanelProps {
  approved: boolean;
  sectionId: string;
  casesValid: boolean;
  coverageComplete: boolean;
  readyCaseCount?: number;
  blockedCaseCount?: number;
  busy: boolean;
  results: string;
  pushBlocker: string;
  lang: UiLanguage;
  onApprovedChange: (value: boolean) => void;
  onPush: () => void;
}

export function ApprovalPanel({
  approved,
  sectionId,
  casesValid,
  coverageComplete,
  readyCaseCount = 0,
  blockedCaseCount = 0,
  busy,
  results,
  pushBlocker,
  lang,
  onApprovedChange,
  onPush,
}: ApprovalPanelProps) {
  const t = uiText[lang].approval;
  const s = uiText[lang].stepper;
  const [collapsed, setCollapsed] = useState(false);

  const gates = [
    { ok: casesValid, label: t.gateCasesValid },
    { ok: coverageComplete, label: t.gateCoverage },
    { ok: approved, label: t.gateApproved },
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
          {collapsed ? '>' : 'v'}
        </button>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={approved} onChange={(event) => onApprovedChange(event.target.checked)} />
        <span>{t.approveForTestrail}</span>
      </label>

      <div className="field">
        <span>{t.sectionId}</span>
        <output className="field-readonly">{sectionId || '—'}</output>
      </div>
      <p className="field-hint">{t.sectionAuto}</p>

      {readyCaseCount || blockedCaseCount ? (
        <p className={`push-selection-summary${blockedCaseCount ? ' has-blockers' : ''}`}>
          {t.readyBlockedSummary(readyCaseCount, blockedCaseCount)}
        </p>
      ) : null}

      <div className="push-gates">
        <div className="push-gates-title">{t.gatesTitle}</div>
        <ul>
          {gates.map((gate) => (
            <li key={gate.label} className={gate.ok ? 'gate-ok' : 'gate-bad'}>
              <span className="gate-mark" aria-hidden="true">{gate.ok ? 'OK' : '-'}</span>
              <span>{gate.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <button className="button button-danger" type="button" disabled={Boolean(pushBlocker)} onClick={onPush}>
        {busy ? t.pushing : t.action}
      </button>
      {!busy ? <p className={`gate-hint${allGatesMet ? ' gate-hint-ready' : ''}`}>{pushBlocker || t.gateReady}</p> : null}

      <pre className="results">{results || t.emptyResults}</pre>
    </section>
  );
}
