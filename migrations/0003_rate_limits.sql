-- Ventanas fijas de rate limit por IP (solo D1, plan gratuito). Limpieza en el Cron.
CREATE TABLE IF NOT EXISTS http_rate_windows (
  bucket_key TEXT NOT NULL,
  window_id INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_id)
);
CREATE INDEX IF NOT EXISTS idx_rate_windows_window ON http_rate_windows(window_id);