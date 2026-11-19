# Despliegue continuo (GitHub Actions + Wrangler)

## Infraestructura como código

El Worker se define en [`wrangler.toml`](../wrangler.toml) (nombre, `main`, D1, KV, cron, vars, Access y assets `ui/dist`). **No** incluye secretos HMAC.

Despliegue automático en **push a `main`** y **workflow_dispatch** (workflow `deploy`). En **pull requests del mismo repositorio** hay validación, `wrangler deploy --dry-run` y una preview (`wrangler preview`) contra `influ-poc-db-preview`. Las PRs de forks no suben preview ni reciben los secretos de Cloudflare.

## Token de API de Cloudflare (permisos mínimos)

Crea un **API Token** (My Profile → API Tokens → Create Custom Token) con permisos **solo en la cuenta** del proyecto:

| Recurso | Permiso |
|---------|---------|
| Account | **Account Settings → Read** |
| Account | **Workers Scripts → Edit** |
| Account | **Workers KV Storage → Edit** |
| Account | **D1 → Edit** |
| Account | **Workers R2 Storage → Edit** |

Opcional si gestionas workers.dev manualmente: **Workers Subdomain → Read** (el smoke resuelve la URL vía API con el token anterior).

No concedas permisos de DNS, Pages ni cuentas completas.

## Secretos y entorno en GitHub

Configura el entorno **`production`** en el repositorio (Settings → Environments) y define estos **Secrets**:

| Secret | Uso |
|--------|-----|
| `CLOUDFLARE_API_TOKEN` | Token anterior |
| `CLOUDFLARE_ACCOUNT_ID` | ID de cuenta Cloudflare |
| `INFLU_CF_ACCESS_CLIENT_ID` | Service token Access (smoke + bot) |
| `INFLU_CF_ACCESS_CLIENT_SECRET` | Service token Access |

Opcional: `INFLU_BASE_URL` si la URL workers.dev no sigue el patrón `https://influ-poc-orchestrator.<subdomain>.workers.dev`.

**Secrets del Worker** (`BOT_HMAC_SECRET`, `APPROVER_HMAC_SECRET`, y cuando se use el conector, `MCP_BEARER_TOKEN`, `ACCESS_MCP_AUD`, `MCP_SERVICE_TOKEN_CLIENT_ID`, `INFLU_WEBHOOK_URL`, `INFLU_WEBHOOK_SECRET`): ya en Cloudflare; `wrangler deploy` los **conserva** (no van en `wrangler.toml` ni en GitHub). `wrangler preview` **no** los hereda: ver más abajo. El alta del bearer, del JWT de `/mcp` y del webhook está en [mcp-grok.md](mcp-grok.md). La aplicación Access de `/mcp` (Service Auth, sin Bypass) se hace en el panel: el token de CI no tiene permiso de Access.

## Pipeline

1. `npm ci`
2. gitleaks (`.gitleaks.toml`)
3. `node deploy/ci-safety-guard.mjs` — exige `PUBLISHER_MODE=mock` y `LIVE_ENABLED_IN_BUILD=false`
4. Tests unitarios y acceptance local
5. En `ui/`: `npm ci`, `npm run lint`, `npm run test:run` y `npm run build`
6. `wrangler deploy --dry-run`
7. *(solo main o preview)* Construcción de `ui/dist` antes del comando Wrangler del job
8. *(solo main)* Sincronización idempotente D1: `deploy/d1-migrations-sync.mjs` + `wrangler d1 execute` + `wrangler d1 migrations apply --remote`
9. `wrangler deploy` o `wrangler preview`, que publica Worker y assets
10. Smoke: sin token → 302/403; con service token → `/v1/health` 200 y `live_enabled_in_build: false`

El job `deploy` es el único que ejecuta `wrangler d1 migrations apply influ-poc-db`, `deploy/ensure-r2-bucket.mjs production` y `wrangler deploy`. El job `ci` no crea el bucket de producción: en una PR no tiene `CLOUDFLARE_API_TOKEN` ni `CLOUDFLARE_ACCOUNT_ID`.

En el deploy de `main`, `deploy/ensure-r2-bucket.mjs production` crea o reutiliza `influ-poc-media` antes de `wrangler deploy`. No lo borra y no configura ciclo de vida. Si R2 no está activado en la cuenta, o el token no tiene **Workers R2 Storage → Edit**, ese paso falla. No se salta: el binding de `wrangler.toml` no se despliega hasta que R2 exista.

## Preview por pull request

El job `preview` corre en `pull_request` cuando la cabeza está en este repositorio (también las PRs de Copilot). Depende de `ci`. No corre en forks. Usa el entorno `production` solo para leer `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` (están en ese entorno, no como secretos sueltos del repositorio). No ejecuta `wrangler deploy` ni migra `influ-poc-db`.

1. `deploy/ensure-preview-d1.mjs` busca la D1 `influ-poc-db-preview`. Si no existe, la crea con `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`. Si el uuid coincide con `influ-poc-db`, el job se detiene.
2. Escribe ese uuid en `[[previews.d1_databases]]` de `wrangler.toml` y en `wrangler.preview-d1.toml` (solo en el checkout, no hace commit).
3. `npx wrangler d1 migrations apply influ-poc-db-preview --remote --config wrangler.preview-d1.toml` aplica las migraciones **de la rama** a esa base. `wrangler.preview-d1.toml` no declara `influ-poc-db`.
4. `deploy/ensure-r2-bucket.mjs preview` crea o reutiliza `influ-poc-media-preview`. Nunca escribe en `influ-poc-media`.
5. `npx wrangler preview --name pr-<número> --json` sube el Worker y los assets ya construidos de `ui/dist`. La URL sale en un solo comentario (`<!-- influ-preview -->`) junto al SHA de cabeza. Cada push actualiza ese comentario.
6. Sin cookie, `GET /health` y `GET /v1/health` deben responder 302 hacia `*.cloudflareaccess.com`. El job no publica la preview si la petición llega al Worker.

`workers_dev` y `preview_urls` están activos. El bloque `[previews]` copia las vars de producción (modo mock y el dominio de Access), el binding `DB` de `influ-poc-db-preview` y `MEDIA_R2` de `influ-poc-media-preview`. `ACCESS_AUD` de preview es el de la aplicación Access `influu-poc-orchestrator previews` (`cfd654f0-28e2-4bb8-b6f5-6e247837638f`), distinta de la de producción. Esa aplicación se gestiona fuera de la CI: cubre `*-influ-poc-orchestrator.gamu-development.workers.dev` y las previews de este Worker, con las mismas políticas reutilizables que producción. El token de CI no la crea ni la modifica, y no necesita permisos de Access. El Worker sigue exigiendo `Cf-Access-Jwt-Assertion`. El issuer sigue siendo `ACCESS_TEAM_DOMAIN`. No copia el cron ni el KV `MEDIA`: la preview no dispara el despacho de producción y no escribe en el namespace de media del bot. `/v1/health` no usa KV.

Todas las previews comparten `influ-poc-db-preview`. `migrations apply` solo avanza. Dos PRs con migraciones distintas pueden dejar el esquema en el punto de la que corrió última.

### Crear la D1 de preview

La crea el job la primera vez. A mano, con las mismas credenciales:

```bash
npx wrangler d1 create influ-poc-db-preview
```

El uuid que imprime puede copiarse a `database_id` bajo `[[previews.d1_databases]]` y en `wrangler.preview-d1.toml`. No es obligatorio: el job vuelve a resolver el id por nombre y sustituye el marcador `00000000-0000-4000-8000-000000000001`. El `database_id` de `influ-poc-db` no se modifica.

### Resetear la D1 de preview

Borra solo la base de preview y deja que la siguiente PR la cree vacía y aplique las migraciones de su rama:

```bash
npx wrangler d1 delete influ-poc-db-preview
```

Eso no borra `influ-poc-db`. El id nuevo lo escribe el job en el checkout. Si se recrea a mano, hay que actualizar los dos `database_id` de preview antes de un `wrangler preview` local.

### Secretos HMAC en la preview

Los secretos del Worker de producción no pasan a la preview. `/v1/health` no los necesita. Para que las rutas firmadas funcionen en **todas** las previews, una sola vez, con el valor por la entrada estándar (no en el comando ni en git):

```bash
npx wrangler preview base-config secret put BOT_HMAC_SECRET
npx wrangler preview base-config secret put APPROVER_HMAC_SECRET
```

Sin esos secretos, las rutas HMAC responden error de configuración. `wrangler deploy` en `main` sigue conservando los secretos del Worker de producción.

## Migraciones D1 ya aplicadas a mano

Si las tablas `batches`, `media_objects` y `http_rate_windows` existen pero `d1_migrations` está vacía, el script [`deploy/d1-migrations-sync.mjs`](../deploy/d1-migrations-sync.mjs) inserta `0001_init.sql` … `0003_rate_limits.sql` solo cuando corresponde, de forma idempotente.

## Manual local (sin CI)

```bash
npm ci
npm run test:unit
npm run test:acceptance -- --target local
npm run deploy:guard
npm ci --prefix ui
npm --prefix ui run lint
npm --prefix ui run test:run
npm --prefix ui run build
npm run deploy:dry-run
```

Con credenciales Cloudflare exportadas, mismo orden que el job `deploy` del workflow.