-- Reservas de PUT prefirmado. El cron suelta la cuota si caducan sin usarse.
-- No reescribe 0001–0006.

ALTER TABLE encargo_assets ADD COLUMN content_md5 TEXT;

CREATE TABLE IF NOT EXISTS deliverable_reservations (
  reservation_id TEXT PRIMARY KEY,
  encargo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_md5 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  bytes_held INTEGER NOT NULL,
  class_a_held INTEGER NOT NULL,
  quota_day TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_encargo ON deliverable_reservations(encargo_id);
CREATE INDEX IF NOT EXISTS idx_reservations_expires ON deliverable_reservations(expires_at);
