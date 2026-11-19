import { ErrorCode } from '../../../core/ports/social-publisher.js';

export const TT_VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];
export const TT_PHOTO_MIME = ['image/jpeg', 'image/webp'];
export const TT_VIDEO_MAX_SECONDS = 180;
export const TT_PHOTO_MAX = 35;
export const TT_PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const TT_CAPTION_MAX = 2200;
export const TT_PHOTO_CAPTION_MAX = 4000;
export const TT_MIN_EDGE = 360;
export const TT_MAX_EDGE = 4096;
export const TT_PHOTO_MAX_EDGE = 1920;

const VIDEO_TYPES = ['reel', 'video', 'short_video'];
const PHOTO_TYPES = ['photo', 'image', 'carousel'];

function resolveTarget(post) {
  if (post.target === 'video' || post.target === 'photo') return post.target;
  if (VIDEO_TYPES.includes(post.content_type)) return 'video';
  if (PHOTO_TYPES.includes(post.content_type)) return 'photo';
  return null;
}

export function validateTikTokPost(post, { maxBytes }) {
  const errors = [];
  const warnings = [];
  const add = (field, message) => errors.push({ code: ErrorCode.VALIDATION_ERROR, field, message });
  const c = post.copy ?? {};
  const target = resolveTarget(post);
  if (post.platform !== 'tiktok') add('platform', 'El adaptador de TikTok solo acepta platform=tiktok');
  if (!target) add('content_type', 'TikTok solo admite vídeo o una publicación de fotos');
  else if (post.content_type && !(target === 'video' ? VIDEO_TYPES : PHOTO_TYPES).includes(post.content_type)) {
    add('content_type', 'El tipo no coincide con el destino del encargo');
  }
  if (post.format === 'carousel' && target === 'video') add('content_type', 'El carrusel del encargo no es un vídeo');
  if ((post.format === 'short_video' || post.format === 'video') && target === 'photo') {
    add('content_type', 'El vídeo del encargo no admite fotos');
  }
  const captionMax = target === 'photo' ? TT_PHOTO_CAPTION_MAX : TT_CAPTION_MAX;
  if (typeof c.caption !== 'string' || !c.caption.trim()) add('copy.caption', 'Caption obligatorio');
  if (c.caption && c.caption.length > captionMax) add('copy.caption', `Caption > ${captionMax} caracteres`);
  if (c.hashtags !== undefined && !Array.isArray(c.hashtags)) add('copy.hashtags', 'hashtags debe ser una lista');
  const m = post.media ?? {};
  if (target === 'photo') {
    if (!TT_PHOTO_MIME.includes(m.mime)) add('media.mime', 'Una foto de TikTok admite JPEG o WebP');
    const count = Number.isInteger(m.item_count) ? m.item_count : 1;
    const min = post.format === 'carousel' || post.content_type === 'carousel' ? 2 : 1;
    if (count < min || count > TT_PHOTO_MAX) add('media.item_count', `Una publicación de fotos admite de ${min} a ${TT_PHOTO_MAX} imágenes`);
    if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
    else if (m.size_bytes > Math.min(maxBytes, TT_PHOTO_MAX_BYTES)) add('media.size_bytes', 'Cada foto admite como máximo 20 MB');
    if ((m.width > 0) && (m.height > 0) && (m.width > TT_PHOTO_MAX_EDGE || m.height > TT_PHOTO_MAX_EDGE)) {
      add('media.width', `Cada lado admite como máximo ${TT_PHOTO_MAX_EDGE} px`);
    }
  } else if (target === 'video') {
    if (!TT_VIDEO_MIME.includes(m.mime)) add('media.mime', `Tipo de archivo incompatible: ${m.mime}`);
    if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
    else if (m.size_bytes > maxBytes) add('media.size_bytes', `Archivo > ${maxBytes} bytes (límite de la POC)`);
    if (m.duration_s == null) warnings.push(`No se ha comprobado la duración (máximo ${TT_VIDEO_MAX_SECONDS} s)`);
    else if (m.duration_s > TT_VIDEO_MAX_SECONDS) add('media.duration_s', `Un vídeo de TikTok no puede superar ${TT_VIDEO_MAX_SECONDS} s`);
    if (m.width > 0 && m.height > 0) {
      if (m.width < TT_MIN_EDGE || m.height < TT_MIN_EDGE || m.width > TT_MAX_EDGE || m.height > TT_MAX_EDGE) {
        add('media.width', `El vídeo admite entre ${TT_MIN_EDGE} y ${TT_MAX_EDGE} px por lado`);
      }
      if (m.width > m.height) warnings.push('Se recomienda formato vertical para TikTok');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function sniffTikTokMedia(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (ftyp === 'ftyp') return 'video/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return null;
}
