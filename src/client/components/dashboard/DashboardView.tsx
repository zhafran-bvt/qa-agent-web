import { useCallback, useEffect, useState } from 'react';
import type { TrPlanSummary } from '../../../shared/contracts';
import { loadTestRailPlans } from '../../api';
import type { UiLanguage } from '../../i18n';
import { uiText } from '../../i18n';
import { ManagePanel } from './ManagePanel';
import { PlanList } from './PlanList';

interface DashboardViewProps {
  lang: UiLanguage;
  authenticated: boolean;
  testrailReady: boolean;
  defaultSectionId: string;
  reporterUrl: string;
  onLogin: () => void;
}

export function DashboardView({ lang, authenticated, testrailReady, defaultSectionId, reporterUrl, onLogin }: DashboardViewProps) {
  const t = uiText[lang].dashboard;
  const [plans, setPlans] = useState<TrPlanSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'plans' | 'manage'>('plans');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await loadTestRailPlans();
      setPlans(response.plans);
    } catch (err) {
      setError((err as Error).message || t.error);
      setPlans(null);
    } finally {
      setLoading(false);
    }
  }, [t.error]);

  useEffect(() => {
    if (authenticated && testrailReady) void refresh();
  }, [authenticated, testrailReady, refresh]);

  return (
    <section className="panel tr-dashboard">
      <div className="panel-header">
        <div>
          <h3>{mode === 'manage' ? t.manageTitle : t.plansHeading}</h3>
          <p>{mode === 'manage' ? t.manageSubtitle : t.subtitle}</p>
        </div>
        <div className="panel-actions">
          <div className="tr-mode-switch" role="tablist" aria-label="TestRail mode">
            <button type="button" role="tab" aria-selected={mode === 'plans'} className={mode === 'plans' ? 'is-active' : ''} onClick={() => setMode('plans')}>
              {t.tabPlans}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'manage'} className={mode === 'manage' ? 'is-active' : ''} onClick={() => setMode('manage')}>
              {t.tabManage}
            </button>
          </div>
          {mode === 'plans' ? (
            <button
              className="button button-secondary button-small"
              type="button"
              onClick={() => void refresh()}
              disabled={loading || !authenticated || !testrailReady}
            >
              {t.refresh}
            </button>
          ) : null}
        </div>
      </div>

      {!authenticated ? (
        <div className="tr-dashboard-state">
          <p>{t.loginRequired}</p>
          <button className="button button-primary button-small" type="button" onClick={onLogin}>
            {uiText[lang].loginWithAtlassian}
          </button>
        </div>
      ) : !testrailReady ? (
        <div className="tr-dashboard-state">{t.notConfigured}</div>
      ) : mode === 'manage' ? (
        <ManagePanel lang={lang} defaultSectionId={defaultSectionId} />
      ) : loading && !plans ? (
        <div className="tr-dashboard-state">{t.loading}</div>
      ) : error ? (
        <div className="tr-dashboard-state tr-dashboard-error">{error}</div>
      ) : plans && plans.length === 0 ? (
        <div className="tr-dashboard-state">{t.empty}</div>
      ) : plans ? (
        <PlanList lang={lang} plans={plans} reporterUrl={reporterUrl} />
      ) : null}
    </section>
  );
}
