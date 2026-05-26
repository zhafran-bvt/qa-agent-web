import test from 'node:test';
import assert from 'node:assert/strict';
import { AtlassianClient } from '../../src/server/services/atlassian';

test('AtlassianClient retries Confluence page fetch across accessible resources', async () => {
  const client = new AtlassianClient({
    accessToken: 'test-token',
    cloudId: 'jira-cloud',
    resources: [
      { id: 'jira-cloud', url: 'https://bvarta-project.atlassian.net' },
      { id: 'confluence-cloud', url: 'https://bvarta-project.atlassian.net' },
    ],
  });

  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  const https = await import('node:https');
  const originalRequest = https.default.request;

  (https.default as any).request = ((options: any, callback: any) => {
    const path = `${options.hostname}${options.path}`;
    requests.push(path);

    const handlers: Record<string, Function> = {};
    const response = {
      statusCode: path.includes('/ex/confluence/jira-cloud/') ? 401 : 200,
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
    };

    queueMicrotask(() => {
      callback(response);
      if (response.statusCode === 401) {
        handlers.data?.(Buffer.from(JSON.stringify({ error: 'HTTP 401' })));
      } else {
        handlers.data?.(
          Buffer.from(
            JSON.stringify({
              id: '1228177422',
              title: 'PRD Page',
              body: { atlas_doc_format: { value: { type: 'doc', content: [] } } },
              _links: { webui: '/wiki/spaces/ORB/pages/1228177422' },
            })
          )
        );
      }
      handlers.end?.();
    });

    return {
      on() {
        return this;
      },
      write() {
        return this;
      },
      end() {
        return this;
      },
    };
  }) as any;

  try {
    const page = await client.getConfluencePage('1228177422');
    assert.equal(page.id, '1228177422');
    assert.equal(requests.some((entry) => entry.includes('/ex/confluence/jira-cloud/')), true);
    assert.equal(requests.some((entry) => entry.includes('/ex/confluence/confluence-cloud/')), true);
  } finally {
    (https.default as any).request = originalRequest;
    globalThis.fetch = originalFetch;
  }
});
