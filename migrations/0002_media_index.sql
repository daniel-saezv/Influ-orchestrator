-- Índice de archivos multimedia (consistencia fuerte en D1; los bytes viven en KV / futuro R2).
CREATE TABLE IF NOT EXISTS media_objects (
  sha256 TEXT PRIMARY KEY,
  storage TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
