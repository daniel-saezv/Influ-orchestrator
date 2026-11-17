// PUERTO: SocialPublisher — contrato común que implementa CADA proveedor (mock o live).
// La lógica general del sistema solo conoce este contrato; nunca APIs concretas de redes.
//
// Datos normalizados de entrada (NormalizedPost):
// {
//   publication_id, batch_id, batch_version, platform, content_type,
//   media: { sha256, mime, size_bytes, filename, duration_s, width, height },
//   copy: { title, description, tags[], hashtags[], caption, category_id, privacy_status,
//           made_for_kids, contains_synthetic_media },
//   scheduled_at (ISO), settings, test_controls, idempotency_key
// }
//
// Respuestas normalizadas (todas incluyen `mock: boolean` y `provider`):
//   validatePost(post)                    -> { ok, errors:[{code,field,message}], warnings:[] }
//   uploadMedia(post, media{bytes,...})   -> { ok, upload_id, error? }
//   publishPost(post, upload)             -> { ok, provider_post_id, status, url, duplicate, error? }
//   getPublicationStatus(provider_post_id)-> { ok, provider_post_id, status, processing_status, error? }
//   getPublicationResult(provider_post_id)-> { ok, provider_post_id, status, url, published_at, raw }
//
// `status` usa los estados comunes de PublicationStatus.
// `error` = { code, message, retryable } con code en ErrorCode.

export const ErrorCode = Object.freeze({
  AUTH_ERROR: 'AUTH_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UPLOAD_ERROR: 'UPLOAD_ERROR',
  PUBLISH_ERROR: 'PUBLISH_ERROR',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  NOT_FOUND: 'NOT_FOUND',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  LIVE_DISABLED: 'LIVE_DISABLED',
});

export const SOCIAL_PUBLISHER_METHODS = ['validatePost', 'uploadMedia', 'publishPost', 'getPublicationStatus', 'getPublicationResult'];

export function assertSocialPublisher(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('Adaptador inválido');
  for (const m of SOCIAL_PUBLISHER_METHODS) {
    if (typeof adapter[m] !== 'function') throw new Error(`El adaptador ${adapter.info?.provider ?? '?'} no implementa ${m}()`);
  }
  if (!adapter.info || !adapter.info.provider || !adapter.info.mode) throw new Error('El adaptador debe exponer info { provider, mode }');
  return adapter;
}

export const providerError = (code, message, retryable = false) => ({ code, message, retryable });
