-- El encargo pasa a failed si el origen de R2 no cuadra.
-- No reescribe 0001–0005. SQLite no altera un CHECK: se reconstruye la tabla.

CREATE TABLE encargos__h (
  encargo_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('from_scratch', 'edit')),
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'claimed', 'ready', 'approved', 'scheduled', 'cancelled', 'failed')),
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

INSERT INTO encargos__h (
  encargo_id, account_id, kind, note, status, platforms_json, batch_id, publish_at,
  synthetic, version, content_hash, delivered, created_at, updated_at
)
SELECT
  encargo_id, account_id, kind, note, status, platforms_json, batch_id, publish_at,
  synthetic, version, content_hash, delivered, created_at, updated_at
FROM encargos;

DROP TABLE encargos;
ALTER TABLE encargos__h RENAME TO encargos;
CREATE INDEX IF NOT EXISTS idx_encargos_account ON encargos(account_id);
CREATE INDEX IF NOT EXISTS idx_encargos_status ON encargos(status);
