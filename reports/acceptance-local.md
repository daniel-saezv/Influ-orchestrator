# Pruebas de aceptación — destino local

Ejecutadas: 19 nov 2026, 0:39:37 (hora de Madrid) · Host: local.test · Lote principal: LOTE-T2611182339

**Resultado: 17/17 OK**

| Prueba | Descripción | Resultado | ms |
|---|---|---|---|
| TEST 01 | Crear un lote con tres publicaciones de ejemplo | OK | 11 |
| TEST 02 | Recibir el lote desde Grok Bot y comprobar que queda registrado | OK | 19 |
| TEST 03 | Comprobar que se muestra correctamente para revisión | OK | 21 |
| TEST 04 | Intentar publicar sin aprobación: debe bloquearse | OK | 11 |
| TEST 05 | Aprobar el lote | OK | 4 |
| TEST 06 | Modificar un copy después de aprobarlo: la aprobación debe invalidarse | OK | 7 |
| TEST 07 | Aprobar la nueva versión | OK | 2 |
| TEST 08 | Simular la publicación de las tres piezas en YouTube MOCK | OK | 12 |
| TEST 09 | Comprobar que se generan tres IDs simulados distintos | OK | 0 |
| TEST 10 | Simular un error temporal y comprobar el reintento | OK | 3525 |
| TEST 11 | Volver a ejecutar el workflow y comprobar que no duplica publicaciones completadas | OK | 4 |
| TEST 12 | Consultar los resultados desde Grok Bot | OK | 1 |
| TEST 13 | Comprobar que no se ha hecho ninguna llamada de publicación a una red social real | OK | 5 |
| EXTRA S1 | Seguridad: peticiones sin firma, firma inválida, replay, clave equivocada y forzar LIVE | OK | 5 |
| EXTRA S2 | Programación: una publicación aprobada con fecha futura no se publica antes de su hora | OK | 7 |
| EXTRA S3 | Solicitar cambios: el lote no puede aprobarse sin una versión nueva | OK | 16 |
| EXTRA S4 | Aislamiento: otro correo recibe 404 y un service token no abre /v1/me | OK | 68 |

## Evidencias
### TEST 01 — Crear un lote con tres publicaciones de ejemplo
- media P01_fotos_nocturnas.mp4 1975 B sha256=f90c941e9022… -> media/f90c941e9022ea27d675d4bddcf8ac29187839e4d20696a97193661ff078e1ee
- media P02_rutina_manana.mp4 1975 B sha256=f90c941e9022… -> media/f90c941e9022ea27d675d4bddcf8ac29187839e4d20696a97193661ff078e1ee
- media P03_escritorio_minimalista.mp4 1975 B sha256=f90c941e9022… -> media/f90c941e9022ea27d675d4bddcf8ac29187839e4d20696a97193661ff078e1ee

### TEST 02 — Recibir el lote desde Grok Bot y comprobar que queda registrado
- registrado LOTE-T2611182339 v1 hash=2b89efbc9592d14b88c7f0a412b12a933d22c31245621ccfa6125dcd63433276
- publicaciones: LOTE-T2611182339-V1-P01=VALIDATED, LOTE-T2611182339-V1-P02=VALIDATED, LOTE-T2611182339-V1-P03=VALIDATED
- reenvío idéntico => idempotent=true

### TEST 03 — Comprobar que se muestra correctamente para revisión
- presentación de revisión: 52 líneas -> reports/review-local-LOTE-T2611182339.md

### TEST 04 — Intentar publicar sin aprobación: debe bloquearse
- publish -> 409 APPROVAL_REQUIRED (estado del lote READY_FOR_REVIEW; no hay aprobación válida; registro de aprobación del lote incoherente)
- dispatch -> 0 lotes procesados

### TEST 05 — Aprobar el lote
- APROBAR LOTE-T2611182339 v1 -> APPROVED (confirmed_by=orchestrator-d1, approved_at=2026-11-18T23:39:33.425Z)

### TEST 06 — Modificar un copy después de aprobarlo: la aprobación debe invalidarse
- v2 hash=60e7b806708c12e27e7e22a0ee8cb63b3df91338fb24bd72faed54ff9b76918a
- aprobación v1 invalidada: "Contenido modificado: versión 2 (huella 60e7b806708c…)"
- aprobar v1 => 409 VERSION_MISMATCH; publicar => 409 APPROVAL_REQUIRED

### TEST 07 — Aprobar la nueva versión
- APROBAR LOTE-T2611182339 v2 -> APPROVED

### TEST 08 — Simular la publicación de las tres piezas en YouTube MOCK
- LOTE-T2611182339-V2-P01: PUBLISHED MOCK-YT-LLc9i0aje1w https://youtube.mock.invalid/watch?v=MOCK-YT-LLc9i0aje1w
- LOTE-T2611182339-V2-P02: PUBLISHED MOCK-YT-icTwPN93KD8 https://youtube.mock.invalid/watch?v=MOCK-YT-icTwPN93KD8
- LOTE-T2611182339-V2-P03: PUBLISHED MOCK-YT-SZ_6pk6CFtM https://youtube.mock.invalid/watch?v=MOCK-YT-SZ_6pk6CFtM

### TEST 09 — Comprobar que se generan tres IDs simulados distintos
- IDs: MOCK-YT-LLc9i0aje1w, MOCK-YT-icTwPN93KD8, MOCK-YT-SZ_6pk6CFtM

### TEST 10 — Simular un error temporal y comprobar el reintento
- intento 1: RETRY_PENDING PUBLISH_ERROR — siguiente reintento 2026-11-18T23:39:35.455Z
- intento 2: PUBLISHED MOCK-YT-NfrAF4M1sC4 (attempts=2)
- publish_permanent: FAILED PUBLISH_ERROR retryable=false
- auth_error: FAILED AUTH_ERROR retryable=false

### TEST 11 — Volver a ejecutar el workflow y comprobar que no duplica publicaciones completadas
- 3 ejecuciones adicionales (dispatch lote, dispatch global, publish) -> 0 reprocesadas; eventos PUBLISHED=3

### TEST 12 — Consultar los resultados desde Grok Bot
- informe -> reports/results-local-LOTE-T2611182339.md

### TEST 13 — Comprobar que no se ha hecho ninguna llamada de publicación a una red social real
- health.mode=mock; live_enabled_in_build=false; egress_log.total=0; hosts contactados por el cliente: local.test; fetch() en src/: solo egress-guard.js

### EXTRA S1 — Seguridad: peticiones sin firma, firma inválida, replay, clave equivocada y forzar LIVE
- sin firma=401, firma inválida=401, replay=401 REPLAY_DETECTED, aprobar con clave bot=403, batch con mode=live=400, dispatch con mode=live => sigue mock

### EXTRA S2 — Programación: una publicación aprobada con fecha futura no se publica antes de su hora
- scheduled_at=2026-11-21T23:39:36.994Z -> SCHEDULED, omitida ("aún no es la hora programada"); RECHAZAR -> REJECTED y publicación CANCELLED

### EXTRA S3 — Solicitar cambios: el lote no puede aprobarse sin una versión nueva
- CAMBIOS -> CHANGES_REQUESTED; APROBAR misma versión -> 409; v2 -> READY_FOR_REVIEW -> APPROVED

### EXTRA S4 — Aislamiento: otro correo recibe 404 y un service token no abre /v1/me
- bob recibe 404 en encargo, pieza, racha, actividad y conexión; service token 403 en /v1/me; conexiones propias vacías
