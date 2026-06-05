import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/client/App';
import * as api from '../../src/client/api';

vi.mock('../../src/client/api', () => ({
  analyzeContext: vi.fn(),
  generateCases: vi.fn(),
  loadConfig: vi.fn(),
  loadDiagnostics: vi.fn(),
  loadHistoryRun: vi.fn(),
  loadHistoryRuns: vi.fn(),
  loadTicketSuggestions: vi.fn(),
  logout: vi.fn(),
  preflightPush: vi.fn(),
  pushCases: vi.fn(),
  translateScopeSnapshot: vi.fn(),
  validateCases: vi.fn(),
}));

const configResponse = {
  authenticated: false,
  user: null,
  ready: {
    atlassian: true,
    llm: true,
    testrail: true,
    database: true,
  },
  defaults: {
    testrailSectionId: '69',
    llmProviders: [{ name: 'openai', model: 'gpt-5.4-mini', configured: true }],
  },
};

describe('App utility UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.loadConfig).mockResolvedValue(configResponse as any);
    vi.mocked(api.loadHistoryRuns).mockResolvedValue({ runs: [] } as any);
    vi.mocked(api.loadTicketSuggestions).mockResolvedValue({ tickets: [], jql: '' } as any);
    vi.mocked(api.loadDiagnostics).mockResolvedValue({
      persistence: { mode: 'postgres', migrationVersion: '002_oauth_states.sql' },
      auth: { configured: true, authenticated: false },
      privacy: { storedAccountCount: 0, dueAccountCount: 0, lastCyclePeriodDays: 7 },
      readiness: { atlassian: true, llm: true, testrail: true, database: true },
      recentIssues: [],
    } as any);
  });

  it('opens the workflow and status modals from the left utility triggers', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText('Recommendations unavailable')).toBeTruthy());
    expect(screen.getAllByText('Log in with Atlassian first to load tickets assigned to you in the active sprint.').length).toBeGreaterThanOrEqual(1);

    await userEvent.click(screen.getByRole('button', { name: /How it works/i }));
    expect(screen.getByRole('dialog', { name: /How QA Agent works/i })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(screen.getByRole('dialog', { name: /Diagnostics/i })).toBeTruthy();
  });

  it('keeps workbench utility controls clickable in the signed-out state', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText('Connect Atlassian to start')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('dialog', { name: /Workflow History/i })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog', { name: /Workflow History/i })).getByRole('button', { name: 'Close' }));

    await userEvent.click(screen.getByRole('button', { name: /Scope Snapshot - Confirm scope/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Pushes' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(document.querySelector('.workbench-app.sidebar-collapsed')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Expand/i }));
    expect(document.querySelector('.workbench-app.sidebar-collapsed')).toBeFalsy();
  });

  it('renders explicit blockers for disabled workbench actions', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText('Log in with Atlassian to analyze Jira scope.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Analyze Jira + Confluence' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Generate test cases before pushing to TestRail.')).toBeTruthy();
    expect(screen.getByText('Load scope before generation')).toBeTruthy();
    expect(screen.getByText('Analyze scope before review')).toBeTruthy();
  });

  it('shows a toast when config loading fails', async () => {
    vi.mocked(api.loadConfig).mockRejectedValueOnce(new Error('Config service down'));

    render(<App />);

    await waitFor(() => expect(screen.getByText('Config load failed')).toBeTruthy());
    expect(screen.getAllByText('Config service down').length).toBeGreaterThanOrEqual(1);
  });

  it('shows assigned ticket suggestions and fills the jira key when one is selected', async () => {
    vi.mocked(api.loadConfig).mockResolvedValueOnce({
      ...configResponse,
      authenticated: true,
      user: 'qa.user',
    } as any);
    vi.mocked(api.loadTicketSuggestions).mockResolvedValueOnce({
      tickets: [
        {
          key: 'ORB-3157',
          summary: 'Generate executive summary for analysis results with no scoring',
          issueType: 'Task',
          status: 'In Progress',
        },
        {
          key: 'ORB-3201',
          summary: 'Regression test AI summary fallback output',
          issueType: 'Bug',
          status: 'To Do',
        },
      ],
      jql: 'mock',
    } as any);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Suggested for you')).toBeTruthy());
    expect(screen.getByText('Tickets assigned to you in the active sprint.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /ORB-3157/i }));

    const jiraInput = screen.getByLabelText('Jira Ticket Key') as HTMLInputElement;
    expect(jiraInput.value).toBe('ORB-3157');
  });
});
