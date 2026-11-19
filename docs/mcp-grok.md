# Conector MCP y rutina de Grok Bot

Fase H2. El Worker sigue en **MOCK** y `LIVE_ENABLED_IN_BUILD` sigue en `false`. El Worker no llama a Grok Imagine ni guarda una clave de API de Grok. Influ genera con la herramienta que ya tiene en la suscripción, y solo después de reclamar un encargo.

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

## Autenticación del MCP

Bearer estático, guardado como secreto del Worker. Es la opción que el conector personalizado de Grok Bot puede usar sin montar otro servicio: en Connect apps, un conector Remote HTTPS acepta cabeceras HTTP. OAuth exigiría un servidor de autorización, una página de consentimiento y otro almacén; este conector es un solo bot, no un usuario de Access.

Sin el secreto, o con un bearer distinto, la ruta responde 401. No queda abierta. El JWT de Access no sustituye al bearer: `/mcp` no mira `Cf-Access-Jwt-Assertion`. El resto de rutas sí.

Genera el token en tu máquina y cárgalo sin dejarlo en el repo, en el historial del shell ni en el chat:

```sh
openssl rand -base64 32
npx wrangler secret put MCP_BEARER_TOKEN
```

Pega el valor cuando Wrangler lo pida. El mismo valor va en la cabecera del conector, no en git.

## Sacar solo `/mcp` de Cloudflare Access

La aplicación Access que ya cubre el Worker sigue delante de la UI y de `/v1`. Grok llama a `/mcp` desde sus servidores y no puede completar el login de Access. Hay que excluir **solo** esa ruta en el edge. El Worker sigue exigiendo el bearer.

El token de CI no tiene permiso de Access y no crea esta aplicación. Hay que hacerla una vez en el panel, en producción (y en la preview solo si vas a probar el conector contra esa URL):

1. Zero Trust → Access → Applications → Add an application → Self-hosted.
2. Dominio: el mismo host del Worker. Ruta: `/mcp`. La URL queda `https://<worker>.<subdominio>.workers.dev/mcp`.
3. Política: Action **Bypass**, Include **Everyone**.
4. No añadas `/`, `/v1` ni el resto del host a esa aplicación. La aplicación más específica gana: `/mcp` queda fuera de Access y el resto sigue con la política de personas y el service token del CLI.

Sin este bypass, Grok recibe la redirección al login y no llega al Worker. Con el bypass y sin bearer, el Worker responde 401.

`run_worker_first` incluye `/mcp` para que el asset de la UI no se coma esa ruta.

## Conectar el MCP a Grok Bot

En la app de escritorio, Connect apps → Add a custom connector:

| Campo | Valor |
|---|---|
| Name | Influ encargos |
| Type | Remote HTTPS |
| Server URL | `https://<worker>.<subdominio>.workers.dev/mcp` |
| HTTP header | `Authorization` = `Bearer <el valor de MCP_BEARER_TOKEN>` |
| OAuth Client ID | vacío |

Add plugin. El bot debe usar las cuatro herramientas y no inventar un paso de aprobar o de publicar. La publicación la hace el cron, en MOCK, cuando la persona ha aprobado esa versión en la UI.

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
| `MCP_BEARER_TOKEN` | Bearer del conector |
| `INFLU_WEBHOOK_URL` | URL de la rutina |
| `INFLU_WEBHOOK_SECRET` | Clave de esa rutina |

La preview de una PR no hereda los secretos de producción. Sin `MCP_BEARER_TOKEN`, `/mcp` responde 401.
