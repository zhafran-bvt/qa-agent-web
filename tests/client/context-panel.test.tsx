import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContextPanel } from '../../src/client/components/ContextPanel';
import type { QaContext } from '../../src/shared/contracts';

const baseContext: QaContext = {
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
    anchor: 'AI-Assistance-Summary-Result',
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
      source: 'parent_story_confluence_section synthesized',
      sourceExcerpt: 'The AI Summary tab is available in the Analysis Summary window and displays an executive summary for results with no score.',
      sourceExcerptLocation: 'PRD: AI Summary NO SCORE',
      sourceExcerptUrl: 'https://example.test/prd#AI-Summary-NO-SCORE',
      sourceExcerptKind: 'prd',
    },
  ],
  userStories: [{ id: 'US-1', text: 'AI Assistance Summary Result', source: 'ORB-1248 summary' }],
  acceptanceCriteriaSource: 'parent_story_confluence_section',
  confidenceLevel: 'high',
  confidenceReasons: ['Main Jira scope was insufficient, so the matched PRD subsection was used.'],
  requiresConfidencePermission: false,
  acceptanceCriteriaDiagnostics: {
    allIssueUserStories: [],
    allIssueCriteria: [],
    confluenceCriteria: [],
    selectedAcceptanceCriteriaSource: 'parent_story_confluence_section',
    selectedAcceptanceCriteriaReason: 'Main Jira scope was insufficient, so the matched PRD subsection was used.',
    ignoredSources: [],
    ignoredMetadataLabels: [],
    thinTicketFallbackUsed: true,
    prdSubsectionMatchQuality: 'confident',
    matchedPrdSubsectionHeading: 'AI Summary NO SCORE',
    matchedPrdSubsectionConfidence: 1,
    userStoryFragmentsDiscardedCount: 2,
  },
  constraints: {
    feOnly: true,
    beAlreadyTested: false,
  },
  actualDevScopeGuidance: 'Use scoped PRD for thin tickets.',
};

describe('ContextPanel', () => {
  it('renders scope diagnostics and triggers the Indonesian display option', async () => {
    const onLanguageChange = vi.fn();
    render(
      <ContextPanel
        context={baseContext}
        analyzing={false}
        translation={null}
        translating={false}
        permissionApproved={false}
        overrideReason=""
        busy={false}
        lang="en"
        onLanguageChange={onLanguageChange}
        onPermissionApprovedChange={vi.fn()}
        onOverrideReasonChange={vi.fn()}
        onGenerate={vi.fn()}
      />
    );

    expect(screen.getByText('Scope Snapshot')).toBeTruthy();
    expect(screen.getAllByText('AI Summary NO SCORE').length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('.source-quote')?.textContent).toMatch(/Analysis Summary window/);
    expect(screen.getAllByText(/PRD: AI Summary NO SCORE/).length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('.source-link')?.getAttribute('href')).toBe('https://example.test/prd#AI-Summary-NO-SCORE');

    await userEvent.click(screen.getByText('Scope Diagnostics'));
    expect(screen.getByText('Thin-ticket fallback')).toBeTruthy();
    expect(screen.getByText('PRD match quality')).toBeTruthy();
    expect(screen.getByText('Discarded story fragments')).toBeTruthy();
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);

    await userEvent.click(screen.getByRole('button', { name: 'ID' }));
    expect(onLanguageChange).toHaveBeenCalledWith('id');
  });

  it('shows an explicit loading state while analysis is running', () => {
    render(
      <ContextPanel
        context={null}
        analyzing
        translation={null}
        translating={false}
        permissionApproved={false}
        overrideReason=""
        busy={false}
        lang="en"
        onLanguageChange={vi.fn()}
        onPermissionApprovedChange={vi.fn()}
        onOverrideReasonChange={vi.fn()}
        onGenerate={vi.fn()}
      />
    );

    expect(screen.getByText('Analyzing Jira and Confluence...')).toBeTruthy();
    expect(screen.getByText('Resolving scope authority, acceptance criteria, and supporting evidence for this ticket.')).toBeTruthy();
  });
});
