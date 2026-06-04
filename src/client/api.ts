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
  ScopeSnapshotTranslationRequest,
  ScopeSnapshotTranslationResponse,
  TicketSuggestionsResponse,
  ValidateRequest,
  ValidateResponse,
  WorkflowHistoryDetailResponse,
  WorkflowHistoryListResponse,
} from '../shared/contracts';

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
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
