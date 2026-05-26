import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersistence } from '../../src/server/services/persistence';
import { logger } from '../../src/server/services/logger';

test('file-backed persistence appends audit log when DATABASE_URL is absent', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-agent-web-'));
  const auditFile = path.join(tempDir, 'audit-log.jsonl');
  const persistence = createPersistence({
    databaseUrl: '',
    auditFile,
    logger,
  });

  await persistence.initialize();
  await persistence.appendAudit({ type: 'analyze', jiraKey: 'ORB-1', user: 'tester' });

  const content = await fs.readFile(auditFile, 'utf8');
  assert.match(content, /"type":"analyze"/);
  assert.equal(persistence.isDatabaseBacked(), false);
});

test('file-backed persistence health ping reports fallback mode', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-agent-web-'));
  const auditFile = path.join(tempDir, 'audit-log.jsonl');
  const persistence = createPersistence({
    databaseUrl: '',
    auditFile,
    logger,
  });

  await persistence.initialize();
  const health = await persistence.ping();

  assert.deepEqual(health, {
    ok: true,
    database: false,
    mode: 'file+memory-fallback',
  });
});

test('file-backed persistence stores and consumes oauth state', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-agent-web-'));
  const auditFile = path.join(tempDir, 'audit-log.jsonl');
  const persistence = createPersistence({
    databaseUrl: '',
    auditFile,
    logger,
  });

  await persistence.initialize();
  await persistence.storeOAuthState('state-123', Date.now());

  assert.equal(await persistence.consumeOAuthState('state-123'), true);
  assert.equal(await persistence.consumeOAuthState('state-123'), false);
});
