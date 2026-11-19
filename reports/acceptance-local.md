# Pruebas de aceptación — destino local

Ejecutadas: 19 nov 2026, 1:49:55 (hora de Madrid) · Host: local.test · Lote principal: LOTE-T2611190049

**Resultado: 19/19 OK**

| Prueba | Descripción | Resultado | ms |
|---|---|---|---|
| TEST 01 | Crear un lote con tres publicaciones de ejemplo | OK | 15 |
| TEST 02 | Recibir el lote desde Grok Bot y comprobar que queda registrado | OK | 8 |
| TEST 03 | Comprobar que se muestra correctamente para revisión | OK | 13 |
| TEST 04 | Intentar publicar sin aprobación: debe bloquearse | OK | 5 |
| TEST 05 | Aprobar el lote | OK | 2 |
| TEST 06 | Modificar un copy después de aprobarlo: la aprobación debe invalidarse | OK | 5 |
| TEST 07 | Aprobar la nueva versión | OK | 2 |
| TEST 08 | Simular la publicación de las tres piezas en YouTube MOCK | OK | 8 |
| TEST 09 | Comprobar que se generan tres IDs simulados distintos | OK | 0 |
| TEST 10 | Simular un error temporal y comprobar el reintento | OK | 3526 |
| TEST 11 | Volver a ejecutar el workflow y comprobar que no duplica publicaciones completadas | OK | 5 |
| TEST 12 | Consultar los resultados desde Grok Bot | OK | 2 |
| TEST 13 | Comprobar que no se ha hecho ninguna llamada de publicación a una red social real | OK | 7 |
| EXTRA S1 | Seguridad: peticiones sin firma, firma inválida, replay, clave equivocada y forzar LIVE | OK | 4 |
| EXTRA S2 | Programación: una publicación aprobada con fecha futura no se publica antes de su hora | OK | 8 |
| EXTRA S3 | Solicitar cambios: el lote no puede aprobarse sin una versión nueva | OK | 7 |
| EXTRA S4 | Aislamiento: otro correo recibe 404 y un service token no abre /v1/me | OK | 62 |
| EXTRA S5 | Bot HMAC: firma inválida, reclamo doble y hash que no cuadra | OK | 90 |
| EXTRA H2 | MCP sin auth, sin aprobar, y el webhook no bloquea la cola | OK | 74 |

## Evidencias
### TEST 01 — Crear un lote con tres publicaciones de ejemplo
- media P01_fotos_nocturnas.mp4 1975 B sha256=f90c941e9022… -> media/f90c941e9022ea27d675d4bddcf8ac29187839e4d20696a97193661ff078e1ee
- media P02_rutina_manana.mp4 1975 B sha256=f90c941e9022… -> media/f90c941e9022ea27d675d4bddcf8ac29187839e4d20696a97193661ff078e1ee
- media P03_escritorio_minimalista.mp4 1975 B sha256=f90c941e9022… -> media/f90c941e9022ea27d675d4bddcf8ac29187839e4d20696a97193661ff078e1ee

### TEST 02 — Recibir el lote desde Grok Bot y comprobar que queda registrado
- registrado LOTE-T2611190049 v1 hash=48e3460ce5e4ab322bbcb57f5dcbc6dfb8fd9c997aead9f90e305776cf99a8a5
- publicaciones: LOTE-T2611190049-V1-P01=VALIDATED, LOTE-T2611190049-V1-P02=VALIDATED, LOTE-T2611190049-V1-P03=VALIDATED
- reenvío idéntico => idempotent=true

### TEST 03 — Comprobar que se muestra correctamente para revisión
- presentación de revisión: 52 líneas -> reports/review-local-LOTE-T2611190049.md

### TEST 04 — Intentar publicar sin aprobación: debe bloquearse
- publish -> 409 APPROVAL_REQUIRED (estado del lote READY_FOR_REVIEW; no hay aprobación válida; registro de aprobación del lote incoherente)
- dispatch -> 0 lotes procesados

### TEST 05 — Aprobar el lote
- APROBAR LOTE-T2611190049 v1 -> APPROVED (confirmed_by=orchestrator-d1, approved_at=2026-11-19T00:49:51.880Z)

### TEST 06 — Modificar un copy después de aprobarlo: la aprobación debe invalidarse
- v2 hash=cc7b165b9557ff67440d2e8c0bcfdd797416cb717285830a22732ea25fd85a73
- aprobación v1 invalidada: "Contenido modificado: versión 2 (huella cc7b165b9557…)"
- aprobar v1 => 409 VERSION_MISMATCH; publicar => 409 APPROVAL_REQUIRED

### TEST 07 — Aprobar la nueva versión
- APROBAR LOTE-T2611190049 v2 -> APPROVED

### TEST 08 — Simular la publicación de las tres piezas en YouTube MOCK
- LOTE-T2611190049-V2-P01: PUBLISHED MOCK-YT-Yp3SAn0hItQ https://youtube.mock.invalid/watch?v=MOCK-YT-Yp3SAn0hItQ
- LOTE-T2611190049-V2-P02: PUBLISHED MOCK-YT-XGf20I20T1o https://youtube.mock.invalid/watch?v=MOCK-YT-XGf20I20T1o
- LOTE-T2611190049-V2-P03: PUBLISHED MOCK-YT-DBo0dNGZkPM https://youtube.mock.invalid/watch?v=MOCK-YT-DBo0dNGZkPM

### TEST 09 — Comprobar que se generan tres IDs simulados distintos
- IDs: MOCK-YT-Yp3SAn0hItQ, MOCK-YT-XGf20I20T1o, MOCK-YT-DBo0dNGZkPM

### TEST 10 — Simular un error temporal y comprobar el reintento
- intento 1: RETRY_PENDING PUBLISH_ERROR — siguiente reintento 2026-11-19T00:49:53.900Z
- intento 2: PUBLISHED MOCK-YT-6SDAvBE2HX8 (attempts=2)
- publish_permanent: FAILED PUBLISH_ERROR retryable=false
- auth_error: FAILED AUTH_ERROR retryable=false

### TEST 11 — Volver a ejecutar el workflow y comprobar que no duplica publicaciones completadas
- 3 ejecuciones adicionales (dispatch lote, dispatch global, publish) -> 0 reprocesadas; eventos PUBLISHED=3

### TEST 12 — Consultar los resultados desde Grok Bot
- informe -> reports/results-local-LOTE-T2611190049.md

### TEST 13 — Comprobar que no se ha hecho ninguna llamada de publicación a una red social real
- health.mode=mock; live_enabled_in_build=false; egress_log.total=0; hosts contactados por el cliente: local.test; fetch en src/: guardia, certificados Access y el webhook de encargos

### EXTRA S1 — Seguridad: peticiones sin firma, firma inválida, replay, clave equivocada y forzar LIVE
- sin firma=401, firma inválida=401, replay=401 REPLAY_DETECTED, aprobar con clave bot=403, batch con mode=live=400, dispatch con mode=live => sigue mock

### EXTRA S2 — Programación: una publicación aprobada con fecha futura no se publica antes de su hora
- scheduled_at=2026-11-22T00:49:55.440Z -> SCHEDULED, omitida ("aún no es la hora programada"); RECHAZAR -> REJECTED y publicación CANCELLED

### EXTRA S3 — Solicitar cambios: el lote no puede aprobarse sin una versión nueva
- CAMBIOS -> CHANGES_REQUESTED; APROBAR misma versión -> 409; v2 -> READY_FOR_REVIEW -> APPROVED

### EXTRA S4 — Aislamiento: otro correo recibe 404 y un service token no abre /v1/me
- bob recibe 404 en encargo, pieza, racha, actividad y conexión; service token 403 en /v1/me; conexiones propias vacías

### EXTRA S5 — Bot HMAC: firma inválida, reclamo doble y hash que no cuadra
- firma inválida=401; reclamo doble=409; file_sha256 distinto=409 y status failed; el bucle no genera si los bytes no cuadran; cola vacía sin Imagine

### EXTRA H2 — MCP sin auth, sin aprobar, y el webhook no bloquea la cola
- MCP sin bearer=401; tools/list no tiene aprobar ni publicar; sin URL no hay POST; un POST que falla deja el encargo en cola
