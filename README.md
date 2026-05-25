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
   http://localhost:5174/auth/atlassian/callback
   ```

6. Fill these environment variables:

   ```text
   ATLASSIAN_CLIENT_ID=
   ATLASSIAN_CLIENT_SECRET=
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

8. Open:

   ```text
   http://localhost:5174
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
   ATLASSIAN_SCOPES=read:jira-work read:confluence-content.all read:confluence-space.summary offline_access
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

Notes for this MVP:
- Sessions are stored in memory. Users must log in again after restart or redeploy.
- `audit-log.jsonl` is written to local service storage and may be lost on Railway redeploys or restarts.

## Workflow

1. Login with Atlassian.
2. Enter Jira ticket key.
3. Analyze Jira and linked Confluence context.
4. Generate BDD test cases with the configured AI model.
5. Review and edit the cases.
6. Approve the cases.
7. Enter TestRail section ID.
8. Push to TestRail.

## Safety Rules

- The configured LLM only drafts test cases.
- The app tries OpenAI first, then falls back to DeepSeek only for quota, rate-limit, billing, token, or context-length failures.
- App code reads Jira/Confluence, validates cases, enforces approval, and pushes to TestRail.
- TestRail BDD cases are pushed with `template_id: 4`.
- BDD content is sent as `custom_testrail_bdd_scenario: [{ content: bddScenario }]`.
- Push is blocked until all generated cases pass validation and QA explicitly approves.
- Railway deploys should use Railway Variables instead of a committed `.env`.

## Tests

Run validation tests:

```bash
npm test
```
