import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from '../../src/client/components/ReviewPanel';
import type { CoverageSummary, GenerateQualityEvaluation, GeneratedTestCase, QaContext, ValidationEntry } from '../../src/shared/contracts';

const context: QaContext = {
  ticketKey: 'ORB-3157',
  epic: 'AI Assistance',
  mainIssue: {
    key: 'ORB-3157',
    summary: '[FE] Integrate API - AI Summary - Generate executive summary for analysis results with no scoring',
    description: '',
    renderedDescription: '',
  },
  linkedIssues: [],
  confluencePages: [],
  scopeParentIssue: {
    key: 'ORB-1248',
    summary: 'AI Assistance Summary Result',
    issueType: 'Story',
  },
  scopeParentRelation: 'is child of',
  scopeConfluenceSection: {
    pageId: '950075398',
    title: 'AI Powered Assistance',
    url: 'https://example.test/prd#AI-Summary-NO-SCORE',
    anchor: 'AI-Summary-NO-SCORE',
    matchedHeading: 'AI Summary NO SCORE',
    matched: true,
    reason: 'Parent Story was resolved and its linked PRD subsection was matched successfully.',
    sourceIssueKey: 'ORB-1248',
    body: 'AI Summary NO SCORE requirements',
  },
  scopeAuthority: {
    type: 'matched_prd_subsection',
    title: 'AI Summary NO SCORE',
    body: 'AI Summary NO SCORE requirements',
    reason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
    quality: 'high',
    sourceIssueKey: 'ORB-1248',
    pageId: '950075398',
  },
  acceptanceCriteria: [
    {
      id: 'AC-1',
      text: 'The AI Summary tab is available for analysis results with no score.',
      sourceExcerpts: [
        {
          text: 'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.',
          location: 'PRD: AI Summary NO SCORE',
          url: 'https://example.test/prd#AI-Summary-NO-SCORE',
          kind: 'prd',
          confidence: 'closest',
        },
        {
          text: 'Results with no score still use the AI Summary variant.',
          location: 'PRD: AI Summary NO SCORE',
          url: 'https://example.test/prd#AI-Summary-NO-SCORE',
          kind: 'prd',
          confidence: 'closest',
        },
      ],
      sourceExcerpt: 'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.',
      sourceExcerptLocation: 'PRD: AI Summary NO SCORE',
      sourceExcerptUrl: 'https://example.test/prd#AI-Summary-NO-SCORE',
      sourceExcerptKind: 'prd',
    },
  ],
  userStories: [],
  acceptanceCriteriaSource: 'parent_story_confluence_section',
  confidenceLevel: 'high',
  confidenceReasons: ['Main Jira scope was insufficient, so the matched PRD subsection was used.'],
  requiresConfidencePermission: false,
  acceptanceCriteriaDiagnostics: {
    allIssueUserStories: [],
    allIssueCriteria: [],
    confluenceCriteria: [],
  },
  constraints: { feOnly: true, beAlreadyTested: false },
  actualDevScopeGuidance: 'Use scoped PRD for thin tickets.',
};

const testCases: GeneratedTestCase[] = [
  {
    id: 'TC-ORB-3157-001',
    title: '[Web][AI Assistance][ORB-3157] Show AI Summary for no-score analysis results',
    type: 'BDD',
    caseIntent: 'positive',
    jiraReference: 'ORB-3157',
    preconditions: 'User has a no-score analysis result.',
    bddScenario: 'Feature: AI Summary\nScenario: View summary\nGiven x\nWhen y\nThen z',
    coversAcceptanceCriteria: ['AC-1'],
    sourceScope: ['ORB-3157', 'AI Summary NO SCORE'],
    evidence: {
      prdSectionTitle: 'AI Summary NO SCORE',
      acceptanceCriteria: [
        {
          id: 'AC-1',
          text: 'The AI Summary tab is available for analysis results with no score.',
          sourceExcerpts: [
            {
              text: 'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.',
              location: 'PRD: AI Summary NO SCORE',
              url: 'https://example.test/prd#AI-Summary-NO-SCORE',
              kind: 'prd',
              confidence: 'closest',
            },
            {
              text: 'Results with no score still use the AI Summary variant.',
              location: 'PRD: AI Summary NO SCORE',
              url: 'https://example.test/prd#AI-Summary-NO-SCORE',
              kind: 'prd',
              confidence: 'closest',
            },
          ],
          sourceExcerpt: 'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.',
          sourceExcerptLocation: 'PRD: AI Summary NO SCORE',
          sourceExcerptUrl: 'https://example.test/prd#AI-Summary-NO-SCORE',
          sourceExcerptKind: 'prd',
        },
      ],
      coverageNote: 'Covers no-score AI Summary availability.',
    },
  },
];

const mixedIntentCases: GeneratedTestCase[] = [
  {
    ...testCases[0],
    id: 'TC-ORB-3157-002',
    title: '[Web][AI Assistance][ORB-3157] Reject access when AI Summary is unavailable',
    type: 'BDD',
    caseIntent: 'negative',
  },
  {
    ...testCases[0],
    id: 'TC-ORB-3157-003',
    title: '[Web][AI Assistance][ORB-3157] Handle empty analysis result boundary',
    type: 'BDD',
    caseIntent: 'edge',
  },
];

const validation: ValidationEntry[] = [
  {
    index: 0,
    id: 'TC-ORB-3157-001',
    valid: true,
    errors: [],
    warnings: [],
    normalized: {
      coversAcceptanceCriteria: ['AC-1'],
      sourceScope: ['ORB-3157', 'AI Summary NO SCORE'],
    },
  },
];

const coverage: CoverageSummary = {
  enforced: true,
  totalCriteria: 1,
  coveredCriteria: 1,
  uncoveredCriteria: [],
  byCriterion: [
    {
      id: 'AC-1',
      text: 'The AI Summary tab is available for analysis results with no score.',
      coveredBy: ['TC-ORB-3157-001'],
    },
  ],
  unmappedCases: [],
  unsubstantiatedClaims: [],
};

const failedQualityEvaluation: GenerateQualityEvaluation = {
  mode: 'quality_baseline',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  durationMs: 1_000,
  acceptanceCriteriaCount: 1,
  testCaseCount: 1,
  coverageEnforced: true,
  coveredCriteria: 1,
  totalCriteria: 1,
  uncoveredCriteria: [],
  weakCoverageClaims: 1,
  singlePolarityWarnings: 0,
  singlePolarityWarningLimit: 1,
  validationWarningCount: 1,
  broadCoverageWarnings: 0,
  broadCoverageWarningLimit: 1,
  duplicateCaseWarnings: 0,
  endpointAlignmentWarnings: 0,
  executionAlignmentWarnings: 0,
  executionTypeMismatchWarnings: 0,
  invalidCaseIds: [],
  minimumFocusedCaseCount: 1,
  tinyBroadSuite: false,
  rawAcceptanceCriteriaQuality: 'strong',
  synthesisUsed: true,
  noisyRawAcceptanceCriteria: false,
  falseGreenCoverageRisk: true,
  qualityGate: 'fail',
};

describe('ReviewPanel', () => {
  it('starts a safe candidate regeneration from the generated-case list', async () => {
    const onRegenerate = vi.fn();
    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={testCases}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
        onRegenerate={onRegenerate}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate test cases' }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('explains the quality-gate blocker instead of restating complete AC coverage', () => {
    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={testCases}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
        qualityEvaluation={failedQualityEvaluation}
      />
    );

    expect(screen.getByText('Quality gate: Failed')).toBeTruthy();
    expect(screen.getByText('1 acceptance criterion claimed but not substantiated')).toBeTruthy();
    expect(screen.queryByText('1 cases · 1/1 ACs covered')).toBeNull();
  });

  it('renders quoted AC evidence inline in traceability details', async () => {
    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={testCases}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
      />
    );

    // Evidence (with source excerpts) now lives behind the Evidence tab.
    await userEvent.click(screen.getByRole('button', { name: 'Evidence' }));

    expect(document.querySelectorAll('.source-quote').length).toBe(2);
    expect(document.querySelector('.source-quote')?.textContent).toMatch(/Analysis Summary window/);
    expect(screen.getAllByText(/PRD: AI Summary NO SCORE/).length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('.source-link')?.getAttribute('href')).toBe('https://example.test/prd#AI-Summary-NO-SCORE');
  });

  it('renders the TestRail preview read-only by default and supports editing BDD steps', async () => {
    const user = userEvent.setup();
    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={testCases}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
      />
    );

    // The review screen is a read-only TestRail preview until the user explicitly edits it.
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'TestRail preview' }).textContent).toContain('Given x');

    await user.click(screen.getByRole('button', { name: 'Edit case in QA Agent' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeTruthy();

    // Editing the preview keeps the existing structured BDD editor available.
    await user.click(screen.getByRole('button', { name: 'Edit as steps' }));
    expect(screen.getByDisplayValue('AI Summary')).toBeTruthy(); // Feature
    expect(screen.getByDisplayValue('View summary')).toBeTruthy(); // Scenario
    expect(screen.getByDisplayValue('x')).toBeTruthy(); // Given
    expect(screen.getByDisplayValue('y')).toBeTruthy(); // When
    expect(screen.getByDisplayValue('z')).toBeTruthy(); // Then
  });

  it('shows acceptance criteria coverage above the case list and TestRail preview', async () => {
    const user = userEvent.setup();
    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={testCases}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
      />
    );

    const coveragePanel = screen.getByRole('region', { name: 'Acceptance criteria coverage' });
    expect(within(coveragePanel).getByText('AC-1')).toBeTruthy();
    expect(within(coveragePanel).getByText('Covered')).toBeTruthy();
    expect(screen.getByText('Other generated cases (0)')).toBeTruthy();

    const listPane = document.querySelector('.review-table-pane');
    const previewPane = screen.getByRole('complementary', { name: 'TestRail preview' });
    if (!listPane) throw new Error('Expected the generated case list pane to render.');
    expect(listPane.compareDocumentPosition(previewPane)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const toggle = within(coveragePanel).getByRole('button', { name: /Acceptance criteria coverage/ });
    await user.click(toggle);
    expect(within(coveragePanel).queryByText(context.acceptanceCriteria[0].text)).toBeNull();
    await user.click(toggle);
    expect(within(coveragePanel).getByText(context.acceptanceCriteria[0].text)).toBeTruthy();
  });

  it('shows technical-spec traceability and prevents selecting clarification-blocked cases', () => {
    const blockedContext: QaContext = {
      ...context,
      acceptanceCriteriaDiagnostics: {
        ...context.acceptanceCriteriaDiagnostics,
        directRequirements: [
          {
            id: 'REQ-1',
            text: 'The response rounding precision is TBD.',
            disposition: 'needs_clarification',
            sourceKind: 'spec',
            sourceLocation: 'Spec: Result formatting',
            sourceUrl: 'https://example.test/spec#formatting',
            acceptanceCriteriaIds: ['AC-1'],
            clarificationReason: 'Rounding precision is undefined.',
          },
        ],
        acceptanceCriteriaExecutionPlan: [
          {
            criterionId: 'AC-1',
            executionType: 'manual_integration',
            observableSurface: 'Integration behavior requiring reviewer-selected evidence',
            reason: 'Endpoint is not verified.',
            coveragePolicy: 'integration_verification',
            endpointDowngrade: {
              method: 'GET',
              path: '/v1/analysis/{id}/summary',
              reason: 'Endpoint is not present in the fetched API contract.',
            },
          },
        ],
      },
    };
    const blockedCase: GeneratedTestCase = {
      ...testCases[0],
      clarificationBlockers: [
        {
          requirementId: 'REQ-1',
          reason: 'Rounding precision is undefined.',
          sourceLocation: 'Spec: Result formatting',
          sourceUrl: 'https://example.test/spec#formatting',
        },
      ],
    };

    render(
      <ReviewPanel
        context={blockedContext}
        generating={false}
        testCases={[blockedCase]}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
        blockedCaseIds={[blockedCase.id]}
        selectedPushCaseIds={[]}
        onSelectedPushCaseIdsChange={vi.fn()}
      />
    );

    const traceability = screen.getByRole('region', { name: 'Technical-spec traceability' });
    expect(within(traceability).getByText('REQ-1')).toBeTruthy();
    expect(within(traceability).getByText(/TC-ORB-3157-001/)).toBeTruthy();
    expect(screen.getByText('Unverified endpoint — downgraded to manual')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Blocked pending clarification/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('0 ready · 1 blocked pending clarification')).toBeTruthy();
  });

  it('shows an explicit generation state before cases are ready', () => {
    render(
      <ReviewPanel
        context={context}
        generating
        testCases={[]}
        validation={[]}
        coverage={null}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
      />
    );

    expect(screen.getByText('Generating test cases...')).toBeTruthy();
    expect(screen.getByText('Building BDD cases from the resolved scope authority and final acceptance criteria.')).toBeTruthy();
    expect(screen.getByText('Coverage will appear after generation finishes.')).toBeTruthy();
  });

  it('shows task-aware empty guidance before generation starts', () => {
    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={[]}
        validation={[]}
        coverage={null}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
      />
    );

    expect(screen.getByText('Generate cases to begin review')).toBeTruthy();
    expect(
      screen.getByText('Scope is ready. Generate BDD cases to inspect validation, coverage, and evidence.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate BDD with AI' })).toBeNull();
  });

  it('summarizes positive, negative, and edge-case mix', () => {
    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={[testCases[0], ...mixedIntentCases]}
        validation={[
          ...validation,
          { ...validation[0], id: 'TC-ORB-3157-002' },
          { ...validation[0], id: 'TC-ORB-3157-003' },
        ]}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
      />
    );

    expect(screen.getByText('Case mix: Positive 1 · Negative 1 · Edge 1')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Test intent' })).toBeTruthy();
    expect(screen.getByText('negative', { selector: '.case-intent-badge' })).toBeTruthy();
    expect(screen.getByText('edge', { selector: '.case-intent-badge' })).toBeTruthy();
  });

  it('shows the standalone expected result in the TestRail preview and confirms draft-only removal', async () => {
    const user = userEvent.setup();
    const onCaseRemove = vi.fn();
    const onCaseChange = vi.fn();
    const caseWithIntent = {
      ...testCases[0],
      goal: 'Confirm the no-score summary is available.',
      inputs: 'A no-score analysis result.',
      expectedResult: 'The AI Summary tab is available and shows the executive summary.',
    };

    render(
      <ReviewPanel
        context={context}
        generating={false}
        testCases={[caseWithIntent]}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={onCaseChange}
        onCaseRemove={onCaseRemove}
      />
    );

    expect(screen.queryByRole('textbox', { name: 'Goal' })).toBeNull();
    expect(screen.getByText('The AI Summary tab is available and shows the executive summary.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Edit case in QA Agent' }));
    expect((screen.getByRole('textbox', { name: 'Expected result' }) as HTMLTextAreaElement).value).toBe(
      'The AI Summary tab is available and shows the executive summary.',
    );
    expect(screen.getByRole('complementary', { name: 'TestRail preview' }).textContent).toContain(
      'The AI Summary tab is available and shows the executive summary.',
    );

    await user.click(screen.getByRole('button', { name: 'Remove TC-ORB-3157-001', exact: true }));
    const dialog = screen.getByRole('dialog', { name: 'Remove TC-ORB-3157-001 from this batch?' });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('It will not delete anything already published in TestRail.');

    await user.click(screen.getByRole('button', { name: 'Remove test case', exact: true }));
    expect(onCaseRemove).toHaveBeenCalledWith(0);
  });
});
