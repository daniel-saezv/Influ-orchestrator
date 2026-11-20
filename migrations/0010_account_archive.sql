ALTER TABLE accounts ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_accounts_user_archived ON accounts(user_id, archived_at);
