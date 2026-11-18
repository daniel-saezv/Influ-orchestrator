// ADAPTADOR MOCK de YouTube. Simula el comportamiento de YouTube Data API v3 (videos.insert,
// videos.update y videos.list) SIN realizar ninguna llamada de red. Todo lo que devuelve está
// marcado como MOCK y las URLs usan el dominio reservado ".invalid" (RFC 2606), que no resuelve.
//
// Escenarios simulables con post.test_controls.mock_scenario:
//   success (por defecto) | auth_error | upload_transient_once | publish_transient_once |
//   transient_always | publish_permanent | processing_failed
import { ErrorCode, providerError } from '../../../core/ports/social-publisher.js';
import { PublicationStatus as S } from '../../../core/domain/states.js';
import { validateYouTubePost, sniffVideo, buildDescription } from './youtube-rules.js';
import { takeVerifiedUpload, verifiedMediaCap } from '../verified-media.js';

export const MOCK_URL_BASE = 'https://youtube.mock.invalid/watch?v=';
const NOTICE = 'SIMULACIÓN (MOCK): no se ha publicado nada en YouTube.';

function mockVideoId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const id = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 11);
  return `MOCK-YT-${id}`;
}

export class YouTubeMockPublisher {
  /** @param {{ store: { get(k):Promise<any>, put(k,v):Promise<void> }, maxBytes?: number, now?: () => Date }} deps */
  constructor({ store, maxBytes = 20 * 1024 * 1024, now = () => new Date() }) {
    this.store = store;
    this.maxBytes = maxBytes;
    this.now = now;
    this.info = Object.freeze({ provider: 'youtube', mode: 'mock', live: false, implementation: 'YouTubeMockPublisher' });
    this.callLog = []; // operaciones simuladas en esta invocación (para trazas)
  }

  #base(extra) { return { mock: true, provider: 'youtube', notice: NOTICE, ...extra }; }
  #scenario(post) { return post?.test_controls?.mock_scenario ?? 'success'; }
  #log(op, detail) { this.callLog.push({ op, at: this.now().toISOString(), ...detail }); }
  async #rec(key) { return (await this.store.get(`yt:key:${key}`)) ?? { attempts: {}, video_id: null }; }
  async #save(key, rec) {
    const firstRef = rec.video_id && !rec.ref_saved;
    if (firstRef) rec.ref_saved = true;
    await this.store.put(`yt:key:${key}`, rec);
    if (firstRef) await this.store.put(`yt:video:${rec.video_id}`, { key });
  }
  async #byVideo(videoId) {
    const ref = await this.store.get(`yt:video:${videoId}`);
    return ref ? { key: ref.key, rec: await this.#rec(ref.key) } : null;
  }

  async validatePost(post) {
    const r = validateYouTubePost(post, { maxBytes: verifiedMediaCap(post, this.maxBytes) });
    this.#log('validatePost', { publication_id: post.publication_id, ok: r.ok });
    return this.#base(r);
  }

  // Equivalente LIVE: videos.insert (uploadType=resumable, part=snippet,status) con privacyStatus=private.
  async uploadMedia(post, media) {
    const key = post.idempotency_key;
    const rec = await this.#rec(key);
    const scen = this.#scenario(post);
    rec.attempts.upload = (rec.attempts.upload ?? 0) + 1;
    rec.scenario = scen;
    this.#log('uploadMedia', { publication_id: post.publication_id, attempt: rec.attempts.upload, scenario: scen });
    if (scen === 'auth_error') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.AUTH_ERROR, 'MOCK 401 authError: credenciales OAuth inválidas o caducadas (simulado)', false) });
    }
    if ((scen === 'upload_transient_once' && rec.attempts.upload === 1) || scen === 'transient_always') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.UPLOAD_ERROR, 'MOCK 503 backendError durante la subida reanudable (simulado)', true) });
    }
    if (rec.video_id) { // idempotencia: el archivo ya se subió para esta publicación
      await this.#save(key, rec);
      return this.#base({ ok: true, upload_id: rec.video_id, duplicate: true });
    }
    const verified = takeVerifiedUpload(post, media);
    if (verified?.error) return this.#base({ ok: false, error: verified.error });
    const bytes = verified ? null : media?.bytes;
    const sniffed = verified ? verified.mime : sniffVideo(bytes);
    if (!verified) {
      if (!sniffed) return this.#base({ ok: false, error: providerError(ErrorCode.VALIDATION_ERROR, 'MOCK: el contenido del archivo no es un vídeo reconocible (firma inválida)', false) });
      if (bytes.length !== post.media.size_bytes) return this.#base({ ok: false, error: providerError(ErrorCode.VALIDATION_ERROR, `MOCK: tamaño recibido ${bytes.length} != declarado ${post.media.size_bytes}`, false) });
      if (bytes.length > this.maxBytes) return this.#base({ ok: false, error: providerError(ErrorCode.VALIDATION_ERROR, 'MOCK: archivo demasiado grande', false) });
    }
    rec.video_id = mockVideoId();
    rec.upload = { bytes: verified ? verified.size : bytes.length, detected_mime: sniffed, uploaded_at: this.now().toISOString(), ...(verified ? { verified: 'r2-sha256' } : {}) };
    rec.video = {
      id: rec.video_id,
      snippet: { title: post.copy.title, description: buildDescription(post.copy), tags: post.copy.tags ?? [], categoryId: post.copy.category_id },
      status: { uploadStatus: 'uploaded', privacyStatus: 'private', selfDeclaredMadeForKids: post.copy.made_for_kids, containsSyntheticMedia: post.copy.contains_synthetic_media },
      processingDetails: { processingStatus: 'processing' },
    };
    await this.#save(key, rec);
    return this.#base({ ok: true, upload_id: rec.video_id, duplicate: false });
  }

  // Equivalente LIVE: videos.update (part=status) fijando privacyStatus final / publishAt.
  async publishPost(post, upload) {
    const key = post.idempotency_key;
    const rec = await this.#rec(key);
    const scen = this.#scenario(post);
    rec.attempts.publish = (rec.attempts.publish ?? 0) + 1;
    this.#log('publishPost', { publication_id: post.publication_id, attempt: rec.attempts.publish, scenario: scen });
    if (!rec.video_id || rec.video_id !== upload?.upload_id) {
      return this.#base({ ok: false, error: providerError(ErrorCode.NOT_FOUND, 'MOCK: no existe la subida indicada', false) });
    }
    if (rec.published) { // publicación duplicada: no se crea nada nuevo
      await this.#save(key, rec);
      return this.#base({ ok: true, duplicate: true, provider_post_id: rec.video_id, status: S.PUBLISHED, url: MOCK_URL_BASE + rec.video_id });
    }
    if ((scen === 'publish_transient_once' && rec.attempts.publish === 1) || scen === 'transient_always') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.PUBLISH_ERROR, 'MOCK 503 backendError al actualizar el estado del vídeo (simulado)', true) });
    }
    if (scen === 'publish_permanent') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.PUBLISH_ERROR, 'MOCK 403 forbiddenPrivacySetting: configuración de privacidad no permitida (simulado, permanente)', false) });
    }
    rec.video.status.privacyStatus = post.copy.privacy_status;
    rec.published = true;
    rec.publish_requested_at = this.now().toISOString();
    rec.status_polls = 0;
    await this.#save(key, rec);
    return this.#base({ ok: true, duplicate: false, provider_post_id: rec.video_id, status: S.PUBLISHING, url: MOCK_URL_BASE + rec.video_id });
  }

  // Equivalente LIVE: videos.list (part=status,processingDetails, id=VIDEO_ID).
  async getPublicationStatus(videoId) {
    const found = await this.#byVideo(videoId);
    this.#log('getPublicationStatus', { provider_post_id: videoId });
    if (!found) return this.#base({ ok: false, provider_post_id: videoId, error: providerError(ErrorCode.NOT_FOUND, 'MOCK: vídeo no encontrado', false) });
    const { key, rec } = found;
    if (rec.published && rec.video.processingDetails.processingStatus === 'processing') {
      rec.status_polls = (rec.status_polls ?? 0) + 1;
      if (rec.status_polls >= 1) {
        const failed = rec.scenario === 'processing_failed';
        rec.video.processingDetails.processingStatus = failed ? 'failed' : 'succeeded';
        rec.video.status.uploadStatus = failed ? 'failed' : 'processed';
        if (!failed) rec.published_at = this.now().toISOString();
      }
      await this.#save(key, rec);
    }
    const ps = rec.video.processingDetails.processingStatus;
    const status = !rec.published ? S.VALIDATED : ps === 'succeeded' ? S.PUBLISHED : ps === 'failed' ? S.FAILED : S.PUBLISHING;
    return this.#base({
      ok: true, provider_post_id: videoId, status, processing_status: ps, upload_status: rec.video.status.uploadStatus,
      error: ps === 'failed' ? providerError(ErrorCode.PROCESSING_ERROR, 'MOCK: falló el procesamiento del vídeo (simulado)', false) : undefined,
    });
  }

  async getPublicationResult(videoId) {
    const found = await this.#byVideo(videoId);
    if (!found) return this.#base({ ok: false, provider_post_id: videoId, error: providerError(ErrorCode.NOT_FOUND, 'MOCK: vídeo no encontrado', false) });
    const { rec } = found;
    const ps = rec.video.processingDetails.processingStatus;
    return this.#base({
      ok: true, provider_post_id: videoId,
      status: ps === 'succeeded' ? S.PUBLISHED : ps === 'failed' ? S.FAILED : S.PUBLISHING,
      url: ps === 'succeeded' ? MOCK_URL_BASE + videoId : null,
      published_at: rec.published_at ?? null,
      attempts: rec.attempts,
      raw: rec.video, // recurso "video" simulado con la forma de YouTube Data API v3
    });
  }
}
