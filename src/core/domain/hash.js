// Huella criptográfica (SHA-256) sobre JSON canónico. Funciona en Workers y en Node >= 20.

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Contenido que cubre la huella: identidad del lote, textos, hashtags, plataformas,
// configuraciones, fechas y la huella SHA-256 de cada archivo multimedia.
export function hashableContent(batch) {
  return {
    batch_id: batch.batch_id,
    title: batch.title ?? null,
    persona: batch.persona ?? null,
    publications: [...batch.publications]
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({
        seq: p.seq,
        platform: p.platform,
        content_type: p.content_type,
        media: p.media,
        copy: p.copy,
        scheduled_at: p.scheduled_at,
        settings: p.settings ?? null,
        test_controls: p.test_controls ?? null,
      })),
  };
}

export async function contentHash(batch) {
  return sha256Hex(canonicalize(hashableContent(batch)));
}
