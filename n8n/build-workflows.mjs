// Genera las plantillas de workflows n8n (WF-01..04) en n8n/workflows/*.json.
// Son la capa de orquestación alternativa para cuando exista una instancia n8n autorizada:
// n8n recibe/programa y delega en la API del orquestador (misma firma HMAC, mismos contratos).
// NO probadas en n8n (no hay instancia autorizada en la Fase 1). Sin secretos: se leen de $vars.
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const SIGN = (keyVar, keyId, method, pathExpr, bodyExpr) => `// Firma HMAC-SHA256 compatible con src/adapters/http/auth.js
const crypto = require('crypto');
const secret = $vars.${keyVar};           // definir en n8n > Variables (nunca en el workflow)
const base = $vars.INFLU_BASE_URL;        // p. ej. https://influ-poc-orchestrator.<subdominio>.workers.dev
const item = $input.first().json;
const path = ${pathExpr};
const body = ${bodyExpr};
const raw = body === null ? '' : JSON.stringify(body);
const ts = String(Math.floor(Date.now() / 1000));
const nonce = crypto.randomBytes(18).toString('base64url');
const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
const s = ['v1', ts, nonce, '${method}', path, bodyHash].join('\\n');
const sig = 'v1=' + crypto.createHmac('sha256', secret).update(s).digest('hex');
return [{ json: { url: base + path, raw, headers: { 'x-influ-key-id': '${keyId}', 'x-influ-timestamp': ts, 'x-influ-nonce': nonce, 'x-influ-signature': sig } } }];`;

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({ id: randomUUID(), name, type, typeVersion, position, parameters, ...extra });
const http = (name, method, pos) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method, url: '={{ $json.url }}',
  sendHeaders: true, specifyHeaders: 'json', jsonHeaders: '={{ JSON.stringify($json.headers) }}',
  ...(method === 'GET' ? {} : { sendBody: true, contentType: 'raw', rawContentType: 'application/json', body: '={{ $json.raw }}' }),
  options: { response: { response: { neverError: true } } },
});
const webhook = (name, path, pos) => node(name, 'n8n-nodes-base.webhook', 2, pos, { httpMethod: 'POST', path, authentication: 'headerAuth', responseMode: 'responseNode', options: {} }, { webhookId: randomUUID() });
const respond = (pos) => node('Responder a Grok Bot', 'n8n-nodes-base.respondToWebhook', 1.1, pos, { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} });
const code = (name, js, pos) => node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: js });
const chain = (nodes) => Object.fromEntries(nodes.slice(0, -1).map((n, i) => [n.name, { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] }]));
const wf = (name, nodes, note) => ({ name, nodes, connections: chain(nodes), settings: { executionOrder: 'v1' }, meta: { templateCredsSetupCompleted: false, note }, pinData: {}, tags: [] });

const out = {
  'WF-01_RECEIVE_BATCH.json': wf('WF-01 RECEIVE_BATCH', [
    webhook('Webhook submitBatch', 'influ/receive-batch', [0, 0]),
    code('Firmar petición (bot)', SIGN('INFLU_BOT_HMAC_SECRET', 'bot', 'POST', "'/v1/batches'", 'item.body'), [220, 0]),
    http('Orquestador: registrar lote', 'POST', [440, 0]),
    respond([660, 0]),
  ], 'Valida, comprueba archivos, registra lote y publicaciones, calcula huella (lo hace el orquestador) y devuelve el resultado.'),
  'WF-02_APPROVE_BATCH.json': wf('WF-02 APPROVE_BATCH', [
    webhook('Webhook decisión', 'influ/decision', [0, 0]),
    code('Firmar petición (aprobador)', SIGN('INFLU_APPROVER_HMAC_SECRET', 'approver', 'POST', "`/v1/batches/${item.body.batch_id}/decision`", '{ command_text: item.body.command_text, version: item.body.version, content_hash: item.body.content_hash, decided_by: item.body.decided_by }'), [220, 0]),
    http('Orquestador: registrar decisión', 'POST', [440, 0]),
    respond([660, 0]),
  ], 'Requiere credencial Header Auth propia del aprobador + firma con la clave del aprobador. Nunca aprueba por sí mismo.'),
  'WF-03_SCHEDULE_AND_DISPATCH.json': wf('WF-03 SCHEDULE_AND_DISPATCH', [
    node('Cada 15 minutos', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
    code('Firmar petición (bot)', SIGN('INFLU_BOT_HMAC_SECRET', 'bot', 'POST', "'/v1/dispatch'", '{}'), [220, 0]),
    http('Orquestador: despachar aprobados', 'POST', [440, 0]),
    code('Resumen de la ejecución', "const d = $input.first().json.data ?? {};\nreturn (d.batches ?? []).map((b) => ({ json: { batch_id: b.batch_id, processed: b.processed.length, blocked: b.blocked ?? null, batch_status: b.batch_status } }));", [660, 0]),
  ], 'Solo despacha lotes con aprobación válida (lo verifica el orquestador). No puede aprobar: no tiene la clave del aprobador.'),
  'WF-04_PUBLISHER_AND_ERROR_HANDLER.json': wf('WF-04 PUBLISHER_AND_ERROR_HANDLER', [
    webhook('Webhook resultados', 'influ/results', [0, 0]),
    code('Firmar petición (bot)', SIGN('INFLU_BOT_HMAC_SECRET', 'bot', 'GET', "`/v1/batches/${item.body.batch_id}/results`", 'null'), [220, 0]),
    http('Orquestador: resultados', 'GET', [440, 0]),
    code('Informe', "const d = $input.first().json.data;\nreturn [{ json: { batch_id: d.batch_id, status: d.status, mock: d.mock, report_markdown: d.report_markdown, publications: d.publications.map((p) => ({ id: p.publication_id, status: p.status, provider_post_id: p.provider_post_id, url: p.published_url, attempts: p.attempts })) } }];", [660, 0]),
    respond([880, 0]),
  ], 'La invocación del adaptador, errores y reintentos viven en el orquestador (WF-04 en src/workflows). Aquí se consulta y se arma el informe.'),
};
mkdirSync(new URL('./workflows/', import.meta.url), { recursive: true });
for (const [f, w] of Object.entries(out)) writeFileSync(new URL(`./workflows/${f}`, import.meta.url), JSON.stringify(w, null, 2));
console.log(Object.keys(out).join('\n'));
