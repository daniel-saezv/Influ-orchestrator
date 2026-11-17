# Configuración

Variables del Worker (`deploy/cloudflare.json` → bindings `plain_text`):

| Variable | Valor POC | Efecto |
|---|---|---|
| `PUBLISHER_MODE` | `mock` | Ausente o vacío ⇒ `mock`. `live` ⇒ bloqueado (ver abajo). Cualquier otro valor ⇒ error `MODE_CONFIG_INVALID` y no se despacha nada. |
| `PUBLISHER_PROVIDER` | `youtube` | Proveedor por defecto (cada publicación usa el adaptador de su `platform`). |
| `MAX_ATTEMPTS` | 3 | Reintentos limitados (máx. 5). |
| `RETRY_BASE_SECONDS` | 10 | Espera exponencial: base × 2^(intento−1). |
| `MAX_PUBLICATIONS_PER_RUN` | 4 | Límite por ejecución (máx. 6; respeta límites del plan gratuito). |
| `MAX_STATUS_POLLS` | 3 | Consultas de estado por intento. |
| `DEPLOY_ENV` | `poc` | Para LIVE debería ser `production`. |
| `RATE_LIMIT_ENABLED` | `true` | Límites por IP en D1 (ver `docs/seguridad-api.md`). |
| `RATE_LIMIT_HEALTH_PER_MINUTE` | `120` | Máximo de `GET /v1/health` por IP y minuto. |
| `RATE_LIMIT_ANON_PER_MINUTE` | `60` | Peticiones sin cabeceras HMAC completas por IP y minuto. |

**Secrets del Worker** (panel de Cloudflare o `wrangler secret put`): `BOT_HMAC_SECRET` (Grok Bot: lotes, despacho, consultas) y `APPROVER_HMAC_SECRET` (solo decisiones).

**CLI del bot y pruebas remotas** (secretos del entorno de ejecución, nunca en el repo): `INFLU_BOT_HMAC_SECRET`, `INFLU_APPROVER_HMAC_SECRET` (mismos valores que en el Worker) y `INFLU_BASE_URL` (URL del Worker). El fichero `~/.config/influ-poc/secrets.json` solo se acepta como respaldo temporal si faltan variables.

## Paso a LIVE (no activado)
`resolvePublisherConfig` (`src/core/config.js`) exige a la vez: `PUBLISHER_MODE=live`, constante de código `LIVE_ENABLED_IN_BUILD=true` (hoy `false`), `LIVE_SAFETY_ACK=ENABLE_LIVE_PUBLISHING_<PROVEEDOR>` y `DEPLOY_ENV=production`. Si falta algo ⇒ `LIVE_MODE_BLOCKED` y no se publica nada (nunca cae en LIVE por accidente ni por una petición). Además el adaptador LIVE de YouTube es un stub que devuelve `LIVE_DISABLED`.
