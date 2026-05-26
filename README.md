# QA Agent Web App

Internal QA workflow app for generating BDD test cases from Jira and Confluence context, reviewing them, approving them, and pushing them to TestRail.

## Setup

1. Open the app folder:

   ```bash
   cd /Users/bvt-zhafran/Downloads/qa-agent-web
   ```

2. Copy `.env.example` to `.env`.

   ```bash
   cp .env.example .env
   ```

3. Edit `.env`.

   ```bash
   open -e .env
   ```

4. Create an Atlassian OAuth 3LO app.
5. Set the callback URL to:

   ```text
   http://localhost:5180/auth/atlassian/callback
   ```

6. Fill these environment variables:

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

7. Start the app:

   ```bash
   npm start
   ```

8. For local UI development with Vite plus the Node API server:

   ```bash
   npm run dev
   ```

9. Open:

   ```text
   http://localhost:5180
   ```

   When running `npm run dev`, the React app is available at:

   ```text
   http://localhost:5173
   ```

## Railway Deployment

1. Create a Railway service from this app directory.
2. Use the default start command:

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

4. Update the Atlassian OAuth 3LO callback URL to exactly:

   ```text
   https://<your-railway-domain>/auth/atlassian/callback
   ```

5. Deploy and open the Railway public URL.

Phase 2 notes:
- Railway deployments require `DATABASE_URL`.
- Local development may use the Railway public Postgres proxy host in `.env`.
- If local Postgres connection fails during `npm run dev`, the app falls back to file-and-memory mode so the API still starts.
- Sessions, audit events, workflow history, and push history persist in Postgres when `DATABASE_URL` is configured.
- Atlassian access tokens are refreshed automatically from stored refresh tokens when possible.

## Workflow

1. Login with Atlassian.
2. Enter Jira ticket key.
3. Analyze Jira and linked Confluence context.
4. Generate BDD test cases with the configured AI model.
5. Review and edit the cases.
6. If regenerating, review the before/after diff before replacing the current draft.
7. Approve the cases.
8. Enter TestRail section ID.
9. Push to TestRail.
10. Browse persisted history and diagnostics in the app.

## Keepalive

If your Railway plan does not allow disabling sleep, use an external monitor or cron to hit:

```text
GET /api/healthz
```

This endpoint is public and lightweight. When Postgres is active, it also performs a simple DB query so the request wakes both the app service and the database.

## Safety Rules

- The configured LLM only drafts test cases.
- The app tries OpenAI first, then falls back to DeepSeek only for quota, rate-limit, billing, token, or context-length failures.
- App code reads Jira/Confluence, validates cases, enforces approval, and pushes to TestRail.
- TestRail BDD cases are pushed with `template_id: 4`.
- BDD content is sent as `custom_testrail_bdd_scenario: [{ content: bddScenario }]`.
- Push is blocked until all generated cases pass validation and QA explicitly approves.
- Railway deploys should use Railway Variables instead of a committed `.env`.

## Tests

Run the test suite:

```bash
npm test
```

Run typechecking:

```bash
npm run typecheck
```
