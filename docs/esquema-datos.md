# Esquema de datos (D1 `influ-poc-db`)

Migraciones: `migrations/0001_init.sql` … `migrations/0008_encargo_format.sql`. Una tabla por entidad (equivalente a n8n Data Tables).

| Tabla | Contenido | Claves |
|---|---|---|
| `batches` | Estado actual de cada lote: `version, status, content_hash, approved_at, approved_by, approved_version, approved_hash, validation_json` | `batch_id` |
| `batch_versions` | Contenido completo de cada versión (`payload_json`) con su huella y nota de cambio | `(batch_id, version)` |
| `publications` | Una fila por publicación y versión: plataforma, tipo, media (sha256, mime, tamaño), `post_json` (metadatos), `scheduled_at`, `status`, `provider_post_id`, `published_url`, `errors_json`, `attempts`, `next_retry_at`, `idempotency_key` | `publication_id` = `LOTE-XXXX-V<n>-P<nn>`; `idempotency_key` único |
| `publication_events` | Historial de operaciones por publicación (registro, decisiones, reclamo, validate, upload, publish, status, reintentos, fallos) | autoincremental |
| `approvals` | Cada decisión: versión, huella, decisión, quién, comando literal, clave usada, `valid`, motivo de invalidación | autoincremental |
| `audit_log` | Registro de operaciones (recepción, versiones, decisiones, despachos, bloqueos, media) | autoincremental |
| `nonces` | Nonces usados (anti-replay); se purgan a las 24 h | `nonce` |
| `egress_log` | Intentos de salida a Internet bloqueados por la guardia | autoincremental |
| `media_objects` | Índice de archivos (sha256, almacenamiento, clave, mime, tamaño) | `sha256` |
| `mock_provider_records` | Estado interno del simulador de YouTube (separado del sistema) | `k` |

## Huella del lote
SHA-256 sobre JSON canónico (claves ordenadas) de: `batch_id`, `title`, `persona` y, por publicación ordenada por `seq`: `seq, platform, content_type, media (incl. sha256 del archivo), copy (textos, hashtags, etiquetas, privacidad, categoría…), settings, test_controls`. La hora (`scheduled_at`) no entra en la huella: se escribe en la fila de la publicación después de aprobar. Código: `src/core/domain/hash.js`. Una huella guardada con la fórmula anterior deja de coincidir y hay que reenviar el lote.

## Subidas (migración 0005)
`encargo_assets.delete_pending` marca un objeto pendiente de borrar en R2. `upload_sessions` añade `mime`, `completed_at` y `bytes_reserved` (el hueco reservado al abrir la sesión). El cron borra las sesiones abiertas de más de 24 h y reintenta los borrados pendientes. No hay ciclo de vida en el bucket.

## Estado `failed` (migración 0006)
`encargos.status` admite `failed`. Lo escribe `POST /v1/encargos/:id/result` cuando el `head` de una parte o el SHA-256 del archivo no coinciden. El resto de estados no cambia.

## Reservas de subida (migración 0007)
`deliverable_reservations` guarda la clave, el SHA-256 declarado, el MD5, el MIME, el tamaño y la caducidad de un PUT prefirmado. `encargo_assets.content_md5` guarda ese MD5 al enlazar la pieza. Si la reserva caduca sin usarse, el cron suelta los bytes y la clase A.

## Formato del encargo (migración 0008)
`encargos.format` (`image`, `carousel`, `short_video`, `video`) y `encargos.targets_json` (un destino por red). Las filas anteriores quedan con NULL y la API las devuelve con `legacy: true`. `platforms_json` se mantiene.
