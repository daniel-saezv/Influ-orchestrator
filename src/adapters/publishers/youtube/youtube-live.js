// ADAPTADOR LIVE de YouTube — NO IMPLEMENTADO EN LA FASE 1 (deshabilitado por diseño).
// Este archivo solo fija el hueco y la correspondencia con la API oficial. Ningún método
// realiza llamadas de red: todos devuelven LIVE_DISABLED.
//
// Correspondencia prevista con YouTube Data API v3 (documentación oficial):
//   validatePost          -> validación local (youtube-rules.js) + videoCategories.list para categoryId
//   uploadMedia           -> videos.insert: POST https://www.googleapis.com/upload/youtube/v3/videos
//                            ?uploadType=resumable&part=snippet,status  (privacyStatus=private al subir)
//   publishPost           -> videos.update: PUT https://www.googleapis.com/youtube/v3/videos?part=status
//                            (privacyStatus final o publishAt; publishAt requiere privacyStatus=private)
//   getPublicationStatus  -> videos.list: GET https://www.googleapis.com/youtube/v3/videos
//                            ?part=status,processingDetails&id=VIDEO_ID
//   getPublicationResult  -> videos.list (part=snippet,status,processingDetails) + URL https://www.youtube.com/watch?v=VIDEO_ID
// Autorización: OAuth 2.0, ámbito https://www.googleapis.com/auth/youtube.upload
// (videos.update/list pueden requerir https://www.googleapis.com/auth/youtube).
// Cuota (doc. videos.insert, consultada 2026-11-17): 100 llamadas/día, 1 unidad en el cubo "Video Uploads".
import { ErrorCode, providerError } from '../../../core/ports/social-publisher.js';

const disabled = () => ({ ok: false, mock: false, provider: 'youtube', error: providerError(ErrorCode.LIVE_DISABLED, 'YouTube LIVE no está implementado ni habilitado en la Fase 1', false) });

export class YouTubeLivePublisher {
  constructor() {
    this.info = Object.freeze({ provider: 'youtube', mode: 'live', live: true, implementation: 'YouTubeLivePublisher (stub deshabilitado)' });
  }
  async validatePost() { return disabled(); }
  async uploadMedia() { return disabled(); }
  async publishPost() { return disabled(); }
  async getPublicationStatus() { return disabled(); }
  async getPublicationResult() { return disabled(); }
}
