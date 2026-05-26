import https from 'node:https';

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
}

interface AccessibleResource {
  id: string;
  name?: string;
  url?: string;
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
  linkedIssues: Array<{ key: string; relation?: string; summary?: string; status?: string; issueType?: string }>;
  labels: string[];
  components: string[];
  priority?: string;
  assignee?: string;
}

function requestJson<T>(url: string, options: RequestOptions = {}, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsedBody: unknown = {};
          try {
            parsedBody = data ? JSON.parse(data) : {};
          } catch {
            reject(new Error(`Invalid JSON from ${url}: ${data.slice(0, 500)}`));
            return;
          }
          if ((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300) {
            resolve(parsedBody as T);
            return;
          }
          const errorBody = parsedBody as { error_description?: string; error?: string };
          reject(new Error(errorBody.error_description || errorBody.error || `HTTP ${res.statusCode}`));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_API_BASE = 'https://api.atlassian.com';

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

export async function getAccessibleResources(accessToken: string): Promise<AccessibleResource[]> {
  return requestJson<AccessibleResource[]>(`${ATLASSIAN_API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  if (record.text) parts.push(String(record.text));
  if (record.content) parts.push(extractText(record.content));
  if (record.value) parts.push(extractText(record.value));
  return parts.filter(Boolean).join('\n');
}

export function extractPageId(url: string): string | null {
  const match = String(url || '').match(/pages\/(\d+)|pageId=(\d+)/);
  return match ? match[1] || match[2] : null;
}

export class AtlassianClient {
  private accessToken: string;
  private cloudId: string;

  constructor({ accessToken, cloudId }: { accessToken: string; cloudId: string }) {
    this.accessToken = accessToken;
    this.cloudId = cloudId;
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
    const issue = await requestJson<Record<string, unknown>>(
      this.jiraUrl(`/issue/${encodeURIComponent(issueKey)}?fields=${fields}&expand=renderedFields`),
      { headers: this.headers() }
    );
    return simplifyIssue(issue);
  }

  async getRemoteLinks(issueKey: string): Promise<Array<Record<string, unknown>>> {
    return requestJson<Array<Record<string, unknown>>>(this.jiraUrl(`/issue/${encodeURIComponent(issueKey)}/remotelink`), {
      headers: this.headers(),
    });
  }

  async getConfluencePage(pageId: string): Promise<{ id: string; title?: string; status?: string; webUrl?: string | null; body: string }> {
    const page = await requestJson<Record<string, any>>(this.confluenceUrl(`/pages/${pageId}?body-format=atlas_doc_format`), {
      headers: this.headers(),
    });
    return {
      id: String(page.id),
      title: page.title,
      status: page.status,
      webUrl: page._links && page._links.webui ? page._links.webui : null,
      body: extractText(page.body && page.body.atlas_doc_format && page.body.atlas_doc_format.value),
    };
  }

  async getConfluenceComments(pageId: string): Promise<Array<{ id: string; body: string }>> {
    try {
      const comments = await requestJson<Record<string, any>>(this.confluenceUrl(`/pages/${pageId}/footer-comments?limit=50`), {
        headers: this.headers(),
      });
      return (comments.results || []).map((comment: Record<string, any>) => ({
        id: String(comment.id),
        body: extractText(comment.body && comment.body.atlas_doc_format && comment.body.atlas_doc_format.value),
      }));
    } catch {
      return [];
    }
  }
}

function simplifyIssue(issue: Record<string, any>): SimplifiedIssue {
  const fields = issue.fields || {};
  const descriptionText = extractText(fields.description);
  const renderedDescription = (issue.renderedFields && issue.renderedFields.description) || '';
  const linkedIssues = (fields.issuelinks || []).map((link: Record<string, any>) => {
    const linked = link.inwardIssue || link.outwardIssue || {};
    return {
      key: linked.key,
      relation: link.inwardIssue ? link.type && link.type.inward : link.type && link.type.outward,
      summary: linked.fields && linked.fields.summary,
      status: linked.fields && linked.fields.status && linked.fields.status.name,
      issueType: linked.fields && linked.fields.issuetype && linked.fields.issuetype.name,
    };
  });

  return {
    key: issue.key,
    id: issue.id,
    webUrl: issue.self,
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
  };
}
