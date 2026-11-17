# Pruebas de aceptación — destino local

Ejecutadas: 17 nov 2026, 22:53:44 (hora de Madrid) · Host: local.test · Lote principal: LOTE-T2611172153

**Resultado: 16/16 OK**

| Prueba | Descripción | Resultado | ms |
|---|---|---|---|
| TEST 01 | Crear un lote con tres publicaciones de ejemplo | OK | 14 |
| TEST 02 | Recibir el lote desde Grok Bot y comprobar que queda registrado | OK | 6 |
| TEST 03 | Comprobar que se muestra correctamente para revisión | OK | 12 |
| TEST 04 | Intentar publicar sin aprobación: debe bloquearse | OK | 4 |
| TEST 05 | Aprobar el lote | OK | 2 |
| TEST 06 | Modificar un copy después de aprobarlo: la aprobación debe invalidarse | OK | 5 |
| TEST 07 | Aprobar la nueva versión | OK | 2 |
| TEST 08 | Simular la publicación de las tres piezas en YouTube MOCK | OK | 9 |
| TEST 09 | Comprobar que se generan tres IDs simulados distintos | OK | 0 |
| TEST 10 | Simular un error temporal y comprobar el reintento | OK | 3529 |
| TEST 11 | Volver a ejecutar el workflow y comprobar que no duplica publicaciones completadas | OK | 7 |
| TEST 12 | Consultar los resultados desde Grok Bot | OK | 2 |
| TEST 13 | Comprobar que no se ha hecho ninguna llamada de publicación a una red social real | OK | 3 |
| EXTRA S1 | Seguridad: peticiones sin firma, firma inválida, replay, clave equivocada y forzar LIVE | OK | 4 |
| EXTRA S2 | Programación: una publicación aprobada con fecha futura no se publica antes de su hora | OK | 8 |
| EXTRA S3 | Solicitar cambios: el lote no puede aprobarse sin una versión nueva | OK | 5 |

## Evidencias
### TEST 01 — Crear un lote con tres publicaciones de ejemplo
- media P01_fotos_nocturnas.mp4 360184 B sha256=28c34346da6e… -> media/28c34346da6e3ae6d988e50678d49c89a0a017bdee24f386dd13b8514d194159
- media P02_rutina_manana.mp4 311245 B sha256=286133ce1bfb… -> media/286133ce1bfb0850d1935a32a8b41008031ad94d0f159bb3b0da88358277b1b2
- media P03_escritorio_minimalista.mp4 241735 B sha256=d5cc710f7894… -> media/d5cc710f78947997ecf62b54ffd553a0d770fb0a6b3cc678a0435559a7c78207

### TEST 02 — Recibir el lote desde Grok Bot y comprobar que queda registrado
- registrado LOTE-T2611172153 v1 hash=f3a59b0b3e688849a5507de0de5d60bceebc57e0c0766fec501ec085cc8c93e3
- publicaciones: LOTE-T2611172153-V1-P01=VALIDATED, LOTE-T2611172153-V1-P02=VALIDATED, LOTE-T2611172153-V1-P03=VALIDATED
- reenvío idéntico => idempotent=true

### TEST 03 — Comprobar que se muestra correctamente para revisión
- presentación de revisión: 52 líneas -> reports/review-local-LOTE-T2611172153.md

### TEST 04 — Intentar publicar sin aprobación: debe bloquearse
- publish -> 409 APPROVAL_REQUIRED (estado del lote READY_FOR_REVIEW; no hay aprobación válida; registro de aprobación del lote incoherente)
- dispatch -> 0 lotes procesados

### TEST 05 — Aprobar el lote
- APROBAR LOTE-T2611172153 v1 -> APPROVED (confirmed_by=orchestrator-d1, approved_at=2026-11-17T21:53:40.622Z)

### TEST 06 — Modificar un copy después de aprobarlo: la aprobación debe invalidarse
- v2 hash=be913c0f0f30f65a22cf3189554d2bc981f6a26b34597c9d0f02c423e993b646
- aprobación v1 invalidada: "Contenido modificado: versión 2 (huella be913c0f0f30…)"
- aprobar v1 => 409 VERSION_MISMATCH; publicar => 409 APPROVAL_REQUIRED

### TEST 07 — Aprobar la nueva versión
- APROBAR LOTE-T2611172153 v2 -> APPROVED

### TEST 08 — Simular la publicación de las tres piezas en YouTube MOCK
- LOTE-T2611172153-V2-P01: PUBLISHED MOCK-YT-jHwWycBeEV0 https://youtube.mock.invalid/watch?v=MOCK-YT-jHwWycBeEV0
- LOTE-T2611172153-V2-P02: PUBLISHED MOCK-YT-eDclAvvR6Po https://youtube.mock.invalid/watch?v=MOCK-YT-eDclAvvR6Po
- LOTE-T2611172153-V2-P03: PUBLISHED MOCK-YT-eDbQEqJOQZY https://youtube.mock.invalid/watch?v=MOCK-YT-eDbQEqJOQZY

### TEST 09 — Comprobar que se generan tres IDs simulados distintos
- IDs: MOCK-YT-jHwWycBeEV0, MOCK-YT-eDclAvvR6Po, MOCK-YT-eDbQEqJOQZY

### TEST 10 — Simular un error temporal y comprobar el reintento
- intento 1: RETRY_PENDING PUBLISH_ERROR — siguiente reintento 2026-11-17T21:53:42.646Z
- intento 2: PUBLISHED MOCK-YT-FFR6ifeFkRE (attempts=2)
- publish_permanent: FAILED PUBLISH_ERROR retryable=false
- auth_error: FAILED AUTH_ERROR retryable=false

### TEST 11 — Volver a ejecutar el workflow y comprobar que no duplica publicaciones completadas
- 3 ejecuciones adicionales (dispatch lote, dispatch global, publish) -> 0 reprocesadas; eventos PUBLISHED=3

### TEST 12 — Consultar los resultados desde Grok Bot
- informe -> reports/results-local-LOTE-T2611172153.md

### TEST 13 — Comprobar que no se ha hecho ninguna llamada de publicación a una red social real
- health.mode=mock; live_enabled_in_build=false; egress_log.total=0; hosts contactados por el cliente: local.test; fetch() en src/: solo egress-guard.js

### EXTRA S1 — Seguridad: peticiones sin firma, firma inválida, replay, clave equivocada y forzar LIVE
- sin firma=401, firma inválida=401, replay=401 REPLAY_DETECTED, aprobar con clave bot=403, batch con mode=live=400, dispatch con mode=live => sigue mock

### EXTRA S2 — Programación: una publicación aprobada con fecha futura no se publica antes de su hora
- scheduled_at=2026-11-20T21:53:44.186Z -> SCHEDULED, omitida ("aún no es la hora programada"); RECHAZAR -> REJECTED y publicación CANCELLED

### EXTRA S3 — Solicitar cambios: el lote no puede aprobarse sin una versión nueva
- CAMBIOS -> CHANGES_REQUESTED; APROBAR misma versión -> 409; v2 -> READY_FOR_REVIEW -> APPROVED
