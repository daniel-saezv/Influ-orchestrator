// Topes de R2 Standard. Binarios: 5 MiB por parte y 150 MiB por archivo.
// La ventana de operaciones es de 30 días UTC, no el mes natural.

export const PART_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
export const MAX_USER_BYTES = 300 * 1024 * 1024;
export const MAX_GLOBAL_BYTES = 6 * 1024 * 1024 * 1024;
export const MAX_CLASS_A_USER = 10_000;
export const MAX_CLASS_A_GLOBAL = 800_000;
export const MAX_CLASS_B_USER = 100_000;
export const MAX_CLASS_B_GLOBAL = 8_000_000;
export const QUOTA_WINDOW_DAYS = 30;
export const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

export function partCountFor(size) {
  return Math.ceil(size / PART_SIZE_BYTES);
}

export function expectedPartSize(size, part) {
  const count = partCountFor(size);
  if (part < count) return PART_SIZE_BYTES;
  return size - PART_SIZE_BYTES * (count - 1);
}

export function shiftUtcDay(day, delta) {
  const [year, month, date] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + delta);
  return utc.toISOString().slice(0, 10);
}

export function windowStart(iso) {
  return shiftUtcDay(iso.slice(0, 10), -(QUOTA_WINDOW_DAYS - 1));
}
