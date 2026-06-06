import { useState } from 'react';
import type { ManageCaseRequest, ManageRunRequest, TestRailManageResponse } from '../../../shared/contracts';
import {
  createTestRailCase,
  createTestRailPlan,
  createTestRailRun,
  deleteTestRailCase,
  deleteTestRailPlan,
  deleteTestRailRun,
  updateTestRailCase,
  updateTestRailPlan,
  updateTestRailRun,
} from '../../api';
import type { UiLanguage } from '../../i18n';
import { uiText } from '../../i18n';

interface ManagePanelProps {
  lang: UiLanguage;
  defaultSectionId: string;
}

type Resource = 'case' | 'run' | 'plan';

const TYPE_OPTIONS: Array<{ id: number; key: 'typeFunctional' | 'typeNegative' | 'typeEdge' }> = [
  { id: 1, key: 'typeFunctional' },
  { id: 2, key: 'typeNegative' },
  { id: 5, key: 'typeEdge' },
];

function ResultView({ lang, result, mode }: { lang: UiLanguage; result: TestRailManageResponse; mode: string }) {
  const t = uiText[lang].dashboard;
  if ('dryRun' in result) {
    return (
      <div className="tr-manage-result tr-manage-preview">
        <p className="section-label">{t.previewHeading} · {result.action} · POST {result.endpoint}</p>
        <pre>{JSON.stringify(result.payload, null, 2)}</pre>
      </div>
    );
  }
  const heading = mode === 'delete' ? t.deletedHeading : mode === 'update' ? t.updatedHeading : t.createdHeading;
  return (
    <div className="tr-manage-result tr-manage-ok">
      {heading}: <strong>{result.action}</strong>{result.id !== undefined ? ` #${String(result.id)}` : ''}
    </div>
  );
}

const onlyFilled = (obj: Record<string, string | number | undefined>): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== '' && !(typeof v === 'string' && v.trim() === '')) out[k] = v;
  }
  return out;
};

export function ManagePanel({ lang, defaultSectionId }: ManagePanelProps) {
  const t = uiText[lang].dashboard;
  const [resource, setResource] = useState<Resource>('case');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<TestRailManageResponse | null>(null);
  const [resultMode, setResultMode] = useState('create');

  // create fields
  const [cSection, setCSection] = useState(defaultSectionId || '');
  const [cTitle, setCTitle] = useState('');
  const [cType, setCType] = useState(1);
  const [cRefs, setCRefs] = useState('');
  const [cPre, setCPre] = useState('');
  const [cBdd, setCBdd] = useState('');
  const [cName, setCName] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cCaseIds, setCCaseIds] = useState('');

  // edit fields
  const [eId, setEId] = useState('');
  const [eTitle, setETitle] = useState('');
  const [eRefs, setERefs] = useState('');
  const [ePre, setEPre] = useState('');
  const [eBdd, setEBdd] = useState('');
  const [eName, setEName] = useState('');
  const [eDesc, setEDesc] = useState('');

  async function run(mode: string, action: () => Promise<TestRailManageResponse>) {
    setBusy(true);
    setError('');
    setResult(null);
    setResultMode(mode);
    try {
      setResult(await action());
    } catch (err) {
      setError((err as Error).message || t.manageError);
    } finally {
      setBusy(false);
    }
  }

  const parsedCaseIds = cCaseIds
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);

  function onCreate(event: React.FormEvent) {
    event.preventDefault();
    if (resource === 'case') {
      void run('create', () => createTestRailCase({ sectionId: cSection, title: cTitle, typeId: cType, refs: cRefs, preconditions: cPre, bddScenario: cBdd, dryRun }));
    } else if (resource === 'run') {
      void run('create', () => createTestRailRun({ name: cName, description: cDesc, caseIds: parsedCaseIds, dryRun }));
    } else {
      void run('create', () => createTestRailPlan({ name: cName, description: cDesc, dryRun }));
    }
  }

  function onUpdate(event: React.FormEvent) {
    event.preventDefault();
    if (!eId.trim()) return;
    if (resource === 'case') {
      const payload = onlyFilled({ title: eTitle, refs: eRefs, preconditions: ePre, bddScenario: eBdd }) as ManageCaseRequest;
      void run('update', () => updateTestRailCase(eId.trim(), { ...payload, dryRun }));
    } else if (resource === 'run') {
      const payload = onlyFilled({ name: eName, description: eDesc }) as ManageRunRequest;
      void run('update', () => updateTestRailRun(eId.trim(), { ...payload, dryRun }));
    } else {
      const payload = onlyFilled({ name: eName, description: eDesc }) as ManageRunRequest;
      void run('update', () => updateTestRailPlan(eId.trim(), { ...payload, dryRun }));
    }
  }

  function onDelete() {
    if (!eId.trim()) return;
    const id = eId.trim();
    const fn = resource === 'case' ? deleteTestRailCase : resource === 'run' ? deleteTestRailRun : deleteTestRailPlan;
    void run('delete', () => fn(id, dryRun));
  }

  const idLabel = resource === 'case' ? t.mgCaseId : resource === 'run' ? t.mgRunId : t.mgPlanId;

  return (
    <div className="tr-manage">
      <div className="tr-manage-resource" role="tablist" aria-label="Resource">
        {(['case', 'run', 'plan'] as Resource[]).map((r) => (
          <button key={r} type="button" role="tab" aria-selected={resource === r} className={resource === r ? 'is-active' : ''} onClick={() => { setResource(r); setResult(null); setError(''); }}>
            {r === 'case' ? t.mgCase : r === 'run' ? t.mgRun : t.mgPlan}
          </button>
        ))}
      </div>

      <div className="tr-manage-cards">
        {/* CREATE */}
        <form className="tr-manage-card" onSubmit={onCreate}>
          <p className="section-label">{t.mgCreate}</p>
          {resource === 'case' ? (
            <>
              <label className="tr-field"><span>{t.fieldSection}</span><input value={cSection} onChange={(e) => setCSection(e.target.value)} required /></label>
              <label className="tr-field"><span>{t.fieldTitle}</span><input value={cTitle} onChange={(e) => setCTitle(e.target.value)} required /></label>
              <div className="tr-field-row">
                <label className="tr-field"><span>{t.fieldType}</span>
                  <select value={cType} onChange={(e) => setCType(Number(e.target.value))}>
                    {TYPE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{t[o.key]}</option>)}
                  </select>
                </label>
                <label className="tr-field"><span>{t.fieldRefs}</span><input value={cRefs} onChange={(e) => setCRefs(e.target.value)} placeholder="ORB-1234" /></label>
              </div>
              <label className="tr-field"><span>{t.fieldPreconds}</span><textarea value={cPre} onChange={(e) => setCPre(e.target.value)} rows={2} /></label>
              <label className="tr-field"><span>{t.fieldBdd}</span><textarea className="tr-bdd" value={cBdd} onChange={(e) => setCBdd(e.target.value)} rows={5} placeholder={'Feature: ...\nScenario: ...\nGiven ...'} /></label>
              <button className="button button-primary button-small" type="submit" disabled={busy}>{busy ? t.working : t.createCaseAction}</button>
            </>
          ) : resource === 'run' ? (
            <>
              <label className="tr-field"><span>{t.fieldRunName}</span><input value={cName} onChange={(e) => setCName(e.target.value)} required /></label>
              <label className="tr-field"><span>{t.mgDescription}</span><textarea value={cDesc} onChange={(e) => setCDesc(e.target.value)} rows={2} /></label>
              <label className="tr-field"><span>{t.fieldRunCaseIds}</span><input value={cCaseIds} onChange={(e) => setCCaseIds(e.target.value)} placeholder="101, 102, 103" /></label>
              <button className="button button-primary button-small" type="submit" disabled={busy}>{busy ? t.working : t.createRunAction}</button>
            </>
          ) : (
            <>
              <label className="tr-field"><span>{t.mgName}</span><input value={cName} onChange={(e) => setCName(e.target.value)} required /></label>
              <label className="tr-field"><span>{t.mgDescription}</span><textarea value={cDesc} onChange={(e) => setCDesc(e.target.value)} rows={2} /></label>
              <button className="button button-primary button-small" type="submit" disabled={busy}>{busy ? t.working : t.createPlanAction}</button>
            </>
          )}
        </form>

        {/* EDIT / DELETE */}
        <form className="tr-manage-card" onSubmit={onUpdate}>
          <p className="section-label">{t.mgEdit}</p>
          <p className="tr-manage-hint">{t.mgEditHint}</p>
          <label className="tr-field"><span>{idLabel}</span><input value={eId} onChange={(e) => setEId(e.target.value)} inputMode="numeric" required /></label>
          {resource === 'case' ? (
            <>
              <label className="tr-field"><span>{t.fieldTitle}</span><input value={eTitle} onChange={(e) => setETitle(e.target.value)} /></label>
              <label className="tr-field"><span>{t.fieldRefs}</span><input value={eRefs} onChange={(e) => setERefs(e.target.value)} /></label>
              <label className="tr-field"><span>{t.fieldPreconds}</span><textarea value={ePre} onChange={(e) => setEPre(e.target.value)} rows={2} /></label>
              <label className="tr-field"><span>{t.fieldBdd}</span><textarea className="tr-bdd" value={eBdd} onChange={(e) => setEBdd(e.target.value)} rows={4} /></label>
            </>
          ) : (
            <>
              <label className="tr-field"><span>{t.mgName}</span><input value={eName} onChange={(e) => setEName(e.target.value)} /></label>
              <label className="tr-field"><span>{t.mgDescription}</span><textarea value={eDesc} onChange={(e) => setEDesc(e.target.value)} rows={2} /></label>
            </>
          )}
          <div className="tr-manage-editactions">
            <button className="button button-primary button-small" type="submit" disabled={busy || !eId.trim()}>{busy ? t.working : t.mgUpdate}</button>
            <button className="button button-danger button-small" type="button" disabled={busy || !eId.trim()} onClick={onDelete}>{t.mgDelete}</button>
          </div>
        </form>
      </div>

      <label className="tr-dryrun">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        <span>{t.dryRunToggle}</span>
      </label>

      {error ? <div className="tr-manage-result tr-dashboard-error">{error}</div> : null}
      {result ? <ResultView lang={lang} result={result} mode={resultMode} /> : null}
    </div>
  );
}
