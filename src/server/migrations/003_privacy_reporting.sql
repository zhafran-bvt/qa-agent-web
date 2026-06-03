ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS personal_data_retrieved_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions (account_id);

CREATE TABLE IF NOT EXISTS privacy_report_state (
  account_id TEXT PRIMARY KEY,
  last_reported_at TIMESTAMPTZ,
  last_reported_age_seconds INTEGER,
  last_action_required TEXT,
  last_cycle_period_days INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS privacy_reporting_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
