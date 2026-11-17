// HUECO PREPARADO para TikTok. No implementado en la Fase 1.
// Para añadirlo: crear tiktok-mock.js y tiktok-live.js que implementen SocialPublisher
// y registrarlos en src/adapters/publishers/registry.js. Ver docs/guia-nuevos-adaptadores.md.
import { ErrorCode, providerError } from '../../../core/ports/social-publisher.js';

const notImpl = () => ({ ok: false, mock: true, provider: 'tiktok', errors: [{ code: ErrorCode.NOT_IMPLEMENTED, field: 'platform', message: 'Adaptador de TikTok aún no implementado (Fase 1)' }], error: providerError(ErrorCode.NOT_IMPLEMENTED, 'Adaptador de TikTok aún no implementado (Fase 1)', false) });

export class TikTokPlaceholderPublisher {
  constructor() { this.info = Object.freeze({ provider: 'tiktok', mode: 'mock', live: false, implementation: 'TikTokPlaceholderPublisher (sin implementar)' }); }
  async validatePost() { return notImpl(); }
  async uploadMedia() { return notImpl(); }
  async publishPost() { return notImpl(); }
  async getPublicationStatus() { return notImpl(); }
  async getPublicationResult() { return notImpl(); }
}
