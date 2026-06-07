import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanList } from '../../src/client/components/dashboard/PlanList';
import { StatusDonut } from '../../src/client/components/dashboard/StatusDonut';
import type { TrPlanSummary } from '../../src/shared/contracts';
import * as api from '../../src/client/api';

vi.mock('../../src/client/api', () => ({
  loadPlanRunCounts: vi.fn(),
  loadTestRailPlanReview: vi.fn(),
  testrailAttachmentUrl: (id: string, name?: string, download?: boolean) =>
    `/api/testrail/attachments/${id}${name ? `?name=${encodeURIComponent(name)}` : ''}${download ? '&download=1' : ''}`,
}));

const plans: TrPlanSummary[] = [
  {
    planId: 241,
    planName: 'Release 1 Regression',
    isCompleted: false,
    createdOn: 1700000000,
    updatedOn: 1700009999,
    totalRuns: 3,
    totalTests: 10,
    passRate: 80,
    completionRate: 90,
    statusDistribution: { Passed: 8, Failed: 1, Untested: 1 },
    failedCount: 1,
    blockedCount: 0,
    untestedCount: 1,
    webUrl: 'https://example.testrail.io/index.php?/plans/view/241',
  },
  {
    planId: 99,
    planName: 'Completed Smoke',
    isCompleted: true,
    createdOn: 1699000000,
    updatedOn: null,
    totalRuns: 1,
    totalTests: 0,
    passRate: 0,
    completionRate: 0,
    statusDistribution: {},
    failedCount: 0,
    blockedCount: 0,
    untestedCount: 0,
    webUrl: 'https://example.testrail.io/index.php?/plans/view/99',
  },
];

describe('PlanList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.loadPlanRunCounts).mockResolvedValue({ counts: {} });
    vi.mocked(api.loadTestRailPlanReview).mockResolvedValue({
      plan: plans[0],
      runs: [
        {
          runId: 1001,
          runName: 'Chrome - Desktop Regression',
          isCompleted: false,
          totalTests: 3,
          statusDistribution: { Passed: 2, Untested: 1 },
          passRate: 100,
          completionRate: 66,
          passedCount: 2,
          evidencePresentCount: 1,
          evidenceMissingCount: 1,
          evidenceUnknownCount: 0,
          evidenceNotRequiredCount: 1,
          webUrl: 'https://example.testrail.io/index.php?/runs/view/1001',
          tests: [
            {
              testId: 11,
              caseId: 501,
              title: 'Passed with evidence',
              statusId: 1,
              status: 'Passed',
              assigneeName: 'Nur QA',
              latestResultId: 9001,
              evidenceStatus: 'present',
              attachments: [{ id: 'att-1', name: 'screen.png' }],
            },
            {
              testId: 12,
              caseId: 502,
              title: 'Passed missing evidence',
              statusId: 1,
              status: 'Passed',
              assigneeName: 'Nur QA',
              latestResultId: 9002,
              evidenceStatus: 'missing',
              attachments: [],
            },
            {
              testId: 13,
              caseId: 503,
              title: 'Todo case',
              statusId: 3,
              status: 'Untested',
              assigneeName: '',
              latestResultId: null,
              evidenceStatus: 'not_required',
              attachments: [],
            },
          ],
        },
      ],
      summary: {
        totalRuns: 1,
        totalTests: 3,
        passedCount: 2,
        evidencePresentCount: 1,
        evidenceMissingCount: 1,
        evidenceUnknownCount: 0,
        evidenceNotRequiredCount: 1,
      },
    });
  });

  it('renders plan rows with pass rate, totals, status chips; the name opens review', () => {
    render(<PlanList lang="en" plans={plans} reporterUrl="https://reporter.example" />);

    expect(screen.getByRole('button', { name: 'Release 1 Regression' })).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByTitle('Passed').textContent).toBe('8');
    expect(screen.getByTitle('Failed').textContent).toBe('1');

    // raw TestRail remains available as a separate external action
    const externalLinks = screen.getAllByRole('link', { name: 'Open in TestRail' });
    expect(externalLinks[0].getAttribute('href')).toBe('https://example.testrail.io/index.php?/plans/view/241');
    expect(screen.getAllByRole('link', { name: 'Open report in TestRail Reporter' })[0].getAttribute('href')).toBe('https://reporter.example/?plan=241');
  });

  it('keeps raw TestRail available when no Reporter URL is set', () => {
    render(<PlanList lang="en" plans={plans} reporterUrl="" />);
    expect(screen.getByRole('button', { name: 'Release 1 Regression' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open in TestRail' })[0].getAttribute('href')).toBe('https://example.testrail.io/index.php?/plans/view/241');
    expect(screen.queryByRole('link', { name: 'Open report in TestRail Reporter' })).toBeNull();
  });

  it('paginates at 20 per page with prev/next', async () => {
    const many: TrPlanSummary[] = Array.from({ length: 25 }, (_, i) => ({
      ...plans[0],
      planId: 1000 + i,
      planName: `Plan ${i + 1}`, // no Jira key → non-sprint section
    }));
    render(<PlanList lang="en" plans={many} reporterUrl="" />);

    expect(screen.getByRole('button', { name: 'Plan 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan 20' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Plan 21' })).toBeNull();
    expect(screen.getByText('1–20 of 25')).toBeTruthy();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Plan 21' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan 25' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Plan 1' })).toBeNull();
    expect(screen.getByText('21–25 of 25')).toBeTruthy();
  });

  it('splits plans into Sprint and Non-sprint sections by Jira key in the title', () => {
    const mixed: TrPlanSummary[] = [
      { ...plans[0], planId: 1, planName: 'ORB-2704, As a User, select adm area' },
      { ...plans[0], planId: 2, planName: 'Release Plan [Data] - 20260528' },
    ];
    render(<PlanList lang="en" plans={mixed} reporterUrl="" />);
    expect(screen.getByText('Sprint test plans')).toBeTruthy();
    expect(screen.getByText('Non-sprint test plans')).toBeTruthy();
  });

  it('opens a plan review modal and filters missing evidence', async () => {
    render(<PlanList lang="en" plans={plans} reporterUrl="" />);

    await userEvent.click(screen.getByRole('button', { name: 'Release 1 Regression' }));

    const dialog = await screen.findByRole('dialog', { name: 'Release 1 Regression' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getAllByText('Chrome - Desktop Regression').length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByText(/C501.*Passed with evidence/)).toBeTruthy();
    expect(within(dialog).getByText(/C502.*Passed missing evidence/)).toBeTruthy();
    expect(within(dialog).getByText(/C503.*Todo case/)).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Missing evidence' }));
    expect(within(dialog).getByText(/C502.*Passed missing evidence/)).toBeTruthy();
    expect(within(dialog).queryByText(/C501.*Passed with evidence/)).toBeNull();
    expect(within(dialog).queryByText(/C503.*Todo case/)).toBeNull();
  });

  it('previews an attachment inline when the evidence pill is clicked', async () => {
    render(<PlanList lang="en" plans={plans} reporterUrl="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Release 1 Regression' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release 1 Regression' });

    // No panel until the pill is clicked (nothing should auto-load the heavy file).
    expect(dialog.querySelector('.tr-evidence-panel')).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: /1 attachment/ }));

    const img = within(dialog).getByRole('img', { name: 'screen.png' });
    expect(img.getAttribute('src')).toBe('/api/testrail/attachments/att-1?name=screen.png');
    expect(within(dialog).getByRole('link', { name: 'Download' }).getAttribute('href')).toContain('download=1');
  });
});

describe('StatusDonut', () => {
  it('renders a segment per non-zero status plus the track, and the total in the center', () => {
    const { container } = render(<StatusDonut distribution={{ Passed: 8, Failed: 1, Untested: 1 }} centerLabel="tests" />);
    // 1 background track + 3 segments
    expect(container.querySelectorAll('circle').length).toBe(4);
    expect(screen.getByText('10')).toBeTruthy(); // total
    expect(screen.getByText('tests')).toBeTruthy();
  });

  it('renders only the track when distribution is empty', () => {
    const { container } = render(<StatusDonut distribution={{}} />);
    expect(container.querySelectorAll('circle').length).toBe(1);
    expect(screen.getByText('0')).toBeTruthy();
  });
});
