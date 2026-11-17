// Límites por IP usando D1 (sin productos de pago). Complementa WAF/Access en el panel.
import { err } from '../../core/domain/errors.js';

const WINDOW_SEC = 60;

function clientIp(request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return ip && ip.length <= 64 ? ip : 'unknown';
}

function parseLimit(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10_000) : fallback;
}

export function rateLimitConfig(env = {}) {
  return {
    healthPerMinute: parseLimit(env, 'RATE_LIMIT_HEALTH_PER_MINUTE', 120),
    anonPerMinute: parseLimit(env, 'RATE_LIMIT_ANON_PER_MINUTE', 60),
    enabled: String(env.RATE_LIMIT_ENABLED ?? 'true').toLowerCase() !== 'false',
  };
}

/** Incrementa contador y devuelve { allowed, remaining, limit }. Lanza 429 si se excede. */
export async function enforceRateLimit(db, bucket, limit) {
  if (!limit || limit <= 0) return { allowed: true, remaining: limit, limit };
  const windowId = Math.floor(Date.now() / 1000 / WINDOW_SEC);
  const row = await db
    .prepare(
      `INSERT INTO http_rate_windows (bucket_key, window_id, hits) VALUES (?1, ?2, 1)
       ON CONFLICT(bucket_key, window_id) DO UPDATE SET hits = hits + 1
       RETURNING hits`,
    )
    .bind(bucket, windowId)
    .first();
  const hits = row?.hits ?? 1;
  if (hits > limit) throw err('RATE_LIMITED', 'Demasiadas peticiones; inténtalo más tarde', 429, { bucket, limit, window_seconds: WINDOW_SEC });
  return { allowed: true, remaining: Math.max(0, limit - hits), limit };
}

export async function purgeOldRateWindows(db, olderThanUnix) {
  await db.prepare('DELETE FROM http_rate_windows WHERE window_id < ?1').bind(olderThanUnix).run();
}

/** health: bucket health:<ip>; anon: rutas sin cabeceras HMAC completas */
export async function applyHttpRateLimit(request, env, { scope }) {
  const cfg = rateLimitConfig(env);
  if (!cfg.enabled) return null;
  const ip = clientIp(request);
  const limit = scope === 'health' ? cfg.healthPerMinute : cfg.anonPerMinute;
  const bucket = `${scope}:${ip}`;
  const r = await enforceRateLimit(env.DB, bucket, limit);
  return { ...r, bucket };
}

export function isAuthenticatedAttempt(request) {
  return ['x-influ-key-id', 'x-influ-timestamp', 'x-influ-nonce', 'x-influ-signature'].every((h) => request.headers.get(h));
}