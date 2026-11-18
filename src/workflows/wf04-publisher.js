// WF-04 PUBLISHER_AND_ERROR_HANDLER — invoca el adaptador (SocialPublisher) de la plataforma,
// registra respuestas, gestiona errores y reintentos limitados, consulta estados y registra
// IDs/URLs (simulados en modo MOCK).
import { PublicationStatus as PS } from '../core/domain/states.js';
import { sha256Hex } from '../core/domain/hash.js';
import { MAX_CLASS_B_GLOBAL, MAX_CLASS_B_USER } from '../core/domain/r2-quota.js';
import { ErrorCode } from '../core/ports/social-publisher.js';
import { VERIFIED_R2 } from '../adapters/publishers/verified-media.js';

export async function publishOne(pub, ctx) {
  const adapter = ctx.registry.forPlatform(pub.platform);
  const post = pub.post_normalized ?? normalizedFromRow(pub);
  const events = [];
  const ev = (op, detail, from, to) => events.push({ op, detail: { mock: adapter.info.mode === 'mock', ...detail }, from, to, at: ctx.now() });
  const base = { provider: adapter.info.provider, provider_mode: adapter.info.mode };
  ev('DISPATCH_CLAIMED', { attempt: pub.attempts, adapter: adapter.info.implementation }, pub.claimed_from ?? null, PS.PUBLISHING);

  const fail = async (error, stage) => {
    const errors = [...(pub.errors ?? []), { at: ctx.now(), stage, attempt: pub.attempts, ...error }];
    const canRetry = error.retryable && pub.attempts < ctx.settings.maxAttempts;
    const status = canRetry ? PS.RETRY_PENDING : PS.FAILED;
    const next = canRetry ? new Date(Date.parse(ctx.now()) + ctx.settings.retryBaseSeconds * 1000 * 2 ** (pub.attempts - 1)).toISOString() : null;
    ev(canRetry ? 'RETRY_SCHEDULED' : 'FAILED', { stage, error, next_retry_at: next, attempts: pub.attempts, max_attempts: ctx.settings.maxAttempts }, PS.PUBLISHING, status);
    await ctx.repo.savePublicationOutcome(pub, { ...base, status, errors, next_retry_at: next }, events, ctx.now());
    return { publication_id: pub.publication_id, status, stage, error, attempts: pub.attempts, next_retry_at: next };
  };

  const loaded = await resolvePublishMedia(post, ctx);
  if (loaded.error) return fail(loaded.error, 'storage');
  if (loaded.verified) post.media = { ...post.media, verified: 'r2-sha256' };

  const v = await adapter.validatePost(post);
  ev('VALIDATE', { ok: v.ok, errors: v.errors });
  if (!v.ok) return fail({ code: ErrorCode.VALIDATION_ERROR, message: (v.errors ?? []).map((e) => e.message).join('; '), retryable: false }, 'validatePost');

  const up = await adapter.uploadMedia(post, loaded.media);
  ev('UPLOAD_MEDIA', { ok: up.ok, upload_id: up.upload_id, duplicate: up.duplicate, error: up.error });
  if (!up.ok) return fail(up.error, 'uploadMedia');

  const pr = await adapter.publishPost(post, up);
  ev('PUBLISH_POST', { ok: pr.ok, provider_post_id: pr.provider_post_id, status: pr.status, duplicate: pr.duplicate, error: pr.error });
  if (!pr.ok) return fail(pr.error, 'publishPost');

  let st = { status: pr.status };
  for (let i = 0; i < ctx.settings.maxStatusPolls && st.status !== PS.PUBLISHED; i++) {
    st = await adapter.getPublicationStatus(pr.provider_post_id);
    ev('GET_STATUS', { poll: i + 1, status: st.status, processing_status: st.processing_status, error: st.error });
    if (!st.ok || st.status === PS.FAILED) return fail(st.error ?? { code: ErrorCode.PROCESSING_ERROR, message: 'Estado no disponible', retryable: true }, 'getPublicationStatus');
  }
  if (st.status !== PS.PUBLISHED) return fail({ code: ErrorCode.PROCESSING_ERROR, message: 'El proveedor sigue procesando el vídeo', retryable: true }, 'getPublicationStatus');

  const res = await adapter.getPublicationResult(pr.provider_post_id);
  ev('GET_RESULT', { provider_post_id: res.provider_post_id, url: res.url, published_at: res.published_at, notice: res.notice });
  ev('PUBLISHED', { provider_post_id: pr.provider_post_id, url: res.url, duplicate: !!pr.duplicate }, PS.PUBLISHING, PS.PUBLISHED);
  await ctx.repo.savePublicationOutcome(pub, { ...base, status: PS.PUBLISHED, provider_post_id: pr.provider_post_id, published_url: res.url, errors: pub.errors ?? [], next_retry_at: null }, events, ctx.now());
  return { publication_id: pub.publication_id, status: PS.PUBLISHED, provider_post_id: pr.provider_post_id, url: res.url, mock: res.mock, duplicate: !!pr.duplicate, attempts: pub.attempts };
}

export async function resolvePublishMedia(post, ctx) {
  const asset = ctx.repo.assetBySha ? await ctx.repo.assetBySha(post.media.sha256) : null;
  if (asset) {
    if (!ctx.r2) return { error: { code: 'MEDIA_UNAVAILABLE', message: 'R2 no está disponible', retryable: true } };
    let reserved = false;
    try {
      reserved = await ctx.repo.reserveDaily(asset.user_id, 'b', ctx.now(), MAX_CLASS_B_USER, MAX_CLASS_B_GLOBAL);
    } catch (error) {
      return { error: { code: 'MEDIA_UNAVAILABLE', message: error.message, retryable: true } };
    }
    if (!reserved) return { error: { code: 'QUOTA_EXCEEDED', message: 'Tope de lecturas de R2', retryable: true } };
    let head;
    try {
      head = await ctx.r2.head(asset.r2_key);
    } catch {
      await ctx.repo.releaseDaily(asset.user_id, 'b', ctx.now());
      return { error: { code: 'MEDIA_UNAVAILABLE', message: 'No se pudo leer el objeto', retryable: true } };
    }
    if (!head || head.sha256 !== post.media.sha256 || head.size !== post.media.size_bytes) {
      return {
        error: {
          code: head ? 'MEDIA_INTEGRITY' : 'MEDIA_UNAVAILABLE',
          message: head ? 'El objeto de R2 no es el aprobado' : 'Archivo no disponible en R2',
          retryable: !head,
        },
      };
    }
    return {
      verified: true,
      media: { verified: VERIFIED_R2, sha256: head.sha256, size_bytes: head.size, mime: head.mime || post.media.mime },
    };
  }
  const stored = await ctx.media.get(post.media.sha256);
  if (!stored) return { error: { code: 'MEDIA_UNAVAILABLE', message: 'Archivo no disponible en el almacenamiento', retryable: true } };
  const realSha = await sha256Hex(stored.bytes);
  if (realSha !== post.media.sha256) return { error: { code: 'MEDIA_INTEGRITY', message: 'La huella del archivo almacenado no coincide', retryable: false } };
  return { verified: false, media: { bytes: stored.bytes, mime: stored.mime, size_bytes: stored.bytes.length, sha256: realSha } };
}

function normalizedFromRow(p) {
  const post = p.post;
  return {
    publication_id: p.publication_id, batch_id: p.batch_id, batch_version: p.batch_version,
    platform: p.platform, content_type: p.content_type, media: post.media, copy: post.copy,
    scheduled_at: p.scheduled_at, settings: post.settings, test_controls: post.test_controls,
    idempotency_key: p.idempotency_key,
  };
}
