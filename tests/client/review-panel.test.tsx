import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from '../../src/client/components/ReviewPanel';
import type { CoverageSummary, GeneratedTestCase, QaContext, ValidationEntry } from '../../src/shared/contracts';

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
};

describe('ReviewPanel', () => {
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

  it('renders the BDD scenario as text by default and supports switching to steps', async () => {
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

    // Details tab is the default; the BDD editor now opens in free-text mode (single textarea).
    const textboxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    expect(textboxes.some((el) => el.value.includes('Given x') && el.value.includes('Then z'))).toBe(true);

    // Toggling to structured mode parses the scenario into Given/When/Then step inputs.
    await user.click(screen.getByRole('button', { name: 'Edit as steps' }));
    expect(screen.getByDisplayValue('AI Summary')).toBeTruthy(); // Feature
    expect(screen.getByDisplayValue('View summary')).toBeTruthy(); // Scenario
    expect(screen.getByDisplayValue('x')).toBeTruthy(); // Given
    expect(screen.getByDisplayValue('y')).toBeTruthy(); // When
    expect(screen.getByDisplayValue('z')).toBeTruthy(); // Then
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
  });
});
