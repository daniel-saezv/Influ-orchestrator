# Contratos de los adaptadores

## SocialPublisher (`src/core/ports/social-publisher.js`)

Todos los proveedores (mock o live) implementan los mismos 5 métodos con datos normalizados.

| Método | Entrada | Salida normalizada |
|---|---|---|
| `validatePost(post)` | NormalizedPost | `{ ok, errors[{code,field,message}], warnings[], mock, provider }` |
| `uploadMedia(post, media)` | NormalizedPost + `{ bytes, mime, size_bytes, sha256 }` | `{ ok, upload_id, duplicate, error? }` |
| `publishPost(post, upload)` | NormalizedPost + resultado de upload | `{ ok, provider_post_id, status, url, duplicate, error? }` |
| `getPublicationStatus(id)` | ID del proveedor | `{ ok, provider_post_id, status, processing_status, error? }` |
| `getPublicationResult(id)` | ID del proveedor | `{ ok, provider_post_id, status, url, published_at, raw }` |

`info = { provider, mode: 'mock'|'live', live, implementation }`.

**NormalizedPost**: `publication_id, batch_id, batch_version, platform, content_type, media{sha256,mime,size_bytes,filename,duration_s,width,height}, copy{title,description,caption,tags[],hashtags[],category_id,privacy_status,made_for_kids,contains_synthetic_media}, scheduled_at, settings, test_controls, idempotency_key`.

**Error normalizado**: `{ code, message, retryable }`, `code` ∈ `AUTH_ERROR, VALIDATION_ERROR, UPLOAD_ERROR, PUBLISH_ERROR, PROCESSING_ERROR, RATE_LIMIT, NOT_FOUND, NOT_IMPLEMENTED, LIVE_DISABLED`.

**Estados comunes de publicación**: `DRAFT, VALIDATED, READY, SCHEDULED, PUBLISHING, PUBLISHED, FAILED, RETRY_PENDING, CANCELLED`.
**Estados de lote**: `DRAFT, READY_FOR_REVIEW, APPROVED, REJECTED, CHANGES_REQUESTED, PUBLISHING, COMPLETED, PARTIALLY_COMPLETED, FAILED`.

Selección: `createPublisherRegistry(env)` usa `PUBLISHER_MODE` (por defecto `mock`) y `PUBLISHER_PROVIDER`. El núcleo pide `registry.forPlatform('youtube')` y nunca importa adaptadores concretos.

## YouTube MOCK (`src/adapters/publishers/youtube/youtube-mock.js`)

- Valida con reglas de YouTube Data API v3 (`youtube-rules.js`): título ≤100 car. sin `< >`, descripción ≤5000 bytes, etiquetas ≤500 car., `categoryId`, `privacyStatus` (public/private/unlisted), `selfDeclaredMadeForKids`, `containsSyntheticMedia`, MIME `video/*`, tamaño, Shorts ≤180 s.
- Comprueba la firma real del archivo (MP4 `ftyp`, WebM EBML) y que el tamaño recibido coincide.
- IDs `MOCK-YT-xxxxxxxxxxx`; URLs `https://youtube.mock.invalid/watch?v=…` (dominio reservado `.invalid`, no resuelve). Todas las respuestas llevan `mock: true` y aviso «SIMULACIÓN (MOCK)».
- Procesamiento simulado: `publishPost` → `PUBLISHING` (processing) → primera consulta de estado → `succeeded` → `PUBLISHED`.
- Idempotencia por `idempotency_key` (publicación + huella): reintentos no vuelven a subir; republicar devuelve `duplicate: true` con el mismo ID.
- Escenarios (`test_controls.mock_scenario`): `success`, `auth_error`, `upload_transient_once`, `publish_transient_once`, `transient_always`, `publish_permanent`, `processing_failed`.

## MediaStorage (`src/core/ports/media-storage.js`)
`put(sha256, bytes, {mime, filename})`, `get(sha256)`, `head(sha256)`. Implementación: `KvMediaStorage` (bytes en KV, índice en D1).

## BatchRepository (`src/core/ports/batch-repository.js`)
Implementación `D1Repository`. Operaciones compuestas con `db.batch()` (transacción).
