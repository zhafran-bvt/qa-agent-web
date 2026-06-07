import type {
  AnalyzeRequest,
  AnalyzeResponse,
  ConfigResponse,
  DiagnosticsResponse,
  GenerateRequest,
  GenerateResponse,
  PushPreflightRequest,
  PushPreflightResponse,
  PushRequest,
  PushResponse,
  CoverageResponse,
  ManageCaseRequest,
  ManageRunRequest,
  PlanForStoryResponse,
  PlanRunCountsResponse,
  ScopeSnapshotTranslationRequest,
  ScopeSnapshotTranslationResponse,
  TestrailCredentialsStatus,
  TestRailManageResponse,
  TrPlanReviewResponse,
  TestRailPlansResponse,
  TestRailSummaryResponse,
  TicketSuggestionsResponse,
  ValidateRequest,
  ValidateResponse,
  WorkflowHistoryDetailResponse,
  WorkflowHistoryListResponse,
} from '../shared/contracts';

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Browser API wrapper: every backend route returns JSON errors, so surface those messages directly to the UI.
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `HTTP ${response.status}`);
  }
  return body as T;
}

export function loadConfig(): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>('/api/config');
}

export function loadTicketSuggestions(): Promise<TicketSuggestionsResponse> {
  return requestJson<TicketSuggestionsResponse>('/api/suggestions/tickets');
}

export function loadTestRailPlans(projectId?: string): Promise<TestRailPlansResponse> {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return requestJson<TestRailPlansResponse>(`/api/testrail/plans${query}`);
}

export function loadTestRailPlanReview(planId: string | number): Promise<TrPlanReviewResponse> {
  return requestJson<TrPlanReviewResponse>(`/api/testrail/plans/${encodeURIComponent(String(planId))}/review`);
}

/** URL for the attachment proxy — used as a <video>/<img> src or an Open/Download href. */
export function testrailAttachmentUrl(id: string | number, name?: string, download = false): string {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (download) params.set('download', '1');
  const query = params.toString();
  return `/api/testrail/attachments/${encodeURIComponent(String(id))}${query ? `?${query}` : ''}`;
}

export function loadTestRailSummary(): Promise<TestRailSummaryResponse> {
  return requestJson<TestRailSummaryResponse>('/api/testrail/summary');
}

export function createTestRailCase(payload: ManageCaseRequest): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>('/api/testrail/manage/case', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createTestRailRun(payload: ManageRunRequest): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>('/api/testrail/manage/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function loadTestrailCredentials(): Promise<TestrailCredentialsStatus> {
  return requestJson<TestrailCredentialsStatus>('/api/testrail/credentials');
}

export function saveTestrailCredentials(payload: { user: string; apiKey: string }): Promise<TestrailCredentialsStatus> {
  return requestJson<TestrailCredentialsStatus>('/api/testrail/credentials', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function clearTestrailCredentials(): Promise<TestrailCredentialsStatus> {
  return requestJson<TestrailCredentialsStatus>('/api/testrail/credentials', { method: 'DELETE' });
}

export function loadCoverage(keys: string[]): Promise<CoverageResponse> {
  return requestJson<CoverageResponse>(`/api/testrail/coverage?keys=${encodeURIComponent(keys.join(','))}`);
}

export function loadPlanRunCounts(planIds: Array<number | string>): Promise<PlanRunCountsResponse> {
  return requestJson<PlanRunCountsResponse>(`/api/testrail/plan-run-counts?ids=${encodeURIComponent(planIds.join(','))}`);
}

export function loadPlanForStory(storyKey: string): Promise<PlanForStoryResponse> {
  return requestJson<PlanForStoryResponse>(`/api/testrail/plan-for-story?key=${encodeURIComponent(storyKey)}`);
}

export function addTestRailPlanEntry(
  planId: string | number,
  payload: { name: string; caseIds: number[]; refs?: string; dryRun?: boolean }
): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>(`/api/testrail/manage/plan/${encodeURIComponent(String(planId))}/entry`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function setTestRailRunCases(runId: string | number, caseIds: number[], dryRun = false): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>(`/api/testrail/manage/run/${encodeURIComponent(String(runId))}/cases`, {
    method: 'POST',
    body: JSON.stringify({ caseIds, dryRun }),
  });
}

export function updateTestRailCase(caseId: string | number, payload: ManageCaseRequest): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>(`/api/testrail/manage/case/${encodeURIComponent(String(caseId))}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function updateTestRailRun(runId: string | number, payload: ManageRunRequest): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>(`/api/testrail/manage/run/${encodeURIComponent(String(runId))}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function createTestRailPlan(payload: ManageRunRequest): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>('/api/testrail/manage/plan', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateTestRailPlan(planId: string | number, payload: ManageRunRequest): Promise<TestRailManageResponse> {
  return requestJson<TestRailManageResponse>(`/api/testrail/manage/plan/${encodeURIComponent(String(planId))}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

function deleteManage(resource: 'case' | 'run' | 'plan', id: string | number, dryRun = false): Promise<TestRailManageResponse> {
  // TestRail delete endpoints support dry-run through the server so dangerous actions can be previewed.
  const query = dryRun ? '?dry_run=true' : '';
  return requestJson<TestRailManageResponse>(`/api/testrail/manage/${resource}/${encodeURIComponent(String(id))}${query}`, {
    method: 'DELETE',
  });
}

export function deleteTestRailCase(caseId: string | number, dryRun = false): Promise<TestRailManageResponse> {
  return deleteManage('case', caseId, dryRun);
}

export function deleteTestRailRun(runId: string | number, dryRun = false): Promise<TestRailManageResponse> {
  return deleteManage('run', runId, dryRun);
}

export function deleteTestRailPlan(planId: string | number, dryRun = false): Promise<TestRailManageResponse> {
  return deleteManage('plan', planId, dryRun);
}

export function analyzeContext(payload: AnalyzeRequest): Promise<AnalyzeResponse> {
  return requestJson<AnalyzeResponse>('/api/analyze', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function generateCases(payload: GenerateRequest): Promise<GenerateResponse> {
  return requestJson<GenerateResponse>('/api/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function validateCases(payload: ValidateRequest): Promise<ValidateResponse> {
  return requestJson<ValidateResponse>('/api/validate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function pushCases(payload: PushRequest): Promise<PushResponse> {
  return requestJson<PushResponse>('/api/push', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function preflightPush(payload: PushPreflightRequest): Promise<PushPreflightResponse> {
  return requestJson<PushPreflightResponse>('/api/push/preflight', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function loadHistoryRuns(): Promise<WorkflowHistoryListResponse> {
  return requestJson<WorkflowHistoryListResponse>('/api/history/runs');
}

export function loadHistoryRun(id: string): Promise<WorkflowHistoryDetailResponse> {
  return requestJson<WorkflowHistoryDetailResponse>(`/api/history/runs/${encodeURIComponent(id)}`);
}

export function loadDiagnostics(): Promise<DiagnosticsResponse> {
  return requestJson<DiagnosticsResponse>('/api/diagnostics');
}

export function translateScopeSnapshot(payload: ScopeSnapshotTranslationRequest): Promise<ScopeSnapshotTranslationResponse> {
  return requestJson<ScopeSnapshotTranslationResponse>('/api/context/translate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}
