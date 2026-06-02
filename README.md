# QA Agent Web App

Internal QA workflow app for turning Jira and Confluence implementation scope into reviewable BDD test cases, validating them against final acceptance criteria, and pushing approved output to TestRail.

## What this app does

`qa-agent-web` is not just a text-generation UI. It combines:

- Atlassian-authenticated Jira and Confluence retrieval
- scope resolution with deterministic source precedence
- LLM-assisted acceptance-criteria synthesis
- BDD test-case generation
- validation, evidence hydration, and AC coverage checking
- approval-gated TestRail push
- persisted workflow history and runtime diagnostics

The app is built to help QA review output they can trust, especially for messy tickets where requirements are split across a main Jira task, parent Story, and PRD subsection.

## Core capabilities

### 1. Scope analysis from Jira and Confluence

The app can analyze a Jira ticket and build a canonical QA context from:

- the main Jira issue
- linked issues
- the parent Story
- linked Confluence/PRD pages
- a scoped PRD subsection when the main ticket is weak

It supports scope toggles on each run:

- `FE-only scope`
- `BE already tested`
- `Include comments`
- freeform QA notes

### 2. Deterministic scope precedence

The source precedence is intentionally fixed:

1. `main_jira`
2. `parent_story_confluence_section`
3. `parent_story_jira`

This keeps the app from broadening scope casually just because nearby Story or PRD content exists.

### 3. Thin-ticket PRD fallback

When a Jira task is thin, empty, or weak, the app can fall back to the linked Story and rank PRD subsections using the task title and summary.

This is designed for tickets like:

- thin implementation tasks with most scope living in the PRD
- PRDs with several neighboring sections where only one matches the ticket

The app records whether thin-ticket fallback was used and whether the PRD subsection match was:

- `confident`
- `broad`
- `none`

### 4. Canonical acceptance-criteria synthesis

The app produces one final `context.acceptanceCriteria` set before generation starts.

That canonical AC set is then reused consistently by:

- generation
- evidence hydration
- validation
- coverage reporting
- push gating

This avoids the earlier failure mode where generation reasoned about one AC set and validation checked another.

### 5. Medium-granularity AC handling

The app does not just preserve raw bullet fragments. It can:

- discard duplicate or fragmentary AC
- synthesize testable AC from structured technical prose
- keep technical-design tickets at medium granularity
- repair over-merged AC when a synthesized criterion bundles multiple independently testable behaviors

Examples of behaviors it tries to keep separate when warranted:

- Run Analysis payload mapping
- Save Config payload mapping
- dataset linkage or `datasets[]` behavior
- UI preview or map-label behavior
- variant-specific PRD behavior such as no-score flows

### 6. BDD generation with provider fallback

The app generates typed BDD cases from the resolved QA context.

Provider behavior:

- tries OpenAI first
- falls back to DeepSeek only for quota, rate-limit, billing, token, or context-length failures

The app also normalizes and constrains generated output so it stays tied to the active Jira run.

### 7. Validation and AC coverage

Generated cases are validated against the canonical AC set.

Validation checks include:

- Jira reference consistency
- AC id mapping
- coverage against final acceptance criteria
- normalized traceability fields

The app shows:

- per-case validation errors and warnings
- coverage summary
- uncovered criteria
- traceability details

### 8. Evidence hydration

Each generated case includes evidence metadata that points back to:

- the scoped PRD section title
- the acceptance criteria it covers
- a coverage note

This gives reviewers a concrete reason why a case exists.

### 9. Regenerate diff review

If cases already exist and the user generates again, the app does not silently replace the current draft.

Instead it creates a candidate set and shows a regenerate diff so QA can compare:

- current case titles
- candidate case titles
- added, removed, changed, and unchanged rows

The current draft is only replaced if the reviewer chooses to accept the candidate.

### 10. Approval-gated TestRail push

The app blocks TestRail push until:

- test cases exist
- all cases pass validation
- AC coverage requirements are satisfied
- QA explicitly approves the set
- a TestRail section ID is present

BDD push behavior:

- uses `template_id: 4`
- sends BDD content through `custom_testrail_bdd_scenario`

### 11. Persisted workflow history

The app stores workflow runs so older output can be inspected later.

Persisted run types:

- `analysis`
- `generation`
- `push`

Stored history can include:

- Jira key
- user
- created timestamp
- provider/model
- generated cases
- validation and coverage
- push summary and push results

### 12. Runtime diagnostics and status surfaces

The app exposes runtime diagnostics through the `Status` utility modal and API.

Diagnostics include:

- Atlassian readiness
- LLM readiness
- TestRail readiness
- database readiness
- persistence mode
- migration version
- recent warn/error issues

### 13. Scope Snapshot translation

The Scope Snapshot panel supports `EN` and `ID`.

Important limitation:

- only the Scope Snapshot display is translated
- generated BDD content remains in English
- TestRail push content remains in English

### 14. Workflow help and utility UI

The app includes left-side utility triggers for:

- `How it works`
- `Status`

`How it works` includes:

- a workflow visualization
- step-by-step explanation of analysis, scope, generation, validation, and push

### 15. Toast notifications for global async feedback

The UI includes toast notifications for cross-panel events such as:

- analyze success/failure
- generate success/failure
- candidate-regeneration ready
- push success/failure
- config/history/translation/validation refresh failures

Validation details still remain inline in the review surface. Toasts are used only for global status feedback.

## Main QA workflow

1. Log in with Atlassian
2. Enter Jira ticket key and optional scope notes
3. Run `Analyze Jira + Confluence`
4. Review Scope Snapshot
5. Generate BDD cases
6. Review validation, traceability, and AC coverage
7. If needed, regenerate and compare candidate vs current draft
8. Approve the reviewed set
9. Enter TestRail section ID
10. Push to TestRail
11. Revisit older runs from Workflow History

## Scope Snapshot contents

The Scope Snapshot is the main trust surface before generation. It can show:

- ticket
- epic
- AC source
- confidence
- main summary
- parent story
- scoped PRD section
- confidence summary
- scope diagnostics
- user stories
- final acceptance criteria

Scope diagnostics can show:

- whether thin-ticket fallback was used
- PRD match quality
- matched PRD heading
- discarded noisy user-story fragment count

## API surface

Main runtime endpoints:

- `GET /api/config`
- `GET /api/healthz`
- `GET /api/diagnostics`
- `GET /api/history/runs`
- `GET /api/history/runs/:id`
- `POST /api/analyze`
- `POST /api/context/translate`
- `POST /api/generate`
- `POST /api/validate`
- `POST /api/push`
- `POST /api/logout`
- `GET /auth/atlassian`
- `GET /auth/atlassian/callback`

`GET /api/healthz` is intentionally public and lightweight. When Postgres is active, it also performs a simple DB query.

## Local setup

1. Open the app folder:

   ```bash
   cd /Users/bvt-zhafran/Downloads/qa-agent-web
   ```

2. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env`:

   ```bash
   open -e .env
   ```

4. Create an Atlassian OAuth 3LO app.
5. For local development with `npm run dev`, set the callback URL to:

   ```text
   http://localhost:5180/auth/atlassian/callback
   ```

6. Fill the required environment variables:

   ```text
   ATLASSIAN_CLIENT_ID=
   ATLASSIAN_CLIENT_SECRET=
   DATABASE_URL=
   OPENAI_API_KEY=
   DEEPSEEK_API_KEY=
   TESTRAIL_BASE_URL=
   TESTRAIL_USER=
   TESTRAIL_API_KEY=
   ```

## Local development

Run the Vite client and Node API server together:

```bash
npm run dev
```

Local URLs for `npm run dev`:

- frontend: `http://localhost:5173`
- backend: `http://localhost:5180`

When running the production start path locally:

```bash
npm start
```

The built app is served from the Node server.

Default local `npm start` URL:

- app server: `http://localhost:5174`

If you want `npm start` to use a different host or port locally, set:

- `QA_AGENT_PORT`
- and, when needed, `QA_AGENT_BASE_URL` and `ATLASSIAN_REDIRECT_URI`

## Environment and persistence behavior

Important runtime behavior:

- `DATABASE_URL` enables Postgres-backed persistence
- local dev may fall back to `file+memory-fallback` when Postgres init fails
- Railway/prod should use Postgres persistence
- Atlassian refresh tokens are stored and used to refresh access tokens when possible
- migrations are applied from `src/server/migrations`

Persistence-backed data includes:

- sessions
- audit events
- workflow history
- push history

## Railway deployment

1. Create a Railway service from this app directory.
2. Use the start command:

   ```text
   npm start
   ```

3. Set Railway variables:

   ```text
   QA_AGENT_BASE_URL=https://<your-railway-domain>
   ATLASSIAN_CLIENT_ID=
   ATLASSIAN_CLIENT_SECRET=
   ATLASSIAN_REDIRECT_URI=https://<your-railway-domain>/auth/atlassian/callback
   ATLASSIAN_SCOPES=read:jira-work read:page:confluence read:confluence-content.all read:confluence-space.summary offline_access
   DATABASE_URL=
   OPENAI_API_KEY=
   OPENAI_MODEL=gpt-5.4-mini
   DEEPSEEK_API_KEY=
   DEEPSEEK_MODEL=deepseek-v4-pro
   TESTRAIL_BASE_URL=
   TESTRAIL_USER=
   TESTRAIL_API_KEY=
   TESTRAIL_SECTION_ID=
   ```

4. Update the Atlassian OAuth callback URL to:

   ```text
   https://<your-railway-domain>/auth/atlassian/callback
   ```

5. Deploy and open the Railway public URL.

Deployment notes:

- Railway deployments should not rely on a committed `.env`
- production should not use persistence fallback mode
- `DATABASE_URL` is required for normal persistent operation

## Commands

Install dependencies:

```bash
npm install
```

Run local dev:

```bash
npm run dev
```

Run full tests:

```bash
npm test
```

Run server tests only:

```bash
npm run test:server
```

Run client tests only:

```bash
npm run test:client
```

Run typecheck:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Start built app:

```bash
npm start
```

## Node version

Supported Node versions are defined in `package.json`:

```text
^20.19.0 || >=22.12.0
```

## Safety rules

- The configured LLM drafts cases, but app code controls validation and push gating.
- Push is blocked until QA explicitly approves.
- Coverage is computed from the final canonical AC set, not raw extracted fragments.
- Thin-ticket fallback and PRD matching are tracked in diagnostics instead of hidden.
- Production logic should stay ticket-neutral even when tests use specific Jira fixtures.

## Testing strategy

Server-side tests cover:

- context building
- source precedence
- thin-ticket PRD fallback
- acceptance-criteria synthesis and repair
- validation and coverage logic

Client-side tests cover:

- Scope Snapshot diagnostics
- EN/ID toggle behavior
- left utility modal triggers
- toast rendering

Known regression fixtures include ticket shapes such as:

- strong main Jira technical-design tickets
- thin Jira + PRD fallback tickets
- explicit-AC tickets

## QA-focused reviewer agent

Before pushing changes to scope resolution, generation, validation, review UI, or TestRail behavior, use the reviewer prompt in [`docs/qa-reviewer-agent.md`](docs/qa-reviewer-agent.md).

Required team rule:

- run the QA reviewer agent before committing any non-trivial app change
- treat reviewer pass/fail as part of normal engineering workflow, not optional cleanup
- docs-only edits can skip it when there is no runtime behavior change

The reviewer is expected to focus on QA trust:

- source precedence
- PRD subsection matching
- AC quality
- generated-case mapping
- validation and coverage correctness
- TestRail push safety
- Scope Snapshot readability and confidence
