import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttachmentMultipart,
  buildGetCasesPath,
  buildGetCasesUrl,
  hasExactJiraRef,
  normalizeRefTokens,
  sanitizeAttachmentName,
} from '../../src/server/services/testrail';

test('normalizes TestRail refs into exact Jira tokens', () => {
  assert.deepEqual(normalizeRefTokens('ORB-123, orb-456 / AC-1; ORB-789'), ['ORB-123', 'ORB-456', 'AC-1', 'ORB-789']);
});

test('matches Jira refs exactly without substring false positives', () => {
  assert.equal(hasExactJiraRef('ORB-123, ORB-456', 'ORB-123'), true);
  assert.equal(hasExactJiraRef('ORB-1234, ORB-456', 'ORB-123'), false);
});

test('builds TestRail get_cases lookup with project, section, and refs filter', () => {
  assert.equal(
    buildGetCasesUrl(
      {
        baseUrl: 'https://example.testrail.io/',
        user: 'qa@example.test',
        apiKey: 'secret',
        projectId: '42',
      },
      '42',
      '69',
      'ORB-123'
    ),
    'https://example.testrail.io/index.php?/api/v2/get_cases/42&section_id=69&refs=ORB-123'
  );
});

test('get_cases URL and the rate-limited trFetch path share one source of truth', () => {
  // findExistingCasesByJiraRef now routes through trFetch(path) for rate-limiting; the path must be the
  // exact api/v2-relative suffix of the full URL, or the duplicate lookup would hit a different URL.
  const config = { baseUrl: 'https://example.testrail.io/', user: 'qa@example.test', apiKey: 'secret', projectId: '42' };
  const url = buildGetCasesUrl(config, '42', '69', 'ORB-123');
  const path = buildGetCasesPath('42', '69', 'ORB-123');
  assert.equal(url, `https://example.testrail.io/index.php?/api/v2/${path}`);
});

test('sanitizeAttachmentName strips header-unsafe chars and path separators', () => {
  assert.equal(sanitizeAttachmentName('shot.png'), 'shot.png');
  assert.equal(sanitizeAttachmentName('a"b\r\nc.png'), 'abc.png');
  assert.equal(sanitizeAttachmentName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeAttachmentName(''), 'evidence');
});

test('buildAttachmentMultipart produces a valid multipart body with the file bytes and boundary', () => {
  const data = Buffer.from('PNGBYTES');
  const { body, contentType } = buildAttachmentMultipart({ buffer: data, filename: 'evidence.png', contentType: 'image/png' });
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  assert.ok(boundaryMatch, 'content type carries a boundary');
  const boundary = boundaryMatch![1];
  const text = body.toString('utf8');
  assert.match(text, new RegExp(`^--${boundary}\\r\\n`));
  assert.match(text, /Content-Disposition: form-data; name="attachment"; filename="evidence\.png"/);
  assert.match(text, /Content-Type: image\/png/);
  assert.ok(text.includes('PNGBYTES'), 'file bytes are embedded');
  assert.match(text, new RegExp(`\\r\\n--${boundary}--\\r\\n$`));
});
