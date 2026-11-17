// Reglas de validación de YouTube compartidas por los adaptadores MOCK y (futuro) LIVE.
// Basadas en la documentación pública de YouTube Data API v3 (videos.insert / recurso video).
// Lo que no se puede comprobar sin la API real (p. ej. lista de categorías asignables por región,
// que se obtiene con videoCategories.list) queda marcado como aviso.
import { ErrorCode } from '../../../core/ports/social-publisher.js';

export const YT_PRIVACY = ['public', 'private', 'unlisted'];
export const YT_TITLE_MAX = 100;            // snippet.title: máx. 100 caracteres, sin < ni >
export const YT_DESCRIPTION_MAX_BYTES = 5000; // snippet.description: máx. 5000 bytes, sin < ni >
export const YT_TAGS_MAX_CHARS = 500;       // snippet.tags[]: máx. 500 caracteres en total
export const YT_ACCEPTED_MIME = /^video\//; // videos.insert acepta video/* y application/octet-stream
export const YT_SHORTS_MAX_SECONDS = 180;

export function buildDescription(copy) {
  const tags = (copy.hashtags ?? []).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
  return [copy.description ?? '', tags].filter(Boolean).join('\n\n');
}

// Longitud de tags tal como la cuenta YouTube: las etiquetas con espacios cuentan entre comillas.
export function tagsLength(tags = []) {
  return tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

export function validateYouTubePost(post, { maxBytes }) {
  const errors = [];
  const warnings = [];
  const add = (field, message) => errors.push({ code: ErrorCode.VALIDATION_ERROR, field, message });
  const c = post.copy ?? {};
  if (post.platform !== 'youtube') add('platform', 'El adaptador de YouTube solo acepta platform=youtube');
  if (!['short_video', 'video'].includes(post.content_type)) add('content_type', 'YouTube solo admite short_video o video');
  if (typeof c.title !== 'string' || !c.title.trim()) add('copy.title', 'Título obligatorio');
  else {
    if (c.title.length > YT_TITLE_MAX) add('copy.title', `Título > ${YT_TITLE_MAX} caracteres`);
    if (/[<>]/.test(c.title)) add('copy.title', 'El título no puede contener < ni >');
  }
  const desc = buildDescription(c);
  if (typeof c.description !== 'string' || !c.description.trim()) add('copy.description', 'Descripción obligatoria');
  if (new TextEncoder().encode(desc).length > YT_DESCRIPTION_MAX_BYTES) add('copy.description', `Descripción > ${YT_DESCRIPTION_MAX_BYTES} bytes`);
  if (/[<>]/.test(desc)) add('copy.description', 'La descripción no puede contener < ni >');
  if (c.tags !== undefined && !Array.isArray(c.tags)) add('copy.tags', 'tags debe ser una lista');
  else if (tagsLength(c.tags ?? []) > YT_TAGS_MAX_CHARS) add('copy.tags', `Etiquetas > ${YT_TAGS_MAX_CHARS} caracteres en total`);
  if (typeof c.category_id !== 'string' || !/^\d+$/.test(c.category_id)) add('copy.category_id', 'category_id obligatorio (id numérico como texto, p. ej. "22")');
  else warnings.push('category_id no verificado contra videoCategories.list (solo posible con la API real)');
  if (!YT_PRIVACY.includes(c.privacy_status)) add('copy.privacy_status', `privacy_status debe ser ${YT_PRIVACY.join(' | ')}`);
  if (typeof c.made_for_kids !== 'boolean') add('copy.made_for_kids', 'made_for_kids (status.selfDeclaredMadeForKids) obligatorio: true/false');
  if (typeof c.contains_synthetic_media !== 'boolean') add('copy.contains_synthetic_media', 'contains_synthetic_media (status.containsSyntheticMedia) obligatorio para un influencer virtual');
  const m = post.media ?? {};
  if (!YT_ACCEPTED_MIME.test(m.mime ?? '') && m.mime !== 'application/octet-stream') add('media.mime', `Tipo de archivo incompatible: ${m.mime}`);
  if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
  else if (m.size_bytes > maxBytes) add('media.size_bytes', `Archivo > ${maxBytes} bytes (límite de la POC)`);
  if (post.content_type === 'short_video') {
    if (m.duration_s != null && m.duration_s > YT_SHORTS_MAX_SECONDS) add('media.duration_s', `Un Short no puede superar ${YT_SHORTS_MAX_SECONDS} s`);
    if (m.width && m.height && m.width > m.height) warnings.push('Short horizontal: se recomienda formato vertical 9:16');
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Comprobación del contenido real del archivo (firma ISO-BMFF "ftyp" para MP4/MOV, EBML para WebM).
export function sniffVideo(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (ftyp === 'ftyp') return 'video/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return null;
}
