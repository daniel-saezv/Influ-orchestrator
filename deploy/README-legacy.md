# Despliegue legacy (MCP / scripts generados)

**Canónico desde la PR de CI:** [`wrangler.toml`](../wrangler.toml) en la raíz + GitHub Actions (`.github/workflows/deploy.yml`).

Los siguientes artefactos se mantienen solo por compatibilidad con el flujo Grok Bot + conector MCP «execute»:

| Archivo | Estado |
|---------|--------|
| [`deploy/cloudflare.json`](cloudflare.json) | **Legacy** — espejo histórico de bindings/vars; la fuente de verdad es `wrangler.toml`. |
| [`deploy/cloudflare.example.json`](cloudflare.example.json) | Plantilla sin IDs reales (documentación). |
| [`deploy/build.mjs`](build.mjs) | **Legacy** — genera `deploy/out/deploy-worker.js`, `migrate.js`, `secrets.js` para el conector MCP. |

No uses `build.mjs` en CI ni en despliegues nuevos. Usa:

```bash
npm ci
node deploy/d1-migrations-sync.mjs --write
npx wrangler d1 execute influ-poc-db --remote --file deploy/out/d1-migrations-sync.sql
npx wrangler d1 migrations apply influ-poc-db --remote
npx wrangler deploy
```

Ver [`docs/despliegue-ci.md`](../docs/despliegue-ci.md).