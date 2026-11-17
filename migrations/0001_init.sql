-- Esquema D1 (sustituto de n8n Data Tables). Tablas planas, una por entidad.
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  approved_version INTEGER,
  approved_hash TEXT,
  validation_json TEXT
);
CREATE TABLE IF NOT EXISTS batch_versions (
  batch_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  change_note TEXT,
  PRIMARY KEY (batch_id, version)
);
CREATE TABLE IF NOT EXISTS publications (
  publication_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  batch_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  platform TEXT NOT NULL,
  content_type TEXT NOT NULL,
  media_sha256 TEXT NOT NULL,
  media_mime TEXT NOT NULL,
  media_size INTEGER NOT NULL,
  media_filename TEXT NOT NULL,
  post_json TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_mode TEXT,
  provider_post_id TEXT,
  published_url TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pub_batch ON publications(batch_id, batch_version);
CREATE INDEX IF NOT EXISTS idx_pub_status ON publications(status);
CREATE TABLE IF NOT EXISTS publication_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  at TEXT NOT NULL,
  op TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_evt_batch ON publication_events(batch_id);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  command_text TEXT,
  comment TEXT,
  key_id TEXT NOT NULL,
  valid INTEGER NOT NULL,
  invalidated_at TEXT,
  invalidated_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_appr_batch ON approvals(batch_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  batch_id TEXT,
  detail_json TEXT
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS egress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  host TEXT NOT NULL,
  url TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  context TEXT
);
-- Estado interno del simulador (adaptador MOCK), separado de las tablas del sistema.
CREATE TABLE IF NOT EXISTS mock_provider_records (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
