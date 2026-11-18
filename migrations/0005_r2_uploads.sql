-- Subidas de la persona y borrados de R2 pendientes de reintento.
-- No reescribe 0001–0004.

ALTER TABLE encargo_assets ADD COLUMN delete_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_assets_delete_pending ON encargo_assets(delete_pending);

ALTER TABLE upload_sessions ADD COLUMN mime TEXT;
ALTER TABLE upload_sessions ADD COLUMN completed_at TEXT;
ALTER TABLE upload_sessions ADD COLUMN bytes_reserved INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_uploads_created ON upload_sessions(created_at);
