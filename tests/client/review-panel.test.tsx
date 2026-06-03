import { render, screen } from '@testing-library/react';
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
  it('renders quoted AC evidence inline in traceability details', () => {
    render(
      <ReviewPanel
        context={context}
        testCases={testCases}
        validation={validation}
        coverage={coverage}
        coverageEnforced={true}
        manualScopeOverride={false}
        lang="en"
        onCaseChange={vi.fn()}
      />
    );

    expect(document.querySelector('.source-quote')?.textContent).toMatch(/Analysis Summary window/);
    expect(screen.getAllByText(/PRD: AI Summary NO SCORE/).length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('.source-link')?.getAttribute('href')).toBe('https://example.test/prd#AI-Summary-NO-SCORE');
  });
});
