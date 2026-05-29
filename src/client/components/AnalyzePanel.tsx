import type { AnalyzeRequest } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface AnalyzePanelProps {
  form: AnalyzeRequest;
  busy: boolean;
  lang: UiLanguage;
  onChange: (patch: Partial<AnalyzeRequest>) => void;
  onAnalyze: () => void;
}

export function AnalyzePanel({ form, busy, lang, onChange, onAnalyze }: AnalyzePanelProps) {
  const t = uiText[lang].analyze;
  return (
    <section className="panel panel-stack panel-control">
      <div className="panel-heading">
        <div className="panel-heading-main">
          <span className="panel-step">1</span>
          <div>
            <h2>{t.title}</h2>
            <p>{t.subtitle}</p>
          </div>
        </div>
      </div>

      <label className="field">
        <span>{t.jiraTicketKey}</span>
        <input value={form.jiraKey} placeholder="ORB-3118" onChange={(event) => onChange({ jiraKey: event.target.value })} />
      </label>

      <div className="toggle-row">
        <label className="checkbox">
          <input type="checkbox" checked={form.feOnly} onChange={(event) => onChange({ feOnly: event.target.checked })} />
          <span>{t.feOnlyScope}</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.beAlreadyTested} onChange={(event) => onChange({ beAlreadyTested: event.target.checked })} />
          <span>{t.beAlreadyTested}</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.includeComments} onChange={(event) => onChange({ includeComments: event.target.checked })} />
          <span>{t.includeComments}</span>
        </label>
      </div>

      <label className="field">
        <span>{t.scopeNotes}</span>
        <textarea
          value={form.notes}
          placeholder={t.scopeNotesPlaceholder}
          onChange={(event) => onChange({ notes: event.target.value })}
        />
      </label>

      <button className="button" type="button" disabled={busy} onClick={onAnalyze}>
        {busy ? t.analyzing : t.action}
      </button>
    </section>
  );
}
