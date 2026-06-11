import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AC_HEADING_ALTERNATION,
  AC_HEADING_BLOCK_RE,
  AC_HEADING_INLINE_RE,
  AC_HEADING_LINE_RE,
  API_SCOPE_VERB_RE,
} from '../../src/server/services/keywords';

// Guards the centralized vocabularies against silent drift. The alternation must stay byte-identical
// to the historical inline regexes that lived in context-builder.ts.
test('AC heading alternation matches the canonical historical list', () => {
  assert.equal(
    AC_HEADING_ALTERNATION,
    'acceptance criteria|acceptance|ac|requirements|requirement|expected result|expected behavior|behaviour|behavior|rules'
  );
});

test('AC_HEADING_LINE_RE matches standalone headings with optional colon', () => {
  for (const heading of ['Acceptance Criteria', 'acceptance criteria:', 'AC', 'Requirements', 'Expected Result:', 'Rules']) {
    assert.ok(AC_HEADING_LINE_RE.test(heading), `expected match: ${heading}`);
  }
  assert.equal(AC_HEADING_LINE_RE.test('Acceptance Criteria for the dataset flow'), false);
});

test('AC_HEADING_INLINE_RE splits a heading from inline content', () => {
  const match = 'Acceptance Criteria: 1) first 2) second'.match(AC_HEADING_INLINE_RE);
  assert.ok(match);
  assert.match(match![1], /Acceptance Criteria/i);
  assert.match(match![2], /1\) first/);
});

test('AC_HEADING_BLOCK_RE finds a heading on its own line within a block', () => {
  assert.ok(AC_HEADING_BLOCK_RE.test('Some intro\nRequirements\n- does a thing'));
  assert.equal(AC_HEADING_BLOCK_RE.test('Some intro that mentions requirements inline only'), false);
});

test('API_SCOPE_VERB_RE recognizes endpoint/data-operation phrasing but boundary-anchors "api"', () => {
  for (const text of ['Get dataset list', 'Submit analysis', 'Reset password', 'Export schema']) {
    assert.ok(API_SCOPE_VERB_RE.test(text), `expected match: ${text}`);
  }
  // "\\bapi\\b" must not fire on substrings like "capital".
  assert.equal(API_SCOPE_VERB_RE.test('capital allocation summary'), false);
  assert.ok(API_SCOPE_VERB_RE.test('the api returns a token'));
});
