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

### Validación en el Worker (segunda capa)

Si defines **ambas** variables de entorno del Worker:

| Variable | Ejemplo | Uso |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `tu-equipo.cloudflareaccess.com` | Host del team (sin `https://` o con él). El `iss` esperado es `https://` + ese host. Las claves salen de `https://<host>/cdn-cgi/access/certs` |
| `ACCESS_AUD` | AUD tag de la aplicación Access de la UI y de `/v1` | Debe coincidir con el claim `aud` del JWT. No es el AUD de `/mcp` |

el Worker exige cabecera `Cf-Access-Jwt-Assertion`, verifica firma RS256 con las claves públicas del team (caché 1 h), el `aud` y, si el token los trae, `exp`, `nbf` e `iss`. Rechaza un `alg` distinto de RS256.

**Producción, fallo cerrado.** `wrangler.toml` pone `ACCESS_JWT_REQUIRED=true` solo en `[vars]`, no en `[previews.vars]`. Con esa var, o cuando el proceso es un Worker de Cloudflare (`navigator.userAgent === "Cloudflare-Workers"`), faltar `ACCESS_TEAM_DOMAIN` o `ACCESS_AUD` responde **503** `SERVER_MISCONFIGURED` y no ejecuta la ruta. No hay modo «Access apagado» en el Worker desplegado.

**Previews y pruebas.** La preview trae `ACCESS_TEAM_DOMAIN` y su propio `ACCESS_AUD` en `[previews.vars]`, así que valida el JWT igual que producción. No lleva `ACCESS_JWT_REQUIRED`; si alguien quitara las dos vars dentro de un Worker, el runtime de Cloudflare también respondería 503. Las pruebas de Node no son ese runtime y no definen `ACCESS_JWT_REQUIRED`: sin las dos vars, `verifyAccessJwt` no exige JWT y los escenarios locales que no montan Access siguen igual. Un test que quiera el cierre de producción pasa `ACCESS_JWT_REQUIRED=true` o `{ onCloudflare: true }`.

El **Cron** del Worker no pasa por HTTP ni por esta comprobación.

## MCP del bot (`/mcp`)

`/mcp` no usa el Bypass ni el `ACCESS_AUD` de la UI. Lleva dos capas, las dos obligatorias:

1. JWT `Cf-Access-Jwt-Assertion` de una aplicación Access self-hosted **solo** de `/mcp`. Audience `ACCESS_MCP_AUD`. `common_name` igual a `MCP_SERVICE_TOKEN_CLIENT_ID` (el Client ID del service token del conector, distinto del CLI). Firma RS256, `exp`, `nbf` e `iss` del team. No se exige email. Un JWT de persona de la app de la UI no abre esta ruta.
2. Bearer `MCP_BEARER_TOKEN`.

Si falta la config de Access de `/mcp`, la respuesta es **503** y no se ejecuta el conector. Si falla el JWT o el bearer, **401**. El Worker no registra `CF-Access-Client-Secret` ni el bearer. El alta en Zero Trust (Service Auth, modo estricto si la organización es anterior al 2026-10-05, las tres cabeceras del conector y la rotación) está en [mcp-grok.md](mcp-grok.md).

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