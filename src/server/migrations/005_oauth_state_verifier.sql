ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS verifier_hash TEXT;

