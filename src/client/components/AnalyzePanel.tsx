import { useEffect, useRef, useState } from 'react';
import type { AnalyzeRequest, ResolvedQaScopeType, SuggestedTicket } from '../../shared/contracts';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

function SuggestionsSlider({
  suggestions,
  onSelect,
  t,
}: {
  suggestions: SuggestedTicket[];
  onSelect: (ticketKey: string) => void;
  t: (typeof uiText)['en']['analyze'];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  function updateArrows() {
    const el = scrollerRef.current;
    if (!el) return;
    setCanPrev(el.scrollLeft > 4);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }

  useEffect(() => {
    updateArrows();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    return () => {
      el.removeEventListener('scroll', updateArrows);
      window.removeEventListener('resize', updateArrows);
    };
  }, [suggestions.length]);

  function slide(direction: number) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(280, el.clientWidth * 0.8), behavior: 'smooth' });
  }

  return (
    <div className="suggestions-slider">
      <button type="button" className="suggestions-arrow" aria-label={t.suggestionsPrev} disabled={!canPrev} onClick={() => slide(-1)}>
        ‹
      </button>
      <div className="suggestions-list" ref={scrollerRef}>
        {suggestions.map((ticket) => (
          <button key={ticket.key} className="suggestion-item" type="button" onClick={() => onSelect(ticket.key)}>
            <span className="suggestion-key">{ticket.key}</span>
            <span className="suggestion-summary">{ticket.summary || t.noSummary}</span>
            <span className="suggestion-meta">{[ticket.issueType, ticket.status].filter(Boolean).join(' - ')}</span>
          </button>
        ))}
      </div>
      <button type="button" className="suggestions-arrow" aria-label={t.suggestionsNext} disabled={!canNext} onClick={() => slide(1)}>
        ›
      </button>
    </div>
  );
}

function splitFigmaReferences(value: string): string[] {
  return value
    .split(/[\r\n,]+/)
    .map((reference) => reference.trim())
    .filter(Boolean);
}

function isFigmaReference(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (parsed.hostname === 'figma.com' || parsed.hostname.endsWith('.figma.com'));
  } catch {
    return false;
  }
}

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
  resolvedScopeType?: ResolvedQaScopeType;
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
  resolvedScopeType,
  onLogin,
  onChange,
  onSuggestionSelect,
  onAnalyze,
}: AnalyzePanelProps) {
  const t = uiText[lang].analyze;
  // Before analysis the scope is still unknown, so QA can provide a link up front.
  // Once Jira scope is resolved, keep Figma references strictly FE/web-only.
  const showFigmaReferences = resolvedScopeType ? resolvedScopeType === 'web' : form.scopeType !== 'api' && form.feOnly !== false;
  const figmaReferenceText = (form.figmaReferences || []).join('\n');
  const invalidFigmaReference = showFigmaReferences && (form.figmaReferences || []).some((reference) => !isFigmaReference(reference));
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
          <button className="button" type="button" disabled={Boolean(analyzeBlocker) || invalidFigmaReference} onClick={() => onAnalyze()}>
            {busy ? t.analyzing : t.action}
          </button>
        </div>

        {showFigmaReferences ? (
          <label className="field figma-reference-field">
            <span>
              {t.figmaReferences}
              <small>{t.figmaReferencesHint}</small>
            </span>
            <textarea
              aria-label={t.figmaReferences}
              value={figmaReferenceText}
              placeholder={t.figmaReferencesPlaceholder}
              onChange={(event) => onChange({ figmaReferences: splitFigmaReferences(event.target.value) })}
            />
            {invalidFigmaReference ? <small className="action-hint">{t.figmaReferencesInvalid}</small> : null}
          </label>
        ) : null}

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
          <SuggestionsSlider suggestions={suggestions} onSelect={onSuggestionSelect} t={t} />
        ) : (
          <div className="muted">{t.noSuggestedTickets}</div>
        )}
      </div>
    </section>
  );
}
