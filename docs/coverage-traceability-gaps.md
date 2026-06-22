# Coverage & Traceability Gaps — Remediation Plan

**Status:** proposed — awaiting approval before any code is written.
**Source:** external review of agent output for **ORB-3205** vs a manual pass over the same Jira ticket + PRD.
**Branch plan:** implement on a fresh branch off `main` (the coverage-hang fix stays on its own branch). One commit per phase.
**Date:** 2026-06-19

---

## 1. Findings — all verified against the code at `main`

Every claim in the source report was checked against the actual source before writing this plan. All five hold.

| # | Gap | Severity | Effort | Verified location |
|---|-----|----------|--------|-------------------|
| **F1** | No cross-source conflict detection (Jira AC vs PRD vs spec) | High | Med | only post-synth guard is `dropOutOfScopeLoginCriteria` — `acceptance-criteria.ts:722,835` |
| **F2** | Coverage gate measures *mapping*, not behavioral *polarity* | High | **Low** | `caseIntent` populated in `llm.ts:582`; **zero** refs in `validation.ts` |
| **F3** | Evidence excerpts are lexical (token F1), not semantic | Medium | High | `scoreExcerptCandidate` + `weakFallback` — `acceptance-criteria.ts:430,621` |
| **M1** | Title-prefix convention: spec doc vs validator disagree | Low | Low | validator enforces `[FE]`/`[BE]` — `validation.ts:178-186` |
| **M2** | Stale PRD URL slug in evidence (page id correct, links resolve) | Low | Low | Confluence fetch path |

## 2. Guiding principles (carried from prior work this session)

- **Flag, don't block.** New diagnostics reuse the existing *acknowledge-to-override* path (`weakCoverage` soft-signal → push-gate flag → client ack + `window.confirm`), not a hard block. A Jira AC that contradicts the PRD is often the AC *intentionally* superseding a stale PRD — that's a human-adjudication signal, not an error.
- **Deterministic first.** Each fix lands a deterministic baseline before any LLM augmentation, so behavior is predictable and testable at temperature 0.
- **No false-green.** The coverage number must never signal safety it can't back up. F2 is prioritized for exactly this reason.
- **Preserve the scaffold.** Formal traceability (`coversAcceptanceCriteria`, `sourceScope`, evidence block, coverage matrix) and flag-on/flag-off pairing are working well — do not disturb them.

## 3. The reusable mechanism (already in the codebase)

A soft, overrideable diagnostic flows like this today for `weakCoverage` (unsubstantiated claims). New signals follow the same five touch-points:

1. **`buildCoverage`** (`validation.ts:310`) returns the new array.
2. **Server preflight** (`index.ts:~1390`) surfaces it; **push gate** (`index.ts:~1492`) optionally requires `body.<flag>Acknowledged`.
3. **Client** (`App.tsx`): ack state + `window.confirm` on preflight + `coverageComplete` logic.
4. **ReviewPanel / ApprovalPanel**: render the warning line + gate row.
5. **i18n** (`i18n.ts`): en + id strings.

---

## Phase 1 — F2: polarity-aware coverage  *(P1 · smallest · start here)*

**Why first:** highest leverage, lowest risk, uses data already present. `caseIntent` (`positive|negative|edge`) is populated on every case but `buildCoverage` never reads it, so "button disabled when radius=0" and "button enabled when radius valid" are indistinguishable to the gate — green coverage hides a missing happy path.

**Change (additive, `buildCoverage` stays sync):**
- In the coverage loop (`validation.ts:331-349`), record per AC entry the **set of `caseIntent` values** among its covering cases (alongside `coveredBy`).
- Classify each AC as **conditional** when its text matches a small lexicon: `when / if / unless / only / disabled / enabled / missing / empty / invalid / 0 / zero`.
- For conditional ACs, require **both** a `positive` and a `negative` covering case. Otherwise add to a new **`singlePolarityCriteria`** array on the return.
- Surface `singlePolarityCriteria` as a **soft, overrideable** signal via the §3 mechanism — *not* a hard block (some ACs are genuinely one-directional).

**Files:** `validation.ts` (logic + return type), `index.ts` (preflight surface + push ack flag `singlePolarityAcknowledged`), `App.tsx` (ack state + confirm), `ReviewPanel.tsx` / `ApprovalPanel.tsx` (render), `i18n.ts` (en+id), `shared/contracts.ts` (coverage type).

**Tests:** extend `tests/unit/validation.test.ts` — conditional AC with only a negative case → flagged; with both polarities → clean; non-conditional AC → never flagged.

**Acceptance:** re-running ORB-3205 flags AC-4 / AC-5 (missing "enabled with valid radius" cases) as `singlePolarityCriteria`. Coverage no longer reads a clean 7/7.

---

## Phase 2 — F1: cross-source conflict scan  *(P1 · more plumbing)*

**Why:** contradictory requirements (ORB-3205 AC7 "Save not disabled at radius=0" vs PRD "zero rejected") pass silently into generation. The contradiction is exactly what a human should adjudicate with dev.

**Change (deterministic baseline + optional LLM):**
- New post-synthesis function in `acceptance-criteria.ts`, sibling to `dropOutOfScopeLoginCriteria` (`:722`), run inside the already-async `finalizeAcceptanceCriteria` (`:742`) which already holds all three corpora: `mainIssue.description`, `prdSectionBody`, and `collectTechnicalSpecExcerpts(context)` (`:750`).
- Pair each synthesized AC against candidate lines from the *other* corpora; flag pairs that **share subject tokens but carry opposite-polarity verbs** (disabled/enabled, rejected/allowed, not-X/X) using a small polarity lexicon.
- Produce a **`crossSourceConflicts`** diagnostic (flag, never remove). **Plumbing note:** conflicts arise at synthesis time but the soft-signal UI surfaces at preflight/push — carry the array on the AC result / `QaContext` and echo it into the preflight + push responses.
- *Optional augmentation:* an LLM yes/no pass over only the flagged pairs raises recall for semantic contradictions that don't reduce to antonyms. Deterministic baseline ships first.

**Files:** `acceptance-criteria.ts` (scan + lexicon + log `context.ac_cross_source_conflicts`), `keywords.ts` (polarity lexicon — centralized), `contracts.ts` (`crossSourceConflicts` on context/result), `index.ts` (surface + ack), `App.tsx` / `ReviewPanel.tsx` / `i18n.ts`.

**Tests:** new `acceptance-criteria.test.ts` cases — opposite-polarity pair across Jira/PRD → flagged; same-polarity restatement → not flagged; the login-guard path still works.

**Acceptance:** re-running ORB-3205 flags AC7 ↔ PRD "zero rejected" as a `crossSourceConflict` for review.

---

## Phase 3 — F3: semantic evidence relevance  *(P2 · standalone)*

**Why:** `scoreExcerptCandidate` ranks by token-overlap F1, which rewards *topic* overlap and can't separate "section displayed **in config UI**" from "section displays info **on story detail**". TC-1's misattributed evidence was attached at `"closest"`, not `"weak"`.

**Two distinct moves — do not conflate:**
- **Stopgap (trivial, but limited):** drop the `weakFallback` branch (`acceptance-criteria.ts:621-627`) so a criterion with no clean match shows **no** excerpt instead of a near-miss. ⚠️ **This does NOT fix the reported symptom** — TC-1 cleared the *real* score gate on topic overlap; `weakFallback` is a separate lower tier. Removes some noise only.
- **Real fix (the actual remedy):** gate every would-be `"closest"` excerpt through one cheap LLM yes/no — *"does this line state the same requirement as the criterion?"* — keep only on yes.
  - **Structural cost (why this is High effort):** `attachSourceExcerpts` (`:510`) is currently **synchronous** and takes no `LlmConfig`. The real fix makes it **async**, threads `LlmConfig` in, and runs the per-excerpt calls **concurrency-limited** (`mapWithConcurrency` from `ttl-cache`). It adds latency + token cost to every generation, so gate it behind a flag (e.g. `EXCERPT_RELEVANCE_LLM=1`) with the deterministic scorer as fallback.

**Decision needed:** stopgap only, real fix, or both. Recommendation: ship the stopgap with F2/F1, schedule the real fix as its own change once F2/F1 are validated.

---

## Phase 4 — Housekeeping  *(P3)*

- **M1 (decision, not a bug):** the agent is *consistent with the validator* (`[FE]`/`[BE]`, `validation.ts:178`); the spec doc (`[Web][{Epic}][Ticket ID]`) is the outlier. **You decide which is canonical**, then update whichever is stale. No code change until that call is made.
- **M2 (quick check):** confirm the Confluence fetch isn't retaining a draft page title in the URL slug. Page id is correct so links resolve — low urgency.

---

## Open decisions for you

1. **Phase scope/sequence:** approve F2 → F1 → F3 in that order? (Recommended — F2 alone already kills the false-green.)
2. **Soft-signal behavior:** new diagnostics *overrideable-block* (like `weakCoverage`) vs *warning-only* (no gate)? (Recommended: overrideable-block, consistent with BUG-04.)
3. **F3 depth:** stopgap only / real LLM fix / both? (Recommended: stopgap now, real fix scheduled separately.)
4. **M1 canonical convention:** `[FE]`/`[BE]` (keep validator, fix the doc) vs `[Web][{Epic}][Ticket ID]` (change validator + cases)?

---

## Checklist

### Phase 1 — F2 polarity coverage ✅ (code complete, awaiting live e2e)
- [x] `buildCoverage` records per-AC intent set + conditional classification + `singlePolarityCriteria`
- [x] `contracts.ts` coverage type updated (`CoverageSummary`, `PushRequest`, preflight response)
- [x] server preflight surfaces `singlePolarity`; push gate honors `singlePolarityAcknowledged`
- [x] client ack state + `window.confirm` (mirrors weakCoverage; persists through duplicate-review path)
- [x] ReviewPanel renders the warning line; i18n en+id
- [x] unit tests (flagged / both-polarity / non-conditional / uncovered-gap)
- [ ] verify against ORB-3205 (AC-4/AC-5 flagged) — needs a live analyze→generate run
- [x] gate: typecheck ✓ + 187 server + 27 client tests ✓ + build ✓

### Phase 2 — F1 conflict scan ✅ (deterministic baseline; LLM pass deferred)
- [x] post-synthesis deterministic polarity scan (`detectCrossSourceConflicts`) in `finalizeAcceptanceCriteria`
- [x] polarity lexicon (`POLARITY_AXES` + `NEGATION_CUES`) centralized in `keywords.ts`
- [x] `crossSourceConflicts` on context diagnostics → carried into push payload; push gate + ReviewPanel surface + ack
- [ ] (optional) LLM verification over flagged pairs — **deferred** (baseline favors precision; LLM is the recall booster)
- [x] unit tests (opposite-polarity / same-polarity / no-shared-subject / cross-axis)
- [ ] verify against ORB-3205 (AC7 ↔ PRD flagged) live — unit test mirrors it; live run needs analyze→generate
- [x] gate: typecheck ✓ + 191 server + 27 client tests ✓ + build ✓

### Phase 3 — F3 evidence relevance
- [ ] stopgap: drop `weakFallback` branch
- [ ] (real fix) `attachSourceExcerpts` → async + `LlmConfig` + concurrency-limited LLM yes/no, behind a flag
- [ ] unit tests
- [ ] gate: typecheck + tests + build

### Phase 4 — housekeeping
- [ ] M1: canonical convention decided + stale side updated
- [ ] M2: Confluence slug source confirmed
