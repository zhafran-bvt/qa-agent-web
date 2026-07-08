ALTER TABLE generated_runs
  ADD COLUMN IF NOT EXISTS quality_json JSONB,
  ADD COLUMN IF NOT EXISTS step_timings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
