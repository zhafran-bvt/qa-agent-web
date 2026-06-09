import type { AnalyzeRequest, SuggestedTicket } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface AnalyzePanelProps {
  form: AnalyzeRequest;
  busy: boolean;
  lang: UiLanguage;
  suggestionsEnabled: boolean;
  suggestions: SuggestedTicket[];
  suggestionsLoading: boolean;
  suggestionsError: string;
  canAnalyze: boolean;
  analyzeBlocker: string;
  onLogin: () => void;
  onChange: (patch: Partial<AnalyzeRequest>) => void;
  onSuggestionSelect: (ticketKey: string) => void;
  onAnalyze: () => void;
}

export function AnalyzePanel({
  form,
  busy,
  lang,
  suggestionsEnabled,
  suggestions,
  suggestionsLoading,
  suggestionsError,
  canAnalyze,
  analyzeBlocker,
  onLogin,
  onChange,
  onSuggestionSelect,
  onAnalyze,
}: AnalyzePanelProps) {
  const t = uiText[lang].analyze;
  return (
    <section className="analysis-card">
      <div className="analysis-ticket">
        <h2>{t.title}</h2>
        <p>{t.subtitle}</p>

        {!canAnalyze ? (
          <div className="connect-callout">
            <div>
              <strong>{t.connectTitle}</strong>
              <p>{t.connectBody}</p>
            </div>
            <button className="button button-primary button-small" type="button" onClick={onLogin}>
              {t.connectAction}
            </button>
          </div>
        ) : null}

        <div className="ticket-entry-row">
          <label className="field">
            <span>{t.jiraTicketKey}</span>
            <input value={form.jiraKey} placeholder="ORB-3118" onChange={(event) => onChange({ jiraKey: event.target.value })} />
          </label>
          <button className="button" type="button" disabled={Boolean(analyzeBlocker)} onClick={() => onAnalyze()}>
            {busy ? t.analyzing : t.action}
          </button>
        </div>

        <div className="toggle-row">
          <label className="checkbox">
            <input type="checkbox" checked={form.beAlreadyTested} onChange={(event) => onChange({ beAlreadyTested: event.target.checked })} />
            <span>{t.beAlreadyTested}</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={form.includeComments} onChange={(event) => onChange({ includeComments: event.target.checked })} />
            <span>{t.includeComments}</span>
          </label>
        </div>
        {analyzeBlocker && analyzeBlocker !== t.blockerTicket ? <div className="action-hint">{analyzeBlocker}</div> : null}
      </div>

      <div className="analysis-suggestions">
        <div>
          <h3>{t.suggestedTickets}</h3>
          <span className="muted">
            {!suggestionsEnabled
              ? t.suggestionsLoginHint
              : suggestionsLoading
                ? t.loadingSuggestions
                : suggestionsError
                  ? t.suggestionsUnavailable
                  : t.suggestedSubtitle}
          </span>
        </div>
        {!suggestionsEnabled ? (
          <div className="suggestions-empty-state compact-empty">
            <strong>{t.suggestionsLockedTitle}</strong>
            <span className="muted">{t.suggestionsLockedBody}</span>
          </div>
        ) : suggestionsError ? (
          <div className="muted">{suggestionsError}</div>
        ) : suggestions.length ? (
          <div className="suggestions-list">
            {suggestions.map((ticket) => (
              <button key={ticket.key} className="suggestion-item" type="button" onClick={() => onSuggestionSelect(ticket.key)}>
                <span className="suggestion-key">{ticket.key}</span>
                <span className="suggestion-summary">{ticket.summary || t.noSummary}</span>
                <span className="suggestion-meta">
                  {[ticket.issueType, ticket.status].filter(Boolean).join(' - ')}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="muted">{t.noSuggestedTickets}</div>
        )}
      </div>
    </section>
  );
}
