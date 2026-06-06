# Functional Design — QA Agent (Node/React) ↔ TestRail Reporter (Python), both kept

**Decision:** keep `testrail_daily_report` (Python) as the canonical TestRail **reporting +
dashboard**. `qa-agent-web` is the **authoring + action** tool. Two apps, one product,
**no duplicated surface** — they hand off via deep links and shared TestRail config.

## Guiding principle
Each capability has exactly one owner. If Python already does it well (browsing
plans/runs/tests, offline HTML reports, attachments), qa-agent-web **links to it** rather
than re-implementing it.

## Responsibility split
| Capability | Owner | Why |
|---|---|---|
| Generate BDD cases from Jira/Confluence scope | **qa-agent-web** | unique to it |
| Validate + push cases to TestRail | **qa-agent-web** | unique |
| Create/update case, create run, **add cases to a run** | **qa-agent-web** (Manage) | the actionable bridge after generation |
| Lightweight **health glance** (project pass-rate, failed/blocked, recent activity) | **qa-agent-web** Home | operational context where you author |
| Full dashboard: browse plans → runs → per-test results, filtering | **Python** | already mature; canonical |
| Offline **HTML reports** (donut, embedded/compressed attachments, video transcode) | **Python** | unique + hard; never rebuild in Node |
| Report generation / scheduling | **Python** | unique |

## Net change to the current A–D build
- **Keep:** Home (hero quick-start + health glance + recent activity), Manage (create case /
  create run / add-to-run), the unified push→createCase path, and `/api/testrail/summary`.
- **Reposition (remove duplication):** the in-app deep browser
  (`PlanDetail → RunBreakdown → per-test table`) is what overlaps Python. Replace "drill into
  a plan" with **"Open in TestRail Reporter"** deep links. Keep at most a *compact* plan list
  as a launchpad (see open question).
- This deletes the part of Phase B that re-implements Python's dashboard, while keeping the
  genuinely complementary pieces.

## Cross-app integration
- **Shared config:** both already use the same `TESTRAIL_BASE_URL/USER/API_KEY` and the same
  project/section defaults — confirmed. No change.
- **New env:**
  - `TESTRAIL_REPORTER_URL` in qa-agent-web → base URL of the Python app.
  - `QA_AGENT_URL` in Python → base URL of qa-agent-web.
- **Deep links (open in new tab, no shared session needed):**
  - qa-agent-web → Python: "Open full report / dashboard" →
    `${TESTRAIL_REPORTER_URL}/?project={pid}&plan={planId}` *(needs a small preselect-from-query
    addition in the Python SPA).*
  - Python → qa-agent-web: on any case/run that carries a Jira ref, "Generate / refresh cases"
    → `${QA_AGENT_URL}/?ticket={JIRA-KEY}` *(needs Home quick-start to accept a `ticket` query
    param and auto-run analyze).*
- **Auth:** each app keeps its own model for now — qa-agent-web stays Atlassian-OAuth gated;
  Python stays network-internal. Cross-links just open the other app. (Unifying auth is a
  separate, later decision.)

## Primary user journeys
1. **Author → execute → report:** Home quick-start a ticket → generate → review → push →
   *Add to run* (Manage) → *Open report in Reporter* to watch execution results.
2. **Monitor → fix:** in the Reporter dashboard a tester sees failing cases → clicks the Jira
   ref → lands in qa-agent-web pre-loaded to regenerate/expand that ticket's cases.

## Open question (drives how much of Phase B we keep)
How much TestRail browsing should stay *inside* qa-agent-web vs. link out to the Reporter?
- **A — Launchpad (recommended):** keep the compact plan list as a status glance; each row
  **deep-links to the Reporter**; drop the in-app run/test drill-down. No duplication, still a
  useful jump-off from where you authored.
- **B — Status-only:** remove the in-app plan browser entirely; Home health glance + one
  "Open TestRail Reporter" button; keep Manage. Most minimal, zero overlap.
- **C — Keep full in-app dashboard too:** accept two dashboards (offline/standalone use) and
  the parity-maintenance cost.
