import { ErrorCode, providerError } from '../../../core/ports/social-publisher.js';
import { PublicationStatus as S } from '../../../core/domain/states.js';
import { validateInstagramPost, sniffInstagramMedia } from './instagram-rules.js';
import { takeVerifiedUpload, verifiedMediaCap } from '../verified-media.js';

export const INSTAGRAM_MOCK_URL_BASE = 'https://instagram.mock.invalid/p/';
const NOTICE = 'SIMULACIÓN (MOCK): no se ha publicado nada en Instagram.';

function mockPostId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const id = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 11);
  return `MOCK-IG-${id}`;
}

export class InstagramMockPublisher {
  constructor({ store, maxBytes = 20 * 1024 * 1024, now = () => new Date() }) {
    this.store = store;
    this.maxBytes = maxBytes;
    this.now = now;
    this.info = Object.freeze({ provider: 'instagram', mode: 'mock', live: false, implementation: 'InstagramMockPublisher' });
    this.callLog = [];
  }
  #base(extra) { return { mock: true, provider: 'instagram', notice: NOTICE, ...extra }; }
  #scenario(post) { return post?.test_controls?.mock_scenario ?? 'success'; }
  #log(op, detail) { this.callLog.push({ op, at: this.now().toISOString(), ...detail }); }
  async #rec(key) { return (await this.store.get(`ig:key:${key}`)) ?? { attempts: {}, post_id: null }; }
  async #save(key, rec) {
    const firstRef = rec.post_id && !rec.ref_saved;
    if (firstRef) rec.ref_saved = true;
    await this.store.put(`ig:key:${key}`, rec);
    if (firstRef) await this.store.put(`ig:post:${rec.post_id}`, { key });
  }
  async #byPost(postId) {
    const ref = await this.store.get(`ig:post:${postId}`);
    return ref ? { key: ref.key, rec: await this.#rec(ref.key) } : null;
  }

  async validatePost(post) {
    const r = validateInstagramPost(post, { maxBytes: verifiedMediaCap(post, this.maxBytes) });
    this.#log('validatePost', { publication_id: post.publication_id, ok: r.ok });
    return this.#base(r);
  }

  async uploadMedia(post, media) {
    const key = post.idempotency_key;
    const rec = await this.#rec(key);
    const scen = this.#scenario(post);
    rec.attempts.upload = (rec.attempts.upload ?? 0) + 1;
    rec.scenario = scen;
    this.#log('uploadMedia', { publication_id: post.publication_id, attempt: rec.attempts.upload, scenario: scen });
    if (scen === 'auth_error') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.AUTH_ERROR, 'MOCK 401: credenciales de Instagram inválidas o caducadas (simulado)', false) });
    }
    if ((scen === 'upload_transient_once' && rec.attempts.upload === 1) || scen === 'transient_always') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.UPLOAD_ERROR, 'MOCK 503: backend de subida temporalmente no disponible (simulado)', true) });
    }
    if (rec.post_id) {
      await this.#save(key, rec);
      return this.#base({ ok: true, upload_id: rec.post_id, duplicate: true });
    }
    const verified = takeVerifiedUpload(post, media);
    if (verified?.error) return this.#base({ ok: false, error: verified.error });
    const bytes = verified ? null : media?.bytes;
    const sniffed = verified ? verified.mime : sniffInstagramMedia(bytes);
    if (!verified) {
      if (!sniffed) return this.#base({ ok: false, error: providerError(ErrorCode.VALIDATION_ERROR, 'MOCK: firma de archivo no reconocida', false) });
      if (bytes.length !== post.media.size_bytes) return this.#base({ ok: false, error: providerError(ErrorCode.VALIDATION_ERROR, `MOCK: tamaño recibido ${bytes.length} != declarado ${post.media.size_bytes}`, false) });
      if (bytes.length > this.maxBytes) return this.#base({ ok: false, error: providerError(ErrorCode.VALIDATION_ERROR, 'MOCK: archivo demasiado grande', false) });
    }
    rec.post_id = mockPostId();
    rec.upload = { bytes: verified ? verified.size : bytes.length, detected_mime: sniffed, uploaded_at: this.now().toISOString(), content_type: post.content_type, ...(verified ? { verified: 'r2-sha256' } : {}) };
    rec.resource = { id: rec.post_id, caption: post.copy?.caption, media_type: post.content_type, status: 'processing' };
    await this.#save(key, rec);
    return this.#base({ ok: true, upload_id: rec.post_id, duplicate: false });
  }

  async publishPost(post, upload) {
    const key = post.idempotency_key;
    const rec = await this.#rec(key);
    const scen = this.#scenario(post);
    rec.attempts.publish = (rec.attempts.publish ?? 0) + 1;
    this.#log('publishPost', { publication_id: post.publication_id, attempt: rec.attempts.publish, scenario: scen });
    if (!rec.post_id || rec.post_id !== upload?.upload_id) return this.#base({ ok: false, error: providerError(ErrorCode.NOT_FOUND, 'MOCK: no existe la subida indicada', false) });
    if (rec.published) {
      await this.#save(key, rec);
      return this.#base({ ok: true, duplicate: true, provider_post_id: rec.post_id, status: S.PUBLISHED, url: INSTAGRAM_MOCK_URL_BASE + rec.post_id });
    }
    if ((scen === 'publish_transient_once' && rec.attempts.publish === 1) || scen === 'transient_always') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.PUBLISH_ERROR, 'MOCK 503: backend de publicación temporalmente no disponible (simulado)', true) });
    }
    if (scen === 'publish_permanent') {
      await this.#save(key, rec);
      return this.#base({ ok: false, error: providerError(ErrorCode.PUBLISH_ERROR, 'MOCK 403: publicación rechazada permanentemente (simulado)', false) });
    }
    rec.published = true;
    rec.publish_requested_at = this.now().toISOString();
    rec.status_polls = 0;
    await this.#save(key, rec);
    return this.#base({ ok: true, duplicate: false, provider_post_id: rec.post_id, status: S.PUBLISHING, url: INSTAGRAM_MOCK_URL_BASE + rec.post_id });
  }

  async getPublicationStatus(postId) {
    const found = await this.#byPost(postId);
    this.#log('getPublicationStatus', { provider_post_id: postId });
    if (!found) return this.#base({ ok: false, provider_post_id: postId, error: providerError(ErrorCode.NOT_FOUND, 'MOCK: publicación de Instagram no encontrada', false) });
    const { key, rec } = found;
    if (rec.published && rec.resource.status === 'processing') {
      rec.status_polls = (rec.status_polls ?? 0) + 1;
      if (rec.status_polls >= 1) {
        rec.resource.status = rec.scenario === 'processing_failed' ? 'failed' : 'published';
        if (rec.resource.status === 'published') rec.published_at = this.now().toISOString();
      }
      await this.#save(key, rec);
    }
    const status = !rec.published ? S.VALIDATED : rec.resource.status === 'published' ? S.PUBLISHED : rec.resource.status === 'failed' ? S.FAILED : S.PUBLISHING;
    return this.#base({ ok: true, provider_post_id: postId, status, processing_status: rec.resource.status,
      error: rec.resource.status === 'failed' ? providerError(ErrorCode.PROCESSING_ERROR, 'MOCK: falló el procesamiento de la publicación (simulado)', false) : undefined });
  }

  async getPublicationResult(postId) {
    const found = await this.#byPost(postId);
    if (!found) return this.#base({ ok: false, provider_post_id: postId, error: providerError(ErrorCode.NOT_FOUND, 'MOCK: publicación de Instagram no encontrada', false) });
    const { rec } = found;
    const status = rec.resource.status === 'published' ? S.PUBLISHED : rec.resource.status === 'failed' ? S.FAILED : S.PUBLISHING;
    return this.#base({ ok: true, provider_post_id: postId, status,
      url: rec.resource.status === 'published' ? INSTAGRAM_MOCK_URL_BASE + postId : null,
      published_at: rec.published_at ?? null, attempts: rec.attempts, raw: rec.resource });
  }
}
