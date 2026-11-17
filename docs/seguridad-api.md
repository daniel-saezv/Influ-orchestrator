# Seguridad de la API expuesta

## Cloudflare Access (app self-hosted en workers.dev)

Flujo recomendado:

1. En **Zero Trust → Access → Applications**, crea una aplicación **Self-hosted** con la URL del Worker (`https://<worker>.<subdominio>.workers.dev`).
2. **Política humana:** Allow con regla *Emails* (dominio o lista).
3. **Service token** para el bot: Zero Trust → Access → Service Auth → Create. Copia **Client ID** y **Client Secret** (solo una vez).
4. Política adicional (o Include en la misma app): *Service Auth* → el token creado (permite al bot sin correo).
5. Copia el **Application Audience (AUD) Tag** de la aplicación.

El edge de Access valida credenciales y reenvía al Worker con `Cf-Access-Jwt-Assertion`. El bot envía en **todas** las peticiones:

- `CF-Access-Client-Id` / `CF-Access-Client-Secret` ← variables de entorno del bot (no en git).

### Validación opcional en el Worker (segunda capa)

Si defines **ambas** variables de entorno del Worker:

| Variable | Ejemplo | Uso |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `tu-equipo.cloudflareaccess.com` | Host del team (sin `https://` o con él) para obtener `/cdn-cgi/access/certs` |
| `ACCESS_AUD` | AUD tag de la aplicación Access | Debe coincidir con el claim `aud` del JWT |

el Worker exige cabecera `Cf-Access-Jwt-Assertion`, verifica firma RS256 con las claves públicas del team (caché 1 h) y el `aud`. Si **no** están definidas, el Worker no valida JWT (compatibilidad local / despliegues sin Access).

El **Cron** del Worker no pasa por HTTP ni por esta comprobación.

## Límites en el Worker (plan gratuito)

El Worker aplica **rate limiting por IP** en D1 (`migrations/0003_rate_limits.sql`):

| Variable | Default POC | Alcance |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | `false` desactiva (solo pruebas) |
| `RATE_LIMIT_HEALTH_PER_MINUTE` | `120` | `GET /v1/health` |
| `RATE_LIMIT_ANON_PER_MINUTE` | `60` | Peticiones **sin** las cuatro cabeceras HMAC (probing, fuzzing) |

Las peticiones **firmadas** no cuentan en el bucket `anon` (siguen exigiendo HMAC, nonce y ventana temporal). La limpieza de ventanas antiguas corre en el Cron del Worker.

Tras desplegar, aplica la migración D1 (`0003_rate_limits.sql`) junto con el resto.

## Controles adicionales en Cloudflare (manual)

1. **WAF / reglas de seguridad** (según plan).
2. **workers.dev**: valorar dominio propio + DNS para políticas más finas.

Variables y secretos del Worker (`BOT_HMAC_SECRET`, etc.) solo en **Settings → Variables and Secrets**, nunca en git.