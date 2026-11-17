// Pruebas de aceptación TEST 01–13 (sección 12 de la especificación) + pruebas extra de seguridad.
// Uso:  node tests/acceptance/run.mjs --target local    (Worker en memoria con dobles de D1/KV)
//       node tests/acceptance/run.mjs --target remote   (Worker desplegado en Cloudflare)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { OrchestratorClient, materializeBatch, sign } from '../../bot/client-lib.mjs';
import { validateBatchInput } from '../../src/core/domain/batch.js';
import { contentHash } from '../../src/core/domain/hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'local';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Transporte ----------
const outbound = []; // todas las peticiones HTTP que hace este proceso
let client, retryBase = 10, baseHost;
if (target === 'local') {
  const { createD1Shim, createKvShim } = await import('../helpers/d1-shim.mjs');
  const worker = (await import('../../src/worker.js')).default;
  const env = {
    DB: createD1Shim(join(ROOT, 'migrations')), MEDIA: createKvShim(),
    BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef', APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
    PUBLISHER_MODE: 'mock', PUBLISHER_PROVIDER: 'youtube', RETRY_BASE_SECONDS: '2',
  };
  retryBase = 2; baseHost = 'local.test';
  const transport = async (url, init) => { outbound.push(new URL(url).hostname); return worker.fetch(new Request(url, init), env); };
  client = new OrchestratorClient({ baseUrl: 'https://local.test', botSecret: env.BOT_HMAC_SECRET, approverSecret: env.APPROVER_HMAC_SECRET, transport });
} else {
  const cfg = loadInfluConfig();
  baseHost = new URL(cfg.base_url).hostname;
  const transport = async (url, init) => { outbound.push(new URL(url).hostname); return fetch(url, init); };
  client = new OrchestratorClient({ baseUrl: cfg.base_url, botSecret: cfg.bot_secret, approverSecret: cfg.approver_secret, transport });
}

// ---------- Mini framework ----------
const results = [];
async function T(id, name, fn) {
  const t0 = Date.now(); const log = [];
  try { await fn(log); results.push({ id, name, pass: true, ms: Date.now() - t0, log }); console.log(`✔ ${id} ${name}`); }
  catch (e) { results.push({ id, name, pass: false, ms: Date.now() - t0, log, error: e.message }); console.log(`✖ ${id} ${name}\n   ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(a === b, `${m}: esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`);

// ---------- Datos ----------
const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const MAIN = `LOTE-T${stamp}`;
const sampleDir = join(ROOT, 'content/batches/LOTE-0001');
const sampleDef = JSON.parse(readFileSync(join(sampleDir, 'batch.json'), 'utf8'));
const past = new Date(Date.now() - 60_000).toISOString();
const probe = () => ({ duration_s: 8, width: 720, height: 1280 });
let batch, files, v1, v2;

async function approveCurrent(id, by = 'Gamusino (test de aceptación)') {
  const s = await client.getBatchStatus(id);
  return client.approveBatch(id, { version: s.data.version, contentHash: s.data.content_hash, decidedBy: by });
}
async function dispatchUntilSettled(id, rounds = 4) {
  let last;
  for (let i = 0; i < rounds; i++) {
    last = await client.dispatch(id);
    const s = await client.getBatchStatus(id);
    if (!['APPROVED', 'PUBLISHING'].includes(s.data.status) || s.data.publications.some((p) => p.status === 'RETRY_PENDING')) return { last, status: s.data };
  }
  return { last, status: (await client.getBatchStatus(id)).data };
}
async function singleBatch(id, scenario) {
  const def = { ...sampleDef, batch_id: id, title: `Escenario ${scenario}`, publications: [{ ...sampleDef.publications[0], scheduled_at: past, test_controls: { mock_scenario: scenario } }] };
  const m = await materializeBatch(def, sampleDir, { probe });
  const r = await client.submitBatch(m.batch); assert(r.ok, `submit ${id}: ${JSON.stringify(r.error)}`);
  const a = await approveCurrent(id); assert(a.ok, `approve ${id}: ${JSON.stringify(a.error)}`);
}

console.log(`Destino: ${target} (${baseHost}) · lote principal ${MAIN}`);
const health = await client.health();
console.log('health:', JSON.stringify(health));

await T('TEST 01', 'Crear un lote con tres publicaciones de ejemplo', async (log) => {
  const def = { ...sampleDef, batch_id: MAIN, publications: sampleDef.publications.map((p) => ({ ...p, scheduled_at: past })) };
  ({ batch, files } = await materializeBatch(def, sampleDir, { probe }));
  eq(batch.publications.length, 3, 'publicaciones');
  for (const f of files) {
    const r = await client.uploadMedia(f.sha256, f.bytes, f.mime, f.filename);
    assert(r.ok, `subida ${f.filename}: ${JSON.stringify(r.error)}`);
    log.push(`media ${f.filename} ${f.bytes.length} B sha256=${f.sha256.slice(0, 12)}… -> ${r.data.key}`);
  }
});

await T('TEST 02', 'Recibir el lote desde Grok Bot y comprobar que queda registrado', async (log) => {
  const r = await client.submitBatch(batch);
  assert(r.ok, JSON.stringify(r.error));
  v1 = r.data;
  eq(v1.status, 'READY_FOR_REVIEW', 'estado'); eq(v1.version, 1, 'versión');
  const local = await contentHash(validateBatchInput(batch));
  eq(v1.content_hash, local, 'huella calculada en el servidor = huella local');
  const s = await client.getBatchStatus(MAIN);
  eq(s.data.publications.length, 3, 'publicaciones registradas');
  assert(s.data.publications.every((p) => p.status === 'VALIDATED'), 'todas VALIDATED');
  const again = await client.submitBatch(batch);
  eq(again.data.idempotent, true, 'reenvío idempotente');
  log.push(`registrado ${MAIN} v1 hash=${v1.content_hash}`, `publicaciones: ${s.data.publications.map((p) => `${p.publication_id}=${p.status}`).join(', ')}`, 'reenvío idéntico => idempotent=true');
});

await T('TEST 03', 'Comprobar que se muestra correctamente para revisión', async (log) => {
  const r = await client.getReview(MAIN);
  assert(r.ok, JSON.stringify(r.error));
  const md = r.data.review_markdown;
  for (let i = 1; i <= 3; i++) assert(md.includes(`## Publicación ${i}`), `falta Publicación ${i}`);
  for (const needle of ['Vista previa', 'Tipo de archivo: video/mp4', 'Plataforma de destino: youtube', 'Copy definitivo', 'Hashtags: #shorts', 'Título:', 'Descripción:', 'Fecha y hora previstas', 'Validación: OK', 'Resumen del lote', `APROBAR ${MAIN}`, v1.content_hash]) assert(md.includes(needle), `falta "${needle}"`);
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(join(ROOT, `reports/review-${target}-${MAIN}.md`), md);
  log.push(`presentación de revisión: ${md.split('\n').length} líneas -> reports/review-${target}-${MAIN}.md`);
});

await T('TEST 04', 'Intentar publicar sin aprobación: debe bloquearse', async (log) => {
  const p = await client.publishBatch(MAIN);
  eq(p.status, 409, 'HTTP'); eq(p.error.code, 'APPROVAL_REQUIRED', 'código');
  const d = await client.dispatch(MAIN);
  eq(d.data.batches.length, 0, 'el despachador no toma lotes sin aprobar');
  const s = await client.getBatchStatus(MAIN);
  assert(s.data.publications.every((x) => x.status === 'VALIDATED' && x.attempts === 0), 'ninguna publicación tocada');
  log.push(`publish -> ${p.status} ${p.error.code} (${(p.error.details ?? []).join('; ')})`, 'dispatch -> 0 lotes procesados');
});

await T('TEST 05', 'Aprobar el lote', async (log) => {
  const r = await client.approveBatch(MAIN, { version: v1.version, contentHash: v1.content_hash, decidedBy: 'Gamusino (test de aceptación)' });
  assert(r.ok, JSON.stringify(r.error));
  eq(r.data.status, 'APPROVED', 'estado confirmado por el orquestador'); eq(r.data.approved_version, 1, 'versión aprobada');
  log.push(`APROBAR ${MAIN} v1 -> ${r.data.status} (confirmed_by=${r.data.confirmed_by}, approved_at=${r.data.approved_at})`);
});

await T('TEST 06', 'Modificar un copy después de aprobarlo: la aprobación debe invalidarse', async (log) => {
  const changed = structuredClone(batch);
  changed.publications[1].copy.caption += ' (versión 2: copy ajustado)';
  const r = await client.updateBatch(changed, 'Ajuste del copy de la publicación 2');
  assert(r.ok, JSON.stringify(r.error));
  v2 = r.data; batch = changed;
  eq(v2.version, 2, 'nueva versión'); eq(v2.status, 'READY_FOR_REVIEW', 'requiere nueva aprobación');
  eq(v2.approval_invalidated, true, 'aprobación anterior invalidada');
  assert(v2.content_hash !== v1.content_hash, 'nueva huella');
  const old = await client.approveBatch(MAIN, { version: 1, contentHash: v1.content_hash, decidedBy: 'test' });
  eq(old.error?.code, 'VERSION_MISMATCH', 'aprobar la versión antigua se rechaza');
  const p = await client.publishBatch(MAIN);
  eq(p.error?.code, 'APPROVAL_REQUIRED', 'publicar sigue bloqueado');
  const res = await client.getPublicationResults(MAIN);
  assert(res.data.approvals.some((a) => a.version === 1 && a.valid === 0 && a.invalidated_reason), 'aprobación v1 marcada como invalidada');
  assert(res.data.superseded_publications.every((x) => x.status === 'CANCELLED'), 'publicaciones v1 canceladas');
  log.push(`v2 hash=${v2.content_hash}`, `aprobación v1 invalidada: "${res.data.approvals.find((a) => a.version === 1).invalidated_reason}"`, 'aprobar v1 => 409 VERSION_MISMATCH; publicar => 409 APPROVAL_REQUIRED');
});

await T('TEST 07', 'Aprobar la nueva versión', async (log) => {
  const r = await client.approveBatch(MAIN, { version: 2, contentHash: v2.content_hash, decidedBy: 'Gamusino (test de aceptación)' });
  assert(r.ok, JSON.stringify(r.error));
  eq(r.data.status, 'APPROVED', 'estado'); eq(r.data.approved_version, 2, 'versión');
  log.push(`APROBAR ${MAIN} v2 -> APPROVED`);
});

let published;
await T('TEST 08', 'Simular la publicación de las tres piezas en YouTube MOCK', async (log) => {
  const r = await client.publishBatch(MAIN);
  assert(r.ok, JSON.stringify(r.error));
  const { status } = await dispatchUntilSettled(MAIN);
  eq(status.status, 'COMPLETED', 'estado del lote');
  const res = await client.getPublicationResults(MAIN);
  published = res.data.publications;
  eq(published.length, 3, 'publicaciones v2');
  assert(published.every((p) => p.status === 'PUBLISHED' && p.provider === 'youtube' && p.provider_mode === 'mock'), 'todas PUBLISHED (mock)');
  log.push(...published.map((p) => `${p.publication_id}: ${p.status} ${p.provider_post_id} ${p.published_url}`));
});

await T('TEST 09', 'Comprobar que se generan tres IDs simulados distintos', async (log) => {
  const ids = published.map((p) => p.provider_post_id);
  eq(new Set(ids).size, 3, 'IDs distintos');
  assert(ids.every((i) => /^MOCK-YT-/.test(i)), 'IDs marcados MOCK');
  assert(published.every((p) => p.published_url.startsWith('https://youtube.mock.invalid/')), 'URLs simuladas (.invalid)');
  log.push(`IDs: ${ids.join(', ')}`);
});

await T('TEST 10', 'Simular un error temporal y comprobar el reintento', async (log) => {
  const id = `${MAIN}-R`;
  await singleBatch(id, 'publish_transient_once');
  const first = await client.dispatch(id);
  const p1 = first.data.batches[0].processed[0];
  eq(p1.status, 'RETRY_PENDING', 'primer intento'); eq(p1.error.retryable, true, 'recuperable');
  log.push(`intento 1: ${p1.status} ${p1.error.code} — siguiente reintento ${p1.next_retry_at}`);
  const early = await client.dispatch(id);
  assert(early.data.batches[0].processed.length === 0, 'no reintenta antes de tiempo');
  await sleep((retryBase + 1.5) * 1000);
  const second = await client.dispatch(id);
  const p2 = second.data.batches[0].processed[0];
  eq(p2?.status, 'PUBLISHED', 'segundo intento'); eq(p2.attempts, 2, 'intentos');
  log.push(`intento 2: ${p2.status} ${p2.provider_post_id} (attempts=${p2.attempts})`);
  // Extra: error permanente => FAILED sin reintentos; error de autenticación => FAILED.
  for (const [suffix, scen] of [['P', 'publish_permanent'], ['A', 'auth_error']]) {
    const bid = `${MAIN}-${suffix}`;
    await singleBatch(bid, scen);
    const d = await client.dispatch(bid);
    const x = d.data.batches[0].processed[0];
    eq(x.status, 'FAILED', `${scen} => FAILED`); eq(x.attempts, 1, `${scen} sin reintentos`);
    eq(d.data.batches[0].batch_status, 'FAILED', `${scen} lote FAILED`);
    log.push(`${scen}: ${x.status} ${x.error.code} retryable=${x.error.retryable}`);
  }
});

await T('TEST 11', 'Volver a ejecutar el workflow y comprobar que no duplica publicaciones completadas', async (log) => {
  const d1 = await client.dispatch(MAIN); const d2 = await client.dispatch();
  const p = await client.publishBatch(MAIN);
  const processedMain = [d1, d2, p].flatMap((d) => (d.data?.batches ?? []).filter((b) => b.batch_id === MAIN).flatMap((b) => b.processed));
  eq(processedMain.length, 0, 'ninguna publicación reprocesada');
  const res = await client.getPublicationResults(MAIN);
  eq(JSON.stringify(res.data.publications.map((x) => x.provider_post_id)), JSON.stringify(published.map((x) => x.provider_post_id)), 'IDs sin cambios');
  const publishedEvents = res.data.events.filter((e) => e.op === 'PUBLISHED');
  eq(publishedEvents.length, 3, 'exactamente 3 eventos PUBLISHED');
  log.push(`3 ejecuciones adicionales (dispatch lote, dispatch global, publish) -> 0 reprocesadas; eventos PUBLISHED=${publishedEvents.length}`);
});

let report;
await T('TEST 12', 'Consultar los resultados desde Grok Bot', async (log) => {
  const r = await client.getPublicationResults(MAIN);
  assert(r.ok, JSON.stringify(r.error));
  report = r.data.report_markdown;
  assert(report.includes('SIMULACIÓN (MOCK)'), 'informe marcado como simulación');
  for (const p of published) assert(report.includes(p.provider_post_id), `informe incluye ${p.provider_post_id}`);
  writeFileSync(join(ROOT, `reports/results-${target}-${MAIN}.md`), report);
  log.push(`informe -> reports/results-${target}-${MAIN}.md`);
});

await T('TEST 13', 'Comprobar que no se ha hecho ninguna llamada de publicación a una red social real', async (log) => {
  const h = await client.health();
  eq(h.publisher.mode, 'mock', 'modo'); eq(h.live_enabled_in_build, false, 'LIVE deshabilitado en la build');
  const e = await client.egress();
  eq(e.data.total, 0, 'salidas a Internet registradas por la guardia del Worker');
  const hosts = [...new Set(outbound)];
  assert(hosts.every((x) => x === baseHost), `este proceso solo habló con ${baseHost}: ${hosts.join(', ')}`);
  // Análisis estático: solo la guardia de salida llama a fetch() en el código del Worker.
  const offenders = [];
  const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js') && /\bfetch\s*\((?![^)]*\)\s*\{)/.test(readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '')) && !p.endsWith('egress-guard.js')) offenders.push(p); });
  walk(join(ROOT, 'src'));
  eq(offenders.length, 0, `archivos con fetch(): ${offenders.join(', ')}`);
  const res = await client.getPublicationResults(MAIN);
  assert(res.data.mock === true && res.data.publications.every((p) => p.provider_mode === 'mock'), 'todo en modo mock');
  log.push(`health.mode=${h.publisher.mode}; live_enabled_in_build=false; egress_log.total=${e.data.total}; hosts contactados por el cliente: ${hosts.join(', ')}; fetch() en src/: solo egress-guard.js`);
});

await T('EXTRA S1', 'Seguridad: peticiones sin firma, firma inválida, replay, clave equivocada y forzar LIVE', async (log) => {
  const anon = await client.call('GET', `/v1/batches/${MAIN}`, { keyId: 'none' });
  eq(anon.status, 401, 'sin autenticación');
  const bad = await client.call('GET', `/v1/batches/${MAIN}`, { signOverride: { ...sign({ secret: 'x'.repeat(40), keyId: 'bot', method: 'GET', pathAndQuery: `/v1/batches/${MAIN}` }) } });
  eq(bad.status, 401, 'firma inválida');
  const hdr = sign({ secret: client.secrets.bot, keyId: 'bot', method: 'GET', pathAndQuery: `/v1/batches/${MAIN}` });
  const ok1 = await client.call('GET', `/v1/batches/${MAIN}`, { signOverride: hdr });
  const replay = await client.call('GET', `/v1/batches/${MAIN}`, { signOverride: hdr });
  eq(ok1.status, 200, 'primera'); eq(replay.status, 401, 'replay'); eq(replay.error.code, 'REPLAY_DETECTED', 'código replay');
  const botApprove = await client.call('POST', `/v1/batches/${MAIN}/decision`, { keyId: 'bot', body: { command_text: `APROBAR ${MAIN}`, version: 2, content_hash: v2.content_hash, decided_by: 'bot' } });
  eq(botApprove.status, 403, 'la clave del bot/cron no puede aprobar');
  const live = await client.submitBatch({ ...batch, batch_id: `${MAIN}-L`, mode: 'live' });
  eq(live.status, 400, 'campo mode rechazado');
  const d = await client.call('POST', '/v1/dispatch', { body: { mode: 'live', publisher_mode: 'live' } });
  eq(d.data.mode, 'mock', 'dispatch ignora el modo de la petición');
  log.push('sin firma=401, firma inválida=401, replay=401 REPLAY_DETECTED, aprobar con clave bot=403, batch con mode=live=400, dispatch con mode=live => sigue mock');
});

await T('EXTRA S2', 'Programación: una publicación aprobada con fecha futura no se publica antes de su hora', async (log) => {
  const id = `${MAIN}-F`;
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const def = { ...sampleDef, batch_id: id, title: 'Escenario fecha futura', publications: [{ ...sampleDef.publications[0], scheduled_at: future }] };
  const m = await materializeBatch(def, sampleDir, { probe });
  assert((await client.submitBatch(m.batch)).ok, 'submit');
  const a = await approveCurrent(id); assert(a.ok, JSON.stringify(a.error));
  const d = await client.dispatch(id);
  const run = d.data.batches[0];
  eq(run.processed.length, 0, 'nada procesado'); assert(run.skipped[0].reason.includes('hora'), 'motivo: aún no es la hora');
  const s = await client.getBatchStatus(id);
  eq(s.data.publications[0].status, 'SCHEDULED', 'publicación SCHEDULED'); eq(s.data.status, 'APPROVED', 'lote sigue APPROVED');
  const r = await client.rejectBatch(id, { version: s.data.version, contentHash: s.data.content_hash, decidedBy: 'test' });
  eq(r.data.status, 'REJECTED', 'rechazo explícito'); 
  const s2 = await client.getBatchStatus(id);
  eq(s2.data.publications[0].status, 'CANCELLED', 'publicación cancelada al rechazar');
  log.push(`scheduled_at=${future} -> SCHEDULED, omitida ("${run.skipped[0].reason}"); RECHAZAR -> REJECTED y publicación CANCELLED`);
});

await T('EXTRA S3', 'Solicitar cambios: el lote no puede aprobarse sin una versión nueva', async (log) => {
  const id = `${MAIN}-C`;
  const def = { ...sampleDef, batch_id: id, title: 'Escenario cambios', publications: [{ ...sampleDef.publications[0], scheduled_at: past }] };
  const m = await materializeBatch(def, sampleDir, { probe });
  const sub = await client.submitBatch(m.batch); assert(sub.ok, 'submit');
  const c = await client.requestBatchChanges(id, { version: 1, contentHash: sub.data.content_hash, decidedBy: 'test', comment: 'Cambia el título' });
  eq(c.data.status, 'CHANGES_REQUESTED', 'estado');
  const a = await client.approveBatch(id, { version: 1, contentHash: sub.data.content_hash, decidedBy: 'test' });
  eq(a.status, 409, 'aprobar sin nueva versión => 409');
  const nb = structuredClone(m.batch); nb.publications[0].copy.title = 'Título corregido #shorts';
  const u = await client.updateBatch(nb, 'Título corregido');
  eq(u.data.version, 2, 'v2'); eq(u.data.status, 'READY_FOR_REVIEW', 'nueva revisión');
  const a2 = await client.approveBatch(id, { version: 2, contentHash: u.data.content_hash, decidedBy: 'test' });
  eq(a2.data.status, 'APPROVED', 'v2 aprobada');
  log.push('CAMBIOS -> CHANGES_REQUESTED; APROBAR misma versión -> 409; v2 -> READY_FOR_REVIEW -> APPROVED');
});

// ---------- Informe ----------
const passed = results.filter((r) => r.pass).length;
const out = { target, base_host: baseHost, main_batch: MAIN, executed_at: new Date().toISOString(), passed, total: results.length, health, results };
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, `reports/acceptance-${target}.json`), JSON.stringify(out, null, 2));
const fmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date());
const md = [`# Pruebas de aceptación — destino ${target}`, '', `Ejecutadas: ${fmt} (hora de Madrid) · Host: ${baseHost} · Lote principal: ${MAIN}`, '', `**Resultado: ${passed}/${results.length} OK**`, '',
  '| Prueba | Descripción | Resultado | ms |', '|---|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.name} | ${r.pass ? 'OK' : 'FALLO: ' + r.error.replace(/\|/g, '/')} | ${r.ms} |`), '',
  '## Evidencias', ...results.flatMap((r) => [`### ${r.id} — ${r.name}`, ...r.log.map((l) => `- ${l}`), ''])].join('\n');
writeFileSync(join(ROOT, `reports/acceptance-${target}.md`), md);
console.log(`\n${passed}/${results.length} OK -> reports/acceptance-${target}.md`);
process.exit(passed === results.length ? 0 : 1);

// Secretos: variables de entorno (secretos del bot de Grok Bot). El archivo local solo queda como respaldo temporal.
function loadInfluConfig() {
  const p = join(homedir(), '.config/influ-poc/secrets.json');
  let file = {};
  try { file = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  return {
    base_url: process.env.INFLU_BASE_URL ?? file.base_url ?? 'https://influ-poc-orchestrator.gamu-development.workers.dev',
    bot_secret: process.env.INFLU_BOT_HMAC_SECRET ?? file.bot_secret,
    approver_secret: process.env.INFLU_APPROVER_HMAC_SECRET ?? file.approver_secret,
  };
}
