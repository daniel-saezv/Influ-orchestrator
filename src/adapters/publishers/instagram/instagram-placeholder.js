// HUECO PREPARADO para Instagram. No implementado en la Fase 1.
// Para añadirlo: crear instagram-mock.js y instagram-live.js que implementen SocialPublisher
// y registrarlos en src/adapters/publishers/registry.js. Ver docs/guia-nuevos-adaptadores.md.
import { ErrorCode, providerError } from '../../../core/ports/social-publisher.js';

const notImpl = () => ({ ok: false, mock: true, provider: 'instagram', errors: [{ code: ErrorCode.NOT_IMPLEMENTED, field: 'platform', message: 'Adaptador de Instagram aún no implementado (Fase 1)' }], error: providerError(ErrorCode.NOT_IMPLEMENTED, 'Adaptador de Instagram aún no implementado (Fase 1)', false) });

export class InstagramPlaceholderPublisher {
  constructor() { this.info = Object.freeze({ provider: 'instagram', mode: 'mock', live: false, implementation: 'InstagramPlaceholderPublisher (sin implementar)' }); }
  async validatePost() { return notImpl(); }
  async uploadMedia() { return notImpl(); }
  async publishPost() { return notImpl(); }
  async getPublicationStatus() { return notImpl(); }
  async getPublicationResult() { return notImpl(); }
}
