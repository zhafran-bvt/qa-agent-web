import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PlanList } from '../../src/client/components/dashboard/PlanList';
import { StatusDonut } from '../../src/client/components/dashboard/StatusDonut';
import type { TrPlanSummary } from '../../src/shared/contracts';

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
  it('renders plan rows with pass rate, totals, status chips; the name deep-links to the Reporter', () => {
    render(<PlanList lang="en" plans={plans} reporterUrl="https://reporter.example" />);

    const nameLink = screen.getByRole('link', { name: 'Release 1 Regression' });
    expect(nameLink.getAttribute('href')).toBe('https://reporter.example/?plan=241');
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByTitle('Passed').textContent).toBe('8');
    expect(screen.getByTitle('Failed').textContent).toBe('1');

    // when a Reporter is configured, the ↗ still links to raw TestRail
    const externalLinks = screen.getAllByRole('link', { name: 'Open in TestRail' });
    expect(externalLinks[0].getAttribute('href')).toBe('https://example.testrail.io/index.php?/plans/view/241');
  });

  it('falls back to the raw TestRail URL on the name when no Reporter URL is set', () => {
    render(<PlanList lang="en" plans={plans} reporterUrl="" />);
    const nameLink = screen.getByRole('link', { name: 'Release 1 Regression' });
    expect(nameLink.getAttribute('href')).toBe('https://example.testrail.io/index.php?/plans/view/241');
    // no separate ↗ when there's no Reporter to distinguish from
    expect(screen.queryByRole('link', { name: 'Open in TestRail' })).toBeNull();
  });

  it('paginates at 20 per page with prev/next', async () => {
    const many: TrPlanSummary[] = Array.from({ length: 25 }, (_, i) => ({
      ...plans[0],
      planId: 1000 + i,
      planName: `Plan ${i + 1}`, // no Jira key → non-sprint section
    }));
    render(<PlanList lang="en" plans={many} reporterUrl="" />);

    expect(screen.getByRole('link', { name: 'Plan 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Plan 20' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Plan 21' })).toBeNull();
    expect(screen.getByText('1–20 of 25')).toBeTruthy();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('link', { name: 'Plan 21' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Plan 25' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Plan 1' })).toBeNull();
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
