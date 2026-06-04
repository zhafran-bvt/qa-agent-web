import https from 'node:https';

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
      reject(error);
    });
    if (typeof (req as { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => {
        if (settled) return;
        settled = true;
        req.destroy(new UpstreamTimeoutError(upstream, timeoutMs));
      });
    }
    if (payload) req.write(payload);
    req.end();
  });
}
