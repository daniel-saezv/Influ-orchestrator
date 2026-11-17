# Informe de pruebas — POC Fase 1

Fecha: 17 nov 2026 (hora de Madrid). Todo en modo **MOCK**; ninguna llamada a redes sociales reales.

## Resumen
| Conjunto | Resultado | Evidencia |
|---|---|---|
| Unitarias (dominio, modo, simulador YouTube: 8 escenarios + auth + procesamiento) | **16/16 OK** | `reports/unit-tests.txt` |
| Aceptación local (Worker en memoria, dobles D1/KV) | **16/16 OK** | `reports/acceptance-local.md` |
| Aceptación remota (Worker desplegado en Cloudflare) | **16/16 OK** | `reports/acceptance-remote.md`, `acceptance-remote.json` |
| Firma de los nodos n8n contra el Worker | 3/3 como se esperaba | `reports/n8n-sign-verification.txt` |
| Cron Trigger real (WF-03 periódico) | OK: 17 nov 2026 23:00:33 despachó `LOTE-CRON-0001` → `MOCK-YT-V5iGNMr5wBw` | `GET /v1/audit` (actor `cron`) |

## Pruebas obligatorias (remoto)
| Prueba | Resultado |
|---|---|
| TEST 01 Lote con 3 publicaciones | OK — 3 vídeos subidos (sha256 verificado) |
| TEST 02 Registro del lote | OK — v1 `READY_FOR_REVIEW`, huella del servidor = huella local, reenvío idempotente |
| TEST 03 Presentación para revisión | OK — `reports/review-remote-*.md` |
| TEST 04 Publicar sin aprobación | OK — 409 `APPROVAL_REQUIRED`; el despachador no toca el lote |
| TEST 05 Aprobar | OK — `APPROVED` confirmado por el orquestador |
| TEST 06 Modificar copy tras aprobar | OK — v2, aprobación v1 invalidada, aprobar v1 ⇒ 409, publicar ⇒ 409 |
| TEST 07 Aprobar v2 | OK |
| TEST 08 Publicación simulada de 3 piezas | OK — lote `COMPLETED` |
| TEST 09 Tres IDs simulados distintos | OK — `MOCK-YT-…`, URLs `youtube.mock.invalid` |
| TEST 10 Error temporal + reintento | OK — intento 1 `RETRY_PENDING`, no reintenta antes de tiempo, intento 2 `PUBLISHED`; extra: error permanente y de autenticación ⇒ `FAILED` sin reintentos |
| TEST 11 Re-ejecución sin duplicados | OK — 3 ejecuciones más, 0 reprocesadas, IDs iguales, 3 eventos PUBLISHED |
| TEST 12 Resultados desde Grok Bot | OK — `reports/results-remote-*.md` |
| TEST 13 Ninguna llamada a redes reales | OK — modo mock, LIVE deshabilitado en build, `egress_log` = 0, el cliente solo habló con `*.workers.dev`, ningún `fetch()` en `src/` salvo la guardia |
| EXTRA S1 Seguridad | OK — sin firma 401, firma inválida 401, replay 401, aprobar con clave del bot 403, `mode=live` en lote 400, `mode=live` en dispatch ignorado |
| EXTRA S2 Programación | OK — publicación con fecha futura queda `SCHEDULED`; rechazo ⇒ `CANCELLED` |
| EXTRA S3 Solicitar cambios | OK — `CHANGES_REQUESTED`, aprobar misma versión 409, v2 aprobable |

Reejecutar: `npm run test:unit`, `node tests/acceptance/run.mjs --target local|remote`, `node n8n/verify-sign-nodes.mjs`.

Nota: los lotes `LOTE-T…` y `LOTE-CRON-0001` son de prueba (aprobados por el arnés de pruebas, publicación simulada). `LOTE-0001` está pendiente de tu revisión.
