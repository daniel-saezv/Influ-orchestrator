# Webhooks (API del orquestador)

Base: `https://<worker-name>.<tu-subdominio>.workers.dev` (tu despliegue; ver `INFLU_BASE_URL`)

## Autenticación (todas salvo `/v1/health`)
Cabeceras:
- `X-Influ-Key-Id`: `bot` o `approver`
- `X-Influ-Timestamp`: segundos Unix (ventana ±300 s)
- `X-Influ-Nonce`: aleatorio 16–128 car. `[A-Za-z0-9_-]`, de un solo uso
- `X-Influ-Signature`: `v1=` + HMAC-SHA256 en hex de `v1\n<timestamp>\n<nonce>\n<MÉTODO>\n<ruta+query>\n<sha256 hex del cuerpo>`

Respuestas: `{ ok: true, data }` o `{ ok: false, error: { code, message, details } }`. 401 sin firma / firma inválida / fuera de ventana / nonce repetido (`REPLAY_DETECTED`); 403 clave no autorizada para la operación.

## Operaciones

| Operación | Método y ruta | Clave | Workflow |
|---|---|---|---|
| health | `GET /v1/health` | — | — |
| subir media | `PUT /v1/media/<sha256>` (cuerpo binario, `Content-Type` video/* o image/*, `X-Media-Filename`) | bot | WF-01 |
| submitBatch | `POST /v1/batches` | bot | WF-01 |
| nueva versión | `PUT /v1/batches/<id>` (+ `change_note`) | bot | WF-01 |
| listBatches | `GET /v1/batches` | bot | — |
| getBatchStatus | `GET /v1/batches/<id>` | bot, approver | — |
| revisión | `GET /v1/batches/<id>/review` | bot, approver | — |
| approveBatch / rejectBatch / requestBatchChanges | `POST /v1/batches/<id>/decision` `{ command_text, version, content_hash, decided_by }` | **approver** | WF-02 |
| publicar ahora (intento explícito) | `POST /v1/batches/<id>/publish` | bot | WF-03 |
| dispatch | `POST /v1/dispatch` `{ batch_id? }` | bot | WF-03 |
| getPublicationResults | `GET /v1/batches/<id>/results` | bot, approver | WF-04 |
| auditoría | `GET /v1/audit?batch_id=` | bot | — |
| salidas bloqueadas | `GET /v1/egress` | bot | — |

`command_text` debe ser literalmente `APROBAR LOTE-XXXX`, `RECHAZAR LOTE-XXXX` o `CAMBIOS LOTE-XXXX: descripción`. La decisión solo se acepta si `version` y `content_hash` coinciden con la versión actual (lo que el usuario revisó).

Ningún campo de petición puede elegir el modo de publicación (`mode`, `live`, `status`, `approved*` se rechazan en los lotes y se ignoran en `dispatch`).

Cliente de referencia: `bot/client-lib.mjs`. CLI: `bot/influ.mjs`.
