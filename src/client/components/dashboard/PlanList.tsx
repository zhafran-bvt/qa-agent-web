import { useEffect, useState } from 'react';
import type { TrPlanSummary, TrStatusDistribution } from '../../../shared/contracts';
import { loadPlanRunCounts } from '../../api';
import type { UiLanguage } from '../../i18n';
import { uiText } from '../../i18n';
import { statusTone, STATUS_ORDER } from './status';

const PAGE_SIZE = 15;

interface PlanListProps {
  lang: UiLanguage;
  plans: TrPlanSummary[];
  /** Base URL of the TestRail Reporter (Python). When set, rows open the full report there. */
  reporterUrl: string;
}

function planReportHref(reporterUrl: string, plan: TrPlanSummary): string {
  return reporterUrl ? `${reporterUrl}/?plan=${encodeURIComponent(String(plan.planId))}` : plan.webUrl;
}

function passRateTone(rate: number): string {
  if (rate >= 80) return 'high';
  if (rate >= 50) return 'medium';
  return 'low';
}

function StatusChips({ distribution }: { distribution: TrStatusDistribution }) {
  const chips = STATUS_ORDER.filter((key) => (distribution[key] || 0) > 0);
  if (!chips.length) return <span className="tr-muted">—</span>;
  return (
    <span className="tr-status-chips">
      {chips.map((key) => (
        <span className={`tr-chip tr-chip-${statusTone(key)}`} key={key} title={key}>
          {distribution[key]}
        </span>
      ))}
    </span>
  );
}

export function PlanList({ lang, plans, reporterUrl }: PlanListProps) {
  const t = uiText[lang].dashboard;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(plans.length / PAGE_SIZE));
  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);
  const start = page * PAGE_SIZE;
  const pagePlans = plans.slice(start, start + PAGE_SIZE);

  // Lazily fetch real run counts for the visible page (TestRail list endpoint omits them).
  const [runCounts, setRunCounts] = useState<Record<string, number>>({});
  const pageIdsKey = pagePlans.map((p) => p.planId).join(',');
  useEffect(() => {
    const ids = pageIdsKey ? pageIdsKey.split(',') : [];
    const missing = ids.filter((id) => runCounts[id] === undefined);
    if (!missing.length) return;
    let cancelled = false;
    loadPlanRunCounts(missing)
      .then((res) => {
        if (!cancelled) setRunCounts((current) => ({ ...current, ...res.counts }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIdsKey]);

  return (
    <>
    <table className="tr-plan-table">
      <thead>
        <tr>
          <th>{t.colPlan}</th>
          <th>{t.colCreatedBy}</th>
          <th className="tr-num">{t.colRuns}</th>
          <th className="tr-num">{t.colTests}</th>
          <th>{t.colPassRate}</th>
          <th>{t.colStatus}</th>
        </tr>
      </thead>
      <tbody>
        {pagePlans.map((plan) => (
          <tr key={plan.planId}>
            <td>
              <a className="tr-plan-name" href={planReportHref(reporterUrl, plan)} target="_blank" rel="noreferrer" title={t.openReport}>
                {plan.planName}
              </a>
              {reporterUrl ? (
                <a
                  className="tr-plan-ext"
                  href={plan.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={t.openInTestRail}
                  aria-label={t.openInTestRail}
                >
                  ↗
                </a>
              ) : null}
              <span className={`tr-state tr-state-${plan.isCompleted ? 'completed' : 'active'}`}>
                {plan.isCompleted ? t.completed : t.active}
              </span>
            </td>
            <td className="tr-createdby">{plan.createdByName ? plan.createdByName : <span className="tr-muted">—</span>}</td>
            <td className="tr-num">{runCounts[String(plan.planId)] ?? <span className="tr-muted">·</span>}</td>
            <td className="tr-num">{plan.totalTests}</td>
            <td>
              <div className="tr-passrate">
                <span className="tr-passrate-bar" aria-hidden="true">
                  <span className={`tr-passrate-fill tr-passrate-${passRateTone(plan.passRate)}`} style={{ width: `${Math.round(plan.passRate)}%` }} />
                </span>
                <span className="tr-passrate-value">{Math.round(plan.passRate)}%</span>
              </div>
            </td>
            <td>
              <StatusChips distribution={plan.statusDistribution} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {totalPages > 1 ? (
      <div className="tr-pager">
        <span className="tr-pager-info">{t.pageShowing(start + 1, start + pagePlans.length, plans.length)}</span>
        <div className="tr-pager-controls">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            {t.pagePrev}
          </button>
          <span className="tr-pager-of">{t.pageOf(page + 1, totalPages)}</span>
          <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
            {t.pageNext}
          </button>
        </div>
      </div>
    ) : null}
    </>
  );
}
