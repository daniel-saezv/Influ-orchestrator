-- Usuarios de Access, cuentas de creador y encargos. No reescribe 0001–0003.
-- platform_connections nace vacía: el OAuth no forma parte de esta fase.

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  time_zone TEXT,
  guide_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS encargos (
  encargo_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('from_scratch', 'edit')),
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'claimed', 'ready', 'approved', 'scheduled', 'cancelled')),
  platforms_json TEXT NOT NULL,
  batch_id TEXT,
  publish_at TEXT,
  synthetic INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_encargos_account ON encargos(account_id);
CREATE INDEX IF NOT EXISTS idx_encargos_status ON encargos(status);

CREATE TABLE IF NOT EXISTS encargo_assets (
  asset_id TEXT PRIMARY KEY,
  encargo_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source', 'deliverable')),
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_encargo ON encargo_assets(encargo_id);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON encargo_assets(sha256);

CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  encargo_id TEXT,
  expected_parts INTEGER NOT NULL,
  received_parts INTEGER NOT NULL DEFAULT 0,
  file_sha256 TEXT,
  part_hashes_json TEXT,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON upload_sessions(user_id);

CREATE TABLE IF NOT EXISTS streaks (
  account_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  last_civil_day TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Contadores diarios (clase A, clase B, pico). La fase de R2 los reserva.
CREATE TABLE IF NOT EXISTS r2_daily (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  class_a INTEGER NOT NULL DEFAULT 0,
  class_b INTEGER NOT NULL DEFAULT 0,
  bytes_peak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);

-- Bytes guardados ahora, por usuario de Access (scope = user_id) y global (scope = 'global').
CREATE TABLE IF NOT EXISTS r2_bytes (
  scope TEXT PRIMARY KEY,
  bytes_stored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS platform_connections (
  connection_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  ciphertext TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conn_account ON platform_connections(account_id);

CREATE TABLE IF NOT EXISTS encargo_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  encargo_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_encargo_events_account ON encargo_events(account_id);

ALTER TABLE batches ADD COLUMN account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_batches_account ON batches(account_id);
