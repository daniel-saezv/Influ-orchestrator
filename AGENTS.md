# AGENTS.md

Fuente única de instrucciones de este repositorio para Cursor (editor y cloud agents) y para el coding agent de GitHub Copilot. El detalle de producto sigue en [README.md](README.md) y en `docs/`. No dupliques estas instrucciones en `.github/copilot-instructions.md`, `.cursor/rules` ni en otra skill.

## Proyecto

POC de Fase 1: producción y publicación **simulada** de lotes de un influencer virtual. Nada se publica en redes reales. El modo LIVE está bloqueado en código (`LIVE_ENABLED_IN_BUILD = false` en `src/core/config.js`).

El orquestador recibe un lote, lo deja a revisión, exige una aprobación ligada a versión y huella SHA-256, y el cron despacha las piezas aprobadas al adaptador YouTube MOCK. Visión general: [README.md](README.md). Arquitectura: [docs/arquitectura.md](docs/arquitectura.md).

## Stack y estructura

JavaScript ESM (`"type": "module"`), Node `>=22` (las pruebas usan `node:sqlite`). La API y el runtime de producción son un Cloudflare Worker (plan gratuito) definido en `wrangler.toml`: Worker `influ-poc-orchestrator`, entrada `src/worker.js`, D1 `influ-poc-db`, KV `influ-poc-media`, cron `*/15 * * * *`, `workers_dev = true`. Wrangler 4.164.0 es devDependency. La UI independiente de fase B vive en `ui/`: Vite + React, Tailwind y componentes shadcn (`Button`, `Field`, `Textarea`, `ToggleGroup`, `Progress`, `Skeleton`).

| Ruta | Qué es |
|---|---|
| `src/core/` | Dominio, puertos y modo (fail-closed). Sin I/O de red ni de Cloudflare. |
| `src/workflows/` | WF-01 recibir, WF-02 aprobar, WF-03 despachar, WF-04 publicar, más revisión e informe. |
| `src/adapters/` | HTTP (HMAC, Access JWT, rate limit, guardia de salida), D1, KV y publishers (YouTube MOCK, stub LIVE, huecos Instagram/TikTok). |
| `src/worker.js` | `fetch` + `scheduled`. |
| `bot/` | CLI de Grok Bot (`bot/influ.mjs`) y cliente HMAC. |
| `content/batches/` | Lotes. `LOTE-0001` es el ejemplo. |
| `migrations/` | SQL de D1 (`0001`–`0003`). |
| `n8n/` | Plantillas WF-01..04 importables. No hay instancia n8n; no se ejecutan en CI. |
| `deploy/` | Guardia de modo mock, sincronización D1, smoke de `/v1/health` y el generador legacy `build.mjs`. |
| `tests/` | Unitarios (`node:test`) y aceptación local/remota. El shim D1 está en `tests/helpers/d1-shim.mjs`. |
| `ui/` | SPA mobile-first de encargos. Tiene su propio `package.json`, lockfile, `components.json`, pruebas Vitest y cliente fingido reemplazable; aún no es un asset del Worker. |
| `docs/` | Arquitectura, contratos, datos, seguridad, instalación, despliegue, n8n, YouTube LIVE. |
| `reports/` | Informes ya generados. La aceptación local reescribe `reports/acceptance-local.*`; no lo versiones si solo has relanzado las pruebas. |

`ui/components.json` configura shadcn en la aplicación Vite; no se mueve a la raíz. La integración con los assets del Worker corresponde a una fase posterior.

## Comandos

Comprobados en este clon el 2026-11-18 (Node v22.23.4, npm 10.9.9):

- Instalación: `npm ci` (41 paquetes auditados, 0 vulnerabilidades). Deja Wrangler 4.164.0.
- Build: no hay build de aplicación. `npm run deploy:dry-run` ejecuta `wrangler deploy --dry-run`, empaqueta el Worker (81.29 KiB / gzip 22.39 KiB en esta ejecución) y sale sin desplegar. `npm run build:deploy` sin argumentos solo imprime el uso del generador legacy (`worker|migrate|secrets`); no es el despliegue canónico.
- Tests: `npm run test:unit` (26 pruebas, 0 fallos) y `npm run test:acceptance -- --target local` (16/16 OK, en memoria). `npm run deploy:guard` exige `PUBLISHER_MODE=mock` y `LIVE_ENABLED_IN_BUILD=false`.
- UI: `cd ui && npm ci && npm run dev` arranca Vite. La validación aislada es `cd ui && npm run lint && npm run test:run && npm run build`.
- Arranque: no hay `npm start`. El proceso que sirve la API es el Worker desplegado en Cloudflare (`docs/despliegue-ci.md`). En local, el sustituto que sí arranca la API es la aceptación: `npm run test:acceptance -- --target local`. `npx wrangler dev --local --port 8787` no llega a escuchar: workerd rechaza el export `SERVICE_VERSION` (`Incorrect type for map entry 'SERVICE_VERSION'`). No está corregido. `node bot/influ.mjs` sin entorno termina con código 2 y pide `INFLU_BASE_URL`, `INFLU_BOT_HMAC_SECRET` e `INFLU_APPROVER_HMAC_SECRET`.

`ffprobe` es opcional para el CLI del bot (metadatos de vídeo). En esta máquina está en `/usr/bin/ffprobe`. Los tests no lo necesitan.

La aceptación remota (`--target remote`), `node n8n/verify-sign-nodes.mjs` y `node deploy/smoke-health.mjs` llaman al Worker desplegado y no se han ejecutado aquí: faltan las variables de entorno.

## Buenas prácticas

- El núcleo no elige red social ni almacenamiento. Un publisher nuevo implementa el puerto `SocialPublisher` y se registra en `src/adapters/publishers/registry.js`. Guía: `docs/guia-nuevos-adaptadores.md`.
- Fail-closed: el valor por defecto es MOCK. LIVE sigue deshabilitado en esta build aunque lleguen variables o un cuerpo HTTP. No pongas `PUBLISHER_MODE=live` en `wrangler.toml`. La guardia de salida, en MOCK, no permite ningún host.
- Secretos HMAC (`BOT_HMAC_SECRET`, `APPROVER_HMAC_SECRET`) solo con `wrangler secret put` o el panel. No van en git, en `wrangler.toml` ni en el workflow. El CLI usa `INFLU_BOT_HMAC_SECRET`, `INFLU_APPROVER_HMAC_SECRET` e `INFLU_BASE_URL`. Con Access, también `INFLU_CF_ACCESS_CLIENT_ID` e `INFLU_CF_ACCESS_CLIENT_SECRET`.
- `wrangler deploy` conserva los secrets ya cargados en el Worker. Las migraciones D1 ya aplicadas a mano se sincronizan con `deploy/d1-migrations-sync.mjs` antes de `wrangler d1 migrations apply` (lo hace el job de `main`).
- Pruebas con `node:test`, sin framework añadido. La aceptación local no toca la cuenta de Cloudflare. `wrangler deploy --dry-run` y `wrangler dev` escriben estado en `.wrangler/`; está en `.gitignore`.
- Plantillas n8n: no las regeneres con `node n8n/build-workflows.mjs` salvo que el cambio sea ese generador; reescribe UUID en `n8n/workflows/`.
- La UI usa `ui/src/api/fakeApi.js` durante la fase B. El cliente real debe sustituir esa frontera, conservar `credentials: "same-origin"` y no guardar secretos HMAC, cuerpos ni tokens en el navegador.

## CI/CD

El proyecto **sí se despliega**. En cada push a `main` (y con `workflow_dispatch`) GitHub Actions publica el Worker `influ-poc-orchestrator` en workers.dev, en el entorno `production`. Detalle de token, secretos y orden: [docs/despliegue-ci.md](docs/despliegue-ci.md).

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `.github/workflows/deploy.yml` | `pull_request`, push a `main`, `workflow_dispatch` | Job `ci` («Validar y empaquetar»): `npm ci`, gitleaks, `deploy:guard`, `test:unit`, aceptación local, `deploy/ensure-r2-bucket.mjs production` y `wrangler deploy --dry-run`. Job `deploy` («Desplegar a producción»): solo si no es un PR y la ref es `main` o el disparo es manual. Sincroniza D1 de producción, aplica migraciones a `influ-poc-db`, asegura el bucket `influ-poc-media`, `wrangler deploy` y smoke de `/v1/health`. Job `preview` («Preview de la PR»): solo PRs del mismo repositorio. Crea o reutiliza `influ-poc-db-preview` y el bucket `influ-poc-media-preview`, aplica ahí las migraciones de la rama y sube `wrangler preview`. No toca `influ-poc-db` ni `influ-poc-media`. |
| `.github/workflows/secrets-guard.yml` | `pull_request` y push a `main` | Job «Archivos sensibles no versionados» y job «gitleaks (historial)». |
| `.github/workflows/copilot-setup-steps.yml` | Cambios de ese archivo, y `workflow_dispatch` | Prepara el entorno del coding agent cuando la sesión corre en GitHub Actions. No despliega. |

Esos jobs de `deploy` y `secrets-guard` son los que corren en cada pull request. No pude leer la protección de rama de `main` (la API respondió 403), así que no consta aquí si GitHub los marca como obligatorios. Conviene exigirlos en la protección de `main` si aún no lo están. No hace falta otro workflow de test: el job `ci` ya ejecuta los comandos de arriba.

Las PRs del mismo repositorio publican una preview con `wrangler preview`, la D1 `influ-poc-db-preview` y el bucket R2 `influ-poc-media-preview`. El binding `MEDIA_R2` de producción es `influ-poc-media`. El job `ci` crea ese bucket si no existe, antes del dry-run. Si R2 no está activado en la cuenta, o el token no tiene **Workers R2 Storage → Edit**, ese paso queda en rojo y no se evita. No uses `wrangler deploy` en un PR: escribiría en `influ-poc-db`, en el KV y en el bucket de producción. Cómo se crea y se resetea esa D1, y cómo se cargan los secretos HMAC de la preview: [docs/despliegue-ci.md](docs/despliegue-ci.md).

Dependabot (`.github/dependabot.yml`): `github-actions` semanal y agrupado, y `npm` semanal y agrupado (`package.json` + `package-lock.json`). La etiqueta existente `dependencies` se mantiene.

## Agentes (Cursor y Copilot)

### Skills

Una sola copia, en `.agents/skills/shadcn` (lock: `skills-lock.json`, origen `shadcn-ui/ui` @ `968d8cb9dc42ae5d52e8fd356cf84596ec832a26`).

Esa ruta la leen los dos:

- Cursor, editor y cloud agents: [Agent Skills](https://cursor.com/docs/skills) incluye `.agents/skills/` de proyecto. En cloud agents hay que commitearla; no se copia sola desde el home.
- Copilot (cloud agent, code review, CLI, app y modo agente de VS Code): [Adding agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) acepta `.agents/skills` junto a `.github/skills` y `.claude/skills`.

El CLI `skills` instala Cursor y GitHub Copilot en ese mismo directorio (`npx skills add https://github.com/shadcn-ui/ui --skill shadcn --agent cursor github-copilot`). No hay copia en `.cursor/skills` ni en `.github/skills`.

La documentación de la skill se aplica ahora dentro de `ui/`, donde vive `components.json`. Mantén los componentes fuente de shadcn bajo `ui/src/components/ui/`. Para usar el MCP desde la raíz, ejecuta el CLI o configura su servidor con `ui/` como proyecto; no crees otro `components.json` en la raíz.

### MCP de Cursor

Archivo que Cursor sí lee y Copilot no: `.cursor/mcp.json`, el que documenta [shadcn MCP](https://ui.shadcn.com/docs/mcp). Tras abrir el repo, activa el servidor en Cursor Settings. No hace falta un `mcp.json` paralelo para Copilot: el coding agent no lo lee.

### MCP de Copilot (pegar a mano)

El coding agent y Copilot code review toman el MCP de los ajustes del repositorio, no de un archivo. Documentación: [Configure MCP servers for your repository](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).

Ruta: Settings del repo → Code planning and automation → Copilot → MCP servers → «MCP configuration» → Save MCP configuration. Este JSON es el de esa página (claves `type` y `tools`, obligatorias ahí; el de Cursor no las lleva). Allowlist con las siete herramientas de `.agents/skills/shadcn/mcp.md` en el commit instalado, en lugar de `"*"`: Copilot las usa sin pedir confirmación.

```json
{
  "mcpServers": {
    "shadcn": {
      "type": "local",
      "command": "npx",
      "args": ["shadcn@latest", "mcp"],
      "tools": [
        "get_project_registries",
        "list_items_in_registries",
        "search_items_in_registries",
        "view_items_in_registries",
        "get_item_examples_from_registries",
        "get_add_command_for_items",
        "get_audit_checklist"
      ]
    }
  }
}
```

No usa secretos. Ahora `components.json` está en `ui/`, no en la raíz del repositorio.

### Entorno del coding agent

`.github/workflows/copilot-setup-steps.yml` sigue [Customize the agent environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment): job `copilot-setup-steps`, Node 22 y `npm ci`. Así hay `npx` y las dependencias del repo (incluido Wrangler) antes de que el agente trabaje. El CLI de shadcn no está en `package.json`; `npx shadcn@latest` lo descarga al usarlo.

Ese workflow solo corre dentro de sesiones de Copilot en GitHub Actions, y solo después de estar en `main`. No aplica a una sesión en cloud sandbox. En el PR también se ejecuta como workflow normal, para ver si los pasos pasan.

### Instrucciones de Copilot

No hay `.github/copilot-instructions.md`. El cloud agent ya carga este `AGENTS.md` ([soporte de instrucciones](https://docs.github.com/en/copilot/reference/custom-instructions-support)). Un `copilot-instructions.md` que solo remitiese aquí se inyectaría además de este archivo, sin aportar nada. Si en el futuro hiciera falta una instrucción que este archivo no cubra, ese `.md` debe limitarse a un enlace aquí, no a repetir el contenido.

## Cursor Cloud specific instructions

La preparación es `npm ci`. No hay Docker, base de datos local ni navegador de pruebas. No hace falta `.cursor/environment.json`: en el cloud agent de esta cuenta Node ya es v22.23.4.

Para validar un cambio: `npm ci`, `npm run test:unit`, `npm run test:acceptance -- --target local` y `npm run deploy:guard`. Esos tres no necesitan secretos. `npm run deploy:dry-run` empaqueta en local sin token. En CI el dry-run va después de `deploy/ensure-r2-bucket.mjs` y sí usa `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`; falla hasta que R2 esté activado y el token tenga Workers R2 Storage → Edit.

`npx wrangler dev --local` falla como se indica en Comandos. No lo uses como arranque.

Secretos que hay que añadir en Cursor solo si el agente debe desplegar o hablar con el Worker remoto (nombres, sin valores):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `INFLU_CF_ACCESS_CLIENT_ID`
- `INFLU_CF_ACCESS_CLIENT_SECRET`
- `INFLU_BASE_URL`
- `INFLU_BOT_HMAC_SECRET`
- `INFLU_APPROVER_HMAC_SECRET`

Los dos HMAC del Worker (`BOT_HMAC_SECRET`, `APPROVER_HMAC_SECRET`) viven en Cloudflare, no en Cursor. Permisos del token: [docs/despliegue-ci.md](docs/despliegue-ci.md).
