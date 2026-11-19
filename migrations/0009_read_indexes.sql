CREATE INDEX IF NOT EXISTS idx_assets_encargo_role_version ON encargo_assets(encargo_id, role, version);
CREATE INDEX IF NOT EXISTS idx_uploads_encargo_completed ON upload_sessions(encargo_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_encargo_events_account_id ON encargo_events(account_id, id);
CREATE INDEX IF NOT EXISTS idx_encargos_account_updated ON encargos(account_id, updated_at);
