# influ-poc — Influencer virtual: producción y publicación (Fase 1, POC)

Sistema de lotes de contenido con aprobación explícita y publicación **simulada** (YouTube MOCK).
Nada se publica en redes reales. El modo LIVE está bloqueado en el código.

- Orquestador desplegado (Cloudflare Workers, plan gratuito): `https://influ-poc-orchestrator.gamu-development.workers.dev`
  (`/v1/health` es público; el resto exige firma HMAC).
- Registro de datos: Cloudflare D1 `influ-poc-db` (en lugar de n8n Data Tables).
- Multimedia: Workers KV `influ-poc-media` + índice en D1 (en lugar de R2, que no está activado en la cuenta).
- Motor periódico: Cron Trigger del Worker cada 15 min (en lugar de n8n; plantillas n8n listas en `n8n/workflows/`).

## Flujo

1. Grok Bot produce el lote (`content/batches/LOTE-XXXX/`: `batch.json`, `media/`, `previews/`, `guiones.md`).
2. `node bot/influ.mjs submit content/batches/LOTE-0001` → sube media (sha256) y registra el lote (WF-01).
3. `node bot/influ.mjs review LOTE-0001` → presentación para revisión (versión + huella).
4. El usuario responde `APROBAR LOTE-0001` / `RECHAZAR LOTE-0001` / `CAMBIOS LOTE-0001: ...`.
5. Grok Bot lo registra: `node bot/influ.mjs decide "APROBAR LOTE-0001" --version 1 --hash <huella> --by "Gamusino"` (WF-02) y confirma con la respuesta del orquestador.
6. El Cron (WF-03) despacha a su hora las publicaciones aprobadas → adaptador YouTube MOCK (WF-04).
7. `node bot/influ.mjs results LOTE-0001` → informe con IDs y URLs simulados (`MOCK-YT-…`, `youtube.mock.invalid`).

## Estructura

```
src/core/            dominio (estados, huella SHA-256, validación), puertos y configuración de modo
src/workflows/       WF-01..WF-04 + presentación/informe (casos de uso)
src/adapters/        publishers/ (youtube mock|live-stub, instagram, tiktok), repository/ (D1), storage/ (KV), http/ (HMAC, guardia de salida)
src/worker.js        entrada HTTP + Cron del Worker
migrations/          esquema D1
bot/                 cliente de Grok Bot (CLI + librería)
content/batches/     lotes de contenido (LOTE-0001 de ejemplo)
n8n/workflows/       plantillas WF-01..04 importables en n8n (no probadas en n8n)
tests/               unitarios (node:test) y aceptación (local y contra Cloudflare)
reports/             informes de pruebas
docs/                arquitectura, contratos, datos, webhooks, instalación, configuración, YouTube LIVE, nuevos adaptadores, limitaciones
deploy/              generador de scripts de despliegue vía conector MCP de Cloudflare
```

## Pruebas

```
npm run test:unit                          # 16 pruebas: dominio, modo, simulador (8 escenarios)
node tests/acceptance/run.mjs --target local    # TEST 01–13 + seguridad, en memoria
node tests/acceptance/run.mjs --target remote   # TEST 01–13 + seguridad, contra el Worker desplegado
```
Resultados: `reports/test-report.md`.

Documentación: `docs/` (empieza por `docs/arquitectura.md`).
