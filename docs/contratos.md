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

## Subida y media de la persona

Rutas bajo el JWT de Access (`Cf-Access-Jwt-Assertion`). La identidad es `email` del token, en minúsculas. Sin ese correo la respuesta es 403 `ACCESS_DENIED`. Si el id no pertenece a una cuenta de ese correo, 404 `NOT_FOUND`: la misma respuesta si el id no existe. Un service token no abre estas rutas. No llevan HMAC. El cuerpo de error es siempre `{ ok: false, error: { code, message, details? } }`.

El Worker no calcula el SHA-256 del cuerpo. El teléfono lo manda y R2 lo comprueba en el `put`. D1 guarda el `checksums.sha256` que devuelve R2, en hex de 64 caracteres. El vídeo de estas rutas va a R2 Standard (`binding` `MEDIA_R2`). Si el binding no está, 503 `R2_UNAVAILABLE` y no hay otro almacén. KV sigue sirviendo a `PUT /v1/media/:sha256` del bot.

Tamaños, en binario: parte de 5 MiB (`5242880` bytes) y archivo de como mucho 150 MiB (`157286400` bytes). Por encima, 413 `QUOTA_EXCEEDED` y no se llama a R2. El mismo 413 vale para el tope de bytes (300 MiB por usuario de Access, 6 GiB globales) y para la ventana móvil de 30 días UTC (clase A: 10.000 por usuario y 800.000 globales; clase B: 100.000 por usuario y 8.000.000 globales). Varias cuentas de creador del mismo correo comparten el tope del usuario. Borrar no devuelve operaciones de clase A ni de clase B.

| Método y ruta | Cuerpo | Respuesta correcta |
|---|---|---|
| `POST /v1/me/uploads` | JSON | 201 y la sesión |
| `PUT /v1/me/uploads/:id/parts/:n` | bytes de la parte | 200 y el checksum que guardó R2 |
| `POST /v1/me/uploads/:id/complete` | JSON | 200, sin llamada a R2 |
| `GET /v1/me/media/:sha256` | vacío | 200 y los bytes de ese objeto |

### `POST /v1/me/uploads`

Abre una sesión de subida para un encargo propio en `draft` o `queued` que todavía no tenga origen. JSON:

```json
{ "encargo_id": "uuid", "size_bytes": 123, "mime": "video/mp4", "sha256": "opcional, hex del archivo", "resume_id": "opcional, uuid" }
```

`mime` es `video/*`, `image/*` o `audio/*`. `sha256` y `resume_id` se pueden omitir. Rechaza `mode`, `live`, `publisher_mode`, `approved`, `status` y `synthetic`.

`201`:

```json
{ "ok": true, "data": { "upload_id": "uuid", "part_size": 5242880, "part_count": 1, "uploaded_parts": [], "resumed": false } }
```

`part_count` es `ceil(size_bytes / part_size)`. Con `resume_id` de una sesión abierta del mismo usuario, no se reserva otra vez: `resumed` es true y `uploaded_parts` lista los índices ya guardados (desde 1). Si el encargo ya tiene origen, 409 `CONFLICT`.

Al abrir se reservan los bytes del archivo entero. Esa reserva se suelta si la sesión sigue abierta un día después: lo hace el cron, desde D1. Esta fase no configura ciclo de vida en el bucket.

### `PUT /v1/me/uploads/:id/parts/:n`

`:n` empieza en 1. El cuerpo son los bytes de la parte, no JSON. Cabeceras:

- `X-Content-Sha256`: hex de 64, el SHA-256 de esa parte.
- `Content-Length`: el tamaño exacto de la parte. Las partes salvo la última miden `part_size`. La última mide el resto y, como poco, 1 byte.
- `Content-Type`: opcional. Si falta, `application/octet-stream`.

`200`:

```json
{ "ok": true, "data": { "part": 1, "uploaded": true, "already_uploaded": false, "sha256": "hex que devolvió R2" } }
```

Repetir la misma parte con el mismo hash responde `already_uploaded: true` y no vuelve a llamar a R2. El mismo índice con otro hash es 409 `CONFLICT`. Si R2 rechaza el checksum, 400 `CHECKSUM_MISMATCH`: no queda objeto, la clase A de ese intento sigue contada y no hay reintento automático. La clave del objeto la elige el servidor (`pending/{user_id}/{upload_id}/{nn}`).

### `POST /v1/me/uploads/:id/complete`

JSON `{ "sha256": "hex del archivo entero" }`. Exige todas las partes. No llama a R2. Enlaza cada parte como origen del encargo (`role` `source`) con el checksum que devolvió R2, cierra la sesión y, si el encargo estaba en `draft`, lo pasa a `queued`. Un segundo cierre es 409 `CONFLICT`. Si faltan partes, 409 `UPLOAD_INCOMPLETE`. Si en la apertura ya vino un `sha256` y este no coincide, 409 `CONFLICT`.

`200`:

```json
{ "ok": true, "data": { "upload_id": "uuid", "encargo_id": "uuid", "sha256": "hex", "size_bytes": 123, "complete": true, "status": "queued" } }
```

`status` es el del encargo después de enlazar.

### `GET /v1/me/media/:sha256`

`:sha256` es el hex de un asset de una cuenta de ese correo (cada parte y cada pieza tienen el suyo). El SHA del archivo entero, si no coincide con un objeto, no devuelve bytes. El cuerpo de la respuesta 200 son los bytes, sin envoltura JSON. Cabeceras: `content-type` del asset, `content-length`, `x-content-sha256` con el checksum de R2 y `cache-control: private, no-store`. Cuesta una operación de clase B. Un asset pendiente de borrado responde 404. El 404 y el resto de errores siguen siendo JSON.

## API del bot (encargos)

HMAC `bot` (nonce anti-replay). La clave del aprobador recibe 403. No lista usuarios ni lee `platform_connections`. Cada ítem trae solo las claves R2 de ese encargo.

| Método y ruta | Uso |
|---|---|
| `GET /v1/encargos?status=queued` | Cola. `status` distinto de `queued` es 400. |
| `POST /v1/encargos/:id/claim` | Pasa de `queued` a `claimed`. Un segundo reclamo es 409 `CONFLICT`. |
| `POST /v1/encargos/:id/result` | Con origen en R2, hace `head` de cada parte (clase B) y compara el SHA-256 del archivo. No hashea el cuerpo. |

`result` correcto, sin origen o con la huella que anunció el teléfono y partes que coinciden:

```json
{ "synthetic": true, "content_hash": "hex", "file_sha256": "hex del archivo", "batch_id": "opcional", "deliverable": { "r2_key": "out/…", "sha256": "hex", "mime": "video/mp4", "size_bytes": 1 } }
```

`file_sha256` es obligatorio si hay partes de origen. Desde cero, `synthetic` tiene que ser true. La respuesta 200 deja el encargo en `ready` y escribe `audit_log` con `account_id`.

Si el `head` no coincide con D1, o `file_sha256` no es el anunciado (en una sola parte, tampoco el de esa parte), el encargo pasa a `failed` y la respuesta es 409 `INTEGRITY_PART_MISMATCH` o `INTEGRITY_FILE_MISMATCH`. Un cuerpo `{ "failed": true, "error": { "code": "…" } }` también lo deja en `failed`: es el camino del bucle cuando, al leer los bytes, el SHA-256 no cuadra. `bot/influ.mjs poll` hace una sola vuelta sobre estas rutas; si la cola está vacía, no reclama y no llama a Imagine.
