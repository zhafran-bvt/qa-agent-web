import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeContext, generateCases, loadConfig, logout, pushCases, validateCases } from './api';
import { AnalyzePanel } from './components/AnalyzePanel';
import { ApprovalPanel } from './components/ApprovalPanel';
import { ContextPanel } from './components/ContextPanel';
import { ReviewPanel } from './components/ReviewPanel';
import type { AnalyzeRequest, ConfigResponse, CoverageSummary, GeneratedTestCase, QaContext, ValidationEntry } from '../shared/contracts';

const initialForm: AnalyzeRequest = {
  jiraKey: '',
  feOnly: true,
  beAlreadyTested: false,
  includeComments: true,
  notes: '',
};

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
  const skipNextValidation = useRef(false);

  useEffect(() => {
    loadConfig()
      .then((response) => {
        setConfig(response);
        setSectionId(response.defaults.testrailSectionId || '');
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
    } catch (analyzeError) {
      setError((analyzeError as Error).message);
    } finally {
      setAnalyzing(false);
    }
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
      skipNextValidation.current = true;
      setTestCases(response.testCases);
      setValidation(response.validation);
      setCoverage(response.coverage);
      setCoverageEnforced(response.coverageEnforced !== false);
      setManualScopeOverride(Boolean(response.manualScopeOverride));
      setApproved(false);
      setPushResults(`Generated with ${response.provider} / ${response.model}`);
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
        jiraKey: context.ticketKey,
        epic: context.epic,
        feOnly: context.constraints.feOnly,
        acceptanceCriteria: context.acceptanceCriteria,
        enforceAcceptanceCriteria: coverageEnforced,
        testCases,
      });
      setPushResults(JSON.stringify(response, null, 2));
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

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <div className="eyebrow">QA Agent</div>
          <h1>BDD generation from Jira, Story scope, and PRD context</h1>
          <p>
            Analyze the implementation chain, review typed test cases, validate AC coverage, and push approved cases to TestRail.
          </p>
        </div>

        <div className="hero-actions">
          <div className="auth-card">
            <div className="auth-label">Atlassian</div>
            <div className="auth-value">
              {loadingConfig ? 'Checking...' : config?.authenticated ? `Logged in as ${config.user}` : 'Not logged in'}
            </div>
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

          <ReviewPanel
            context={context}
            testCases={testCases}
            validation={validation}
            coverage={coverage}
            coverageEnforced={coverageEnforced}
            manualScopeOverride={manualScopeOverride}
            onCaseChange={handleCaseChange}
          />
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
