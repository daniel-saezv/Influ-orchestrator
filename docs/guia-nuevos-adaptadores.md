# Añadir Instagram o TikTok

Huecos preparados: `src/adapters/publishers/instagram/instagram-placeholder.js` y `tiktok/tiktok-placeholder.js` (devuelven `NOT_IMPLEMENTED`; un lote con esas plataformas queda en `DRAFT` con el error visible en la revisión).

Pasos:
1. Crear `instagram/instagram-rules.js` (validación de la plataforma), `instagram-mock.js` (simulador con el mismo patrón que `youtube-mock.js`) y, más adelante, `instagram-live.js`.
2. Implementar los 5 métodos de `SocialPublisher` con respuestas normalizadas.
3. Registrar en `src/adapters/publishers/registry.js`: `instagram: { mock: (d) => new InstagramMockPublisher(d), live: ... }`.
4. Añadir pruebas en `tests/unit/` con los 8 escenarios del simulador.
5. Desplegar (`node deploy/build.mjs worker`). Los lotes ya admiten `platform: "instagram" | "tiktok"` y `content_type` `reel`, `image`, `carousel`, `story`. `validatePost` también entiende `target` (`short`, `video`, `feed`, `reel`, `story`, `photo`) cuando el encargo lo trae.

Referencias oficiales para la fase LIVE (a verificar al implementar, no usadas aún): Instagram Graph API (Content Publishing) y TikTok Content Posting API. Ambas requieren app aprobada y OAuth del titular de la cuenta.

Opción alternativa: un adaptador `http-remote` que llame a n8n o a un servicio (p. ej. Postiz) que publique; cumple el mismo contrato y no cambia el núcleo.
