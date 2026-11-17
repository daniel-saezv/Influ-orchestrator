# Conectar YouTube real (fase posterior)

Estado: **no implementado**; `src/adapters/publishers/youtube/youtube-live.js` es un stub que siempre devuelve `LIVE_DISABLED`.

## Correspondencia con YouTube Data API v3 (doc. oficial consultada el 17 nov 2026)

| Contrato | Llamada oficial |
|---|---|
| `validatePost` | Reglas locales (`youtube-rules.js`) + `videoCategories.list` para validar `snippet.categoryId` |
| `uploadMedia` | `videos.insert`: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` (subir como `privacyStatus=private`) |
| `publishPost` | `videos.update` (`part=status`): `privacyStatus` final o `status.publishAt` (requiere `private`) |
| `getPublicationStatus` | `videos.list?part=status,processingDetails&id=VIDEO_ID` (`processingDetails.processingStatus`, `status.uploadStatus`) |
| `getPublicationResult` | `videos.list` (`snippet,status`) + `https://www.youtube.com/watch?v=VIDEO_ID` |

Propiedades usadas en `videos.insert`: `snippet.title, snippet.description, snippet.tags[], snippet.categoryId, status.privacyStatus, status.publishAt, status.selfDeclaredMadeForKids, status.containsSyntheticMedia`. Límites del recurso: 256 GB, MIME `video/*` o `application/octet-stream`. Cuota según la doc. de `videos.insert`: 100 llamadas/día, 1 unidad en el cubo «Video Uploads» (verificar al implementar).

## Pasos (requieren tu autorización)
1. Proyecto en Google Cloud con YouTube Data API v3 habilitada; pantalla de consentimiento OAuth.
2. Credencial OAuth 2.0 (cliente web) con ámbito `https://www.googleapis.com/auth/youtube.upload` (y `https://www.googleapis.com/auth/youtube` para `videos.update`/`list`).
3. Autorización del canal (flujo OAuth) y guardado del refresh token como Secret del Worker (nunca en repo ni chat).
4. Revisar la política de verificación/auditoría de la API para proyectos que suben vídeos (afecta a la privacidad permitida).
5. Implementar `YouTubeLivePublisher` con el contrato existente; permitir `www.googleapis.com`/`oauth2.googleapis.com` en la guardia de salida solo en modo LIVE.
6. Poner `LIVE_ENABLED_IN_BUILD=true`, `PUBLISHER_MODE=live`, `LIVE_SAFETY_ACK=ENABLE_LIVE_PUBLISHING_YOUTUBE`, `DEPLOY_ENV=production`; primero con `privacy_status=private` en un canal de pruebas.

Nada del núcleo, del formato de lote ni de la aprobación cambia.
