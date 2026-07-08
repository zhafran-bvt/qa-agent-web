import type {
  AnalyzeRequest,
  AnalyzeResponse,
  ConfigResponse,
  DiagnosticsResponse,
  GenerateRequest,
  GenerateResponse,
  JiraSprintBurndownResponse,
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

export function loadJiraSprintBurndown(): Promise<JiraSprintBurndownResponse> {
  return requestJson<JiraSprintBurndownResponse>('/api/jira/sprint-burndown');
}

export function loadTestRailPlans(projectId?: string): Promise<TestRailPlansResponse> {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return requestJson<TestRailPlansResponse>(`/api/testrail/plans${query}`);
}

export function loadTestRailPlanReview(planId: string | number): Promise<TrPlanReviewResponse> {
  return requestJson<TrPlanReviewResponse>(`/api/testrail/plans/${encodeURIComponent(String(planId))}/review`);
}

// Upload raw file bytes (not JSON) to an evidence endpoint, with the filename URL-encoded in a header
// so it stays ASCII-safe; the server forwards it to TestRail.
async function postEvidence(path: string, file: File, contentType?: string): Promise<{ attachmentId: string }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': contentType || file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'evidence'),
    },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `Upload failed (${response.status})`);
  }
  return body as { attachmentId: string };
}

/** Attach evidence to a TestRail result (per-run; flips the evidence badge for passed tests). */
export function uploadResultEvidence(resultId: string | number, file: File, contentType?: string): Promise<{ attachmentId: string }> {
  return postEvidence(`/api/testrail/results/${encodeURIComponent(String(resultId))}/attachments`, file, contentType);
}

/** For a test with no result yet (e.g. Untested): record a Passed result for the case in the run, then
 *  attach the evidence to it. Mutates TestRail (sets the test Passed) — the caller confirms first. */
export function passWithEvidence(
  runId: string | number,
  caseId: string | number,
  file: File,
  contentType?: string
): Promise<{ resultId: string; attachmentId: string; status: string }> {
  return postEvidence(
    `/api/testrail/runs/${encodeURIComponent(String(runId))}/cases/${encodeURIComponent(String(caseId))}/pass-with-evidence`,
    file,
    contentType
  ) as Promise<{ resultId: string; attachmentId: string; status: string }>;
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

// Thrown when /api/generate refuses because the acceptance criteria are not production-ready (weak raw
// ACs + failed/empty synthesis). Carries the reason so the UI can offer an explicit override instead of
// showing an opaque error.
export class GenerationBlockedError extends Error {
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'GenerationBlockedError';
    this.reason = reason;
  }
}

export async function generateCases(payload: GenerateRequest): Promise<GenerateResponse> {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  const blocked = body as { blocked?: boolean; reason?: string; message?: string };
  if (response.status === 422 && blocked.blocked) {
    throw new GenerationBlockedError(blocked.message || 'Generation was blocked.', blocked.reason || 'blocked');
  }
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `HTTP ${response.status}`);
  }
  return body as GenerateResponse;
}

export function validateCases(payload: ValidateRequest): Promise<ValidateResponse> {
  return requestJson<ValidateResponse>('/api/validate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// Thrown when /api/push blocks on the backup quality gate (residual quality issues). Carries the message
// so the UI can offer an explicit acknowledge-to-override, mirroring the weak-coverage / single-polarity
// acknowledgements rather than surfacing an opaque error.
export class PushQualityGateBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushQualityGateBlockedError';
  }
}

export async function pushCases(payload: PushRequest): Promise<PushResponse> {
  const response = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  const blocked = body as { requiresQualityGateAck?: boolean; error?: string };
  if (response.status === 400 && blocked.requiresQualityGateAck) {
    throw new PushQualityGateBlockedError(blocked.error || 'This run has unresolved quality issues.');
  }
  if (!response.ok) {
    throw new Error(blocked.error || `HTTP ${response.status}`);
  }
  return body as PushResponse;
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
