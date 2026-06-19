// Centralized keyword/regex vocabularies.
//
// These lists were previously duplicated across context-builder.ts (and drifting between copies):
// every time a ticket used a new phrasing, the fix had to be applied in several places or it silently
// failed in some. Keeping the vocabulary in one place — and building the regexes from it — makes a
// new phrasing a one-line change that applies everywhere.

// Heading words that introduce an acceptance-criteria-like block ("Acceptance Criteria:",
// "Requirements", "Expected Result", ...). Order is preserved so the generated alternation is
// byte-identical to the historical inline regexes.
export const AC_HEADING_WORDS = [
  'acceptance criteria',
  'acceptance',
  'ac',
  'requirements',
  'requirement',
  'expected result',
  'expected behavior',
  'behaviour',
  'behavior',
  'rules',
] as const;

export const AC_HEADING_ALTERNATION = AC_HEADING_WORDS.join('|');

// Regexes derived from the canonical heading list. Build them once and reuse rather than re-typing
// the alternation at each call site.
/** Matches a line that is exactly an AC heading, e.g. "Acceptance Criteria:" or "Rules". */
export const AC_HEADING_LINE_RE = new RegExp(`^(${AC_HEADING_ALTERNATION})[:]?$`, 'i');
/** Matches an AC heading with inline content after it: "Acceptance Criteria: 1) ... 2) ...". */
export const AC_HEADING_INLINE_RE = new RegExp(`^((?:${AC_HEADING_ALTERNATION})[:]?)(\\s+.+)$`, 'i');
/** Matches an AC heading on its own line anywhere within a block of text. */
export const AC_HEADING_BLOCK_RE = new RegExp(`(?:^|\\n)\\s*(${AC_HEADING_ALTERNATION})\\s*:?\\s*(?:\\n|$)`, 'i');

// Verbs/nouns that signal an endpoint/data-operation. Backend tickets often express scope as
// operation bullets ("Get dataset list", "Reset password") rather than should/must sentences, so this
// list lets the criterion extractor recognize them under API scope. Each entry is a raw regex
// fragment (note "\\bapi\\b" is boundary-anchored to avoid matching words like "capital").
export const API_SCOPE_VERB_FRAGMENTS = [
  'get', 'post', 'put', 'patch', 'delete', 'retrieve', 'fetch', 'list', 'submit', 'send', 'create',
  'read', 'update', 'upsert', 'remove', 'validate', 'validation', 'verify', 'verification',
  'authenticate', 'authorize', 'authorization', 'login', 'logout', 'reset', 'forgot', 'activation',
  'register', 'endpoint', '\\bapi\\b', 'request', 'response', 'schema', 'dataset', 'export', 'import',
  'stream', 'migration', 'backfill', 'database', 'access', 'permission', 'password', 'token',
] as const;

/** Matches text that mentions any endpoint/data-operation verb (case-insensitive substring). */
export const API_SCOPE_VERB_RE = new RegExp(`(${API_SCOPE_VERB_FRAGMENTS.join('|')})`, 'i');

// Confluence page titles that denote a technical specification / design doc. Shared by the AC
// spec-grounding (acceptance-criteria.ts) and the descendant-page expansion (context-builder.ts) so
// the two can't drift on what counts as a "spec" page.
export const SPEC_PAGE_TITLE_RE =
  /\b(technical spec|tech spec|technical design|tech design|engineering design|solution design|specification|design doc|rfc)\b/i;

// Polarity axes for cross-source conflict detection (F1). A conflict is flagged when a synthesized
// acceptance criterion and a line from a source corpus describe the SAME subject but resolve to
// OPPOSITE signs on the SAME axis — e.g. "Save button is NOT disabled when radius=0" (permission +)
// vs PRD "zero radius values are rejected" (permission -). A nearby negation cue flips a term's sign.
// The "permission" axis is deliberately broad (enable / allow / accept / valid all collapse to "the
// action proceeds") so the common UI-gate-vs-validation contradiction is caught lexically, without an
// LLM. Recall for subtler semantic contradictions is the job of the optional LLM pass, not this list.
export const POLARITY_AXES = [
  {
    axis: 'permission',
    positive: ['enabled', 'enable', 'allowed', 'allow', 'accepted', 'accept', 'permitted', 'permit', 'valid', 'active', 'succeeds', 'succeed', 'passes'],
    negative: ['disabled', 'disable', 'rejected', 'reject', 'denied', 'deny', 'blocked', 'block', 'invalid', 'prevented', 'prevent', 'inactive', 'fails', 'fail'],
  },
  {
    axis: 'visibility',
    positive: ['visible', 'shown', 'show', 'shows', 'displayed', 'display', 'displays', 'appears', 'appear', 'present'],
    negative: ['hidden', 'hide', 'hides', 'removed', 'remove', 'absent', 'invisible'],
  },
  {
    axis: 'requirement',
    positive: ['required', 'mandatory'],
    negative: ['optional'],
  },
] as const;

// Negation cues that flip the sign of a nearby polarity term ("not disabled" → permission positive).
export const NEGATION_CUES = new Set([
  'not', 'no', 'never', "n't", 'cannot', "can't", 'without', "isn't", "aren't", "won't", "doesn't", "don't", "shouldn't",
]);
