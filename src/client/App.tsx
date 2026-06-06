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
  preflightPush,
  pushCases,
  translateScopeSnapshot,
  validateCases,
} from './api';
import { AnalyzePanel } from './components/AnalyzePanel';
import { ApprovalPanel } from './components/ApprovalPanel';
import { AddToRunCard } from './components/AddToRunCard';
import { PlanLinkCard } from './components/PlanLinkCard';
import { ContextPanel } from './components/ContextPanel';
import { DashboardView } from './components/dashboard/DashboardView';
import { HomeView } from './components/HomeView';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { DuplicatePushReviewModal } from './components/DuplicatePushReviewModal';
import { HistoryPanel } from './components/HistoryPanel';
import { RegenerateDiffPanel } from './components/RegenerateDiffPanel';
import { ReviewPanel } from './components/ReviewPanel';
import type { WorkflowStepKey, WorkflowStepState } from './components/WorkflowStepper';
import { uiText, type UiLanguage } from './i18n';
import type {
  AnalyzeRequest,
  ConfigResponse,
  CoverageSummary,
  DuplicateCaseRecommendation,
  ExistingTestRailCase,
  DiagnosticsResponse,
  GenerateResponse,
  GeneratedTestCase,
  PushRequest,
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

function formatPushResults(
  response: { summary: { pushed: number; failed: number; total: number }; results: Array<{ ok: boolean; caseId?: number | string; error?: string; title: string }> },
  lang: UiLanguage
): string {
  const t = uiText[lang].approval;
  const caseRefs = response.results
    .filter((entry) => entry.ok && entry.caseId !== undefined && entry.caseId !== null)
    .map((entry) => `C${entry.caseId}`)
    .join(', ');
  const lines = [t.pushSummary(response.summary.pushed, response.summary.failed, response.summary.total, caseRefs)];
  const failures = response.results.filter((entry) => !entry.ok);
  if (failures.length) {
    lines.push('');
    lines.push(t.pushFailures);
    for (const failure of failures) {
      lines.push(`- ${failure.title}: ${failure.error || 'Unknown error'}`);
    }
  }
  return lines.join('\n');
}

export default function App() {
  const [lang, setLang] = useState<UiLanguage>('en');
  const [showWorkflowHelp, setShowWorkflowHelp] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [view, setView] = useState<'home' | 'generate' | 'testrail'>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const [pushedCases, setPushedCases] = useState<{ ids: number[]; jiraKey: string } | null>(null);
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
  const [duplicateReview, setDuplicateReview] = useState<{
    existingCases: ExistingTestRailCase[];
    recommendations: DuplicateCaseRecommendation[];
    selectedCaseIds: string[];
  } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const skipNextValidation = useRef(false);
  const nextToastId = useRef(1);
  const analyzeSectionRef = useRef<HTMLElement | null>(null);
  const scopeSectionRef = useRef<HTMLElement | null>(null);
  const reviewSectionRef = useRef<HTMLElement | null>(null);
  const approveSectionRef = useRef<HTMLElement | null>(null);

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
          // Inbound deep link from the TestRail Reporter: ?ticket=ORB-1234 → generate.
          const inboundTicket = new URLSearchParams(window.location.search).get('ticket');
          if (inboundTicket) {
            const cleaned = new URL(window.location.href);
            cleaned.searchParams.delete('ticket');
            window.history.replaceState({}, '', cleaned.pathname + cleaned.search);
            handleQuickStart(inboundTicket.trim().toUpperCase());
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
  const casesValid = useMemo(() => testCases.length > 0 && validation.every((item) => item.valid), [testCases.length, validation]);
  const coverageComplete = useMemo(
    () => !coverageEnforced || !coverage || coverage.uncoveredCriteria.length === 0,
    [coverage, coverageEnforced]
  );
  const stepperSteps = useMemo<Array<{ key: WorkflowStepKey; state: WorkflowStepState }>>(() => {
    const analyzeDone = Boolean(context);
    const scopeDone = testCases.length > 0;
    const reviewReady = casesValid && coverageComplete;
    const order: WorkflowStepKey[] = ['analyze', 'scope', 'review', 'approve'];
    const activeIndex = !analyzeDone ? 0 : !scopeDone ? 1 : !reviewReady ? 2 : 3;
    return order.map((key, index) => ({
      key,
      state: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'upcoming',
    }));
  }, [context, testCases.length, casesValid, coverageComplete]);
  const activeWorkflowLabel = useMemo(() => {
    const active = stepperSteps.find((step) => step.state === 'active')?.key || 'analyze';
    return uiText[lang].stepper[active];
  }, [lang, stepperSteps]);
  const analyzeBlocker = useMemo(() => {
    if (analyzing) return t.analyze.blockerAnalyzing;
    if (!config?.authenticated) return t.analyze.blockerLogin;
    if (!form.jiraKey.trim()) return t.analyze.blockerTicket;
    return '';
  }, [analyzing, config?.authenticated, form.jiraKey, t.analyze]);
  const generateBlocker = useMemo(() => {
    if (generating) return t.context.blockerGenerating;
    if (!context) return t.context.blockerNoContext;
    if (context.requiresConfidencePermission && !confidenceApproved) return t.context.blockerConfidence;
    return '';
  }, [confidenceApproved, context, generating, t.context]);
  const pushBlocker = useMemo(() => {
    if (pushing) return t.approval.blockerPushing;
    if (!testCases.length) return t.approval.blockerNoCases;
    if (!casesValid) return t.approval.blockerCasesInvalid;
    if (!coverageComplete) return t.approval.blockerCoverage;
    if (!approved) return t.approval.blockerApproval;
    if (!sectionId.trim()) return t.approval.blockerSection;
    return '';
  }, [approved, casesValid, coverageComplete, pushing, sectionId, t.approval, testCases.length]);

  function removeToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function scrollToSection(key: WorkflowStepKey) {
    const target =
      key === 'analyze'
        ? analyzeSectionRef.current
        : key === 'scope'
          ? scopeSectionRef.current
          : key === 'review'
            ? reviewSectionRef.current
            : approveSectionRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function pushToast(tone: ToastTone, title: string, message: string) {
    const id = nextToastId.current++;
    setToasts((current) => [...current, { id, tone, title, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }

  function buildPushPayload(casesToPush: GeneratedTestCase[] = testCases): PushRequest | null {
    if (!context) return null;
    return {
      approved,
      sectionId,
      generatedRunId,
      jiraKey: context.ticketKey,
      epic: context.epic,
      feOnly: context.constraints.feOnly,
      acceptanceCriteria: context.acceptanceCriteria,
      enforceAcceptanceCriteria: coverageEnforced,
      testCases: casesToPush,
    };
  }

  async function submitPush(casesToPush: GeneratedTestCase[]) {
    const payload = buildPushPayload(casesToPush);
    if (!payload) return;
    const response = await pushCases(payload);
    setPushResults(formatPushResults(response, lang));
    const ids = response.results
      .filter((entry) => entry.ok && entry.caseId !== undefined && entry.caseId !== null)
      .map((entry) => Number(entry.caseId))
      .filter((id) => Number.isFinite(id));
    setPushedCases(ids.length && context ? { ids, jiraKey: context.ticketKey } : null);
    pushToast('success', toastText.pushSuccessTitle, toastText.pushSuccessMessage);
    setDuplicateReview(null);
    await refreshAuxiliaryData();
  }

  function handleQuickStart(jiraKey: string) {
    setView('generate');
    void handleAnalyze({ jiraKey });
  }

  async function handleAnalyze(override?: Partial<AnalyzeRequest>) {
    const payload = override ? { ...form, ...override } : form;
    if (override) setForm(payload);
    setAnalyzing(true);
    setError('');
    try {
      const response = await analyzeContext(payload);
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
      setPushedCases(null);
      setGeneratedRunId('');
      setPendingGeneration(null);
      setDuplicateReview(null);
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
    setDuplicateReview(null);
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
      const payload = buildPushPayload();
      if (!payload) return;
      const preflight = await preflightPush(payload);
      if (preflight.duplicateLookupSkipped) {
        setPushResults(preflight.duplicateLookupSkipped.reason);
        pushToast('info', toastText.duplicateLookupSkippedTitle, preflight.duplicateLookupSkipped.reason);
        await submitPush(testCases);
        return;
      }
      if (preflight.duplicatesFound) {
        const selectedCaseIds = testCases
          .filter((testCase) => preflight.recommendations.find((item) => item.newCaseId === testCase.id)?.recommendation === 'include')
          .map((testCase) => testCase.id);
        setDuplicateReview({
          existingCases: preflight.existingCases,
          recommendations: preflight.recommendations,
          selectedCaseIds,
        });
        setPushResults(
          `Duplicate review required: ${preflight.summary.existingCount} existing TestRail case(s) found for ${preflight.summary.jiraKey}.`
        );
        pushToast('info', toastText.duplicateReviewTitle, toastText.duplicateReviewMessage(preflight.summary.existingCount, preflight.summary.jiraKey));
        return;
      }
      await submitPush(testCases);
    } catch (pushError) {
      const message = (pushError as Error).message;
      setPushResults(message);
      pushToast('error', toastText.pushErrorTitle, message);
    } finally {
      setPushing(false);
    }
  }

  async function handleDuplicatePushConfirm() {
    if (!duplicateReview) return;
    const selected = new Set(duplicateReview.selectedCaseIds);
    const casesToPush = testCases.filter((testCase) => selected.has(testCase.id));
    if (!casesToPush.length) {
      pushToast('error', toastText.pushErrorTitle, toastText.duplicateReviewEmptySelection);
      return;
    }
    setPushing(true);
    setError('');
    try {
      await submitPush(casesToPush);
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

  function handleLogin() {
    window.location.href = '/auth/atlassian';
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
    <div className={`workbench-app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
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
              <DiagnosticsPanel lang={lang} diagnostics={diagnostics} showHeader={false} />
            </div>
          </section>
        </div>
      ) : null}

      {showHistory ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowHistory(false)}>
          <section
            className="modal-card workflow-help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">QA Agent</div>
                <h2 id="history-modal-title">{t.history.title}</h2>
                <p>{t.history.subtitle}</p>
              </div>
              <button className="button button-secondary button-small" type="button" onClick={() => setShowHistory(false)}>
                {t.status.close}
              </button>
            </div>
            <div className="modal-panel-wrap">
              <HistoryPanel lang={lang} runs={historyRuns} selectedRun={selectedHistoryRun} busy={historyLoading} onOpenRun={handleOpenHistoryRun} />
            </div>
          </section>
        </div>
      ) : null}

      {duplicateReview && context ? (
        <DuplicatePushReviewModal
          lang={lang}
          jiraKey={context.ticketKey}
          sectionId={sectionId}
          existingCases={duplicateReview.existingCases}
          generatedCases={testCases}
          recommendations={duplicateReview.recommendations}
          selectedCaseIds={duplicateReview.selectedCaseIds}
          busy={pushing}
          onSelectedCaseIdsChange={(selectedCaseIds) => setDuplicateReview((current) => (current ? { ...current, selectedCaseIds } : current))}
          onCancel={() => setDuplicateReview(null)}
          onPushSelected={handleDuplicatePushConfirm}
        />
      ) : null}

      <aside className="workbench-sidebar">
        <div className="workbench-brand">
          <button className="hamburger-button" type="button" aria-label="Toggle sidebar" onClick={() => setSidebarCollapsed((value) => !value)}>
            <span className="hamburger-lines" aria-hidden="true"><span /><span /><span /></span>
          </button>
          <strong>QA Agent</strong>
        </div>
        <nav className="workbench-areanav" role="tablist" aria-label="Area">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'home'}
            className={`workbench-areanav-item ${view === 'home' ? 'is-active' : ''}`}
            onClick={() => setView('home')}
            title={t.home.areaHome}
          >
            <span className="workbench-areanav-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
            </span>
            <span className="workbench-areanav-label">{t.home.areaHome}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'generate'}
            className={`workbench-areanav-item ${view === 'generate' ? 'is-active' : ''}`}
            onClick={() => setView('generate')}
            title={t.dashboard.areaGenerate}
          >
            <span className="workbench-areanav-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v16M4 12h16" /></svg>
            </span>
            <span className="workbench-areanav-label">{t.dashboard.areaGenerate}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'testrail'}
            className={`workbench-areanav-item ${view === 'testrail' ? 'is-active' : ''}`}
            onClick={() => setView('testrail')}
            title={t.dashboard.areaTestRail}
          >
            <span className="workbench-areanav-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </span>
            <span className="workbench-areanav-label">{t.dashboard.areaTestRail}</span>
          </button>
        </nav>
        {view === 'generate' ? (
        <>
        <nav className="workbench-nav" aria-label={t.stepper.ariaLabel}>
          {stepperSteps.map((step, index) => (
            <button
              className={`workbench-nav-step is-${step.state}`}
              key={step.key}
              type="button"
              aria-label={`${t.stepper[step.key]} - ${
                step.key === 'analyze'
                  ? 'Pick ticket and sources'
                  : step.key === 'scope'
                    ? 'Confirm scope'
                    : step.key === 'review'
                      ? 'Inspect test cases'
                      : 'Validate and push'
              }`}
              title={t.stepper[step.key]}
              onClick={() => scrollToSection(step.key)}
            >
              <span className="workbench-nav-dot">{index + 1}</span>
              <span className="workbench-nav-copy">
                <span>{t.stepper[step.key]}</span>
                <small>
                  {step.key === 'analyze'
                    ? 'Pick ticket & sources'
                    : step.key === 'scope'
                      ? 'Confirm scope'
                      : step.key === 'review'
                        ? 'Inspect test cases'
                        : 'Validate & push'}
                </small>
              </span>
            </button>
          ))}
        </nav>
        <div className="workbench-nav-secondary">
          <button type="button" title="History" onClick={() => setShowHistory(true)}>
            <span className="workbench-nav-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </span>
            <span className="workbench-nav-label">History</span>
          </button>
          <button type="button" title="Pushes" onClick={() => scrollToSection('approve')}>
            <span className="workbench-nav-ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V6" />
                <path d="M6 11l6-6 6 6" />
                <path d="M5 21h14" />
              </svg>
            </span>
            <span className="workbench-nav-label">Pushes</span>
          </button>
        </div>
        </>
        ) : null}
        <button className="workbench-collapse" type="button" onClick={() => setSidebarCollapsed((value) => !value)}>
          ‹ <span>{sidebarCollapsed ? 'Expand' : 'Collapse'}</span>
        </button>
      </aside>

      <main className="workbench-main">
        <header className="workbench-topbar">
          <div>
            <h1>{view === 'home' ? t.home.title : view === 'testrail' ? t.dashboard.title : t.heroTitle}</h1>
            <p>{view === 'home' ? t.home.subtitle : view === 'testrail' ? t.dashboard.subtitle : activeWorkflowLabel}</p>
          </div>
          <div className="workbench-top-actions">
            <button className="button button-secondary button-small" type="button" onClick={() => setShowWorkflowHelp(true)}>
              {t.help.trigger}
            </button>
            <button className="button button-secondary button-small" type="button" onClick={() => setShowStatusModal(true)}>
              {t.status.trigger}
            </button>
            {config?.authenticated ? (
              <button className="button button-secondary button-small" type="button" onClick={handleLogout}>
                {t.logout}
              </button>
            ) : (
              <button className="button button-primary button-small" type="button" onClick={handleLogin}>
                {t.loginWithAtlassian}
              </button>
            )}
            <span className="workbench-avatar">QA</span>
            <span>{config?.authenticated ? config.user || 'QA Engineer' : t.notLoggedIn}</span>
          </div>
        </header>

        <div className="workbench-content">
          {error ? <div className="global-error">{error}</div> : null}

          {view === 'home' ? (
            <HomeView
              lang={lang}
              authenticated={Boolean(config?.authenticated)}
              testrailReady={Boolean(config?.ready?.testrail)}
              suggestions={ticketSuggestions}
              recentRuns={historyRuns}
              onQuickStart={handleQuickStart}
              onOpenDashboard={() => setView('testrail')}
              onOpenHistory={() => setShowHistory(true)}
              onLogin={handleLogin}
            />
          ) : view === 'testrail' ? (
            <DashboardView
              lang={lang}
              authenticated={Boolean(config?.authenticated)}
              testrailReady={Boolean(config?.ready?.testrail)}
              defaultSectionId={config?.defaults?.testrailSectionId || ''}
              reporterUrl={config?.defaults?.reporterUrl || ''}
              onLogin={handleLogin}
            />
          ) : (
          <>
          <section ref={analyzeSectionRef} className="workbench-anchor">
          <AnalyzePanel
            lang={lang}
            form={form}
            busy={analyzing}
            canAnalyze={Boolean(config?.authenticated)}
            analyzeBlocker={analyzeBlocker}
            suggestionsEnabled={Boolean(config?.authenticated)}
            suggestions={ticketSuggestions}
            suggestionsLoading={loadingSuggestions}
            suggestionsError={suggestionsError}
            onLogin={handleLogin}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            onSuggestionSelect={handleSuggestionSelect}
            onAnalyze={handleAnalyze}
          />
          </section>

          <div className="workbench-primary">
            <section ref={scopeSectionRef} className="workbench-anchor">
              <ContextPanel
                lang={lang}
                context={context}
                analyzing={analyzing}
                translation={lang === 'id' ? scopeTranslation : null}
                translating={translatingScope}
                permissionApproved={confidenceApproved}
                overrideReason={overrideReason}
                busy={generating}
                generateBlocker={generateBlocker}
                onLanguageChange={handleScopeLanguageChange}
                onPermissionApprovedChange={setConfidenceApproved}
                onOverrideReasonChange={setOverrideReason}
                onGenerate={handleGenerate}
              />
            </section>

            {pendingGeneration ? (
              <RegenerateDiffPanel
                lang={lang}
                currentCases={testCases}
                candidate={pendingGeneration}
                onReplace={() => {
                  applyGeneration(pendingGeneration);
                  setPendingGeneration(null);
                }}
                onCancel={() => setPendingGeneration(null)}
              />
            ) : null}

            <section ref={reviewSectionRef} className="workbench-anchor">
              <ReviewPanel
                lang={lang}
                context={context}
                generating={generating}
                testCases={testCases}
                validation={validation}
                coverage={coverage}
                coverageEnforced={coverageEnforced}
                manualScopeOverride={manualScopeOverride}
                onCaseChange={handleCaseChange}
              />
            </section>

            <section ref={approveSectionRef} className="workbench-anchor">
              <ApprovalPanel
                lang={lang}
                approved={approved}
                sectionId={sectionId}
                casesValid={casesValid}
                coverageComplete={coverageComplete}
                busy={pushing}
                results={pushResults}
                pushBlocker={pushBlocker}
                onApprovedChange={setApproved}
                onSectionIdChange={setSectionId}
                onPush={handlePush}
              />
              {pushedCases ? (
                context?.scopeParentIssue ? (
                  <PlanLinkCard
                    lang={lang}
                    caseIds={pushedCases.ids}
                    taskKey={pushedCases.jiraKey}
                    taskSummary={context.mainIssue.summary || ''}
                    storyKey={context.scopeParentIssue.key}
                    storySummary={context.scopeParentIssue.summary || ''}
                  />
                ) : (
                  <AddToRunCard lang={lang} caseIds={pushedCases.ids} jiraKey={pushedCases.jiraKey} />
                )
              ) : null}
            </section>
          </div>
          </>
          )}
        </div>

      </main>
    </div>
  );
}
