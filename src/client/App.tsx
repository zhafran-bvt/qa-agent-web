import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeContext,
  generateCases,
  loadConfig,
  loadDiagnostics,
  loadHistoryRun,
  loadHistoryRuns,
  logout,
  pushCases,
  validateCases,
} from './api';
import { AnalyzePanel } from './components/AnalyzePanel';
import { ApprovalPanel } from './components/ApprovalPanel';
import { ContextPanel } from './components/ContextPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { RegenerateDiffPanel } from './components/RegenerateDiffPanel';
import { ReviewPanel } from './components/ReviewPanel';
import type {
  AnalyzeRequest,
  ConfigResponse,
  CoverageSummary,
  DiagnosticsResponse,
  GenerateResponse,
  GeneratedTestCase,
  QaContext,
  ValidationEntry,
  WorkflowHistoryDetail,
  WorkflowHistorySummary,
} from '../shared/contracts';

const initialForm: AnalyzeRequest = {
  jiraKey: '',
  feOnly: true,
  beAlreadyTested: false,
  includeComments: true,
  notes: '',
};

type PendingGeneration = GenerateResponse;

export default function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [form, setForm] = useState<AnalyzeRequest>(initialForm);
  const [context, setContext] = useState<QaContext | null>(null);
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);
  const [validation, setValidation] = useState<ValidationEntry[]>([]);
  const [coverage, setCoverage] = useState<CoverageSummary | null>(null);
  const [coverageEnforced, setCoverageEnforced] = useState(false);
  const [manualScopeOverride, setManualScopeOverride] = useState(false);
  const [confidenceApproved, setConfidenceApproved] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [approved, setApproved] = useState(false);
  const [sectionId, setSectionId] = useState('');
  const [pushResults, setPushResults] = useState('');
  const [error, setError] = useState('');
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<WorkflowHistorySummary[]>([]);
  const [selectedHistoryRun, setSelectedHistoryRun] = useState<WorkflowHistoryDetail | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [generatedRunId, setGeneratedRunId] = useState<string>('');
  const [pendingGeneration, setPendingGeneration] = useState<PendingGeneration | null>(null);
  const skipNextValidation = useRef(false);

  async function refreshAuxiliaryData() {
    try {
      const [history, diag] = await Promise.all([loadHistoryRuns(), loadDiagnostics()]);
      setHistoryRuns(history.runs);
      setDiagnostics(diag);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }

  useEffect(() => {
    loadConfig()
      .then(async (response) => {
        setConfig(response);
        setSectionId(response.defaults.testrailSectionId || '');
        if (response.authenticated) await refreshAuxiliaryData();
      })
      .catch((loadError) => setError((loadError as Error).message))
      .finally(() => setLoadingConfig(false));
  }, []);

  useEffect(() => {
    if (!context || testCases.length === 0) return;
    if (skipNextValidation.current) {
      skipNextValidation.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      validateCases({
        testCases,
        jiraKey: context.ticketKey,
        epic: context.epic,
        feOnly: context.constraints.feOnly,
        acceptanceCriteria: context.acceptanceCriteria,
        enforceAcceptanceCriteria: coverageEnforced,
        context,
      })
        .then((response) => {
          setTestCases(response.testCases);
          setValidation(response.validation);
          setCoverage(response.coverage);
        })
        .catch((validationError) => setError((validationError as Error).message));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [context, coverageEnforced, testCases]);

  const invalidCount = useMemo(() => validation.filter((item) => !item.valid).length, [validation]);
  const pushDisabled = useMemo(() => {
    const validationOkay = testCases.length > 0 && validation.every((item) => item.valid);
    const coverageOkay = !coverageEnforced || !coverage || coverage.uncoveredCriteria.length === 0;
    return !(validationOkay && coverageOkay && approved && sectionId.trim());
  }, [approved, coverage, coverageEnforced, sectionId, testCases.length, validation]);

  async function handleAnalyze() {
    setAnalyzing(true);
    setError('');
    try {
      const response = await analyzeContext(form);
      setContext(response.context);
      setTestCases([]);
      setValidation([]);
      setCoverage(null);
      setCoverageEnforced(false);
      setManualScopeOverride(false);
      setConfidenceApproved(false);
      setOverrideReason('');
      setApproved(false);
      setPushResults('');
      setGeneratedRunId('');
      setPendingGeneration(null);
    } catch (analyzeError) {
      setError((analyzeError as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  function applyGeneration(response: GenerateResponse) {
    skipNextValidation.current = true;
    setTestCases(response.testCases);
    setValidation(response.validation);
    setCoverage(response.coverage);
    setCoverageEnforced(response.coverageEnforced !== false);
    setManualScopeOverride(Boolean(response.manualScopeOverride));
    setApproved(false);
    setPushResults(`Generated with ${response.provider} / ${response.model}`);
    setGeneratedRunId(response.runId || '');
  }

  async function handleGenerate() {
    if (!context) return;
    setGenerating(true);
    setError('');
    try {
      const response = await generateCases({
        context,
        confidencePermissionApproved: confidenceApproved,
        manualScopeOverrideReason: overrideReason,
      });
      if (testCases.length > 0) {
        setPendingGeneration(response);
        setPushResults(`Candidate generated with ${response.provider} / ${response.model}. Review diff before replace.`);
      } else {
        applyGeneration(response);
      }
      await refreshAuxiliaryData();
    } catch (generateError) {
      setError((generateError as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function handlePush() {
    if (!context) return;
    setPushing(true);
    setError('');
    try {
      const response = await pushCases({
        approved,
        sectionId,
        generatedRunId,
        jiraKey: context.ticketKey,
        epic: context.epic,
        feOnly: context.constraints.feOnly,
        acceptanceCriteria: context.acceptanceCriteria,
        enforceAcceptanceCriteria: coverageEnforced,
        testCases,
      });
      setPushResults(JSON.stringify(response, null, 2));
      await refreshAuxiliaryData();
    } catch (pushError) {
      setPushResults((pushError as Error).message);
    } finally {
      setPushing(false);
    }
  }

  function handleCaseChange(index: number, field: keyof GeneratedTestCase, value: string | string[]) {
    setTestCases((current) =>
      current.map((testCase, caseIndex) => (caseIndex === index ? { ...testCase, [field]: value } : testCase))
    );
  }

  async function handleLogout() {
    await logout();
    window.location.reload();
  }

  async function handleOpenHistoryRun(id: string) {
    setHistoryLoading(true);
    try {
      const response = await loadHistoryRun(id);
      setSelectedHistoryRun(response.run);
    } catch (historyError) {
      setError((historyError as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <div className="eyebrow">QA Agent</div>
          <h1>BDD generation from Jira, Story scope, and PRD context</h1>
          <p>Analyze the implementation chain, review typed test cases, validate AC coverage, and push approved cases to TestRail.</p>
        </div>

        <div className="hero-actions">
          <div className="auth-card">
            <div className="auth-label">Atlassian</div>
            <div className="auth-value">
              {loadingConfig ? 'Checking...' : config?.authenticated ? `Logged in as ${config.user}` : 'Not logged in'}
            </div>
            {config?.session?.expiresAt ? <div className="muted">Session expiry: {new Date(config.session.expiresAt).toLocaleString()}</div> : null}
            {config?.authenticated ? (
              <button className="button button-secondary" type="button" onClick={handleLogout}>
                Logout
              </button>
            ) : (
              <a className="button button-secondary" href="/auth/atlassian">
                Login with Atlassian
              </a>
            )}
          </div>
        </div>
      </header>

      {error ? <div className="global-error">{error}</div> : null}

      <main className="main-grid">
        <div className="main-column">
          <div className="top-grid">
            <AnalyzePanel form={form} busy={analyzing} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} onAnalyze={handleAnalyze} />
            <ContextPanel
              context={context}
              permissionApproved={confidenceApproved}
              overrideReason={overrideReason}
              busy={generating}
              onPermissionApprovedChange={setConfidenceApproved}
              onOverrideReasonChange={setOverrideReason}
              onGenerate={handleGenerate}
            />
          </div>

          {pendingGeneration ? (
            <RegenerateDiffPanel
              currentCases={testCases}
              candidate={pendingGeneration}
              onReplace={() => {
                applyGeneration(pendingGeneration);
                setPendingGeneration(null);
              }}
              onCancel={() => setPendingGeneration(null)}
            />
          ) : null}

          <ReviewPanel
            context={context}
            testCases={testCases}
            validation={validation}
            coverage={coverage}
            coverageEnforced={coverageEnforced}
            manualScopeOverride={manualScopeOverride}
            onCaseChange={handleCaseChange}
          />

          <HistoryPanel runs={historyRuns} selectedRun={selectedHistoryRun} busy={historyLoading} onOpenRun={handleOpenHistoryRun} />
          <DiagnosticsPanel diagnostics={diagnostics} />
        </div>

        <ApprovalPanel
          approved={approved}
          sectionId={sectionId}
          pushDisabled={pushDisabled}
          busy={pushing}
          results={pushResults}
          onApprovedChange={setApproved}
          onSectionIdChange={setSectionId}
          onPush={handlePush}
        />
      </main>

      <footer className="footer-bar">
        <div>{config?.defaults.llmProviders.filter((provider) => provider.configured).map((provider) => `${provider.name}:${provider.model}`).join(' · ') || 'No LLM configured'}</div>
        <div>{invalidCount ? `${invalidCount} cases need fixes` : testCases.length ? 'Validation clear' : 'No cases generated yet'}</div>
      </footer>
    </div>
  );
}
