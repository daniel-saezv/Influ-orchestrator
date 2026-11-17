# Seguridad de la API expuesta

## Límites en el Worker (plan gratuito)

El Worker aplica **rate limiting por IP** en D1 (`migrations/0003_rate_limits.sql`):

| Variable | Default POC | Alcance |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | `false` desactiva (solo pruebas) |
| `RATE_LIMIT_HEALTH_PER_MINUTE` | `120` | `GET /v1/health` |
| `RATE_LIMIT_ANON_PER_MINUTE` | `60` | Peticiones **sin** las cuatro cabeceras HMAC (probing, fuzzing) |

Las claves usan `CF-Connecting-IP`: IPv4 exacta; IPv6 agregada por **prefijo /64** (clientes con IPv6 efímera en la misma subred); `::ffff:x.x.x.x` como IPv4.

Las peticiones **firmadas** no cuentan en el bucket `anon` (siguen exigiendo HMAC, nonce y ventana temporal). La limpieza de ventanas antiguas corre en el Cron del Worker.

Tras desplegar, aplica la migración D1 (`0003_rate_limits.sql`) junto con el resto.

## Controles adicionales en Cloudflare (manual)

No están en este repositorio; configúralos en el panel si el Worker queda en Internet público:

1. **WAF / reglas de seguridad** (cuenta con plan que lo incluya): limitar países, bloquear patrones de bots conocidos, o regla de *rate limiting* en el edge para `*/v1/health`.
2. **Cloudflare Access** (Zero Trust, cuota gratuita limitada): proteger todo el Worker salvo `/v1/health`, o dejar health público y Access en rutas `/v1/*` (el cliente bot necesitaría Service Token o excepción para máquinas).
3. **workers.dev**: valorar **dominio propio** + DNS en Cloudflare para políticas más finas y ocultar el subdominio de cuenta en la URL.

Variables y secretos del Worker (`BOT_HMAC_SECRET`, etc.) solo en **Settings → Variables and Secrets**, nunca en git.