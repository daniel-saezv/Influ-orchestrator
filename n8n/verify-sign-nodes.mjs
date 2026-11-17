// Ejecuta en Node el código de los nodos "Firmar petición" de las plantillas n8n contra el Worker
// desplegado, para comprobar que la firma que generarían es aceptada (no prueba n8n en sí).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cfg = loadInfluConfig();
if (!cfg.base_url || !cfg.bot_secret || !cfg.approver_secret) {
  console.error('Define INFLU_BASE_URL, INFLU_BOT_HMAC_SECRET e INFLU_APPROVER_HMAC_SECRET (o ~/.config/influ-poc/secrets.json).');
  process.exit(2);
}
const $vars = { INFLU_BASE_URL: cfg.base_url, INFLU_BOT_HMAC_SECRET: cfg.bot_secret, INFLU_APPROVER_HMAC_SECRET: cfg.approver_secret };
async function run(file, nodeName, input, method) {
  const wf = JSON.parse(readFileSync(new URL(`./workflows/${file}`, import.meta.url)));
  const js = wf.nodes.find((n) => n.name === nodeName).parameters.jsCode;
  const fn = new Function('require', '$vars', '$input', js);
  const [{ json }] = fn(require, $vars, { first: () => ({ json: input }) });
  const r = await fetch(json.url, { method, headers: { ...json.headers, ...(json.raw ? { 'content-type': 'application/json' } : {}) }, body: method === 'GET' ? undefined : json.raw });
  const b = await r.json();
  console.log(`${file} · ${nodeName} -> HTTP ${r.status} ok=${b.ok}${b.error ? ' ' + b.error.code : ''}`);
  return r.status;
}
const codes = [
  await run('WF-04_PUBLISHER_AND_ERROR_HANDLER.json', 'Firmar petición (bot)', { body: { batch_id: 'LOTE-0001' } }, 'GET'),
  await run('WF-03_SCHEDULE_AND_DISPATCH.json', 'Firmar petición (bot)', {}, 'POST'),
  // Decisión con huella deliberadamente errónea: debe autenticar (no 401) y rechazar por HASH_MISMATCH (409).
  await run('WF-02_APPROVE_BATCH.json', 'Firmar petición (aprobador)', { body: { batch_id: 'LOTE-0001', command_text: 'APROBAR LOTE-0001', version: 1, content_hash: '0'.repeat(64), decided_by: 'verificación n8n' } }, 'POST'),
];
process.exit(codes[0] === 200 && codes[1] === 200 && codes[2] === 409 ? 0 : 1);

function loadInfluConfig() {
  const p = join(homedir(), '.config/influ-poc/secrets.json');
  let file = {};
  try { file = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  return {
    base_url: process.env.INFLU_BASE_URL ?? file.base_url,
    bot_secret: process.env.INFLU_BOT_HMAC_SECRET ?? file.bot_secret,
    approver_secret: process.env.INFLU_APPROVER_HMAC_SECRET ?? file.approver_secret,
  };
}