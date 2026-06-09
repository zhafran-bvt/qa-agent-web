import type { ApiContractEndpoint, ApiContractSummary, QaContext, QaScopeType, ResolvedQaScopeType } from '../../shared/contracts';
import { requestText } from './http';
import { TtlCache, mapWithConcurrency } from './ttl-cache';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const ENDPOINT_PATTERN = /\b(GET|POST|PUT|PATCH|DELETE)\s+((?:https?:\/\/[^\s"'`<>]+)?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%{}-]+)/gi;

function normalizePath(path: string): string {
  const raw = String(path || '').trim().replace(/[),.;]+$/, '');
  try {
    const parsed = raw.startsWith('http') ? new URL(raw) : null;
    return parsed ? parsed.pathname : raw.split(/[?#]/)[0];
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

function normalizeMethod(method: string): string {
  return String(method || '').trim().toUpperCase();
}

export function extractEndpointMentions(text: string, source: ApiContractEndpoint['source']): ApiContractEndpoint[] {
  const seen = new Set<string>();
  const endpoints: ApiContractEndpoint[] = [];
  for (const match of String(text || '').matchAll(ENDPOINT_PATTERN)) {
    const method = normalizeMethod(match[1]);
    const path = normalizePath(match[2]);
    if (!path || !HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ method, path, source });
  }
  return endpoints;
}

export function resolveScopeType(input: {
  requestedScopeType?: QaScopeType;
  feOnly?: boolean;
  title?: string;
  text?: string;
  labels?: string[];
}): ResolvedQaScopeType {
  if (input.requestedScopeType === 'web' || input.requestedScopeType === 'api') {
    return input.requestedScopeType;
  }
  // The Jira label is authoritative: tickets are tagged `frontend` or `backend`.
  const labels = (input.labels || []).map((label) => label.toLowerCase().trim());
  if (labels.includes('backend')) return 'api';
  if (labels.includes('frontend')) return 'web';
  const haystack = `${input.title || ''}\n${input.text || ''}\n${(input.labels || []).join(' ')}`.toLowerCase();
  if (/\[(be|backend)\]/i.test(input.title || '') || /\b(post|put|get|patch|delete)\s+\/v\d+\//i.test(haystack) || /\b(api|endpoint|schema|proto|bff|migration|backfill|dataset_schema|sql|db)\b/i.test(haystack)) {
    return 'api';
  }
  if (/\[(fe|web|frontend)\]/i.test(input.title || '') || input.feOnly !== false) return 'web';
  return 'web';
}

function contextSearchText(context: QaContext): string {
  return [
    context.mainIssue.summary,
    context.mainIssue.description,
    context.mainIssue.renderedDescription,
    ...(context.mainIssue.comments || []),
    ...context.linkedIssues.map((issue) => `${issue.key} ${issue.summary || ''}`),
    ...context.confluencePages.map((page) => `${page.title || ''}\n${page.body || ''}`),
    context.scopeConfluenceSection?.body || '',
    context.scopeAuthority?.body || '',
    ...context.acceptanceCriteria.map((criterion) => criterion.text),
  ]
    .filter(Boolean)
    .join('\n');
}

// Strong signals that a backend ticket changes the HTTP API contract. Deliberately specific so a
// passing mention of "endpoint" or a "dataset_schema" field (e.g. an internal data-backfill ticket)
// does NOT match — only request/response contract phrasing or explicit HTTP verbs count.
const API_CONTRACT_KEYWORDS =
  /\b(request|response)\s*(body|payload|schema)\b|\bpayload\b|\brest\s+api\b|\bopenapi\b|\bswagger\b|\bapi\s+contract\b|\b(query|path)\s+param(eter)?s?\b|\bstatus\s+code\b|\bhttp\s+(get|post|put|patch|delete)\b/i;

// Decide whether a backend ticket should use the API docs as reference. API-contract work (endpoint
// references or contract keywords) does; internal backend work (migration, backfill, DB schema,
// inference jobs) does not — so we skip the docs crawl and steer generation to manual DB cases.
export function assessApiContractRelevance(context: QaContext): { relevant: boolean; reason: string } {
  const text = contextSearchText(context);
  const endpoints = extractEndpointMentions(text, 'jira');
  if (endpoints.length > 0) {
    return { relevant: true, reason: `Ticket references ${endpoints.length} HTTP endpoint(s); using API docs as reference.` };
  }
  if (API_CONTRACT_KEYWORDS.test(text)) {
    return { relevant: true, reason: 'Ticket describes API request/response contract details; using API docs as reference.' };
  }
  return {
    relevant: false,
    reason: 'No HTTP endpoint references or API-contract keywords found; treated as internal backend work (API docs not used).',
  };
}

function uniqueEndpoints(endpoints: ApiContractEndpoint[]): ApiContractEndpoint[] {
  const byKey = new Map<string, ApiContractEndpoint>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (!byKey.has(key)) byKey.set(key, endpoint);
  }
  return [...byKey.values()];
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function openApiEndpoints(value: unknown): ApiContractEndpoint[] {
  if (!value || typeof value !== 'object') return [];
  const paths = (value as Record<string, unknown>).paths;
  if (!paths || typeof paths !== 'object') return [];
  const endpoints: ApiContractEndpoint[] = [];
  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as Record<string, unknown>)[method.toLowerCase()];
      if (!operation || typeof operation !== 'object') continue;
      const record = operation as Record<string, unknown>;
      endpoints.push({
        method,
        path,
        source: 'api_docs',
        summary: String(record.summary || record.operationId || '').trim() || undefined,
        documentationExcerpt: JSON.stringify(operation).slice(0, 1200),
      });
    }
  }
  return endpoints;
}

function pathMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const normalizeTemplate = (value: string) => value.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}');
  return normalizeTemplate(left) === normalizeTemplate(right);
}

function matchDocs(ticketEndpoints: ApiContractEndpoint[], docsEndpoints: ApiContractEndpoint[]): ApiContractEndpoint[] {
  const matches: ApiContractEndpoint[] = [];
  for (const endpoint of ticketEndpoints) {
    const doc = docsEndpoints.find((candidate) => candidate.method === endpoint.method && pathMatches(candidate.path, endpoint.path));
    matches.push(doc ? { ...endpoint, source: 'api_docs', summary: doc.summary, documentationExcerpt: doc.documentationExcerpt } : endpoint);
  }
  return uniqueEndpoints(matches);
}

function docsTimeoutMs(): number {
  return Number(process.env.API_DOCS_HTTP_TIMEOUT_MS || process.env.UPSTREAM_HTTP_TIMEOUT_MS || 12_000);
}

interface DocPortalPage {
  title?: string;
  path?: string;
}

interface DocPortalGroup {
  id?: string;
  title?: string;
  pages?: DocPortalPage[];
  subgroups?: DocPortalGroup[];
}

interface DocPortalConfig {
  groups?: DocPortalGroup[];
}

// Only these doc-portal groups document the current REST services we generate tests against.
// Everything else (Protocol Buffers/gRPC, Targetin, the huge deprecated Legacy tree) is excluded
// so we don't waste fetches or false-match against dead endpoints. Override via API_DOCS_GROUPS.
function allowedGroupFragments(): string[] {
  return (process.env.API_DOCS_GROUPS || 'analytics apis,internal bff apis')
    .split(',')
    .map((fragment) => fragment.trim().toLowerCase())
    .filter(Boolean);
}

function isGroupAllowed(group: DocPortalGroup, fragments: string[]): boolean {
  const haystack = `${group.title || ''} ${group.id || ''}`.toLowerCase();
  return fragments.some((fragment) => haystack.includes(fragment));
}

// Walk the doc-portal `doc_config.json` tree and collect REST page paths from allowed groups only.
export function collectDocPagePaths(config: DocPortalConfig, fragments: string[] = allowedGroupFragments()): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const walk = (group: DocPortalGroup, allowedAncestor: boolean) => {
    const allowed = allowedAncestor || isGroupAllowed(group, fragments);
    if (allowed) {
      for (const page of group.pages || []) {
        if (page.path && !seen.has(page.path)) {
          seen.add(page.path);
          paths.push(page.path);
        }
      }
    }
    for (const subgroup of group.subgroups || []) walk(subgroup, allowed);
  };
  for (const group of config.groups || []) walk(group, false);
  return paths;
}

// Cache the full crawled endpoint index per docs base URL; the portal is large (dozens of pages),
// so re-crawling on every analysis would be wasteful.
const docPortalCache = new TtlCache<ApiContractEndpoint[]>(Number(process.env.API_DOCS_CACHE_TTL_MS || 30 * 60 * 1000), 16);

// Crawl a doc portal that lists its pages in `doc_config.json` (e.g. dev.lokasi.com/api-docs/),
// fetching each REST page and extracting endpoint mentions.
async function crawlDocPortal(baseUrl: string): Promise<ApiContractEndpoint[]> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const cached = docPortalCache.get(base);
  if (cached) return cached;
  let configResponse;
  try {
    configResponse = await requestText({ url: new URL('doc_config.json', base).toString(), upstream: 'API docs', timeoutMs: docsTimeoutMs() });
  } catch {
    return [];
  }
  if (configResponse.statusCode < 200 || configResponse.statusCode >= 300) return [];
  const config = tryParseJson(configResponse.body) as DocPortalConfig | null;
  if (!config || !Array.isArray(config.groups)) return [];
  const paths = collectDocPagePaths(config);
  if (!paths.length) return [];
  const concurrency = Number(process.env.API_DOCS_CRAWL_CONCURRENCY || 6);
  const perPage = await mapWithConcurrency(paths, concurrency, async (path) => {
    try {
      const response = await requestText({ url: new URL(path, base).toString(), upstream: 'API docs', timeoutMs: docsTimeoutMs() });
      if (response.statusCode < 200 || response.statusCode >= 300) return [] as ApiContractEndpoint[];
      return extractEndpointMentions(response.body.replace(/<[^>]+>/g, ' '), 'api_docs');
    } catch {
      return [] as ApiContractEndpoint[];
    }
  });
  const endpoints = uniqueEndpoints(perPage.flat());
  if (endpoints.length) docPortalCache.set(base, endpoints);
  return endpoints;
}

async function fetchApiDocs(url: string): Promise<ApiContractEndpoint[]> {
  const candidates = [
    url,
    new URL('openapi.json', url.endsWith('/') ? url : `${url}/`).toString(),
    new URL('swagger.json', url.endsWith('/') ? url : `${url}/`).toString(),
  ];
  for (const candidate of candidates) {
    try {
      const response = await requestText({
        url: candidate,
        upstream: 'API docs',
        timeoutMs: docsTimeoutMs(),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) continue;
      const parsed = tryParseJson(response.body);
      if (parsed) {
        const endpoints = openApiEndpoints(parsed);
        if (endpoints.length) return endpoints;
      }
      const endpoints = extractEndpointMentions(response.body.replace(/<[^>]+>/g, ' '), 'api_docs');
      if (endpoints.length) return endpoints;
    } catch {
      // Try the next well-known docs URL.
    }
  }
  // No single-document spec; fall back to crawling a `doc_config.json`-driven doc portal.
  return crawlDocPortal(url);
}

export async function buildApiContract(context: QaContext, apiDocsUrl: string): Promise<ApiContractSummary | undefined> {
  const sourceUrl = String(apiDocsUrl || '').trim();
  if (!sourceUrl) return undefined;
  const warnings: string[] = [];
  const ticketEndpoints = uniqueEndpoints([
    ...extractEndpointMentions(contextSearchText(context), 'jira'),
  ]);
  if (!ticketEndpoints.length) {
    warnings.push('No API endpoint mentions were found in Jira or Confluence scope.');
  }
  let docsEndpoints: ApiContractEndpoint[] = [];
  try {
    docsEndpoints = await fetchApiDocs(sourceUrl);
  } catch (error) {
    warnings.push(`API docs could not be fetched: ${(error as Error).message}`);
  }
  if (!docsEndpoints.length) {
    warnings.push('API docs were unavailable or did not expose parseable endpoints; Jira and Confluence remain the source of truth.');
  }
  const matchedEndpoints = docsEndpoints.length ? matchDocs(ticketEndpoints, docsEndpoints) : ticketEndpoints;
  return { sourceUrl, matchedEndpoints, warnings };
}
