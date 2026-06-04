import https from 'node:https';
import type { Logger } from './logger';
import { requestHttpsJson } from './http';

interface AtlassianAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
}

interface AtlassianTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface AccessibleResource {
  id: string;
  name?: string;
  url?: string;
}

export interface AtlassianCurrentUserProfile {
  accountId: string;
  displayName: string;
  email?: string;
}

export interface PersonalDataReportRequestAccount {
  accountId: string;
  updatedAt: string;
}

export interface PersonalDataReportResultAccount {
  accountId: string;
  status: 'ok' | 'closed' | 'updated';
}

export interface PersonalDataReportResponse {
  accounts: PersonalDataReportResultAccount[];
  cyclePeriodDays: number | null;
}

export interface SimplifiedIssue {
  key: string;
  id?: string;
  webUrl?: string;
  summary?: string;
  issueType?: string;
  status?: string;
  parent?: {
    key?: string;
    summary?: string;
    issueType?: string;
  } | null;
  description: string;
  renderedDescription: string;
  comments: string[];
  subtasks: Array<{ key: string; summary?: string; status?: string }>;
  linkedIssues: Array<{ key: string; webUrl?: string; relation?: string; summary?: string; status?: string; issueType?: string }>;
  labels: string[];
  components: string[];
  priority?: string;
  assignee?: string;
  updatedAt?: string;
  createdAt?: string;
}

const ATLASSIAN_TIMEOUT_MS = Number(process.env.ATLASSIAN_TIMEOUT_MS) || 20000;

function requestJsonWithHeaders<T>(url: string, options: RequestOptions = {}, body?: unknown): Promise<{ body: T; headers: Record<string, string | string[] | undefined>; statusCode: number }> {
  return requestHttpsJson<T>({
    url,
    method: options.method || 'GET',
    headers: options.headers || {},
    body,
    upstream: 'Atlassian',
    timeoutMs: Number(process.env.ATLASSIAN_HTTP_TIMEOUT_MS || process.env.UPSTREAM_HTTP_TIMEOUT_MS || 20_000),
  }).then((response) => {
    if (response.statusCode >= 200 && response.statusCode < 300) return response;
    const errorBody = response.body as { error_description?: string; error?: string; errorMessage?: string };
    const error = new Error(errorBody.errorMessage || errorBody.error_description || errorBody.error || `HTTP ${response.statusCode}`) as Error & {
      statusCode?: number;
    };
    error.statusCode = response.statusCode;
    throw error;
  });
}

function requestJson<T>(url: string, options: RequestOptions = {}, body?: unknown): Promise<T> {
  return requestJsonWithHeaders<T>(url, options, body).then((response) => response.body);
}

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_API_BASE = 'https://api.atlassian.com';

function normalizeSiteUrl(siteUrl?: string | null): string {
  return String(siteUrl || '').trim().replace(/\/$/, '');
}

function buildJiraIssueWebUrl(siteUrl: string | null | undefined, issueKey?: string): string {
  const base = normalizeSiteUrl(siteUrl);
  if (!base || !issueKey) return '';
  return `${base}/browse/${issueKey}`;
}

function buildConfluenceWebUrl(siteUrl: string | null | undefined, webUi?: string | null): string | null {
  const raw = String(webUi || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = normalizeSiteUrl(siteUrl);
  if (!base) return raw;
  return `${base}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

export function buildAuthUrl(config: AtlassianAuthConfig, state: string): string {
  const url = new URL(ATLASSIAN_AUTH_URL);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function exchangeCode(config: AtlassianAuthConfig, code: string): Promise<AtlassianTokenResponse> {
  return requestJson<AtlassianTokenResponse>(
    ATLASSIAN_TOKEN_URL,
    { method: 'POST' },
    {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }
  );
}

export async function refreshAccessToken(config: AtlassianAuthConfig, refreshToken: string): Promise<AtlassianTokenResponse> {
  return requestJson<AtlassianTokenResponse>(
    ATLASSIAN_TOKEN_URL,
    { method: 'POST' },
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }
  );
}

export async function getAccessibleResources(accessToken: string): Promise<AccessibleResource[]> {
  return requestJson<AccessibleResource[]>(`${ATLASSIAN_API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function getCurrentUserProfile(accessToken: string): Promise<AtlassianCurrentUserProfile> {
  const body = await requestJson<Record<string, unknown>>(`${ATLASSIAN_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return {
    accountId: String(body.account_id || ''),
    displayName: String(body.name || body.nickname || body.email || body.account_id || ''),
    email: typeof body.email === 'string' ? body.email : undefined,
  };
}

export async function reportPersonalData(accessToken: string, accounts: PersonalDataReportRequestAccount[]): Promise<PersonalDataReportResponse> {
  const response = await requestJsonWithHeaders<{ accounts?: Array<{ accountId?: string; status?: string }> }>(
    `${ATLASSIAN_API_BASE}/app/report-accounts/`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    { accounts }
  );

  const cycleHeader = response.headers['cycle-period'];
  const cycleValue = Array.isArray(cycleHeader) ? cycleHeader[0] : cycleHeader;
  const parsedCycleDays = Number.parseInt(String(cycleValue || ''), 10);
  const cyclePeriodDays = Number.isFinite(parsedCycleDays) && parsedCycleDays > 0 ? parsedCycleDays : null;

  const resultAccounts = accounts.map((input) => {
    const matched = Array.isArray(response.body.accounts)
      ? response.body.accounts.find((candidate) => String(candidate.accountId || '') === input.accountId)
      : null;
    const rawStatus = String(matched?.status || '').toLowerCase();
    const status: 'ok' | 'closed' | 'updated' =
      rawStatus === 'closed' ? 'closed' : rawStatus === 'updated' ? 'updated' : 'ok';
    return { accountId: input.accountId, status };
  });

  return {
    accounts: resultAccounts,
    cyclePeriodDays,
  };
}

export function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return extractText(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join('');
  }
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const type = String(record.type || '');
  const content = Array.isArray(record.content) ? record.content : [];
  const text = record.text ? String(record.text) : '';
  const joinedContent = content.map((item) => extractText(item)).join('');

  switch (type) {
    case 'text':
      return text;
    case 'hardBreak':
      return '\n';
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
    case 'panel':
      return `${joinedContent}\n`;
    case 'listItem':
      return joinedContent.trim();
    case 'orderedList':
      return content
        .map((item, index) => {
          const itemText = extractText(item).trim();
          return itemText ? `${index + 1}. ${itemText}\n` : '';
        })
        .join('');
    case 'bulletList':
      return content
        .map((item) => {
          const itemText = extractText(item).trim();
          return itemText ? `- ${itemText}\n` : '';
        })
        .join('');
    case 'doc':
      return `${joinedContent}`;
    default: {
      const parts: string[] = [];
      if (text) parts.push(text);
      if (joinedContent) parts.push(joinedContent);
      if (record.value) parts.push(extractText(record.value));
      return parts.join('');
    }
  }
}

export function extractPageId(url: string): string | null {
  const match = String(url || '').match(/pages\/(\d+)|pageId=(\d+)/);
  return match ? match[1] || match[2] : null;
}

export class AtlassianClient {
  private accessToken: string;
  private cloudId: string;
  private resources: AccessibleResource[];
  private expiresAt: number | null;
  private selectedResource: AccessibleResource | null;
  private logger?: Logger;
  private readonly refreshSession?: () => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number | null;
    cloudId: string;
    resources: AccessibleResource[];
    selectedResource?: AccessibleResource | null;
  }>;

  constructor({
    accessToken,
    cloudId,
    resources = [],
    expiresAt = null,
    selectedResource = null,
    refreshSession,
    logger,
  }: {
    accessToken: string;
    cloudId: string;
    resources?: AccessibleResource[];
    expiresAt?: number | null;
    selectedResource?: AccessibleResource | null;
    refreshSession?: () => Promise<{
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number | null;
      cloudId: string;
      resources: AccessibleResource[];
      selectedResource?: AccessibleResource | null;
    }>;
    logger?: Logger;
  }) {
    this.accessToken = accessToken;
    this.cloudId = cloudId;
    this.resources = resources;
    this.expiresAt = expiresAt;
    this.selectedResource = selectedResource;
    this.refreshSession = refreshSession;
    this.logger = logger;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  private jiraUrl(requestPath: string): string {
    return `${ATLASSIAN_API_BASE}/ex/jira/${this.cloudId}/rest/api/3${requestPath}`;
  }

  private confluenceUrl(requestPath: string): string {
    return `${ATLASSIAN_API_BASE}/ex/confluence/${this.cloudId}/wiki/api/v2${requestPath}`;
  }

  private confluenceUrlFor(cloudId: string, requestPath: string): string {
    return `${ATLASSIAN_API_BASE}/ex/confluence/${cloudId}/wiki/api/v2${requestPath}`;
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.refreshSession || !this.expiresAt) return;
    if (Date.now() < this.expiresAt - 60_000) return;
    await this.refreshAuthState();
  }

  private async refreshAuthState(): Promise<void> {
    if (!this.refreshSession) return;
    const refreshed = await this.refreshSession();
    this.accessToken = refreshed.accessToken;
    this.cloudId = refreshed.cloudId;
    this.resources = refreshed.resources || [];
    this.expiresAt = refreshed.expiresAt || null;
    this.selectedResource = refreshed.selectedResource || null;
    if (this.selectedResource?.id) this.cloudId = this.selectedResource.id;
  }

  private async requestWithRefresh<T>(request: () => Promise<T>): Promise<T> {
    await this.ensureFreshToken();
    try {
      return await request();
    } catch (error) {
      const typedError = error as Error & { statusCode?: number };
      if (typedError.statusCode === 401 && this.refreshSession) {
        this.logger?.warn('atlassian.request.unauthorized_refresh_retry', {
          errorMessage: typedError.message,
        });
        await this.refreshAuthState();
        return request();
      }
      throw error;
    }
  }

  async getIssue(issueKey: string): Promise<SimplifiedIssue> {
    const fields = [
      'summary',
      'description',
      'issuetype',
      'status',
      'parent',
      'subtasks',
      'issuelinks',
      'comment',
      'project',
      'labels',
      'components',
      'priority',
      'assignee',
      'reporter',
    ].join(',');
    const issue = await this.requestWithRefresh(() =>
      requestJson<Record<string, unknown>>(this.jiraUrl(`/issue/${encodeURIComponent(issueKey)}?fields=${fields}&expand=renderedFields`), {
        headers: this.headers(),
      })
    );
    return simplifyIssue(issue, this.selectedResource?.url || null);
  }

  async searchIssues(jql: string, maxResults = 10): Promise<SimplifiedIssue[]> {
    const fields = ['summary', 'issuetype', 'status', 'assignee', 'created', 'updated'];
    const result = await this.requestWithRefresh(() =>
      requestJson<Record<string, any>>(
        this.jiraUrl('/search/jql'),
        {
          method: 'POST',
          headers: this.headers(),
        },
        {
          jql,
          fields,
          maxResults: Math.max(1, Math.min(maxResults, 50)),
          fieldsByKeys: false,
        }
      )
    );
    return Array.isArray(result.issues) ? result.issues.map((issue) => simplifyIssue(issue, this.selectedResource?.url || null)) : [];
  }

  async getRemoteLinks(issueKey: string): Promise<Array<Record<string, unknown>>> {
    return this.requestWithRefresh(() =>
      requestJson<Array<Record<string, unknown>>>(this.jiraUrl(`/issue/${encodeURIComponent(issueKey)}/remotelink`), {
        headers: this.headers(),
      })
    );
  }

  async getConfluencePage(pageId: string): Promise<{ id: string; title?: string; status?: string; webUrl?: string | null; body: string; adf?: unknown }> {
    const tried = new Set<string>();
    const candidates = [this.cloudId, ...this.resources.map((resource) => resource.id)].filter((id) => {
      if (!id || tried.has(id)) return false;
      tried.add(id);
      return true;
    });

    let lastError: Error | null = null;
    for (const candidateCloudId of candidates) {
      try {
        const page = await this.requestWithRefresh(() =>
          requestJson<Record<string, any>>(this.confluenceUrlFor(candidateCloudId, `/pages/${pageId}?body-format=atlas_doc_format`), {
            headers: this.headers(),
          })
        );
        if (candidateCloudId !== this.cloudId) {
          this.logger?.info('atlassian.confluence.resource_fallback_success', {
            pageId,
            previousCloudId: this.cloudId,
            resolvedCloudId: candidateCloudId,
          });
          this.cloudId = candidateCloudId;
          this.selectedResource = this.resources.find((resource) => resource.id === candidateCloudId) || this.selectedResource;
        }
        const adfValue = page.body && page.body.atlas_doc_format && page.body.atlas_doc_format.value;
        let adf: unknown = null;
        if (typeof adfValue === 'string') {
          try {
            adf = JSON.parse(adfValue);
          } catch {
            adf = null;
          }
        } else if (adfValue && typeof adfValue === 'object') {
          adf = adfValue;
        }
        return {
          id: String(page.id),
          title: page.title,
          status: page.status,
          webUrl: buildConfluenceWebUrl(this.selectedResource?.url || null, page._links && page._links.webui ? page._links.webui : null),
          body: extractText(adfValue),
          adf,
        };
      } catch (error) {
        lastError = error as Error;
        this.logger?.warn('atlassian.confluence.resource_attempt_failed', {
          pageId,
          attemptedCloudId: candidateCloudId,
          errorMessage: lastError.message,
        });
      }
    }

    throw lastError || new Error('Unable to resolve a Confluence resource for the requested page.');
  }

  async getConfluenceComments(pageId: string): Promise<Array<{ id: string; body: string }>> {
    try {
      const comments = await this.requestWithRefresh(() =>
        requestJson<Record<string, any>>(this.confluenceUrl(`/pages/${pageId}/footer-comments?limit=50`), {
          headers: this.headers(),
        })
      );
      return (comments.results || []).map((comment: Record<string, any>) => ({
        id: String(comment.id),
        body: extractText(comment.body && comment.body.atlas_doc_format && comment.body.atlas_doc_format.value),
      }));
    } catch {
      return [];
    }
  }
}

function simplifyIssue(issue: Record<string, any>, siteUrl?: string | null): SimplifiedIssue {
  const fields = issue.fields || {};
  const descriptionText = extractText(fields.description);
  const renderedDescription = (issue.renderedFields && issue.renderedFields.description) || '';
  const linkedIssues = (fields.issuelinks || []).map((link: Record<string, any>) => {
    const linked = link.inwardIssue || link.outwardIssue || {};
    return {
      key: linked.key,
      webUrl: buildJiraIssueWebUrl(siteUrl, linked.key),
      relation: link.inwardIssue ? link.type && link.type.inward : link.type && link.type.outward,
      summary: linked.fields && linked.fields.summary,
      status: linked.fields && linked.fields.status && linked.fields.status.name,
      issueType: linked.fields && linked.fields.issuetype && linked.fields.issuetype.name,
    };
  });

  return {
    key: issue.key,
    id: issue.id,
    webUrl: buildJiraIssueWebUrl(siteUrl, issue.key) || issue.self,
    summary: fields.summary,
    issueType: fields.issuetype && fields.issuetype.name,
    status: fields.status && fields.status.name,
    parent: fields.parent
      ? {
          key: fields.parent.key,
          summary: fields.parent.fields && fields.parent.fields.summary,
          issueType: fields.parent.fields && fields.parent.fields.issuetype && fields.parent.fields.issuetype.name,
        }
      : null,
    description: descriptionText || renderedDescription,
    renderedDescription,
    comments: fields.comment && fields.comment.comments ? fields.comment.comments.map((comment: Record<string, unknown>) => extractText(comment.body)) : [],
    subtasks: (fields.subtasks || []).map((subtask: Record<string, any>) => ({
      key: subtask.key,
      summary: subtask.fields && subtask.fields.summary,
      status: subtask.fields && subtask.fields.status && subtask.fields.status.name,
    })),
    linkedIssues,
    labels: fields.labels || [],
    components: (fields.components || []).map((component: Record<string, string>) => component.name),
    priority: fields.priority && fields.priority.name,
    assignee: fields.assignee && fields.assignee.displayName,
    updatedAt: fields.updated || undefined,
    createdAt: fields.created || undefined,
  };
}
