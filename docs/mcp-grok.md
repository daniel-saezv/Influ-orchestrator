# Conector MCP y rutina de Grok Bot

Fase H3. El Worker sigue en **MOCK** y `LIVE_ENABLED_IN_BUILD` sigue en `false`. El Worker no llama a Grok Imagine ni guarda una clave de API de Grok. Influ genera con la herramienta que ya tiene en la suscripción, y solo después de reclamar un encargo.

La aprobación no está en el conector. La persona aprueba en la UI con su JWT de Access.

## Qué hay en el Worker

| Pieza | Dónde |
|---|---|
| Servidor MCP | `POST /mcp` en el mismo Worker. [Agents SDK](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), `createMcpHandler` de `agents/mcp/server`. No usa Durable Object: cada petición crea el servidor, y el estado sigue en D1 y R2. Cabe en el plan gratuito. |
| Herramientas | `reclamar_encargo`, `leer_origen`, `preparar_subida`, `subir_resultado`, `revisar_estado`. No hay herramienta de aprobar ni de publicar. |
| Webhook | Al crear un encargo que queda `queued`, un `POST` a `INFLU_WEBHOOK_URL`. |
| Respaldo | El cron `*/15` que ya existe mira la cola una vez por día UTC. Si hay encargos `queued` sin reclamar, lo escribe en el log. No reclama, no llama a Grok y no publica. |

`leer_origen` y `reclamar_encargo` incluyen `format` y `targets`. En un encargo anterior, `format` es null y `legacy` es true. `preparar_subida` admite `image/*` o `video/*` y responde `DELIVERABLE_FORMAT_MISMATCH` si el archivo no encaja con el formato.

Un reintento de la persona vuelve a dejar el encargo fallido en la cola, con los mismos assets ya comprobados. `reclamar_encargo` devuelve el campo `origin` con el mismo cuerpo que `leer_origen` (nota, metadatos y orígenes firmados). Tras reclamar, el bot no tiene que llamar a `leer_origen` si usa `origin`. `leer_origen` sigue para volver a firmar o si el reclamo fue por la API HMAC sin `origin`. Exige un encargo `claimed`. Por cada origen incluye la clave, el SHA-256, el mime, el tamaño y una URL de GET prefirmada que caduca a los 10 minutos. No devuelve bytes: el bot descarga con `curl` y compara el SHA-256. Cada GET emitido cuenta una clase B, además del head del origen. `preparar_subida` elige la clave `out/{encargo_id}/{version}/{id}`, guarda la reserva y devuelve un PUT prefirmado (10 minutos) con `Content-Type`, `Content-Length`, `Content-MD5` e `If-None-Match: *`. Esas URLs son un secreto de corta vida: no se muestran en el chat ni se escriben en logs. La firma se calcula en el Worker con `aws4fetch` y no abre la guardia de salida. `subir_resultado` solo acepta la clave de esa reserva, tras un `head` cuyo tamaño y `checksums.md5` coinciden. Si faltan `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` o `R2_BUCKET_NAME`, esas dos herramientas responden `R2_SIGNING_UNAVAILABLE` y el resto del Worker sigue.

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

> Cuando el cuerpo traiga `event` = `encargo.queued`, usa el conector Influ encargos. Reclama ese encargo y usa el campo `origin` de la respuesta (no llames a `leer_origen` si ya trae las URLs). Descarga cada URL de `origin.assets` con `curl` y comprueba el SHA-256 antes de generar. Después llama a `preparar_subida`, sube el archivo con `curl -X PUT` y las cabeceras que devolvió la herramienta, y cierra con `subir_resultado` usando esa `r2_key`. `synthetic` en true si has generado o alterado. Las URLs son un secreto de corta vida: no las escribas en el chat ni en logs. No apruebes y no publiques. Si la herramienta dice que el encargo no está en la cola, termina sin generar.

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
| `R2_ACCESS_KEY_ID` | Access Key ID del token R2 Object Read & Write de un solo bucket |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key de ese token. No va en `[vars]` |

`R2_ACCOUNT_ID` y `R2_BUCKET_NAME` no son secretos: van en `[vars]` (`influ-poc-media`) y en `[previews.vars]` (`influ-poc-media-preview`). El token de producción es solo de `influ-poc-media`. El de preview, solo de `influ-poc-media-preview`. No sirven el token de CI ni el service token de Access. La preview no hereda secretos:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler preview base-config secret put R2_ACCESS_KEY_ID
npx wrangler preview base-config secret put R2_SECRET_ACCESS_KEY
```

La preview de una PR no hereda los secretos de producción. Sin la config de Access de `/mcp`, la ruta responde 503. Con esa config y sin `MCP_BEARER_TOKEN`, responde 401. `/v1/health` no usa estos secretos.

## El resto de rutas, en producción

`ACCESS_JWT_REQUIRED=true` está en las vars de producción de `wrangler.toml`. Si en ese Worker faltan `ACCESS_TEAM_DOMAIN` o `ACCESS_AUD`, `verifyAccessJwt` responde 503 y no ejecuta la ruta. La preview no copia esa var: trae las dos de Access en `[previews.vars]` y por eso sigue validando el JWT. Si en un runtime de Cloudflare faltaran, también responde 503, porque el Worker desplegado no trata la ausencia como «Access apagado».

Las pruebas (`npm test`, aceptación `--target local`) corren en Node. Ahí, sin `ACCESS_JWT_REQUIRED`, la falta de esas dos vars no exige JWT: así siguen pasando los escenarios que no montan Access. Para simular el cierre de producción en un test, pon `ACCESS_JWT_REQUIRED=true` o `onCloudflare: true` en las dependencias de `verifyAccessJwt`. El detalle está en [seguridad-api.md](seguridad-api.md).
