import { ErrorCode } from '../../../core/ports/social-publisher.js';

export const IG_ACCEPTED_CONTENT_TYPES = ['reel', 'image', 'carousel', 'story'];
export const IG_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IG_REEL_MIN_SECONDS = 3;
export const IG_REEL_MAX_SECONDS = 15 * 60;
export const IG_STORY_MIN_SECONDS = 3;
export const IG_STORY_MAX_SECONDS = 60;
export const IG_CAROUSEL_MIN = 2;
export const IG_CAROUSEL_MAX = 20;
export const IG_FEED_MIN_RATIO = 4 / 5;
export const IG_FEED_MAX_RATIO = 1.91;

const TARGET_TYPES = {
  feed: ['image', 'carousel'],
  reel: ['reel'],
  story: ['story'],
};
const VIDEO_MIME = ['video/mp4', 'video/quicktime'];

function resolveTarget(post) {
  if (post.target === 'feed' || post.target === 'reel' || post.target === 'story') return post.target;
  if (post.content_type === 'image' || post.content_type === 'carousel') return 'feed';
  if (post.content_type === 'reel') return 'reel';
  if (post.content_type === 'story') return 'story';
  return null;
}

function shape(post, target) {
  if (post.format === 'carousel' || post.content_type === 'carousel') return 'carousel';
  if (target === 'reel') return 'reel';
  if (target === 'story') return 'story';
  return 'image';
}

function ratio(media) {
  if (!(media.width > 0) || !(media.height > 0)) return null;
  return media.width / media.height;
}

export function validateInstagramPost(post, { maxBytes }) {
  const errors = [];
  const warnings = [];
  const add = (field, message) => errors.push({ code: ErrorCode.VALIDATION_ERROR, field, message });
  const c = post.copy ?? {};
  const target = resolveTarget(post);
  if (post.platform !== 'instagram') add('platform', 'El adaptador de Instagram solo acepta platform=instagram');
  if (!target) add('content_type', 'Instagram solo admite feed, reel o story');
  else if (post.content_type && !TARGET_TYPES[target].includes(post.content_type)) {
    add('content_type', 'El tipo no coincide con el destino del encargo');
  }
  if (post.format === 'carousel' && post.content_type && post.content_type !== 'carousel') {
    add('content_type', 'El carrusel del encargo no admite este tipo');
  }
  if (post.format === 'image' && post.content_type && !['image', 'story'].includes(post.content_type)) {
    add('content_type', 'La foto del encargo no admite este tipo');
  }
  if ((post.format === 'short_video' || post.format === 'video') && post.content_type === 'image') {
    add('content_type', 'El vídeo del encargo no admite una imagen');
  }
  if (typeof c.caption !== 'string' || !c.caption.trim()) add('copy.caption', 'Caption obligatorio');
  if (c.hashtags !== undefined && !Array.isArray(c.hashtags)) add('copy.hashtags', 'hashtags debe ser una lista');
  const m = post.media ?? {};
  const kind = target ? shape(post, target) : null;
  const cap = (limit) => Math.min(maxBytes, limit);
  if (kind === 'reel') {
    if (!VIDEO_MIME.includes(m.mime)) add('media.mime', 'Un reel debe usar vídeo MP4 o MOV');
    if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
    else if (m.size_bytes > cap(300 * 1024 * 1024)) add('media.size_bytes', `Archivo > ${cap(300 * 1024 * 1024)} bytes`);
    if (m.duration_s == null) warnings.push(`No se ha comprobado la duración del reel (${IG_REEL_MIN_SECONDS}–${IG_REEL_MAX_SECONDS} s)`);
    else if (m.duration_s < IG_REEL_MIN_SECONDS || m.duration_s > IG_REEL_MAX_SECONDS) {
      add('media.duration_s', `Un reel dura entre ${IG_REEL_MIN_SECONDS} s y ${IG_REEL_MAX_SECONDS} s`);
    }
  } else if (kind === 'carousel') {
    const count = m.item_count;
    if (!Number.isInteger(count) || count < IG_CAROUSEL_MIN || count > IG_CAROUSEL_MAX) {
      add('media.item_count', `Un carrusel admite de ${IG_CAROUSEL_MIN} a ${IG_CAROUSEL_MAX} imágenes`);
    }
    if (m.mime !== 'image/jpeg') add('media.mime', 'Un carrusel de feed solo admite JPEG');
    if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
    else if (m.size_bytes > cap(IG_IMAGE_MAX_BYTES)) add('media.size_bytes', 'Cada imagen del carrusel admite como máximo 8 MB');
    const aspect = ratio(m);
    if (aspect == null) warnings.push('No se ha comprobado la relación de aspecto del carrusel (de 4:5 a 1,91:1)');
    else if (aspect < IG_FEED_MIN_RATIO || aspect > IG_FEED_MAX_RATIO) add('media.width', 'La relación de aspecto tiene que estar entre 4:5 y 1,91:1');
  } else if (kind === 'story') {
    const video = VIDEO_MIME.includes(m.mime);
    const image = m.mime === 'image/jpeg';
    if (!video && !image) add('media.mime', 'Una story admite JPEG o vídeo MP4/MOV');
    if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
    else if (image && m.size_bytes > cap(IG_IMAGE_MAX_BYTES)) add('media.size_bytes', 'Una imagen de story admite como máximo 8 MB');
    else if (video && m.size_bytes > cap(100 * 1024 * 1024)) add('media.size_bytes', `Archivo > ${cap(100 * 1024 * 1024)} bytes`);
    if (video) {
      if (m.duration_s == null) warnings.push(`No se ha comprobado la duración de la story (máximo ${IG_STORY_MAX_SECONDS} s)`);
      else if (m.duration_s < IG_STORY_MIN_SECONDS || m.duration_s > IG_STORY_MAX_SECONDS) {
        add('media.duration_s', `Un vídeo de story dura entre ${IG_STORY_MIN_SECONDS} s y ${IG_STORY_MAX_SECONDS} s`);
      }
    }
  } else if (kind === 'image') {
    if (m.mime !== 'image/jpeg') add('media.mime', 'Una foto de feed solo admite JPEG');
    if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
    else if (m.size_bytes > cap(IG_IMAGE_MAX_BYTES)) add('media.size_bytes', 'Una foto de feed admite como máximo 8 MB');
    const aspect = ratio(m);
    if (aspect == null) warnings.push('No se ha comprobado la relación de aspecto (de 4:5 a 1,91:1)');
    else if (aspect < IG_FEED_MIN_RATIO || aspect > IG_FEED_MAX_RATIO) add('media.width', 'La relación de aspecto tiene que estar entre 4:5 y 1,91:1');
  }
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
