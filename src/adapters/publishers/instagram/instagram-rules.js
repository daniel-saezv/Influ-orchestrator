import { ErrorCode } from '../../../core/ports/social-publisher.js';

export const IG_ACCEPTED_CONTENT_TYPES = ['reel', 'image', 'carousel', 'story'];
export const IG_ACCEPTED_MIME = ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'];

export function validateInstagramPost(post, { maxBytes }) {
  const errors = [];
  const warnings = [];
  const add = (field, message) => errors.push({ code: ErrorCode.VALIDATION_ERROR, field, message });
  const c = post.copy ?? {};
  if (post.platform !== 'instagram') add('platform', 'El adaptador de Instagram solo acepta platform=instagram');
  if (!IG_ACCEPTED_CONTENT_TYPES.includes(post.content_type)) add('content_type', 'Instagram solo admite reel, image, carousel o story');
  if (typeof c.caption !== 'string' || !c.caption.trim()) add('copy.caption', 'Caption obligatorio');
  if (c.hashtags !== undefined && !Array.isArray(c.hashtags)) add('copy.hashtags', 'hashtags debe ser una lista');
  const m = post.media ?? {};
  if (!IG_ACCEPTED_MIME.includes(m.mime)) add('media.mime', `Tipo de archivo incompatible: ${m.mime}`);
  if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
  else if (m.size_bytes > maxBytes) add('media.size_bytes', `Archivo > ${maxBytes} bytes (límite de la POC)`);
  if (post.content_type === 'reel') {
    if (!['video/mp4', 'video/quicktime'].includes(m.mime)) add('media.mime', 'Un reel debe usar vídeo MP4/MOV');
  } else if (post.content_type !== 'carousel') {
    if (!['image/jpeg', 'image/png'].includes(m.mime)) add('media.mime', `${post.content_type} debe usar una imagen JPEG/PNG`);
  }
  if (post.content_type === 'carousel' && m.mime && !['image/jpeg', 'image/png'].includes(m.mime)) {
    add('media.mime', 'Un carrusel debe usar imágenes JPEG/PNG');
  }
  if (post.content_type === 'reel' && m.duration_s != null && m.duration_s > 90) add('media.duration_s', 'Un reel no puede superar 90 s');
  return { ok: errors.length === 0, errors, warnings };
}

export function sniffInstagramMedia(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (ftyp === 'ftyp') return 'video/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/mp4';
  return null;
}
