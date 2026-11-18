// Reglas de encargos que no tocan la red ni el almacenamiento.
import { err } from './errors.js';
import { SUPPORTED_PLATFORMS } from './batch.js';

const SHA_RE = /^[a-f0-9]{64}$/;
const NAME_MAX = 80;
const NOTE_MAX = 4000;
const MAX_ASSET_BYTES = 150 * 1024 * 1024;
const FORBIDDEN = ['mode', 'live', 'publisher_mode', 'approved', 'status', 'synthetic'];

export function assertNoControlFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw err('INVALID_INPUT', 'El cuerpo debe ser un objeto JSON', 400);
  }
  for (const key of FORBIDDEN) {
    if (key in body) throw err('INVALID_INPUT', `Campo no permitido: ${key}`, 400);
  }
}

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

export function assertName(value, field) {
  if (typeof value !== 'string') throw err('INVALID_INPUT', `${field} obligatorio`, 400);
  const name = value.trim();
  if (!name || name.length > NAME_MAX) throw err('INVALID_INPUT', `${field} debe tener entre 1 y ${NAME_MAX} caracteres`, 400);
  return name;
}

export function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 64) {
    throw err('INVALID_INPUT', 'Zona horaria obligatoria', 400);
  }
  const zone = timeZone.trim();
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  } catch {
    throw err('INVALID_INPUT', 'Zona horaria no reconocida', 400);
  }
  return zone;
}

export function assertPlatforms(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > SUPPORTED_PLATFORMS.length) {
    throw err('INVALID_INPUT', 'Elige al menos una plataforma', 400);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length || unique.some((p) => !SUPPORTED_PLATFORMS.includes(p))) {
    throw err('INVALID_INPUT', `Plataforma no admitida. Usa ${SUPPORTED_PLATFORMS.join(', ')}`, 400);
  }
  return unique;
}

export function assertSha256(value, field) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) throw err('INVALID_INPUT', `${field} debe ser un SHA-256 en hex`, 400);
  return value;
}

export function assertAssetBytes(value) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_ASSET_BYTES) {
    throw err('INVALID_INPUT', 'Tamaño de la pieza no admitido', 400);
  }
  return value;
}

/** Día civil YYYY-MM-DD en la zona guardada del usuario. */
export function civilDay(timeZone, instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw err('INVALID_INPUT', 'Instante no válido', 400);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function localTime(timeZone, instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function previousCivilDay(day) {
  const [year, month, date] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

/** La racha visible se apaga si el último día contabilizado no es hoy ni ayer. */
export function visibleStreak(row, today) {
  if (!row) return { count: 0, last_civil_day: null, today };
  const alive = row.last_civil_day === today || row.last_civil_day === previousCivilDay(today);
  return { count: alive ? row.count : 0, last_civil_day: row.last_civil_day, today };
}

export function nextStreakCount(row, today) {
  if (!row || (row.last_civil_day !== today && row.last_civil_day !== previousCivilDay(today))) return 1;
  if (row.last_civil_day === today) return row.count;
  return row.count + 1;
}
