CREATE TABLE IF NOT EXISTS user_testrail_credentials (
  account_id TEXT PRIMARY KEY,
  tr_user TEXT NOT NULL,
  tr_api_key_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
