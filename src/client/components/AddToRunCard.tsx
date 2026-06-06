import { useState } from 'react';
import type { TestRailManageResponse } from '../../shared/contracts';
import { createTestRailRun, setTestRailRunCases } from '../api';
import type { UiLanguage } from '../i18n';
import { uiText } from '../i18n';

interface AddToRunCardProps {
  lang: UiLanguage;
  caseIds: number[];
  jiraKey: string;
}

export function AddToRunCard({ lang, caseIds, jiraKey }: AddToRunCardProps) {
  const t = uiText[lang].addRun;
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [runName, setRunName] = useState(`${jiraKey} — generated cases`);
  const [runId, setRunId] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<TestRailManageResponse | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res =
        mode === 'new'
          ? await createTestRailRun({ name: runName, caseIds, dryRun })
          : await setTestRailRunCases(runId.trim(), caseIds, dryRun);
      setResult(res);
    } catch (err) {
      setError((err as Error).message || t.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel add-run-card">
      <div className="panel-header">
        <div>
          <h3>{t.heading}</h3>
          <p>{t.pushedCount(caseIds.length)}</p>
        </div>
      </div>
      <form className="add-run-body" onSubmit={submit}>
        <div className="add-run-modes" role="tablist" aria-label={t.heading}>
          <button type="button" role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'is-active' : ''} onClick={() => setMode('new')}>
            {t.modeNew}
          </button>
          <button type="button" role="tab" aria-selected={mode === 'existing'} className={mode === 'existing' ? 'is-active' : ''} onClick={() => setMode('existing')}>
            {t.modeExisting}
          </button>
        </div>

        {mode === 'new' ? (
          <label className="field compact">
            <span>{t.runNameLabel}</span>
            <input value={runName} onChange={(e) => setRunName(e.target.value)} required />
          </label>
        ) : (
          <label className="field compact">
            <span>{t.runIdLabel}</span>
            <input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="e.g. 1024" inputMode="numeric" required />
          </label>
        )}

        <div className="add-run-actions">
          <label className="checkbox add-run-dry">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            <span>{t.dryRun}</span>
          </label>
          <button className="button button-primary button-small" type="submit" disabled={busy || (mode === 'existing' && !runId.trim())}>
            {mode === 'new' ? t.createAction : t.addAction}
          </button>
        </div>

        {error ? <div className="add-run-result tr-dashboard-error">{error}</div> : null}
        {result ? (
          'dryRun' in result ? (
            <div className="add-run-result add-run-preview">
              <p className="section-label">{result.action} · POST {result.endpoint}</p>
              <pre>{JSON.stringify(result.payload, null, 2)}</pre>
            </div>
          ) : (
            <div className="add-run-result add-run-ok">
              {mode === 'new' ? t.doneNew : t.doneExisting} #{String(result.id ?? runId)}
            </div>
          )
        ) : null}
      </form>
    </section>
  );
}
