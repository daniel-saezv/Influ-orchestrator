import { ErrorCode } from '../../../core/ports/social-publisher.js';

export const TT_ACCEPTED_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];

export function validateTikTokPost(post, { maxBytes }) {
  const errors = [];
  const warnings = [];
  const add = (field, message) => errors.push({ code: ErrorCode.VALIDATION_ERROR, field, message });
  const c = post.copy ?? {};
  if (post.platform !== 'tiktok') add('platform', 'El adaptador de TikTok solo acepta platform=tiktok');
  if (post.content_type !== 'reel') add('content_type', 'TikTok solo admite reel');
  if (typeof c.caption !== 'string' || !c.caption.trim()) add('copy.caption', 'Caption obligatorio');
  if (c.caption && c.caption.length > 2200) add('copy.caption', 'Caption > 2200 caracteres');
  if (c.hashtags !== undefined && !Array.isArray(c.hashtags)) add('copy.hashtags', 'hashtags debe ser una lista');
  const m = post.media ?? {};
  if (!TT_ACCEPTED_MIME.includes(m.mime)) add('media.mime', `Tipo de archivo incompatible: ${m.mime}`);
  if (!(m.size_bytes > 0)) add('media.size_bytes', 'Archivo vacío');
  else if (m.size_bytes > maxBytes) add('media.size_bytes', `Archivo > ${maxBytes} bytes (límite de la POC)`);
  if (m.duration_s != null && m.duration_s > 600) add('media.duration_s', 'Un vídeo de TikTok no puede superar 600 s');
  if (m.width && m.height && m.width > m.height) warnings.push('Se recomienda formato vertical 9:16 para TikTok');
  return { ok: errors.length === 0, errors, warnings };
}

export function sniffTikTokMedia(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (ftyp === 'ftyp') return 'video/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return null;
}
