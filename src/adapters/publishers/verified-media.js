// Un objeto ya comprobado con head() de R2 se publica sin volver a leer el cuerpo.
import { ErrorCode, providerError } from '../../core/ports/social-publisher.js';
import { MAX_FILE_BYTES } from '../../core/domain/r2-quota.js';

export const VERIFIED_R2 = 'r2-sha256';

export function verifiedMediaCap(post, maxBytes) {
  return post?.media?.verified === VERIFIED_R2 ? Math.max(maxBytes, MAX_FILE_BYTES) : maxBytes;
}

export function takeVerifiedUpload(post, media) {
  if (media?.verified !== VERIFIED_R2) return null;
  if (media.sha256 !== post?.media?.sha256) {
    return { error: providerError(ErrorCode.VALIDATION_ERROR, 'MOCK: el SHA-256 verificado no coincide', false) };
  }
  if (media.size_bytes !== post?.media?.size_bytes) {
    return { error: providerError(ErrorCode.VALIDATION_ERROR, 'MOCK: el tamaño verificado no coincide', false) };
  }
  if (!(media.size_bytes > 0) || media.size_bytes > MAX_FILE_BYTES) {
    return { error: providerError(ErrorCode.VALIDATION_ERROR, 'MOCK: archivo demasiado grande', false) };
  }
  return { size: media.size_bytes, mime: media.mime || post.media.mime };
}
