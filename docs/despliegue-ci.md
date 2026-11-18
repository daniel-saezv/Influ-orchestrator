# Despliegue continuo (GitHub Actions + Wrangler)

## Infraestructura como código

El Worker se define en [`wrangler.toml`](../wrangler.toml) (nombre, `main`, D1, KV, cron, vars, Access). **No** incluye secretos HMAC.

Despliegue automático en **push a `main`** y **workflow_dispatch** (workflow `deploy`). En **pull requests del mismo repositorio** hay validación, `wrangler deploy --dry-run` y una preview (`wrangler preview`) contra `influ-poc-db-preview`. Las PRs de forks no suben preview ni reciben los secretos de Cloudflare.

## Token de API de Cloudflare (permisos mínimos)

Crea un **API Token** (My Profile → API Tokens → Create Custom Token) con permisos **solo en la cuenta** del proyecto:

| Recurso | Permiso |
|---------|---------|
| Account | **Account Settings → Read** |
| Account | **Workers Scripts → Edit** |
| Account | **Workers KV Storage → Edit** |
| Account | **D1 → Edit** |
| Account | **Access: Apps and Policies → Edit** |

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

**Secrets del Worker** (`BOT_HMAC_SECRET`, `APPROVER_HMAC_SECRET`): ya en Cloudflare; `wrangler deploy` los **conserva** (no van en `wrangler.toml` ni en GitHub). `wrangler preview` **no** los hereda: ver más abajo.

## Pipeline

1. `npm ci`
2. gitleaks (`.gitleaks.toml`)
3. `node deploy/ci-safety-guard.mjs` — exige `PUBLISHER_MODE=mock` y `LIVE_ENABLED_IN_BUILD=false`
4. Tests unitarios y acceptance local
5. `wrangler deploy --dry-run`
6. *(solo main)* Sincronización idempotente D1: `deploy/d1-migrations-sync.mjs` + `wrangler d1 execute` + `wrangler d1 migrations apply --remote`
7. `wrangler deploy`
8. Smoke: sin token → 302/403; con service token → `/v1/health` 200 y `live_enabled_in_build: false`

El job `deploy` es el único que ejecuta `wrangler d1 migrations apply influ-poc-db` y `wrangler deploy`.

## Preview por pull request

El job `preview` corre en `pull_request` cuando la cabeza está en este repositorio (también las PRs de Copilot). Depende de `ci`. No corre en forks. Usa el entorno `production` solo para leer `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` (están en ese entorno, no como secretos sueltos del repositorio). No ejecuta `wrangler deploy` ni migra `influ-poc-db`.

1. `deploy/ensure-preview-d1.mjs` busca la D1 `influ-poc-db-preview`. Si no existe, la crea con `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`. Si el uuid coincide con `influ-poc-db`, el job se detiene.
2. Escribe ese uuid en `[[previews.d1_databases]]` de `wrangler.toml` y en `wrangler.preview-d1.toml` (solo en el checkout, no hace commit).
3. `npx wrangler d1 migrations apply influ-poc-db-preview --remote --config wrangler.preview-d1.toml` aplica las migraciones **de la rama** a esa base. `wrangler.preview-d1.toml` no declara `influ-poc-db`.
4. `npx wrangler preview --name pr-<número> --json` sube la preview. La URL sale en un solo comentario (`<!-- influ-preview -->`) junto al SHA de cabeza. Cada push actualiza ese comentario.
5. `GET /v1/health` de esa URL debe responder 200, 301, 302, 401 o 403.

`workers_dev` y `preview_urls` están activos. El bloque `[previews]` copia las vars de producción (modo mock y Access) y el binding `DB` de `influ-poc-db-preview`. No copia el cron ni el KV `MEDIA`: la preview no dispara el despacho de producción y no escribe en el namespace de media. `/v1/health` no usa KV.

`deploy/ensure-preview-access.mjs` crea, si no existe, la aplicación Access `influ-poc-orchestrator previews`. Cubre `*-influ-poc-orchestrator.<subdominio>.workers.dev` y las previews de este Worker, y le enlaza las mismas políticas reutilizables que la app de producción (personas y service token). No modifica esa app. El Worker sigue exigiendo `Cf-Access-Jwt-Assertion`: el script escribe en `[previews.vars]` el AUD de la app de preview y deja intacto el AUD de producción. El issuer sigue siendo `ACCESS_TEAM_DOMAIN`. Sin cookie, el edge redirige al login de Access; la petición no llega al Worker.

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
npm run deploy:dry-run
```

Con credenciales Cloudflare exportadas, mismo orden que el job `deploy` del workflow.