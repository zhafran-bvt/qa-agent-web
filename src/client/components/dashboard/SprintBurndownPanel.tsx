import type { JiraSprintBurndownResponse } from '../../../shared/contracts';
import type { UiLanguage } from '../../i18n';
import { uiText } from '../../i18n';

interface SprintBurndownPanelProps {
  lang: UiLanguage;
  burndown: JiraSprintBurndownResponse | null;
  loading: boolean;
  error: string;
}

function topEntries(distribution: Record<string, number>): Array<[string, number]> {
  return Object.entries(distribution)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6);
}

export function SprintBurndownPanel({ lang, burndown, loading, error }: SprintBurndownPanelProps) {
  const t = uiText[lang].dashboard;
  const donePercent = burndown?.completionRate || 0;
  const remainingPercent = Math.max(0, 100 - donePercent);

  return (
    <section className="jira-burndown" aria-label={t.burndownTitle}>
      <div className="jira-burndown-head">
        <div>
          <h4>{t.burndownTitle}</h4>
          <p>{t.burndownSubtitle}</p>
        </div>
        {burndown ? <span className="jira-burndown-rate">{burndown.completionRate}%</span> : null}
      </div>

      {loading && !burndown ? (
        <div className="tr-dashboard-state">{t.burndownLoading}</div>
      ) : error ? (
        <div className="tr-dashboard-state tr-dashboard-error">{error}</div>
      ) : !burndown || burndown.totalIssues === 0 ? (
        <div className="tr-dashboard-state">{t.burndownEmpty}</div>
      ) : (
        <>
          <div className="jira-burndown-meter" aria-label={t.burndownMeterLabel(burndown.doneIssues, burndown.remainingIssues)}>
            <span className="jira-burndown-meter-done" style={{ width: `${donePercent}%` }} />
            <span className="jira-burndown-meter-remaining" style={{ width: `${remainingPercent}%` }} />
          </div>
          <div className="jira-burndown-metrics">
            <div>
              <span>{t.burndownTotal}</span>
              <strong>{burndown.totalIssues}</strong>
            </div>
            <div>
              <span>{t.burndownDone}</span>
              <strong>{burndown.doneIssues}</strong>
            </div>
            <div>
              <span>{t.burndownRemaining}</span>
              <strong>{burndown.remainingIssues}</strong>
            </div>
          </div>
          <div className="jira-burndown-statuses" aria-label={t.burndownStatusBreakdown}>
            {topEntries(burndown.statusDistribution).map(([status, count]) => (
              <span key={status}>
                {status} <strong>{count}</strong>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
