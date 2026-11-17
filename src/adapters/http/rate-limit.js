// Límites por IP usando D1 (sin productos de pago). Complementa WAF/Access en el panel.
import { err } from '../../core/domain/errors.js';

const WINDOW_SEC = 60;

function parseHextet(part) {
  if (!part && part !== '') return null;
  if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
  return parseInt(part, 16);
}

function isValidIpv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255;
  });
}

function ipv4TailToGroups(v4) {
  const o = v4.split('.').map(Number);
  return [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
}

/** Expande una dirección IPv6 (con `::` y/o sufijo IPv4) a 8 hextetos de 16 bits. */
function parseIpv6To8Groups(raw) {
  let lower = String(raw).trim().toLowerCase();
  if (!lower.includes(':')) return null;

  let tailV4 = null;
  const v4Suffix = /^(.+):(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (v4Suffix && isValidIpv4(v4Suffix[2])) {
    tailV4 = v4Suffix[2];
    lower = v4Suffix[1];
    if (lower.endsWith(':')) lower = lower.slice(0, -1);
    if (!lower) lower = '::';
  }

  const pieces = lower.split('::');
  if (pieces.length > 2) return null;

  const headParts = pieces[0] ? pieces[0].split(':').filter(Boolean) : [];
  const tailParts = pieces.length === 2 && pieces[1] ? pieces[1].split(':').filter(Boolean) : [];
  const tailSlots = tailV4 ? 2 : 0;
  const headSlots = headParts.length + tailParts.length;
  let groups;

  if (pieces.length === 2) {
    const missing = 8 - headSlots - tailSlots;
    if (missing < 0) return null;
    groups = [...headParts.map(parseHextet), ...Array(missing).fill(0), ...tailParts.map(parseHextet)];
    if (tailV4) groups.push(...ipv4TailToGroups(tailV4));
  } else {
    if (headSlots + tailSlots !== 8) return null;
    groups = headParts.map(parseHextet);
    if (tailV4) groups.push(...ipv4TailToGroups(tailV4));
  }

  if (groups.length !== 8 || groups.some((g) => g === null)) return null;
  return groups;
}

/** Parsea IPv4, IPv6 (comprimida) o IPv4-mapeada (::ffff:x.x.x.x). */
function parseIpAddress(raw) {
  if (raw === undefined || raw === null) return null;
  const ip = String(raw).trim();
  if (!ip) return null;
  if (isValidIpv4(ip)) return { kind: 'v4', address: ip };
  if (!ip.includes(':')) return null;

  const groups = parseIpv6To8Groups(ip);
  if (!groups) return null;

  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return {
      kind: 'v4',
      address: `${(groups[6] >> 8) & 255}.${groups[6] & 255}.${(groups[7] >> 8) & 255}.${groups[7] & 255}`,
    };
  }
  return { kind: 'v6', groups };
}

/** Clave estable para rate limit: IPv4 exacta; IPv6 prefijo /64; inválido → unknown. */
export function normalizeRateLimitClientKey(raw) {
  const parsed = parseIpAddress(raw);
  if (!parsed) return 'unknown';
  if (parsed.kind === 'v4') return parsed.address;
  const hextets = parsed.groups.slice(0, 4).map((g) => g.toString(16).padStart(4, '0'));
  return `v6-64:${hextets.join(':')}`;
}

function clientIp(request) {
  const raw = request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return normalizeRateLimitClientKey(raw);
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