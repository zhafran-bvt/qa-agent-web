import { useEffect, useState } from 'react';
import type { TrPlanSummary } from '../../shared/contracts';
import { addTestRailPlanEntry, createTestRailPlan, loadPlanForStory } from '../api';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface PlanLinkCardProps {
  lang: UiLanguage;
  caseIds: number[];
  taskKey: string;
  taskSummary: string;
  storyKey: string;
  storySummary: string;
}

export function PlanLinkCard({ lang, caseIds, taskKey, taskSummary, storyKey, storySummary }: PlanLinkCardProps) {
  const t = uiText[lang].planLink;
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState<TrPlanSummary[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [runName, setRunName] = useState(`${taskKey} — ${taskSummary}`.trim());
  const [planName, setPlanName] = useState(`${storyKey} — ${storySummary}`.trim());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadPlanForStory(storyKey)
      .then((res) => {
        if (cancelled) return;
        setMatches(res.plans);
        setSelectedPlanId(res.plans[0]?.planId ?? null);
      })
      .catch(() => {
        if (!cancelled) setMatches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storyKey]);

  if (dismissed) return null;

  const runRefs = [storyKey, taskKey].filter(Boolean).join(', ');

  async function addToExisting() {
    if (!selectedPlanId) return;
    setBusy(true);
    setError('');
    try {
      await addTestRailPlanEntry(selectedPlanId, { name: runName, caseIds, refs: runRefs });
      setDone(t.doneFound);
    } catch (err) {
      setError((err as Error).message || t.error);
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd() {
    setBusy(true);
    setError('');
    try {
      const created = await createTestRailPlan({ name: planName, refs: storyKey });
      const planId = 'dryRun' in created ? null : created.id;
      if (planId === null || planId === undefined) throw new Error(t.error);
      await addTestRailPlanEntry(planId, { name: runName, caseIds, refs: runRefs });
      setDone(t.doneNew);
    } catch (err) {
      setError((err as Error).message || t.error);
    } finally {
      setBusy(false);
    }
  }

  const hasMatch = matches.length > 0;

  return (
    <section className="panel plan-link-card">
      <div className="plan-link-head">
        <span className="plan-link-ic" aria-hidden="true">
          {hasMatch ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          )}
        </span>
        <div>
          <h3>{loading ? t.checking : hasMatch ? t.headingFound : t.headingNew}</h3>
          {!loading ? (
            <p>{hasMatch ? t.bodyFound(taskKey, storyKey, caseIds.length) : t.bodyNew(storyKey, taskKey, caseIds.length)}</p>
          ) : null}
        </div>
      </div>

      {loading ? null : done ? (
        <div className="plan-link-body">
          <div className="add-run-result add-run-ok">{done}</div>
        </div>
      ) : (
        <div className="plan-link-body">
          {hasMatch ? (
            <>
              {matches.length > 1 ? (
                <label className="field compact">
                  <span>{t.matchSelect}</span>
                  <select value={selectedPlanId ?? ''} onChange={(e) => setSelectedPlanId(Number(e.target.value))}>
                    {matches.map((plan) => (
                      <option key={plan.planId} value={plan.planId}>
                        #{plan.planId} · {plan.planName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="plan-link-chip">
                  <span className="k">#{matches[0].planId}</span>
                  <span className="n">{matches[0].planName}</span>
                  <span className="meta">{matches[0].totalRuns} runs · {Math.round(matches[0].passRate)}%</span>
                </div>
              )}
              <label className="field compact">
                <span>{t.runNameLabel}</span>
                <input value={runName} onChange={(e) => setRunName(e.target.value)} />
              </label>
              <div className="plan-link-actions">
                <button className="button button-primary button-small" type="button" disabled={busy || !selectedPlanId} onClick={addToExisting}>
                  {busy ? t.busy : t.addAction}
                </button>
                <button className="button button-ghost button-small" type="button" onClick={() => setDismissed(true)}>
                  {t.skip}
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="field compact">
                <span>{t.planNameLabel}</span>
                <input value={planName} onChange={(e) => setPlanName(e.target.value)} />
              </label>
              <label className="field compact">
                <span>{t.runNameLabel}</span>
                <input value={runName} onChange={(e) => setRunName(e.target.value)} />
              </label>
              <div className="plan-link-actions">
                <button className="button button-primary button-small" type="button" disabled={busy || !planName.trim()} onClick={createAndAdd}>
                  {busy ? t.busy : t.createAction}
                </button>
                <button className="button button-ghost button-small" type="button" onClick={() => setDismissed(true)}>
                  {t.skip}
                </button>
              </div>
            </>
          )}
          {error ? <div className="add-run-result tr-dashboard-error">{error}</div> : null}
        </div>
      )}
    </section>
  );
}
