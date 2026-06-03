import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeContext,
  generateCases,
  loadConfig,
  loadDiagnostics,
  loadHistoryRun,
  loadHistoryRuns,
  loadTicketSuggestions,
  logout,
  pushCases,
  translateScopeSnapshot,
  validateCases,
} from './api';
import { AnalyzePanel } from './components/AnalyzePanel';
import { ApprovalPanel } from './components/ApprovalPanel';
import { ContextPanel } from './components/ContextPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { RegenerateDiffPanel } from './components/RegenerateDiffPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { uiText, type UiLanguage } from './i18n';
import type {
  AnalyzeRequest,
  ConfigResponse,
  CoverageSummary,
  DiagnosticsResponse,
  GenerateResponse,
  GeneratedTestCase,
  QaContext,
  ScopeSnapshotTranslation,
  SuggestedTicket,
  ValidationEntry,
  WorkflowHistoryDetail,
  WorkflowHistorySummary,
} from '../shared/contracts';

const initialForm: AnalyzeRequest = {
  jiraKey: '',
  feOnly: true,
  beAlreadyTested: false,
  includeComments: true,
};

type PendingGeneration = GenerateResponse;
type ToastTone = 'success' | 'error' | 'info';
type ToastItem = {
  id: number;
  tone: ToastTone;
  title: string;
  message: string;
};

export default function App() {
  const [lang, setLang] = useState<UiLanguage>('en');
  const [showWorkflowHelp, setShowWorkflowHelp] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [scopeTranslation, setScopeTranslation] = useState<ScopeSnapshotTranslation | null>(null);
  const [translatingScope, setTranslatingScope] = useState(false);
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
  const [ticketSuggestions, setTicketSuggestions] = useState<SuggestedTicket[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState('');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const skipNextValidation = useRef(false);
  const nextToastId = useRef(1);

  async function refreshAuxiliaryData() {
    try {
      const [history, diag, suggestions] = await Promise.all([loadHistoryRuns(), loadDiagnostics(), loadTicketSuggestions()]);
      setHistoryRuns(history.runs);
      setDiagnostics(diag);
      setTicketSuggestions(suggestions.tickets || []);
      setSuggestionsError('');
    } catch (loadError) {
      const message = (loadError as Error).message;
      setError(message);
      setSuggestionsError(message);
      pushToast('error', toastText.refreshErrorTitle, message);
    }
  }

  useEffect(() => {
    loadConfig()
      .then(async (response) => {
        setConfig(response);
        setSectionId(response.defaults.testrailSectionId || '');
        if (response.authenticated) {
          setLoadingSuggestions(true);
          try {
            await refreshAuxiliaryData();
          } finally {
            setLoadingSuggestions(false);
          }
        }
      })
      .catch((loadError) => {
        const message = (loadError as Error).message;
        setError(message);
        pushToast('error', toastText.loadConfigErrorTitle, message);
      })
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
        .catch((validationError) => {
          const message = (validationError as Error).message;
          setError(message);
          pushToast('error', toastText.validationErrorTitle, message);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [context, coverageEnforced, testCases]);

  const invalidCount = useMemo(() => validation.filter((item) => !item.valid).length, [validation]);
  const t = uiText[lang];
  const toastText = uiText[lang].toast;
  const pushDisabled = useMemo(() => {
    const validationOkay = testCases.length > 0 && validation.every((item) => item.valid);
    const coverageOkay = !coverageEnforced || !coverage || coverage.uncoveredCriteria.length === 0;
    return !(validationOkay && coverageOkay && approved && sectionId.trim());
  }, [approved, coverage, coverageEnforced, sectionId, testCases.length, validation]);

  function removeToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function pushToast(tone: ToastTone, title: string, message: string) {
    const id = nextToastId.current++;
    setToasts((current) => [...current, { id, tone, title, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }

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
      setLang('en');
      setScopeTranslation(null);
      pushToast('success', toastText.analyzeSuccessTitle, toastText.analyzeSuccessMessage(response.context.ticketKey));
    } catch (analyzeError) {
      const message = (analyzeError as Error).message;
      setError(message);
      pushToast('error', toastText.analyzeErrorTitle, message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleScopeLanguageChange(nextLang: UiLanguage) {
    setLang(nextLang);
    if (nextLang !== 'id' || !context || scopeTranslation || translatingScope) return;
    setTranslatingScope(true);
    setError('');
    try {
      const response = await translateScopeSnapshot({
        context,
        targetLanguage: 'id',
      });
      setScopeTranslation(response.translation);
    } catch (translationError) {
      const message = (translationError as Error).message;
      setError(message);
      pushToast('error', toastText.translateErrorTitle, message);
      setLang('en');
    } finally {
      setTranslatingScope(false);
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
    setPushResults(t.runStatus.generatedWith(response.provider, response.model));
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
        setPushResults(t.runStatus.candidateGenerated(response.provider, response.model));
        pushToast('info', toastText.generateCandidateTitle, toastText.generateCandidateMessage);
      } else {
        applyGeneration(response);
        pushToast('success', toastText.generateSuccessTitle, toastText.generateSuccessMessage(response.testCases.length));
      }
      await refreshAuxiliaryData();
    } catch (generateError) {
      const message = (generateError as Error).message;
      setError(message);
      pushToast('error', toastText.generateErrorTitle, message);
    } finally {
      setGenerating(false);
    }
  }

  function handleSuggestionSelect(ticketKey: string) {
    setForm((current) => ({ ...current, jiraKey: ticketKey }));
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
      pushToast('success', toastText.pushSuccessTitle, toastText.pushSuccessMessage);
      await refreshAuxiliaryData();
    } catch (pushError) {
      const message = (pushError as Error).message;
      setPushResults(message);
      pushToast('error', toastText.pushErrorTitle, message);
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
      const message = (historyError as Error).message;
      setError(message);
      pushToast('error', toastText.historyErrorTitle, message);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <div className="app-shell">
      {toasts.length ? (
        <div className="toast-stack" aria-live="polite" aria-atomic="true">
          {toasts.map((toast) => (
            <div className={`toast toast-${toast.tone}`} key={toast.id}>
              <div className="toast-icon" aria-hidden="true">
                {toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : 'i'}
              </div>
              <div className="toast-copy">
                <strong>{toast.title}</strong>
                <div>{toast.message}</div>
              </div>
              <button className="toast-close" type="button" onClick={() => removeToast(toast.id)}>
                {toastText.dismiss}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="utility-trigger-stack">
        <button className="workflow-help-trigger" type="button" onClick={() => setShowWorkflowHelp(true)} aria-haspopup="dialog" aria-expanded={showWorkflowHelp}>
          <span className="workflow-help-trigger-icon">?</span>
          <span>{t.help.trigger}</span>
        </button>

        <button className="workflow-help-trigger" type="button" onClick={() => setShowStatusModal(true)} aria-haspopup="dialog" aria-expanded={showStatusModal}>
          <span className="workflow-help-trigger-icon">!</span>
          <span>{t.status.trigger}</span>
        </button>
      </div>

      {showWorkflowHelp ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowWorkflowHelp(false)}>
          <section
            className="modal-card workflow-help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-help-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">QA Agent</div>
                <h2 id="workflow-help-title">{t.help.title}</h2>
                <p>{t.help.subtitle}</p>
              </div>
              <button className="button button-secondary button-small" type="button" onClick={() => setShowWorkflowHelp(false)}>
                {t.help.close}
              </button>
            </div>

            <div className="workflow-visualization" aria-label="QA Agent workflow overview">
              {t.help.steps.map((step, index) => {
                const shortLabel = step.title.replace(/^\d+\.\s*/, '');
                return (
                  <div className="workflow-visual-step" key={step.title}>
                    <div className="workflow-visual-node">
                      <span className="workflow-visual-number">{index + 1}</span>
                    </div>
                    <div className="workflow-visual-label">{shortLabel}</div>
                  </div>
                );
              })}
            </div>

            <div className="workflow-help-list">
              {t.help.steps.map((step) => (
                <article className="workflow-help-step" key={step.title}>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  {'details' in step && Array.isArray(step.details) && step.details.length ? (
                    <ul className="workflow-help-points">
                      {step.details.map((detail) => (
                        <li key={detail}>{detail}</li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {showStatusModal ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowStatusModal(false)}>
          <section
            className="modal-card workflow-help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="status-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">QA Agent</div>
                <h2 id="status-modal-title">{t.diagnostics.title}</h2>
                <p>{t.diagnostics.subtitle}</p>
              </div>
              <button className="button button-secondary button-small" type="button" onClick={() => setShowStatusModal(false)}>
                {t.status.close}
              </button>
            </div>

            <div className="modal-panel-wrap">
              <DiagnosticsPanel lang="en" diagnostics={diagnostics} />
            </div>
          </section>
        </div>
      ) : null}

      <header className="hero">
        <div className="hero-copy">
          <div className="eyebrow">QA Agent</div>
          <h1>{t.heroTitle}</h1>
          <p>{t.heroSubtitle}</p>
        </div>

        <div className="hero-actions">
          <div className="auth-card">
            <div className="auth-label">{t.authLabel}</div>
            <div className="auth-value">
              {loadingConfig ? t.checking : config?.authenticated ? t.loggedInAs(config.user || '') : t.notLoggedIn}
            </div>
            {config?.session?.expiresAt ? <div className="muted">{t.sessionExpiry(new Date(config.session.expiresAt).toLocaleString())}</div> : null}
            {config?.authenticated ? (
              <button className="button button-secondary" type="button" onClick={handleLogout}>
                {t.logout}
              </button>
            ) : (
              <a className="button button-secondary" href="/auth/atlassian">
                {t.loginWithAtlassian}
              </a>
            )}
          </div>
        </div>
      </header>

      {error ? <div className="global-error">{error}</div> : null}

      <main className="workflow-shell">
        <div className="section-bar">
          <h2>{t.mainWorkflow}</h2>
          <div className="section-tag">{t.guidedWorkflow}</div>
        </div>

        <div className="workflow-top">
          <div className="workflow-main-column">
            <AnalyzePanel
              lang={lang}
              form={form}
              busy={analyzing}
              suggestionsEnabled={Boolean(config?.authenticated)}
              suggestions={ticketSuggestions}
              suggestionsLoading={loadingSuggestions}
              suggestionsError={suggestionsError}
              onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
              onSuggestionSelect={handleSuggestionSelect}
              onAnalyze={handleAnalyze}
            />
          </div>
          <ApprovalPanel
            lang="en"
            approved={approved}
            sectionId={sectionId}
            pushDisabled={pushDisabled}
            busy={pushing}
            results={pushResults}
            onApprovedChange={setApproved}
            onSectionIdChange={setSectionId}
            onPush={handlePush}
          />
        </div>

        <div className="workflow-main-column">
          <ContextPanel
            lang={lang}
            context={context}
            analyzing={analyzing}
            translation={lang === 'id' ? scopeTranslation : null}
            translating={translatingScope}
            permissionApproved={confidenceApproved}
            overrideReason={overrideReason}
            busy={generating}
            onLanguageChange={handleScopeLanguageChange}
            onPermissionApprovedChange={setConfidenceApproved}
            onOverrideReasonChange={setOverrideReason}
            onGenerate={handleGenerate}
          />

          {pendingGeneration ? (
            <RegenerateDiffPanel
              lang="en"
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
            lang="en"
            context={context}
            generating={generating}
            testCases={testCases}
            validation={validation}
            coverage={coverage}
            coverageEnforced={coverageEnforced}
            manualScopeOverride={manualScopeOverride}
            onCaseChange={handleCaseChange}
          />
        </div>

        <section className="secondary-sections">
          <div className="section-bar section-bar-secondary">
            <h2>{t.secondarySections}</h2>
            <div className="section-note">{t.secondarySectionsNote}</div>
          </div>

          <div className="secondary-stack">
          <HistoryPanel lang="en" runs={historyRuns} selectedRun={selectedHistoryRun} busy={historyLoading} onOpenRun={handleOpenHistoryRun} />
          </div>
        </section>
      </main>

      <footer className="footer-bar">
        <div>{config?.defaults.llmProviders.filter((provider) => provider.configured).map((provider) => `${provider.name}:${provider.model}`).join(' · ') || t.noLlmConfigured}</div>
        <div>{invalidCount ? t.casesNeedFixes(invalidCount) : testCases.length ? t.validationClear : t.noCasesGeneratedYet}</div>
      </footer>
    </div>
  );
}
