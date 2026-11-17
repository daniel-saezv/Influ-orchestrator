// Registro de adaptadores: elige la implementación por plataforma y modo.
// El núcleo pide "un SocialPublisher para youtube"; nunca importa adaptadores concretos.
import { assertSocialPublisher } from '../../core/ports/social-publisher.js';
import { resolvePublisherConfig } from '../../core/config.js';
import { YouTubeMockPublisher } from './youtube/youtube-mock.js';
import { YouTubeLivePublisher } from './youtube/youtube-live.js';
import { InstagramPlaceholderPublisher } from './instagram/instagram-placeholder.js';
import { TikTokPlaceholderPublisher } from './tiktok/tiktok-placeholder.js';

const FACTORIES = {
  youtube: { mock: (d) => new YouTubeMockPublisher(d), live: () => new YouTubeLivePublisher() },
  instagram: { mock: () => new InstagramPlaceholderPublisher(), live: null },
  tiktok: { mock: () => new TikTokPlaceholderPublisher(), live: null },
};

export function createPublisherRegistry(env, deps) {
  const cfg = resolvePublisherConfig(env); // lanza error si se pide LIVE sin garantías
  const cache = new Map();
  return {
    config: cfg,
    forPlatform(platform) {
      if (!cache.has(platform)) {
        const f = FACTORIES[platform]?.[cfg.mode];
        if (!f) throw new Error(`No hay adaptador ${cfg.mode} para ${platform}`);
        cache.set(platform, assertSocialPublisher(f(deps)));
      }
      return cache.get(platform);
    },
  };
}
