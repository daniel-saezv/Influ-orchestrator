import { err } from './errors.js';
import { SUPPORTED_PLATFORMS } from './batch.js';

export const FORMATS = Object.freeze(['image', 'carousel', 'short_video', 'video']);

export const FORMAT_TARGETS = Object.freeze({
  image: Object.freeze({
    instagram: Object.freeze(['feed', 'story']),
    tiktok: Object.freeze(['photo']),
  }),
  carousel: Object.freeze({
    instagram: Object.freeze(['feed']),
    tiktok: Object.freeze(['photo']),
  }),
  short_video: Object.freeze({
    youtube: Object.freeze(['short']),
    instagram: Object.freeze(['reel', 'story']),
    tiktok: Object.freeze(['video']),
  }),
  video: Object.freeze({
    youtube: Object.freeze(['video']),
    instagram: Object.freeze(['reel']),
    tiktok: Object.freeze(['video']),
  }),
});

const MEDIA_MIME = /^(image|video)\/[\w.+-]+$/;
const AUDIO_MIME = /^audio\/[\w.+-]+$/;

export function assertEncargoSelection(body) {
  const format = body?.format;
  if (!FORMATS.includes(format)) throw err('INVALID_INPUT', 'Elige un formato', 400);
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    throw err('INVALID_INPUT', 'Elige al menos un destino', 400);
  }
  const allowed = FORMAT_TARGETS[format];
  const seen = new Set();
  const targets = [];
  for (const item of body.targets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw err('INVALID_INPUT', 'Destino no válido', 400);
    }
    const { platform, target } = item;
    const options = allowed[platform];
    if (!options || !options.includes(target)) {
      throw err('INVALID_INPUT', 'Ese destino no encaja con el formato', 400);
    }
    if (seen.has(platform)) throw err('INVALID_INPUT', 'Un destino por red', 400);
    seen.add(platform);
    targets.push({ platform, target });
  }
  const platforms = SUPPORTED_PLATFORMS.filter((platform) => seen.has(platform));
  return { format, targets, platforms };
}

export function assertDeliverableMime(format, mime) {
  if (typeof mime === 'string' && AUDIO_MIME.test(mime)) {
    throw err('DELIVERABLE_FORMAT_MISMATCH', 'El audio ya no es una pieza válida', 400);
  }
  if (typeof mime !== 'string' || !MEDIA_MIME.test(mime)) {
    throw err('INVALID_INPUT', 'mime no admitido', 400);
  }
  const image = mime.startsWith('image/');
  if (format == null) return mime;
  if (format === 'image' || format === 'carousel') {
    if (!image) throw err('DELIVERABLE_FORMAT_MISMATCH', 'Este encargo pide una imagen', 400);
    return mime;
  }
  if (format === 'short_video' || format === 'video') {
    if (image) throw err('DELIVERABLE_FORMAT_MISMATCH', 'Este encargo pide un vídeo', 400);
    return mime;
  }
  throw err('DELIVERABLE_FORMAT_MISMATCH', 'El formato del encargo no admite esta pieza', 400);
}
