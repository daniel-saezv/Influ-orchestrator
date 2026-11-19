// Validación estructural del lote (independiente de la red social).
// La validación específica de cada plataforma la hace su adaptador (validatePost).
import { err } from './errors.js';

export const SUPPORTED_PLATFORMS = ['youtube', 'instagram', 'tiktok'];
export const CONTENT_TYPES = ['short_video', 'video', 'image', 'carousel', 'reel', 'story'];
export const BATCH_ID_RE = /^LOTE-[A-Z0-9-]{4,24}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_PUBLICATIONS = 20;
// Campos que el cliente nunca puede fijar (p. ej. intentar forzar modo LIVE).
const FORBIDDEN_KEYS = ['mode', 'publisher_mode', 'live', 'status', 'approved', 'approved_by', 'approved_at'];

export function validateBatchInput(input) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw err('INVALID_BATCH', 'El cuerpo debe ser un objeto JSON', 400);
  }
  for (const k of FORBIDDEN_KEYS) if (k in input) add(k, `Campo no permitido en la entrada: ${k}`);
  if (!BATCH_ID_RE.test(input.batch_id ?? '')) add('batch_id', 'batch_id obligatorio con formato LOTE-XXXX');
  if (typeof input.title !== 'string' || !input.title.trim()) add('title', 'title obligatorio');
  if (!Array.isArray(input.publications) || input.publications.length === 0) add('publications', 'Debe haber al menos una publicación');
  else if (input.publications.length > MAX_PUBLICATIONS) add('publications', `Máximo ${MAX_PUBLICATIONS} publicaciones por lote`);
  const seqs = new Set();
  (Array.isArray(input.publications) ? input.publications : []).forEach((p, i) => {
    const f = (n) => `publications[${i}].${n}`;
    if (!p || typeof p !== 'object') { add(`publications[${i}]`, 'Publicación inválida'); return; }
    for (const k of FORBIDDEN_KEYS) if (k in p) add(f(k), `Campo no permitido en la entrada: ${k}`);
    if (!Number.isInteger(p.seq) || p.seq < 1) add(f('seq'), 'seq entero >= 1');
    else if (seqs.has(p.seq)) add(f('seq'), 'seq duplicado'); else seqs.add(p.seq);
    if (!SUPPORTED_PLATFORMS.includes(p.platform)) add(f('platform'), `platform debe ser uno de ${SUPPORTED_PLATFORMS.join(', ')}`);
    if (!CONTENT_TYPES.includes(p.content_type)) add(f('content_type'), `content_type debe ser uno de ${CONTENT_TYPES.join(', ')}`);
    const m = p.media;
    if (!m || typeof m !== 'object') add(f('media'), 'media obligatorio');
    else {
      if (!SHA_RE.test(m.sha256 ?? '')) add(f('media.sha256'), 'sha256 hex de 64 caracteres');
      if (typeof m.mime !== 'string' || !m.mime.includes('/')) add(f('media.mime'), 'mime obligatorio');
      if (!Number.isInteger(m.size_bytes) || m.size_bytes <= 0) add(f('media.size_bytes'), 'size_bytes entero > 0');
      if (typeof m.filename !== 'string' || !m.filename) add(f('media.filename'), 'filename obligatorio');
    }
    if (!p.copy || typeof p.copy !== 'object') add(f('copy'), 'copy obligatorio');
    if (typeof p.scheduled_at !== 'string' || Number.isNaN(Date.parse(p.scheduled_at))) add(f('scheduled_at'), 'scheduled_at fecha ISO-8601 obligatoria');
    if (p.test_controls !== undefined && (typeof p.test_controls !== 'object' || p.test_controls === null)) add(f('test_controls'), 'test_controls debe ser objeto');
  });
  if (errors.length) throw err('INVALID_BATCH', 'El lote no supera la validación estructural', 400, errors);
  // Normalización: sólo se conservan los campos conocidos.
  return {
    batch_id: input.batch_id,
    title: input.title.trim(),
    persona: input.persona ?? null,
    notes: input.notes ?? null,
    publications: input.publications.map((p) => ({
      seq: p.seq,
      platform: p.platform,
      content_type: p.content_type,
      media: {
        sha256: p.media.sha256, mime: p.media.mime, size_bytes: p.media.size_bytes, filename: p.media.filename,
        duration_s: p.media.duration_s ?? null, width: p.media.width ?? null, height: p.media.height ?? null,
        ...(Number.isInteger(p.media.item_count) ? { item_count: p.media.item_count } : {}),
      },
      copy: p.copy,
      scheduled_at: new Date(p.scheduled_at).toISOString(),
      settings: p.settings ?? null,
      test_controls: p.test_controls ?? null,
    })).sort((a, b) => a.seq - b.seq),
  };
}

export function publicationId(batchId, version, seq) {
  return `${batchId}-V${version}-P${String(seq).padStart(2, '0')}`;
}
