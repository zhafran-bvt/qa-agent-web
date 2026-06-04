import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

const repoRoot = '/Users/bvt-zhafran/Downloads/qa-agent-web';
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

let serverProcess: ChildProcessWithoutNullStreams | null = null;
let serverPort = 0;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to resolve free port.'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for test server startup.');
}

test.before(async () => {
  serverPort = await getFreePort();
  serverProcess = spawn(tsxBin, ['src/server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      QA_AGENT_PORT: String(serverPort),
      QA_AGENT_BASE_URL: `http://127.0.0.1:${serverPort}`,
      ATLASSIAN_CLIENT_ID: '',
      ATLASSIAN_CLIENT_SECRET: '',
      DATABASE_URL: '',
      LOG_LEVEL: 'error',
      PRIVACY_REPORTING_ENABLED: 'false',
    },
    stdio: 'pipe',
  });
  await waitForServer(serverPort);
});

test.after(async () => {
  if (!serverProcess) return;
  serverProcess.kill('SIGTERM');
  await new Promise((resolve) => serverProcess?.once('exit', resolve));
});

test('auth start route reports missing OAuth config cleanly', async () => {
  const response = await fetch(`http://127.0.0.1:${serverPort}/auth/atlassian`);
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, 'Atlassian OAuth is not configured.');
});

test('authenticated API routes reject unauthenticated access', async () => {
  const [historyResponse, pushResponse, suggestionsResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${serverPort}/api/history/runs`),
    fetch(`http://127.0.0.1:${serverPort}/api/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    fetch(`http://127.0.0.1:${serverPort}/api/suggestions/tickets`),
  ]);

  for (const response of [historyResponse, pushResponse, suggestionsResponse]) {
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error, 'Atlassian login required.');
  }
});
