import { useEffect, useMemo, useState } from 'react';
import type { CoverageResponse, TrSummary, WorkflowHistorySummary } from '../../shared/contracts';
import { loadCoverage, loadTestRailSummary } from '../api';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface HomeSuggestion {
  key: string;
  summary: string;
}

interface HomeViewProps {
  lang: UiLanguage;
  authenticated: boolean;
  testrailReady: boolean;
  suggestions: HomeSuggestion[];
  recentRuns: WorkflowHistorySummary[];
  onQuickStart: (jiraKey: string) => void;
  onOpenDashboard: () => void;
  onOpenHistory: () => void;
  onLogin: () => void;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function PassRing({ rate }: { rate: number }) {
  const r = 25;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, rate)) / 100 * c;
  return (
    <span className="home-ring" aria-hidden="true">
      <svg width="60" height="60" viewBox="0 0 60 60">
        <g transform="rotate(-90 30 30)">
          <circle cx="30" cy="30" r={r} fill="none" stroke="#eef1f5" strokeWidth="8" />
          <circle cx="30" cy="30" r={r} fill="none" stroke="#15803d" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${filled} ${c - filled}`} />
        </g>
      </svg>
      <span className="home-ring-v">{Math.round(rate)}%</span>
    </span>
  );
}

function ActivityRow({ lang, run }: { lang: UiLanguage; run: WorkflowHistorySummary }) {
  const h = uiText[lang].home;
  const map = {
    analysis: { tone: 'an', glyph: '◎', label: h.activityAnalyzed, detail: run.jiraKey },
    generation: {
      tone: 'gen',
      glyph: '✦',
      label: run.caseCount ? `${h.activityGenerated} (${run.caseCount})` : h.activityGenerated,
      detail: [run.jiraKey, run.model].filter(Boolean).join(' · '),
    },
    push: {
      tone: 'push',
      glyph: '↥',
      label: typeof run.pushed === 'number' ? `${h.activityPushed} (${run.pushed})` : h.activityPushed,
      detail: run.jiraKey,
    },
  } as const;
  const meta = map[run.entryType];
  return (
    <div className="home-feed-row">
      <span className={`home-dot home-dot-${meta.tone}`} aria-hidden="true">{meta.glyph}</span>
      <div className="home-feed-tx">
        <b>{meta.label}</b>
        <div className="home-feed-sub">{meta.detail}</div>
      </div>
      <span className="home-feed-when">{relativeTime(run.createdAt)}</span>
    </div>
  );
}

export function HomeView({
  lang,
  authenticated,
  testrailReady,
  suggestions,
  recentRuns,
  onQuickStart,
  onOpenDashboard,
  onOpenHistory,
  onLogin,
}: HomeViewProps) {
  const h = uiText[lang].home;
  const [ticketKey, setTicketKey] = useState('');
  const [summary, setSummary] = useState<TrSummary | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [coverage, setCoverage] = useState<CoverageResponse['coverage'] | null>(null);

  const suggestionKeys = suggestions.map((s) => s.key).join(',');
  useEffect(() => {
    if (!authenticated || !testrailReady || !suggestionKeys) {
      setCoverage(null);
      return;
    }
    let cancelled = false;
    loadCoverage(suggestionKeys.split(','))
      .then((res) => {
        if (!cancelled) setCoverage(res.coverage);
      })
      .catch(() => {
        if (!cancelled) setCoverage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, testrailReady, suggestionKeys]);

  // gaps (no cases yet) first
  const sortedSuggestions = useMemo(() => {
    if (!coverage) return suggestions;
    return [...suggestions].sort((a, b) => Number(coverage[a.key]?.covered ?? true) - Number(coverage[b.key]?.covered ?? true));
  }, [suggestions, coverage]);

  const gapCount = coverage ? suggestions.filter((s) => coverage[s.key] && !coverage[s.key].covered).length : 0;

  useEffect(() => {
    if (!authenticated || !testrailReady) return;
    let cancelled = false;
    setHealthLoading(true);
    setHealthError('');
    loadTestRailSummary()
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err) => {
        if (!cancelled) setHealthError((err as Error).message || h.healthError);
      })
      .finally(() => {
        if (!cancelled) setHealthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, testrailReady, h.healthError]);

  if (!authenticated) {
    return (
      <div className="home">
        <div className="home-qs home-qs-signedout">
          <div className="home-qs-copy">
            <h2>{h.heroTitle}</h2>
            <p>{h.heroBody}</p>
          </div>
          <div className="home-qs-form">
            <button className="button button-primary" type="button" onClick={onLogin}>
              {uiText[lang].loginWithAtlassian}
            </button>
            <span className="home-muted">{h.loginRequired}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      {/* quick start */}
      <div className="home-qs">
        <div className="home-qs-copy">
          <h2>{h.heroTitle}</h2>
          <p>{h.heroBody}</p>
        </div>
        <form
          className="home-qs-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (ticketKey.trim()) onQuickStart(ticketKey.trim().toUpperCase());
          }}
        >
          <div className="home-qs-row">
            <input
              className="home-qs-input"
              value={ticketKey}
              onChange={(event) => setTicketKey(event.target.value)}
              placeholder={h.heroPlaceholder}
            />
            <button className="button button-primary" type="submit" disabled={!ticketKey.trim()}>
              {h.heroAction} →
            </button>
          </div>
          {suggestions.length ? (
            <div className="home-qs-sug">
              <span>{h.suggestedLabel}</span>
              {suggestions.slice(0, 2).map((s) => (
                <button key={s.key} type="button" className="home-qs-chip" onClick={() => onQuickStart(s.key)} title={s.summary}>
                  <b>{s.key}</b>
                  {s.summary ? ` · ${s.summary}` : ''}
                </button>
              ))}
            </div>
          ) : null}
        </form>
      </div>

      {/* QA health KPIs */}
      <div className="home-sec-head">
        <h3>{h.healthHeading}</h3>
        {testrailReady ? (
          <button type="button" className="home-link" onClick={onOpenDashboard}>
            {h.healthLink}
          </button>
        ) : null}
      </div>
      {!testrailReady ? (
        <div className="home-card home-pad home-muted">{h.healthNotConfigured}</div>
      ) : healthError ? (
        <div className="home-card home-pad tr-dashboard-error">{healthError}</div>
      ) : healthLoading && !summary ? (
        <div className="home-card home-pad home-muted">{h.healthLoading}</div>
      ) : summary ? (
        <div className="home-kpis">
          <div className="home-kpi">
            <PassRing rate={summary.passRate} />
            <div>
              <div className="home-kpi-lbl">{h.healthPassRate}</div>
              <div className="home-kpi-sub">{h.healthPassRateSub}</div>
            </div>
          </div>
          <div className="home-kpi">
            <span className="home-kpi-ic neu" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 9h16" /></svg>
            </span>
            <div>
              <div className="home-kpi-lbl">{h.healthPlans}</div>
              <div className="home-kpi-big">{summary.plans}</div>
              <div className="home-kpi-sub">{summary.activePlans} {h.healthActiveSuffix}</div>
            </div>
          </div>
          <div className="home-kpi">
            <span className="home-kpi-ic bad" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </span>
            <div>
              <div className="home-kpi-lbl">{h.healthFailed}</div>
              <div className="home-kpi-big bad">{summary.failed}</div>
              <div className="home-kpi-sub">{h.healthFailedSub}</div>
            </div>
          </div>
          <div className="home-kpi">
            <span className="home-kpi-ic warn" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
            </span>
            <div>
              <div className="home-kpi-lbl">{h.healthBlocked}</div>
              <div className="home-kpi-big warn">{summary.blocked}</div>
              <div className="home-kpi-sub">{h.healthBlockedSub}</div>
            </div>
          </div>
        </div>
      ) : null}

      {/* recent activity + assigned */}
      <div className="home-grid2">
        <section className="home-card">
          <div className="home-card-head">
            <h3>{h.activityHeading}</h3>
            <button type="button" className="home-link" onClick={onOpenHistory}>{h.activityLink}</button>
          </div>
          <div className="home-card-body">
            {recentRuns.length ? (
              recentRuns.slice(0, 6).map((run) => <ActivityRow key={run.id} lang={lang} run={run} />)
            ) : (
              <div className="home-muted home-empty-row">{h.activityEmpty}</div>
            )}
          </div>
        </section>

        <section className="home-card">
          <div className="home-card-head">
            <h3>{h.assignedHeading}</h3>
            {coverage && suggestions.length ? (
              <span className={`home-cov-summary ${gapCount > 0 ? 'has-gaps' : ''}`}>
                {gapCount > 0 ? h.coverageSummary(gapCount, suggestions.length) : h.coverageAllCovered}
              </span>
            ) : null}
          </div>
          <div className="home-card-body">
            {suggestions.length ? (
              sortedSuggestions.slice(0, 6).map((s) => {
                const cov = coverage?.[s.key];
                return (
                  <div className="home-tk-row" key={s.key}>
                    <span className="home-tk-key">{s.key}</span>
                    <span className="home-tk-sum" title={s.summary}>{s.summary}</span>
                    {cov ? (
                      <span className={`home-cov-badge ${cov.covered ? 'covered' : 'gap'}`}>
                        {cov.covered ? h.coverageHas(cov.count) : h.coverageGap}
                      </span>
                    ) : null}
                    <button type="button" className="home-tk-go" onClick={() => onQuickStart(s.key)}>
                      {h.assignedGenerate}
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="home-muted home-empty-row">{h.assignedEmpty}</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
