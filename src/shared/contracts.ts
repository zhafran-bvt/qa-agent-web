export interface LlmProviderStatus {
  name: string;
  model: string;
  configured: boolean;
}

export interface ConfigResponse {
  authenticated: boolean;
  user?: string | null;
  accountId?: string | null;
  session?: {
    expiresAt?: number | null;
    selectedResource?: {
      cloudId: string;
      url?: string | null;
      name?: string | null;
    } | null;
  };
  ready: {
    atlassian: boolean;
    llm: boolean;
    testrail: boolean;
    database: boolean;
  };
  defaults: {
    testrailSectionId: string;
    testrailApiSectionId: string;
    reporterUrl: string;
    apiDocsUrl: string;
    llmProviders: LlmProviderStatus[];
  };
}

export interface SuggestedTicket {
  key: string;
  summary: string;
  status?: string;
  issueType?: string;
  assignee?: string;
  webUrl?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface TicketSuggestionsResponse {
  tickets: SuggestedTicket[];
  jql: string;
}

export interface JiraSprintBurndownIssue {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  assignee?: string;
  webUrl?: string;
  updatedAt?: string;
}

export interface JiraSprintBurndownResponse {
  jql: string;
  totalIssues: number;
  doneIssues: number;
  remainingIssues: number;
  completionRate: number;
  statusDistribution: Record<string, number>;
  issueTypeDistribution: Record<string, number>;
  updatedAt: string;
  issues: JiraSprintBurndownIssue[];
}

export interface AnalyzeRequest {
  jiraKey: string;
  scopeType?: QaScopeType;
  feOnly: boolean;
  beAlreadyTested: boolean;
  includeComments: boolean;
  apiDocsUrl?: string;
}

export type QaScopeType = 'web' | 'api' | 'auto';
export type ResolvedQaScopeType = Exclude<QaScopeType, 'auto'>;

export interface LinkedIssueSummary {
  key: string;
  webUrl?: string;
  summary?: string;
  status?: string;
  issueType?: string;
  relation?: string;
  linkRelation?: string;
  linkSummary?: string;
  fetchError?: string;
  classification?: string;
}

export interface ConfluencePageSourceRef {
  issueKey: string;
  sourceType: string;
  relationship?: string;
  anchor?: string;
}

export interface ConfluenceComment {
  id: string;
  body: string;
}

export interface ConfluencePageSummary {
  id: string;
  title?: string;
  status?: string;
  webUrl?: string | null;
  body?: string;
  sourceRefs?: ConfluencePageSourceRef[];
  sourceUrl?: string;
  comments?: ConfluenceComment[];
  fetchError?: string;
}

export interface ScopedItem {
  id: string;
  text: string;
  source?: string;
  sourceExcerpts?: SourceExcerptMatch[];
  sourceExcerpt?: string;
  sourceExcerptLocation?: string;
  sourceExcerptUrl?: string;
  sourceExcerptKind?: 'jira' | 'prd' | 'spec';
  sourceExcerptConfidence?: 'verbatim' | 'closest' | 'weak';
}

export interface SourceExcerptMatch {
  text: string;
  location?: string;
  url?: string;
  kind?: 'jira' | 'prd' | 'spec';
  confidence?: 'verbatim' | 'closest' | 'weak';
}

export interface ApiContractEndpoint {
  method: string;
  path: string;
  /** Human phrase when the endpoint was referenced by name (e.g. "Get dataset list") rather than as METHOD /path. */
  label?: string;
  summary?: string;
  source: 'jira' | 'confluence' | 'api_docs';
  documentationExcerpt?: string;
}

export interface ApiContractSummary {
  sourceUrl: string;
  matchedEndpoints: ApiContractEndpoint[];
  warnings: string[];
}

export interface ParentIssueSummary {
  key?: string;
  summary?: string;
  issueType?: string;
}

export interface MainIssueSummary {
  key: string;
  id?: string;
  webUrl?: string;
  summary?: string;
  issueType?: string;
  status?: string;
  parent?: ParentIssueSummary | null;
  description?: string;
  renderedDescription?: string;
  comments?: string[];
  subtasks?: Array<{ key: string; summary?: string; status?: string }>;
  linkedIssues?: LinkedIssueSummary[];
  labels?: string[];
  components?: string[];
  priority?: string;
  assignee?: string;
}

export interface ScopeConfluenceSection {
  pageId: string;
  title: string;
  url: string;
  anchor: string;
  matchedHeading: string;
  matched: boolean;
  reason: string;
  sourceIssueKey: string;
  body: string;
}

export interface ScopeAuthority {
  type:
    | 'main_jira_description'
    | 'main_jira_acceptance_criteria'
    | 'matched_prd_subsection'
    | 'broad_prd_section'
    | 'parent_story_jira'
    | 'none';
  title: string;
  body: string;
  reason: string;
  quality: 'high' | 'medium' | 'low';
  sourceIssueKey?: string;
  pageId?: string;
}

export interface AcceptanceCriteriaDiagnostics {
  allIssueUserStories: ScopedItem[];
  allIssueCriteria: ScopedItem[];
  confluenceCriteria: ScopedItem[];
  selectedAcceptanceCriteriaSource?: string;
  selectedAcceptanceCriteriaReason?: string;
  ignoredSources?: string[];
  ignoredMetadataLabels?: string[];
  thinTicketFallbackUsed?: boolean;
  prdSubsectionMatchQuality?: 'confident' | 'broad' | 'none';
  matchedPrdSubsectionHeading?: string;
  matchedPrdSubsectionConfidence?: number;
  userStoryFragmentsDiscardedCount?: number;
  scopeQualifierDetected?: string;
  scopeCandidatesRanked?: Array<{ heading: string; score: number; confidence: number }>;
  scopeAnchorResolvedFromChain?: boolean;
  synthesisUsed?: boolean;
  synthesisReason?: string;
  rawAcceptanceCriteriaQuality?: 'none' | 'weak' | 'strong';
  rawAcceptanceCriteriaWeakSignals?: string[];
  discardedFragmentCount?: number;
  discardedFragmentExamples?: string[];
}

export interface QaContext {
  analysisRunId?: string;
  ticketKey: string;
  epic: string;
  mainIssue: MainIssueSummary;
  linkedIssues: LinkedIssueSummary[];
  confluencePages: ConfluencePageSummary[];
  scopeParentIssue: LinkedIssueSummary | null;
  scopeParentRelation: string;
  scopeConfluenceSection: ScopeConfluenceSection | null;
  scopeAuthority: ScopeAuthority;
  acceptanceCriteria: ScopedItem[];
  userStories: ScopedItem[];
  acceptanceCriteriaSource: string;
  confidenceLevel: 'high' | 'medium' | 'low';
  confidenceReasons: string[];
  requiresConfidencePermission: boolean;
  acceptanceCriteriaDiagnostics: AcceptanceCriteriaDiagnostics;
  constraints: {
    feOnly: boolean;
    beAlreadyTested: boolean;
    scopeType?: ResolvedQaScopeType;
    requestedScopeType?: QaScopeType;
    // For backend (api) scope: whether the ticket actually changes the HTTP API contract
    // (endpoint refs or contract keywords) vs. internal backend work (migration, backfill, DB).
    // Only API-contract work uses the API docs as reference.
    apiContractRelevant?: boolean;
    apiContractRelevanceReason?: string;
  };
  apiDocsUrl?: string;
  apiContract?: ApiContractSummary;
  actualDevScopeGuidance: string;
}

export interface AnalyzeResponse {
  context: QaContext;
}

export interface ScopeSnapshotTranslation {
  mainSummary: string;
  parentStorySummary: string;
  scopedPrdSection: string;
  confidenceReasons: string[];
  selectedAcceptanceCriteriaReason?: string;
  userStories: ScopedItem[];
  acceptanceCriteria: ScopedItem[];
}

export interface ScopeSnapshotTranslationRequest {
  context: QaContext;
  targetLanguage: 'id';
}

export interface ScopeSnapshotTranslationResponse {
  translation: ScopeSnapshotTranslation;
}

export interface GeneratedTestCase {
  id: string;
  title: string;
  type: string;
  executionType?: 'postman' | 'manual_db' | 'manual_other';
  caseIntent?: 'positive' | 'negative' | 'edge';
  jiraReference: string;
  preconditions: string;
  bddScenario: string;
  coversAcceptanceCriteria: string[];
  sourceScope: string[];
  apiSpec?: {
    method: string;
    path: string;
    samplePayload?: string;
    expectedResponse?: string;
    assertions?: string[];
  };
  manualVerification?: {
    target: string;
    steps: string[];
    expectedResult: string;
  };
  evidence: TestCaseEvidence;
}

export interface TestCaseEvidenceAcceptanceCriterion {
  id: string;
  text: string;
  sourceExcerpts?: SourceExcerptMatch[];
  sourceExcerpt?: string;
  sourceExcerptLocation?: string;
  sourceExcerptUrl?: string;
  sourceExcerptKind?: 'jira' | 'prd' | 'spec';
  sourceExcerptConfidence?: 'verbatim' | 'closest' | 'weak';
}

export interface TestCaseEvidence {
  prdSectionTitle: string;
  acceptanceCriteria: TestCaseEvidenceAcceptanceCriterion[];
  coverageNote: string;
}

export interface ValidationEntry {
  index: number;
  id: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalized: {
    coversAcceptanceCriteria: string[];
    sourceScope: string[];
  };
}

export interface CoverageCriterion {
  id: string;
  text: string;
  source?: string;
  coveredBy: string[];
}

export interface CoverageSummary {
  enforced: boolean;
  totalCriteria: number;
  coveredCriteria: number;
  uncoveredCriteria: string[];
  byCriterion: CoverageCriterion[];
  unmappedCases: string[];
  // Claimed (case, AC) pairs whose case content doesn't substantiate the AC. Surfaced as a
  // non-blocking warning so reviewers can see weak/inflated coverage that still "counts" as mapped.
  unsubstantiatedClaims: Array<{ caseId: string; criterionId: string }>;
}

export interface GenerateRequest {
  context: QaContext;
  confidencePermissionApproved: boolean;
  manualScopeOverrideReason?: string;
}

export interface GenerateResponse {
  runId?: string;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary;
  coverageEnforced: boolean;
  manualScopeOverride: boolean;
  provider: string;
  model: string;
  pendingReplacement: boolean;
}

export interface ValidateRequest {
  testCases: GeneratedTestCase[];
  jiraKey: string;
  epic: string;
  feOnly: boolean;
  scopeType?: ResolvedQaScopeType;
  allowNonMainRefs?: boolean;
  acceptanceCriteria: ScopedItem[];
  enforceAcceptanceCriteria: boolean;
  context?: QaContext;
  // Lean copy of the matched API endpoints so the push/preflight gates can flag invented apiSpec
  // paths without shipping the whole context. Sourced from context.apiContract.matchedEndpoints.
  matchedEndpoints?: ApiContractEndpoint[];
}

export interface ValidateResponse {
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary;
}

export interface PushRequest extends ValidateRequest {
  approved: boolean;
  sectionId: string;
  generatedRunId?: string;
  // Acknowledge-to-override: weak (claimed-but-unsubstantiated) coverage does not hard-block the push,
  // but the push only proceeds when the reviewer has explicitly acknowledged it.
  weakCoverageAcknowledged?: boolean;
}

export type DuplicateCaseDecision = 'include' | 'exclude' | 'review';

export interface ExistingTestRailCase {
  caseId: number | string;
  title: string;
  refs: string;
  typeId?: number | string;
  preconditions?: string;
  bddScenario?: string;
  webUrl?: string;
}

export interface DuplicateCaseRecommendation {
  newCaseId: string;
  recommendation: DuplicateCaseDecision;
  overlap: 'already_covered' | 'partial_overlap' | 'new_coverage';
  matchedExistingCaseIds: Array<number | string>;
  reason: string;
  deterministic: boolean;
}

export interface PushPreflightRequest extends PushRequest {}

export interface PushPreflightResponse {
  duplicatesFound: boolean;
  duplicateLookupSkipped?: {
    reason: string;
  };
  existingCases: ExistingTestRailCase[];
  recommendations: DuplicateCaseRecommendation[];
  summary: {
    jiraKey: string;
    sectionId: string;
    existingCount: number;
    generatedCount: number;
  };
  // Surfaced so the reviewer sees non-blocking warnings (apiSpec provenance, weak coverage) before the
  // push, instead of them being silently dropped on the preflight success path.
  validation?: ValidationEntry[];
  coverage?: CoverageSummary;
  // Present (with the claim pairs) when coverage is claimed but unsubstantiated; the client must obtain
  // an explicit acknowledgement before pushing (the push endpoint enforces the same gate).
  weakCoverage?: {
    claims: Array<{ caseId: string; criterionId: string }>;
  };
}

export interface PushCaseResult {
  ok: boolean;
  caseId?: number | string;
  error?: string;
  title: string;
}

export interface PushResponse {
  results: PushCaseResult[];
  summary: {
    pushed: number;
    failed: number;
    total: number;
  };
}

export interface WorkflowHistorySummary {
  id: string;
  entryType: 'analysis' | 'generation' | 'push';
  jiraKey: string;
  user: string;
  createdAt: string;
  provider?: string;
  model?: string;
  caseCount?: number;
  pushed?: number;
  failed?: number;
  status: 'completed' | 'pushed';
}

export interface WorkflowHistoryDetail {
  id: string;
  entryType: 'analysis' | 'generation' | 'push';
  jiraKey: string;
  user: string;
  createdAt: string;
  context: QaContext | null;
  testCases: GeneratedTestCase[];
  validation: ValidationEntry[];
  coverage: CoverageSummary | null;
  provider?: string;
  model?: string;
  push?: {
    sectionId: string;
    summary: {
      pushed: number;
      failed: number;
      total: number;
    };
    results: PushCaseResult[];
    createdAt: string;
  } | null;
}

export interface WorkflowHistoryListResponse {
  visibility: 'team';
  runs: WorkflowHistorySummary[];
}

export interface WorkflowHistoryDetailResponse {
  run: WorkflowHistoryDetail;
}

export interface DiagnosticsResponse {
  auth: {
    configured: boolean;
    accountId?: string | null;
    selectedResource: {
      cloudId: string;
      url?: string | null;
      name?: string | null;
    } | null;
    sessionExpiresAt?: number | null;
  };
  privacy: {
    enabled: boolean;
    storedAccountCount: number;
    dueAccountCount: number;
    lastSuccessfulRunAt?: number | null;
    lastRunError?: string | null;
    lastCyclePeriodDays?: number | null;
  };
  persistence: {
    mode: 'postgres' | 'file+memory-fallback';
    migrationsEnabled: boolean;
    currentVersion: string | null;
  };
  readiness: {
    atlassian: boolean;
    llm: boolean;
    testrail: boolean;
    database: boolean;
  };
  recentIssues: Array<{
    timestamp: string;
    level: 'warn' | 'error';
    message: string;
    fields?: Record<string, unknown>;
  }>;
}

// --- TestRail dashboard (read views) -------------------------------------
export type TrStatusDistribution = Record<string, number>;

export interface TrPlanSummary {
  planId: number;
  planName: string;
  isCompleted: boolean;
  createdOn: number;
  updatedOn: number | null;
  totalRuns: number;
  totalTests: number;
  passRate: number;
  completionRate: number;
  statusDistribution: TrStatusDistribution;
  failedCount: number;
  blockedCount: number;
  untestedCount: number;
  createdBy?: number;
  createdByName?: string;
  webUrl: string;
}

export interface TestRailPlansResponse {
  projectId: string;
  plans: TrPlanSummary[];
}

export interface TrSummary {
  projectId: string;
  plans: number;
  activePlans: number;
  completedPlans: number;
  totalTests: number;
  passRate: number;
  completionRate: number;
  failed: number;
  blocked: number;
  untested: number;
  distribution: TrStatusDistribution;
}

export interface TestRailSummaryResponse extends TrSummary {}

export interface PlanForStoryResponse {
  storyKey: string;
  plans: TrPlanSummary[];
}

export interface CoverageResponse {
  coverage: Record<string, { covered: boolean; count: number }>;
}

export interface PlanRunCountsResponse {
  counts: Record<string, number>;
}

export type TrEvidenceStatus = 'not_required' | 'present' | 'missing' | 'unknown';

export interface TrAttachmentSummary {
  id: string;
  name: string;
  createdOn?: number | null;
  size?: number | null;
}

export interface TrPlanReviewTest {
  testId: number;
  caseId: number;
  title: string;
  statusId: number | null;
  status: string;
  assigneeId?: number | null;
  assigneeName?: string;
  refs?: string;
  elapsed?: string;
  defects?: string;
  latestResultId?: number | string | null;
  evidenceStatus: TrEvidenceStatus;
  attachments: TrAttachmentSummary[];
}

export interface TrPlanReviewRun {
  runId: number;
  runName: string;
  isCompleted: boolean;
  totalTests: number;
  statusDistribution: TrStatusDistribution;
  passRate: number;
  completionRate: number;
  passedCount: number;
  evidencePresentCount: number;
  evidenceMissingCount: number;
  evidenceUnknownCount: number;
  evidenceNotRequiredCount: number;
  tests: TrPlanReviewTest[];
  webUrl: string;
}

export interface TrPlanReviewResponse {
  plan: TrPlanSummary;
  runs: TrPlanReviewRun[];
  summary: {
    totalRuns: number;
    totalTests: number;
    passedCount: number;
    evidencePresentCount: number;
    evidenceMissingCount: number;
    evidenceUnknownCount: number;
    evidenceNotRequiredCount: number;
  };
}

export interface TestrailCredentialsStatus {
  available: boolean;
  configured: boolean;
  user: string | null;
}

// --- TestRail management (write) -----------------------------------------
export interface ManageCaseRequest {
  sectionId?: string | number;
  title?: string;
  refs?: string;
  preconditions?: string;
  bddScenario?: string;
  typeId?: number;
  priorityId?: number;
  templateId?: number;
  dryRun?: boolean;
}

export interface ManageRunRequest {
  projectId?: string | number;
  suiteId?: number;
  name?: string;
  description?: string;
  refs?: string;
  caseIds?: number[];
  includeAll?: boolean;
  dryRun?: boolean;
}

export interface ManageDryRunPreview {
  dryRun: true;
  action: string;
  endpoint: string;
  payload: Record<string, unknown>;
}

export interface ManageResult {
  ok: true;
  action: string;
  id?: number | string;
  result?: Record<string, unknown>;
}

export type TestRailManageResponse = ManageDryRunPreview | ManageResult;
