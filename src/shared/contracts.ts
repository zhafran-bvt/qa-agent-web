export interface LlmProviderStatus {
  name: string;
  model: string;
  configured: boolean;
}

export interface ConfigResponse {
  authenticated: boolean;
  user?: string | null;
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
    llmProviders: LlmProviderStatus[];
  };
}

export interface AnalyzeRequest {
  jiraKey: string;
  feOnly: boolean;
  beAlreadyTested: boolean;
  includeComments: boolean;
  notes: string;
}

export interface LinkedIssueSummary {
  key: string;
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
    notes: string;
  };
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
  jiraReference: string;
  preconditions: string;
  bddScenario: string;
  coversAcceptanceCriteria: string[];
  sourceScope: string[];
  evidence: TestCaseEvidence;
}

export interface TestCaseEvidenceAcceptanceCriterion {
  id: string;
  text: string;
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
  allowNonMainRefs?: boolean;
  acceptanceCriteria: ScopedItem[];
  enforceAcceptanceCriteria: boolean;
  context?: QaContext;
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
  runs: WorkflowHistorySummary[];
}

export interface WorkflowHistoryDetailResponse {
  run: WorkflowHistoryDetail;
}

export interface DiagnosticsResponse {
  auth: {
    configured: boolean;
    selectedResource: {
      cloudId: string;
      url?: string | null;
      name?: string | null;
    } | null;
    sessionExpiresAt?: number | null;
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
