# Conector MCP y rutina de Grok Bot

Fase H3. El Worker sigue en **MOCK** y `LIVE_ENABLED_IN_BUILD` sigue en `false`. El Worker no llama a Grok Imagine ni guarda una clave de API de Grok. Influ genera con la herramienta que ya tiene en la suscripción, y solo después de reclamar un encargo.

La aprobación no está en el conector. La persona aprueba en la UI con su JWT de Access.

## Qué hay en el Worker

| Pieza | Dónde |
|---|---|
| Servidor MCP | `POST /mcp` en el mismo Worker. [Agents SDK](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), `createMcpHandler` de `agents/mcp/server`. No usa Durable Object: cada petición crea el servidor, y el estado sigue en D1 y R2. Cabe en el plan gratuito. |
| Herramientas | `reclamar_encargo`, `leer_origen`, `subir_resultado`, `revisar_estado`. Hacen lo mismo que la API HMAC del bot. |
| Webhook | Al crear un encargo que queda `queued`, un `POST` a `INFLU_WEBHOOK_URL`. |
| Respaldo | El cron `*/15` que ya existe mira la cola una vez por día UTC. Si hay encargos `queued` sin reclamar, lo escribe en el log. No reclama, no llama a Grok y no publica. |

`leer_origen` devuelve la nota y el `head` de cada objeto R2 de origen (clave, SHA-256, tamaño). No copia el vídeo: en el plan gratuito el Worker tiene 10 ms de CPU y no da para mover el archivo. La huella la vuelve a comprobar `subir_resultado`, igual que `POST /v1/encargos/:id/result`.

`bot/influ.mjs` sigue para pruebas y CI sobre las rutas HMAC. En producción, Influ usa el conector.

## Dos capas en `/mcp`

Las dos son obligatorias. Una no sustituye a la otra.

1. **Cloudflare Access**, con un service token dedicado a esta ruta. El edge comprueba `CF-Access-Client-Id` y `CF-Access-Client-Secret` y, si la política lo autoriza, añade `Cf-Access-Jwt-Assertion`. El Worker valida ese JWT: firma RS256 con las claves del team, `exp`, `nbf`, `iss` igual a `https://<ACCESS_TEAM_DOMAIN>` y `aud` igual a `ACCESS_MCP_AUD`. El claim `common_name` tiene que ser `MCP_SERVICE_TOKEN_CLIENT_ID`, el Client ID de ese token. No se exige `email`. Un JWT de persona de la aplicación de la UI (otro `aud`, con correo y sin ese `common_name`) no abre `/mcp`.
2. **Bearer** `Authorization: Bearer <MCP_BEARER_TOKEN>`. Si no coincide, 401.

El Worker no lee `CF-Access-Client-Secret` para decidir, y no lo escribe en logs ni lo reenvía al servidor MCP. El secreto lo consume el edge. Tampoco se registra el bearer.

Si falta `ACCESS_TEAM_DOMAIN`, `ACCESS_MCP_AUD` o `MCP_SERVICE_TOKEN_CLIENT_ID`, `/mcp` responde **503** y no ejecuta herramientas. Si la config está y falla el JWT o el bearer, responde **401**. Sin el secreto del bearer, o con uno distinto, también es 401.

Esas tres variables y el bearer se cargan como secretos del Worker. No van en git:

```sh
npx wrangler secret put ACCESS_MCP_AUD
npx wrangler secret put MCP_SERVICE_TOKEN_CLIENT_ID
openssl rand -base64 32
npx wrangler secret put MCP_BEARER_TOKEN
```

Pega cada valor cuando Wrangler lo pida. No los dejes en el historial del shell ni en el chat. `ACCESS_AUD` (la aplicación de la UI y de `/v1`) sigue en `wrangler.toml`: es otro audience.

## Aplicación Access solo para `/mcp`

La aplicación que ya cubre el Worker sigue delante de la UI y de `/v1`, con la política de personas y el service token del CLI. Grok llama a `/mcp` desde sus servidores y no puede completar el login de una persona. No se usa Bypass. Se añade una aplicación self-hosted **solo** de esa ruta, con un service token distinto del CLI.

El token de CI no tiene permiso de Access y no crea esta aplicación. Hay que hacerla una vez en el panel, en producción (y en la preview solo si vas a probar el conector contra esa URL):

1. Zero Trust → Access controls → Service credentials → Service tokens → Create. Nombre, por ejemplo, `influ-conector-mcp`. Duración la que elijas. Copia **Client ID** y **Client Secret** en ese momento: el secreto se muestra una sola vez. No reutilices el token del CLI (`INFLU_CF_ACCESS_CLIENT_ID`).
2. Zero Trust → Access controls → Applications → Add an application → Self-hosted.
3. Dominio: el mismo host del Worker. Ruta: `/mcp`. La URL queda `https://<worker>.<subdominio>.workers.dev/mcp`. No añadas `/`, `/v1` ni el resto del host. La aplicación más específica gana: esta cubre solo el conector y el resto sigue con la política de personas y el token del CLI.
4. Política: Action **Service Auth** (no Bypass, no Allow). Include → Selector **Service Token** → solo el token del paso 1. Sin Everyone, sin correos y sin el token del CLI.
5. En la aplicación, Additional settings, copia el **Application Audience (AUD) Tag**. Ese valor es `ACCESS_MCP_AUD`. El Client ID del paso 1 es `MCP_SERVICE_TOKEN_CLIENT_ID`.
6. Si la organización Zero Trust es anterior al 2026-10-05, activa el modo estricto: Zero Trust → Access controls → Access settings → Manage service tokens → **Strict service token authentication** → Enable. Las organizaciones creadas en esa fecha o después lo tienen activo y no se puede apagar. Con el modo estricto, un service token que no autoriza responde 401 o 403, no un 302 al login; solo cuentan las políticas Service Auth; Access no devuelve la cookie `CF_Authorization`. Documentación: [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/#strict-service-token-authentication).
7. Si quedó una aplicación antigua de `/mcp` con política Bypass, bórrala o cámbiala a esta. Un Bypass dejaría la ruta fuera de Access y el Worker seguiría exigiendo el JWT, así que Grok no entraría: el edge no le pondría `Cf-Access-Jwt-Assertion`.

`run_worker_first` incluye `/mcp` para que el asset de la UI no se coma esa ruta.

## Conectar el MCP a Grok Bot

En la app de escritorio, Connect apps → Add a custom connector:

| Campo | Valor |
|---|---|
| Name | Influ encargos |
| Type | Remote HTTPS |
| Server URL | `https://<worker>.<subdominio>.workers.dev/mcp` |
| HTTP headers | Tres. `CF-Access-Client-Id` = Client ID del token de `/mcp`. `CF-Access-Client-Secret` = Client Secret de ese token. `Authorization` = `Bearer <el valor de MCP_BEARER_TOKEN>` |
| OAuth Client ID | vacío |

Add plugin. El bot debe usar las cuatro herramientas y no inventar un paso de aprobar o de publicar. La publicación la hace el cron, en MOCK, cuando la persona ha aprobado esa versión en la UI.

## Rotación

Rota cuando sospeches que un valor se ha visto, y de vez en cuando.

| Qué | Qué cambia | Qué no cambia |
|---|---|---|
| Bearer | `openssl rand -base64 32`, `npx wrangler secret put MCP_BEARER_TOKEN`, y la cabecera `Authorization` del conector. El valor anterior deja de valer en el siguiente deploy que ya tenga el secreto (Wrangler lo aplica al guardarlo). | El service token de Access. |
| Client Secret del token de `/mcp` | En el panel, rota el secreto de **ese** service token. Access mantiene el Client ID y genera otro Client Secret, mostrado una vez. Actualiza solo `CF-Access-Client-Secret` en el conector. | `MCP_SERVICE_TOKEN_CLIENT_ID` y `common_name`, porque el Client ID sigue igual. El bearer tampoco. |
| Token nuevo (otro Client ID) | Crea otro service token, ponlo en la política Service Auth, quita el viejo, actualiza las dos cabeceras `CF-Access-*` del conector y `npx wrangler secret put MCP_SERVICE_TOKEN_CLIENT_ID`. | `ACCESS_MCP_AUD`, salvo que borres y vuelvas a crear la aplicación. |

No pegues el Client Secret ni el bearer en git, en un issue ni en el historial de comandos. El Worker no los registra.

## Rutina con webhook

Pide al bot que añada un disparador webhook a la rutina. En el escritorio, la rutina muestra tres campos: la URL (`POST to`), la clave (`key`) y la cabecera ya montada. La clave se envía como `Authorization: Bearer`. Un 200 significa que Grok ha aceptado el aviso, no que el encargo esté generado.

Carga los dos secretos en el Worker, por la entrada estándar, sin escribirlos en el comando:

```sh
npx wrangler secret put INFLU_WEBHOOK_URL
npx wrangler secret put INFLU_WEBHOOK_SECRET
```

`INFLU_WEBHOOK_URL` es la URL `POST to`, solo `https`, sin usuario, contraseña ni puerto. `INFLU_WEBHOOK_SECRET` es la clave de la rutina.

Si falta la URL o falta la clave, el Worker no llama a nadie y el encargo se crea igual. Si el `POST` falla o no devuelve 2xx, el encargo sigue en cola. El cuerpo es JSON, sin la nota y sin correos:

```json
{ "event": "encargo.queued", "encargo_id": "…", "kind": "from_scratch", "status": "queued" }
```

Texto orientativo para la instrucción de la rutina, para pegarlo tú en el bot:

> Cuando el cuerpo traiga `event` = `encargo.queued`, usa el conector Influ encargos. Reclama ese encargo, lee el origen y, solo entonces, genera con Grok Imagine. Sube el resultado con `synthetic` en true si has generado o alterado. No apruebes y no publiques. Si la herramienta dice que el encargo no está en la cola, termina sin generar.

Un encargo `edit` nace en `draft` y no dispara el webhook: aún no está en la cola. Cuando pase a `queued`, la revisión del día siguiente lo verá si nadie lo ha reclamado.

La revisión de respaldo no sustituye al webhook. Escribe en el log del Worker `{ "event": "encargo_backup_review", "day", "queued", "encargo_ids" }` como mucho una vez por día UTC, y solo si la cola tiene encargos. Una fila `ENCARGO_BACKUP_CHECKED` en `audit_log` evita repetir el mismo día; si `queued` es 0, no hay línea de log.

## Secretos

Solo en el Worker (`wrangler secret put` o el panel). No van en `wrangler.toml`, en GitHub Actions ni en el navegador.

| Secreto | Uso |
|---|---|
| `ACCESS_MCP_AUD` | AUD de la aplicación Access que cubre solo `/mcp` |
| `MCP_SERVICE_TOKEN_CLIENT_ID` | Client ID del service token de esa aplicación. Tiene que coincidir con `common_name` |
| `MCP_BEARER_TOKEN` | Bearer del conector |
| `INFLU_WEBHOOK_URL` | URL de la rutina |
| `INFLU_WEBHOOK_SECRET` | Clave de esa rutina |

La preview de una PR no hereda los secretos de producción. Sin la config de Access de `/mcp`, la ruta responde 503. Con esa config y sin `MCP_BEARER_TOKEN`, responde 401. `/v1/health` no usa estos secretos.

## El resto de rutas, en producción

`ACCESS_JWT_REQUIRED=true` está en las vars de producción de `wrangler.toml`. Si en ese Worker faltan `ACCESS_TEAM_DOMAIN` o `ACCESS_AUD`, `verifyAccessJwt` responde 503 y no ejecuta la ruta. La preview no copia esa var: trae las dos de Access en `[previews.vars]` y por eso sigue validando el JWT. Si en un runtime de Cloudflare faltaran, también responde 503, porque el Worker desplegado no trata la ausencia como «Access apagado».

Las pruebas (`npm test`, aceptación `--target local`) corren en Node. Ahí, sin `ACCESS_JWT_REQUIRED`, la falta de esas dos vars no exige JWT: así siguen pasando los escenarios que no montan Access. Para simular el cierre de producción en un test, pon `ACCESS_JWT_REQUIRED=true` o `onCloudflare: true` en las dependencias de `verifyAccessJwt`. El detalle está en [seguridad-api.md](seguridad-api.md).
