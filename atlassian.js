const https = require('https');

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_API_BASE = 'https://api.atlassian.com';

function requestJson(url, options = {}, body) {
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
          let parsedBody = {};
          try {
            parsedBody = data ? JSON.parse(data) : {};
          } catch (error) {
            reject(new Error(`Invalid JSON from ${url}: ${data.slice(0, 500)}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsedBody);
            return;
          }
          reject(new Error(parsedBody.error_description || parsedBody.error || `HTTP ${res.statusCode}`));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function buildAuthUrl(config, state) {
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

async function exchangeCode(config, code) {
  return requestJson(
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

async function getAccessibleResources(accessToken) {
  return requestJson(`${ATLASSIAN_API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);

  const parts = [];
  if (value.text) parts.push(value.text);
  if (value.content) parts.push(extractText(value.content));
  if (value.value) parts.push(extractText(value.value));
  return parts.filter(Boolean).join('\n');
}

function extractPageId(url) {
  const match = String(url || '').match(/pages\/(\d+)|pageId=(\d+)/);
  return match ? match[1] || match[2] : null;
}

class AtlassianClient {
  constructor({ accessToken, cloudId }) {
    this.accessToken = accessToken;
    this.cloudId = cloudId;
  }

  headers() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  jiraUrl(path) {
    return `${ATLASSIAN_API_BASE}/ex/jira/${this.cloudId}/rest/api/3${path}`;
  }

  confluenceUrl(path) {
    return `${ATLASSIAN_API_BASE}/ex/confluence/${this.cloudId}/wiki/api/v2${path}`;
  }

  async getIssue(issueKey) {
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
    const issue = await requestJson(this.jiraUrl(`/issue/${encodeURIComponent(issueKey)}?fields=${fields}&expand=renderedFields`), {
      headers: this.headers(),
    });
    return simplifyIssue(issue);
  }

  async getRemoteLinks(issueKey) {
    return requestJson(this.jiraUrl(`/issue/${encodeURIComponent(issueKey)}/remotelink`), {
      headers: this.headers(),
    });
  }

  async getConfluencePage(pageId) {
    const page = await requestJson(this.confluenceUrl(`/pages/${pageId}?body-format=atlas_doc_format`), {
      headers: this.headers(),
    });
    return {
      id: page.id,
      title: page.title,
      status: page.status,
      webUrl: page._links && page._links.webui ? page._links.webui : null,
      body: extractText(page.body && page.body.atlas_doc_format && page.body.atlas_doc_format.value),
    };
  }

  async getConfluenceComments(pageId) {
    try {
      const comments = await requestJson(this.confluenceUrl(`/pages/${pageId}/footer-comments?limit=50`), {
        headers: this.headers(),
      });
      return (comments.results || []).map((comment) => ({
        id: comment.id,
        body: extractText(comment.body && comment.body.atlas_doc_format && comment.body.atlas_doc_format.value),
      }));
    } catch (error) {
      return [];
    }
  }
}

function simplifyIssue(issue) {
  const fields = issue.fields || {};
  const descriptionText = extractText(fields.description);
  const renderedDescription = (issue.renderedFields && issue.renderedFields.description) || '';
  const linkedIssues = (fields.issuelinks || []).map((link) => {
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
    comments: fields.comment && fields.comment.comments ? fields.comment.comments.map((comment) => extractText(comment.body)) : [],
    subtasks: (fields.subtasks || []).map((subtask) => ({
      key: subtask.key,
      summary: subtask.fields && subtask.fields.summary,
      status: subtask.fields && subtask.fields.status && subtask.fields.status.name,
    })),
    linkedIssues,
    labels: fields.labels || [],
    components: (fields.components || []).map((component) => component.name),
    priority: fields.priority && fields.priority.name,
    assignee: fields.assignee && fields.assignee.displayName,
  };
}

module.exports = {
  AtlassianClient,
  buildAuthUrl,
  exchangeCode,
  getAccessibleResources,
  extractPageId,
};
