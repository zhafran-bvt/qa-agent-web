CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  cloud_id TEXT NOT NULL,
  resources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_resource_json JSONB,
  user_name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS selected_resource_json JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT,
  user_name TEXT,
  jira_key TEXT,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jira_key TEXT NOT NULL,
  user_name TEXT NOT NULL,
  context_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generated_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id UUID REFERENCES analysis_runs(id) ON DELETE SET NULL,
  jira_key TEXT NOT NULL,
  user_name TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  validation_json JSONB NOT NULL,
  coverage_json JSONB NOT NULL,
  coverage_enforced BOOLEAN NOT NULL DEFAULT TRUE,
  manual_scope_override BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generated_test_cases (
  id BIGSERIAL PRIMARY KEY,
  generated_run_id UUID NOT NULL REFERENCES generated_runs(id) ON DELETE CASCADE,
  case_order INTEGER NOT NULL,
  case_key TEXT,
  title TEXT,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS push_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_run_id UUID REFERENCES generated_runs(id) ON DELETE SET NULL,
  jira_key TEXT NOT NULL,
  user_name TEXT NOT NULL,
  section_id TEXT NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT TRUE,
  summary_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_case_results (
  id BIGSERIAL PRIMARY KEY,
  push_run_id UUID NOT NULL REFERENCES push_runs(id) ON DELETE CASCADE,
  case_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  case_ref TEXT,
  error TEXT,
  payload_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_created_at ON analysis_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_runs_created_at ON generated_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_runs_created_at ON push_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_test_cases_generated_run_id ON generated_test_cases (generated_run_id, case_order);
CREATE INDEX IF NOT EXISTS idx_push_case_results_push_run_id ON push_case_results (push_run_id, case_order);
