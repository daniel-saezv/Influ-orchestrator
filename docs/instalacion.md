# Instalación y despliegue

Requisitos: Node ≥ 22 (pruebas usan `node:sqlite`), `ffprobe` (opcional). Dependencias: `npm ci` (incluye Wrangler como devDependency).

## Despliegue recomendado (Wrangler + CI)

1. Infraestructura: [`wrangler.toml`](../wrangler.toml) — D1 `influ-poc-db`, KV `MEDIA`, cron `*/15 * * * *`, variables (mock, rate limit, Cloudflare Access).
2. Secretos HMAC en Cloudflare (una vez): `BOT_HMAC_SECRET` y `APPROVER_HMAC_SECRET` en el Worker (panel o `wrangler secret put`). **No** van en git ni en `wrangler.toml`.
3. CI: ver [`docs/despliegue-ci.md`](despliegue-ci.md) — token de API, secretos de GitHub y entorno `production`.
4. Migraciones: en bases ya inicializadas a mano, ejecutar primero `node deploy/d1-migrations-sync.mjs --write` y `wrangler d1 execute influ-poc-db --remote --file deploy/out/d1-migrations-sync.sql`, luego `wrangler d1 migrations apply influ-poc-db --remote`.
5. Despliegue local: `npx wrangler deploy` (conserva secrets existentes).

Entorno del bot: `INFLU_BOT_HMAC_SECRET`, `INFLU_APPROVER_HMAC_SECRET`, `INFLU_BASE_URL`; con Access activo también `INFLU_CF_ACCESS_CLIENT_ID` / `INFLU_CF_ACCESS_CLIENT_SECRET`.

Comprobar: `node deploy/smoke-health.mjs` (con credenciales Access) o acceptance remota `node tests/acceptance/run.mjs --target remote`.

## Flujo legacy (conector MCP Grok)

`deploy/build.mjs` + `deploy/cloudflare.json` siguen disponibles para scripts MCP generados; ver [`deploy/README-legacy.md`](../deploy/README-legacy.md). No usar en CI.

Antes de hacer el repo público: `docs/github-seguridad.md`, `docs/seguridad-api.md`, `docs/contenido-generado-ia.md`.