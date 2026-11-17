# Instalación y despliegue

Requisitos: Node ≥ 22 (pruebas usan `node:sqlite` de Node 24), `ffprobe` (opcional, para duración/resolución). Sin dependencias npm.

El despliegue se hace con la API de Cloudflare a través del conector MCP de Cloudflare de Grok Bot (no hay token local). `deploy/build.mjs` genera los scripts que se ejecutan con la herramienta `execute` del conector:

1. Recursos (ya creados el 17 nov 2026): D1 `influ-poc-db` (`ef8d5216-77f4-4921-84d3-acc5e24820aa`), KV `influ-poc-media` (`2a84b1f0c32346d1b52801f6814faf99`). IDs en `deploy/cloudflare.json`.
2. Esquema: `node deploy/build.mjs migrate` → ejecutar `deploy/out/migrate.js` (idempotente, `IF NOT EXISTS`).
3. Worker: `node deploy/build.mjs worker` → ejecutar `deploy/out/deploy-worker.js` (sube 26 módulos ES, bindings D1/KV/variables, activa workers.dev, Cron `*/15 * * * *`; conserva los Secrets con `keep_bindings`).
4. Secretos HMAC (primera vez o rotación): en el panel de Cloudflare → Workers → `influ-poc-orchestrator` → Settings → Variables and Secrets, define `BOT_HMAC_SECRET` y `APPROVER_HMAC_SECRET` (claves aleatorias ≥ 256 bits, distintas entre sí). Alternativa: `wrangler secret put BOT_HMAC_SECRET` y `wrangler secret put APPROVER_HMAC_SECRET`.

5. Entorno del bot (local, CI o Grok Bot): exporta `INFLU_BOT_HMAC_SECRET` e `INFLU_APPROVER_HMAC_SECRET` con los mismos valores; opcional `INFLU_BASE_URL` si no usas el workers.dev por defecto. No versiones estos valores.

`node deploy/build.mjs secrets` queda como ayuda legacy (genera claves locales y, si aplica, `deploy/out/secrets.js` vía MCP); **no sustituye** la configuración manual de Secrets en Cloudflare.

Con wrangler (alternativa con token propio): el mismo `src/worker.js` sirve como `main`; bindings `DB` (D1) y `MEDIA` (KV), variables de `deploy/cloudflare.json`, secretos vía `wrangler secret put` o dashboard.

Comprobar: `curl https://influ-poc-orchestrator.gamu-development.workers.dev/v1/health` y, con las variables de entorno definidas, `node tests/acceptance/run.mjs --target remote`.
