# TestRail Dashboard Migration Plan (features 1–4)

Re-home `testrail_daily_report`'s **dashboard + listing + management** features into
`qa-agent-web` (Node + React), one phase at a time. Reports/attachments (features 5–6)
are **out of scope** — they stay in the Python app (link-out) or are dropped.

## Why qa-agent-web is the base
It already owns the infrastructure the Python app lacks: Atlassian OAuth sessions,
Postgres, audit log, a TestRail client (`src/server/services/testrail.ts`), a React
component system, and i18n. We extend, not rebuild.

## Landing / main page (decided)
- **Generate stays the default landing.** On load the app shows today's generation
  workbench (`Analyze → Scope → Review → Approve`) unchanged.
- **TestRail is additive.** The sidebar gains a top-level area switch: *Generate* (default)
  and *TestRail*. Selecting *TestRail* swaps the main pane to the dashboard.
- **Overview Home is deferred to Phase D** — a combined landing (generate CTA + ticket
  input, QA-health strip, recent activity, entry into both areas) is built only once both
  areas exist, so the landing isn't redesigned twice.

## Decisions baked in (flag if any are wrong)
1. **Base = qa-agent-web**; Python app kept alive only until each feature cuts over.
2. **TestRail access = service account** (`config.testrail`), same creds as the existing
   push path — NOT the user's Atlassian token.
3. **Auth = existing OAuth session.** All new endpoints sit behind `requireSession`, so
   the dashboard is login-gated (closes the Python app's no-auth gap).
4. **Parity is mandatory.** Stat math mirrors `dashboard_stats.py` exactly; ported with
   unit tests.
5. **Status IDs** fetched from `get_statuses` (fallback to 1=Passed/2=Blocked/3=Untested/
   4=Retest/5=Failed) rather than hardcoded, so custom TestRail configs don't break.
6. **Reports (5–6) excluded.** If the rich HTML report is needed, link out to the Python
   app for now.

---

## Target architecture inside qa-agent-web

### Server (`src/server/`)
- `services/testrail.ts` — **extend** with read + management methods (reuse `authHeader`,
  `requestHttpsJson`, `config.testrail`). Add a small paginated GET helper.
- `services/testrail-stats.ts` — **new**: `statusDistribution()`, `passRate()`,
  `completionRate()`, `runStatistics()`, `planStatistics()` — direct port of
  `dashboard_stats.py`.
- `services/ttl-cache.ts` — **new**: tiny in-memory TTL+LRU cache (mirrors
  `app/services/cache.py`) to avoid hammering TestRail on dashboard fan-out.
- `index.ts` — **new routes** in `handleApi`, following the existing
  `if (req.method === ... && url.pathname === ...)` pattern; add new pathnames to the
  auth-gate list (currently `index.ts:314-319`).

### Shared (`src/shared/contracts.ts`)
- New types: `TrPlanSummary`, `TrPlanDetail`, `TrRunSummary`, `TrRunStats`,
  `TrStatusDistribution`, `TrCase`, and request/response envelopes per endpoint.

### Client (`src/client/`)
- `api.ts` — new fetch wrappers per endpoint.
- `App.tsx` — introduce a top-level `view: 'generate' | 'testrail'` state; sidebar gets
  two areas. The existing stepper stays under **Generate**; **TestRail** gets its own
  sub-nav (Plans / Runs / Manage).
- `components/dashboard/` — **new**: `DashboardView`, `PlanList`, `PlanDetail`,
  `RunBreakdown`, `StatusDonut`, `ManagePanel`.
- `i18n.ts` — new `dashboard` namespace (en + id, parity guard intact).

### Concurrency
Python fans out run-stats with a 2-worker pool. In Node use a bounded `Promise` pool
(limit ~4) for the per-run `get_tests` calls; never unbounded `Promise.all` over all runs.

---

## Endpoint map (new, all GET unless noted, all `requireSession`)

| Endpoint | Purpose | Python origin |
|---|---|---|
| `GET /api/testrail/plans?project_id&limit&offset` | Plan list + per-plan stats (cached) | `/api/dashboard/plans` |
| `GET /api/testrail/plans/:planId` | Plan detail + aggregated stats | `/api/dashboard/plan/{id}` |
| `GET /api/testrail/plans/:planId/runs` | Runs in a plan + per-run stats | `/api/dashboard/runs/{id}` |
| `GET /api/testrail/runs/:runId/tests` | Tests in a run (status, title, assignee, refs) | `/api/tests/{run_id}` |
| `GET /api/testrail/meta` | users + priorities + statuses maps (cached long) | `/api/users`, statuses |
| `POST /api/testrail/cache/clear` | Clear dashboard caches | `/api/*/cache/clear` |
| **Management (phase C)** | | |
| `POST /api/testrail/manage/case` | Create case (BDD) | `/api/manage/case` |
| `PUT /api/testrail/manage/case/:caseId` | Update case | `/api/manage/case/{id}` |
| `DELETE /api/testrail/manage/case/:caseId` | Delete case | `/api/manage/case/{id}` |
| `POST /api/testrail/manage/run` / `PUT` / `DELETE` | Run CRUD | `/api/manage/run*` |
| `POST /api/testrail/manage/plan` / `PUT` / `DELETE` | Plan CRUD | `/api/manage/plan*` |
| `POST /api/testrail/manage/run/:runId/add_cases` | Add cases to run | `/api/manage/run/{id}/add_cases` |
| `POST /api/testrail/manage/test/:testId/result` | Add test result | `/api/manage/test/{id}/result` |

Each management write supports a `dryRun` flag (mirrors the Python app) — preview without
committing.

---

## Phases (each = one PR, each ships behind the gate `npm run review:qa`)

### Phase A — Read foundation + Plan list (features 1, 2, part of 4)
**Goal:** logged-in users see a TestRail dashboard listing plans with pass-rate, completion,
and a status chip — data parity with the Python dashboard.

Server:
- Extend `testrail.ts`: `getProjects`, `getPlans(projectId, filters)`, `getPlan(planId)`,
  `getRunsForPlan(planId)`, `getTestsForRun(runId)`, `getUsers`, `getPriorities`,
  `getStatuses`, plus a paginated GET helper.
- New `testrail-stats.ts` (port of `dashboard_stats.py`) + `ttl-cache.ts`.
- Routes: `/api/testrail/plans`, `/api/testrail/plans/:planId`,
  `/api/testrail/plans/:planId/runs`, `/api/testrail/meta`, `/api/testrail/cache/clear`.
- Contracts for all of the above.

Client:
- `view` switch in `App.tsx` + sidebar "TestRail" area.
- `DashboardView` + `PlanList` (table: plan, runs, tests, pass-rate bar, status chips).
- `api.ts` wrappers; `dashboard` i18n namespace.

Tests:
- `testrail-stats.test.ts` — parity unit tests for `statusDistribution / passRate /
  completionRate / runStatistics / planStatistics` using fixtures mirroring the Python
  docstring examples (incl. zero-division, unknown status, string status_id coercion).
- Client test: `PlanList` renders rates/chips from a mock response.

Gate: typecheck, server+client tests, build. Manual: dashboard lists real plans.

### Phase B — Plan/run drill-down (rest of feature 4, read side)
**Goal:** click a plan → see its runs and per-run status breakdown with a donut chart.

Client:
- `PlanDetail` (plan header + run list), `RunBreakdown` (per-run table of tests:
  title, status badge, assignee, refs→Jira link), `StatusDonut` (SVG, no chart dep —
  matches the moodboard style).
- Filters: status filter + search (reuse Review panel's filter patterns).

Server: reuse Phase A endpoints; add `/api/testrail/runs/:runId/tests` if not already.

Tests: donut math + RunBreakdown render; assignee/priority name resolution via `meta`.

### Phase C — Management CRUD + consolidate push (feature 3)
**Goal:** create/update/delete plan/run/case from the UI, add cases to runs, post results —
and route the **Generate flow's push through the same case-create path** (one write path).

Server:
- Extend `testrail.ts` with write methods (`add_case` already exists — generalize it;
  add `update_case`, `delete_case`, plan/run CRUD, `add_cases_to_run`, `add_result`).
- `/api/testrail/manage/*` routes with `dryRun` support.
- Refactor: existing `pushCases` (`testrail.ts:139`) becomes a thin caller over the new
  `createCase` so generate-push and manual-create share one implementation + telemetry.

Client:
- `ManagePanel` (forms for case/run/plan CRUD; reuse `BddEditor` for case BDD).
- Wire "add generated cases to an existing run" into the post-push step.

Tests: management request builders (payload shape parity, incl. `custom_testrail_bdd_scenario`),
dryRun returns preview without calling TestRail.

### Phase D — Overview Home + cutover + cleanup
- **Build the Overview Home** as the new default landing (generate CTA + ticket input,
  QA-health strip from Phase A/B stats, recent activity from `history`, entry cards into
  both areas). Generate and TestRail become areas reached from Home.
- Put the Python app behind the same proxy/host (temporary) OR retire its dashboard once
  Phases A–C reach parity; keep Python only for reports if still wanted.
- Parity sign-off: compare numbers for a known plan between old dashboard and new.
- Remove dead Python dashboard routes / the vanilla-TS dashboard UI if fully retired.
- Docs: update README with the unified TestRail dashboard.

---

## Risks & mitigations
- **Stat drift vs Python** → port with fixture-based parity tests (Phase A) before any UI.
- **TestRail rate limits on fan-out** → bounded concurrency + TTL cache + `cache/clear`.
- **Custom TestRail status/priority IDs** → fetch maps from `get_statuses`/`get_priorities`
  instead of hardcoding.
- **Lost robustness** (pagination, mixed payload shapes, retry/backoff) → port the Python
  client's pagination + the existing `requestHttpsJson` retry behavior; add the
  `parseCasesResponse`-style tolerant parsers for plans/runs/tests.
- **UX regression from new top-level view** → keep Generate as the default view; TestRail
  is additive.

## Out of scope (explicit)
- Report HTML generation, NDJSON streaming, Jinja2 templates.
- Attachment download/compress/embed, ffmpeg video transcoding.
- The `AUTOMATION_*` orbis-test-automation git/cypress wiring.

## First concrete step
Phase A, scoped to a single PR: `testrail-stats.ts` + parity tests, the read methods in
`testrail.ts`, the `/api/testrail/plans*` + `/meta` routes, and a minimal `PlanList`
behind a new "TestRail" sidebar view.
