# Limitaciones y pasos pendientes

## Sustituciones respecto a la especificación
| Especificación | POC (Fase 1) | Motivo | Para pasar al servicio previsto |
|---|---|---|---|
| n8n Cloud (motor) | Worker de Cloudflare + Cron `*/15` (WF-01..04 en código) | n8n Cloud no autorizado (de pago tras la prueba); n8n no cabe en Cloudflare gratis | Instancia n8n autorizada + importar `n8n/workflows/*.json` |
| n8n Data Tables | Cloudflare D1 `influ-poc-db` | Ídem | Adaptador `BatchRepository` para Data Tables o mantener D1 |
| Cloudflare R2 para el lote del bot | Workers KV `influ-poc-media` + índice D1 | El `PUT /v1/media` del bot sigue en KV | El vídeo de la UI ya usa R2 (`influ-poc-media`). Hay que activar R2 en el panel para que el deploy del binding deje de fallar |
| Webhooks Grok Bot ↔ n8n | Webhooks HMAC del Worker + CLI `bot/influ.mjs` | — | Mismo contrato detrás de n8n |

## Limitaciones conocidas
- Los workflows n8n son plantillas no ejecutadas dentro de n8n (solo se verificó su código de firma contra el Worker).
- Vídeos de ejemplo: 8 s, sin voz ni música (imagen IA + zoom + rótulos). El título de la publicación 2 dice «30 segundos» pero el vídeo de muestra dura 8 s.
- `category_id` no se valida contra `videoCategories.list` (necesita la API real).
- El plan gratuito de Workers limita CPU por invocación y KV a 1.000 escrituras/día: el despacho procesa como máximo 4 publicaciones por ejecución; archivos hasta 20 MB.
- KV es eventualmente consistente: si un archivo recién subido aún no se ve, la publicación pasa a `RETRY_PENDING` y se reintenta.
- El aprobador usa una clave HMAC distinta a la del bot, pero en la POC ambas las custodia Grok Bot (que solo envía `APROBAR` cuando tú lo escribes). En producción conviene que la clave del aprobador viva aparte (p. ej. enlace de aprobación protegido con Cloudflare Access).
- No se pudo leer el plan de suscripción de la cuenta (la API devolvió 403); los recursos usados (Workers, D1, KV, Cron) están incluidos en el plan gratuito según la doc. de precios.
- Código en GitHub: pendiente de subir (ver informe).

## Pendiente de tu autorización
1. **GitHub**: dar acceso de escritura para subir el código a `daniel-saezv/Influ-orchestrator` (el conector solo permite leer; no hay `gh` autenticado).
2. **R2**: activarlo en el panel de Cloudflare (pide datos de facturación aunque el uso sea gratuito) y dar al token de CI el permiso **Workers R2 Storage → Edit**. Sin eso, el job que crea `influ-poc-media` y el dry-run del binding fallan. El bucket de preview es `influ-poc-media-preview`.
3. **n8n**: decidir dónde alojarlo (p. ej. Oracle Cloud Always Free) y crear la instancia.
4. **YouTube LIVE**: proyecto Google Cloud + OAuth del canal (ver `docs/youtube-live.md`).
5. **Instagram / TikTok**: apps y OAuth de cada plataforma.
