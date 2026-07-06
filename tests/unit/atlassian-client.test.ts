import test from 'node:test';
import assert from 'node:assert/strict';
import { AtlassianClient, getCurrentUserProfile, reportPersonalData } from '../../src/server/services/atlassian';

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
              _links: { webui: '/spaces/ORB/pages/1228177422' },
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
    assert.equal(page.webUrl, 'https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/1228177422');
    assert.equal(requests.some((entry) => entry.includes('/ex/confluence/jira-cloud/')), true);
    assert.equal(requests.some((entry) => entry.includes('/ex/confluence/confluence-cloud/')), true);
  } finally {
    (https.default as any).request = originalRequest;
    globalThis.fetch = originalFetch;
  }
});

test('BUG-08: Confluence web URL is not double-prefixed when webui already includes /wiki', async () => {
  const client = new AtlassianClient({
    accessToken: 'test-token',
    cloudId: 'confluence-cloud',
    resources: [{ id: 'confluence-cloud', url: 'https://bvarta-project.atlassian.net' }],
    selectedResource: { id: 'confluence-cloud', url: 'https://bvarta-project.atlassian.net' },
  });

  const https = await import('node:https');
  const originalRequest = https.default.request;

  (https.default as any).request = ((options: any, callback: any) => {
    const handlers: Record<string, Function> = {};
    const response = {
      statusCode: 200,
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
    };

    queueMicrotask(() => {
      callback(response);
      handlers.data?.(
        Buffer.from(
          JSON.stringify({
            id: '999',
            title: 'Spec Page',
            body: { atlas_doc_format: { value: { type: 'doc', content: [] } } },
            _links: { webui: '/wiki/spaces/ORB/pages/999' },
          })
        )
      );
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
    const page = await client.getConfluencePage('999');
    assert.equal(page.webUrl, 'https://bvarta-project.atlassian.net/wiki/spaces/ORB/pages/999');
  } finally {
    (https.default as any).request = originalRequest;
  }
});

test('getCurrentUserProfile reads Atlassian /me response', async () => {
  const https = await import('node:https');
  const originalRequest = https.default.request;

  (https.default as any).request = ((options: any, callback: any) => {
    const handlers: Record<string, Function> = {};
    const response = {
      statusCode: 200,
      headers: {},
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
    };
    queueMicrotask(() => {
      callback(response);
      handlers.data?.(
        Buffer.from(
          JSON.stringify({
            account_id: 'acct-123',
            name: 'QA User',
            email: 'qa@example.com',
          })
        )
      );
      handlers.end?.();
    });
    return { on() { return this; }, write() { return this; }, end() { return this; } };
  }) as any;

  try {
    const profile = await getCurrentUserProfile('token');
    assert.deepEqual(profile, {
      accountId: 'acct-123',
      displayName: 'QA User',
      email: 'qa@example.com',
    });
  } finally {
    (https.default as any).request = originalRequest;
  }
});

test('reportPersonalData maps statuses and cycle-period header', async () => {
  const https = await import('node:https');
  const originalRequest = https.default.request;

  (https.default as any).request = ((options: any, callback: any) => {
    const handlers: Record<string, Function> = {};
    const response = {
      statusCode: 200,
      headers: { 'cycle-period': '9' },
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
    };
    queueMicrotask(() => {
      callback(response);
      handlers.data?.(
        Buffer.from(
          JSON.stringify({
            accounts: [{ accountId: 'acct-2', status: 'updated' }],
          })
        )
      );
      handlers.end?.();
    });
    return { on() { return this; }, write() { return this; }, end() { return this; } };
  }) as any;

  try {
    const report = await reportPersonalData('token', [
      { accountId: 'acct-1', updatedAt: '2026-06-01T00:00:00.000Z' },
      { accountId: 'acct-2', updatedAt: '2026-06-01T00:00:00.000Z' },
    ]);
    assert.equal(report.cyclePeriodDays, 9);
    assert.deepEqual(report.accounts, [
      { accountId: 'acct-1', status: 'ok' },
      { accountId: 'acct-2', status: 'updated' },
    ]);
  } finally {
    (https.default as any).request = originalRequest;
  }
});
