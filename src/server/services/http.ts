import https from 'node:https';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';

export class UpstreamTimeoutError extends Error {
  statusCode = 504;

  constructor(
    public readonly upstream: string,
    public readonly timeoutMs: number
  ) {
    super(`${upstream} request timed out after ${timeoutMs}ms`);
    this.name = 'UpstreamTimeoutError';
  }
}

/**
 * Turn a low-level socket error (ETIMEDOUT, ECONNRESET, …) into a human-readable, upstream-named
 * message. These happen when the connection drops before any response arrives, so there is no
 * provider error body to surface — we explain the network condition instead of leaking "read ETIMEDOUT".
 */
export function describeNetworkError(error: unknown, upstream: string): Error {
  const code = (error as { code?: string })?.code || '';
  const raw = error instanceof Error ? error.message : String(error);
  const byCode: Record<string, string> = {
    ETIMEDOUT: `${upstream} did not respond in time (connection timed out). Please try again.`,
    ECONNRESET: `${upstream} closed the connection unexpectedly (reset). Please try again.`,
    ECONNREFUSED: `Could not connect to ${upstream} (connection refused).`,
    ENOTFOUND: `Could not resolve ${upstream} host (DNS lookup failed).`,
    EAI_AGAIN: `Temporary DNS failure reaching ${upstream}. Please try again.`,
    EPIPE: `${upstream} connection broke mid-request (broken pipe). Please try again.`,
  };
  const friendly = byCode[code] || (/timed out|etimedout/i.test(raw) ? `${upstream} did not respond in time. Please try again.` : '');
  const decorated = new Error(friendly || `${upstream} request failed: ${raw}`) as Error & { code?: string; cause?: unknown };
  if (code) decorated.code = code;
  decorated.cause = error;
  return decorated;
}

export async function requestHttpsJson<T>({
  url,
  method = 'GET',
  headers = {},
  body,
  upstream,
  timeoutMs = Number(process.env.UPSTREAM_HTTP_TIMEOUT_MS || 20_000),
}: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  upstream: string;
  timeoutMs?: number;
}): Promise<{ body: T; headers: Record<string, string | string[] | undefined>; statusCode: number }> {
  // Shared JSON transport for upstream APIs; callers decide whether non-2xx responses are errors.
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === undefined ? null : JSON.stringify(body);
    let settled = false;
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          let parsedBody: unknown = {};
          try {
            parsedBody = data ? JSON.parse(data) : {};
          } catch {
            reject(new Error(`Invalid JSON from ${upstream}: ${data.slice(0, 500)}`));
            return;
          }
          resolve({
            body: parsedBody as T,
            headers: res.headers,
            statusCode: res.statusCode || 500,
          });
        });
      }
    );
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(describeNetworkError(error, upstream));
    });
    if (typeof (req as { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => {
        if (settled) return;
        settled = true;
        // Reject directly: destroying the socket fires 'error', but that handler is guarded by the
        // now-true `settled` flag, so relying on it would leave the promise pending forever (a hung
        // request). Tear the socket down for cleanup and settle the promise here.
        req.destroy();
        reject(new UpstreamTimeoutError(upstream, timeoutMs));
      });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

export async function requestText({
  url,
  method = 'GET',
  headers = {},
  upstream,
  timeoutMs = Number(process.env.UPSTREAM_HTTP_TIMEOUT_MS || 20_000),
}: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  upstream: string;
  timeoutMs?: number;
}): Promise<{ body: string; headers: Record<string, string | string[] | undefined>; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    let settled = false;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { Accept: 'application/json,text/html,text/plain,*/*', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ body: data, headers: res.headers, statusCode: res.statusCode || 500 });
        });
      }
    );
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(describeNetworkError(error, upstream));
    });
    if (typeof (req as { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => {
        if (settled) return;
        settled = true;
        // Reject directly: destroying the socket fires 'error', but that handler is guarded by the
        // now-true `settled` flag, so relying on it would leave the promise pending forever (a hung
        // request). Tear the socket down for cleanup and settle the promise here.
        req.destroy();
        reject(new UpstreamTimeoutError(upstream, timeoutMs));
      });
    }
    req.end();
  });
}

/**
 * Streaming variant for binary upstream payloads (e.g. TestRail attachments). Resolves once the
 * response headers arrive; the caller pipes the stream to the client. Non-2xx responses still
 * resolve (the caller inspects statusCode and may read the body for an error message).
 */
export async function requestHttpsStream({
  url,
  method = 'GET',
  headers = {},
  upstream,
  timeoutMs = Number(process.env.UPSTREAM_HTTP_TIMEOUT_MS || 20_000),
}: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  upstream: string;
  timeoutMs?: number;
}): Promise<{ stream: IncomingMessage; statusCode: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    let settled = false;
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { Accept: '*/*', ...headers },
      },
      (res) => {
        if (settled) return;
        settled = true;
        resolve({ stream: res, statusCode: res.statusCode || 500, headers: res.headers });
      }
    );
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(describeNetworkError(error, upstream));
    });
    if (typeof (req as { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => {
        if (settled) return;
        settled = true;
        // Reject directly: destroying the socket fires 'error', but that handler is guarded by the
        // now-true `settled` flag, so relying on it would leave the promise pending forever (a hung
        // request). Tear the socket down for cleanup and settle the promise here.
        req.destroy();
        reject(new UpstreamTimeoutError(upstream, timeoutMs));
      });
    }
    req.end();
  });
}
