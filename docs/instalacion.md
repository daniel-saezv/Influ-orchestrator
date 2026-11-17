# Instalación y despliegue

Requisitos: Node ≥ 22 (pruebas usan `node:sqlite` de Node 24), `ffprobe` (opcional, para duración/resolución). Sin dependencias npm.

El despliegue se hace con la API de Cloudflare a través del conector MCP de Cloudflare de Grok Bot (no hay token local). `deploy/build.mjs` genera los scripts que se ejecutan con la herramienta `execute` del conector:

1. Recursos (ya creados el 17 nov 2026): D1 `influ-poc-db` (`ef8d5216-77f4-4921-84d3-acc5e24820aa`), KV `influ-poc-media` (`2a84b1f0c32346d1b52801f6814faf99`). IDs en `deploy/cloudflare.json`.
2. Esquema: `node deploy/build.mjs migrate` → ejecutar `deploy/out/migrate.js` (idempotente, `IF NOT EXISTS`).
3. Worker: `node deploy/build.mjs worker` → ejecutar `deploy/out/deploy-worker.js` (sube 26 módulos ES, bindings D1/KV/variables, activa workers.dev, Cron `*/15 * * * *`; conserva los Secrets con `keep_bindings`).
4. Secretos (solo la primera vez o para rotarlos): `node deploy/build.mjs secrets <url>` → genera 2 claves aleatorias de 256 bits, las guarda en `~/.config/influ-poc/secrets.json` (permisos 600, fuera del repo) y crea `deploy/out/secrets.js`; ejecutarlo y **borrarlo**.

Con wrangler (alternativa futura con un token propio): el mismo `src/worker.js` sirve como `main`; bindings `DB` (D1) y `MEDIA` (KV), variables de `deploy/cloudflare.json`, `wrangler secret put BOT_HMAC_SECRET` / `APPROVER_HMAC_SECRET`.

Comprobar: `curl https://influ-poc-orchestrator.gamu-development.workers.dev/v1/health` y `node tests/acceptance/run.mjs --target remote`.
