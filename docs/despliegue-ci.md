# Despliegue continuo (GitHub Actions + Wrangler)

## Infraestructura como código

El Worker se define en [`wrangler.toml`](../wrangler.toml) (nombre, `main`, D1, KV, cron, vars, Access). **No** incluye secretos HMAC.

Despliegue automático en **push a `main`** y **workflow_dispatch** (workflow `deploy`). En **pull requests** solo validación + `wrangler deploy --dry-run`.

## Token de API de Cloudflare (permisos mínimos)

Crea un **API Token** (My Profile → API Tokens → Create Custom Token) con permisos **solo en la cuenta** del proyecto:

| Recurso | Permiso |
|---------|---------|
| Account | **Account Settings → Read** |
| Account | **Workers Scripts → Edit** |
| Account | **Workers KV Storage → Edit** |
| Account | **D1 → Edit** |

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

**Secrets del Worker** (`BOT_HMAC_SECRET`, `APPROVER_HMAC_SECRET`): ya en Cloudflare; `wrangler deploy` los **conserva** (no van en `wrangler.toml` ni en GitHub).

## Pipeline

1. `npm ci`
2. gitleaks (`.gitleaks.toml`)
3. `node deploy/ci-safety-guard.mjs` — exige `PUBLISHER_MODE=mock` y `LIVE_ENABLED_IN_BUILD=false`
4. Tests unitarios y acceptance local
5. `wrangler deploy --dry-run`
6. *(solo main)* Sincronización idempotente D1: `deploy/d1-migrations-sync.mjs` + `wrangler d1 execute` + `wrangler d1 migrations apply --remote`
7. `wrangler deploy`
8. Smoke: sin token → 302/403; con service token → `/v1/health` 200 y `live_enabled_in_build: false`

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