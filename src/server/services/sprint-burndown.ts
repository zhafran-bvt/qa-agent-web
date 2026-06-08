import type { JiraSprintBurndownResponse } from '../../shared/contracts';
import type { SimplifiedIssue } from './atlassian';

const DONE_STATUS_RE = /^(done|closed|resolved|deployed|released)$/i;

function increment(bucket: Record<string, number>, key: string): void {
  const normalized = key.trim() || 'Unknown';
  bucket[normalized] = (bucket[normalized] || 0) + 1;
}

function isDoneStatus(status?: string): boolean {
  return DONE_STATUS_RE.test(String(status || '').trim());
}

export function summarizeSprintBurndown(jql: string, issues: SimplifiedIssue[]): JiraSprintBurndownResponse {
  const statusDistribution: Record<string, number> = {};
  const issueTypeDistribution: Record<string, number> = {};
  let doneIssues = 0;

  for (const issue of issues) {
    increment(statusDistribution, issue.status || 'Unknown');
    increment(issueTypeDistribution, issue.issueType || 'Unknown');
    if (isDoneStatus(issue.status)) doneIssues += 1;
  }

  const totalIssues = issues.length;
  const remainingIssues = Math.max(0, totalIssues - doneIssues);
  const completionRate = totalIssues ? Math.round((doneIssues / totalIssues) * 100) : 0;

  return {
    jql,
    totalIssues,
    doneIssues,
    remainingIssues,
    completionRate,
    statusDistribution,
    issueTypeDistribution,
    updatedAt: new Date().toISOString(),
    issues: issues.map((issue) => ({
      key: issue.key,
      summary: issue.summary || '',
      status: issue.status || '',
      issueType: issue.issueType || '',
      assignee: issue.assignee || '',
      webUrl: issue.webUrl || '',
      updatedAt: issue.updatedAt || '',
    })),
  };
}
