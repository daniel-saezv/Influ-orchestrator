// Pruebas de aceptación TEST 01–13 (sección 12 de la especificación) + pruebas extra de seguridad.
// Uso:  node tests/acceptance/run.mjs --target local    (Worker en memoria con dobles de D1/KV)
//       node tests/acceptance/run.mjs --target remote   (Worker desplegado en Cloudflare)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { OrchestratorClient, materializeBatch, sign } from '../../bot/client-lib.mjs';
import { createAccessSigner, cryptoKeyFromPublic } from '../helpers/access-token.mjs';
import { validateBatchInput } from '../../src/core/domain/batch.js';
import { contentHash } from '../../src/core/domain/hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'local';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Transporte ----------
const outbound = []; // todas las peticiones HTTP que hace este proceso
let client, retryBase = 10, baseHost, workerMod;
if (target === 'local') {
  const { createD1Shim, createKvShim } = await import('../helpers/d1-shim.mjs');
  workerMod = await import('../../src/worker.js');
  const worker = workerMod.default;
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
  if (!cfg.base_url || !cfg.bot_secret || !cfg.approver_secret) {
    console.error('Modo remote: define INFLU_BASE_URL, INFLU_BOT_HMAC_SECRET e INFLU_APPROVER_HMAC_SECRET.');
    process.exit(2);
  }
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
  // Análisis estático: la publicación no llama a fetch. Sí pueden hacerlo la guardia, el canje de certificados Access y el webhook del encargo.
  const offenders = [];
  const allowedFetch = new Set(['egress-guard.js', 'access-jwt.js', 'encargo-webhook.js']);
  const walk = (d) => readdirSync(d).forEach((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { walk(p); return; }
    if (!p.endsWith('.js') || allowedFetch.has(f)) return;
    const src = readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '');
    const callsFetch = new RegExp(String.raw`\bfetch\s*\((?![^)]*\)\s*\{)`);
    if (callsFetch.test(src) || /globalThis\.fetch\b/.test(src)) offenders.push(p);
  });
  walk(join(ROOT, 'src'));
  eq(offenders.length, 0, `archivos con fetch(): ${offenders.join(', ')}`);
  const res = await client.getPublicationResults(MAIN);
  assert(res.data.mock === true && res.data.publications.every((p) => p.provider_mode === 'mock'), 'todo en modo mock');
  log.push(`health.mode=${h.publisher.mode}; live_enabled_in_build=false; egress_log.total=${e.data.total}; hosts contactados por el cliente: ${hosts.join(', ')}; fetch en src/: guardia, certificados Access y el webhook de encargos`);
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

if (target === 'local') {
  await T('EXTRA S4', 'Aislamiento: otro correo recibe 404 y un service token no abre /v1/me', async (log) => {
    const { createD1Shim, createKvShim } = await import('../helpers/d1-shim.mjs');
    const aud = 'aud-aceptacion';
    const signer = createAccessSigner();
    const key = await cryptoKeyFromPublic(signer.publicKey);
    workerMod.setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', key]]) });
    const env = {
      DB: createD1Shim(join(ROOT, 'migrations')), MEDIA: createKvShim(),
      BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef', APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
      PUBLISHER_MODE: 'mock', PUBLISHER_PROVIDER: 'youtube',
      ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: aud,
    };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = (email) => signer.sign({ aud, exp, email });
    const service = signer.sign({ aud, exp, common_name: 'bot-aceptacion', type: 'app' });
    const call = async (method, path, jwt, body) => {
      const res = await workerMod.default.fetch(new Request(`https://local.test${path}`, {
        method,
        headers: { 'cf-access-jwt-assertion': jwt, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }), env);
      const payload = await res.json();
      return { status: res.status, ...payload };
    };
    const ana = await call('POST', '/v1/me', token('ana@example.com'), { display_name: 'Ana', time_zone: 'Europe/Madrid' });
    assert(ana.ok, JSON.stringify(ana.error));
    const accountId = ana.data.accounts[0].account_id;
    const encargo = await call('POST', '/v1/me/encargos', token('ana@example.com'), {
      account_id: accountId, kind: 'from_scratch', note: 'idea', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }],
    });
    assert(encargo.ok, JSON.stringify(encargo.error));
    const bot = new OrchestratorClient({
      baseUrl: 'https://local.test', botSecret: env.BOT_HMAC_SECRET, approverSecret: env.APPROVER_HMAC_SECRET,
      accessHeaders: { 'cf-access-jwt-assertion': service },
      transport: (url, init) => workerMod.default.fetch(new Request(url, init), env),
    });
    const sha = 'cd'.repeat(32);
    assert((await bot.call('POST', `/v1/encargos/${encargo.data.encargo_id}/claim`)).ok, 'claim');
    const ready = await bot.call('POST', `/v1/encargos/${encargo.data.encargo_id}/result`, { body: {
      synthetic: true, content_hash: 'ab'.repeat(32),
    } });
    assert(ready.ok, JSON.stringify(ready.error));
    await call('POST', '/v1/me', token('bob@example.com'), { display_name: 'Bob', time_zone: 'Europe/Madrid' });
    for (const path of [
      `/v1/me/encargos/${encargo.data.encargo_id}`,
      `/v1/me/media/${sha}`,
      `/v1/me/accounts/${accountId}/streak`,
      `/v1/me/accounts/${accountId}/activity`,
      `/v1/me/accounts/${accountId}/connections`,
    ]) {
      const foreign = await call('GET', path, token('bob@example.com'));
      eq(foreign.status, 404, path);
      eq(foreign.error.code, 'NOT_FOUND', path);
    }
    const own = await call('GET', `/v1/me/accounts/${accountId}/connections`, token('ana@example.com'));
    eq(own.status, 200, 'conexiones propias');
    eq(own.data.connections.length, 0, 'tabla vacía');
    const denied = await call('GET', '/v1/me', service);
    eq(denied.status, 403, 'service token');
    eq(denied.error.code, 'ACCESS_DENIED', 'código');
    const bobEncargos = await call('GET', '/v1/me/encargos', token('bob@example.com'));
    eq(bobEncargos.status, 200, 'lista de bob');
    eq(bobEncargos.data.encargos.length, 0, 'bob no ve encargos ajenos');
    const anaEncargos = await call('GET', '/v1/me/encargos', token('ana@example.com'));
    eq(anaEncargos.status, 200, 'lista de ana');
    eq(anaEncargos.data.encargos.length, 1, 'ana ve el suyo');
    eq(anaEncargos.data.encargos[0].encargo_id, encargo.data.encargo_id, 'id');
    eq(anaEncargos.data.encargos[0].status, 'ready', 'estado del servidor');
    eq(Boolean(anaEncargos.data.encargos[0].updated_at), true, 'fecha');
    const deniedList = await call('GET', '/v1/me/encargos', service);
    eq(deniedList.status, 403, 'service token en la lista');
    eq(deniedList.error.code, 'ACCESS_DENIED', 'código lista');
    log.push('bob recibe 404 en encargo, pieza, racha, actividad y conexión; su lista queda vacía y la de ana trae el estado; service token 403 en /v1/me');
  });

  await T('EXTRA S5', 'Bot HMAC: firma inválida, reclamo doble y hash que no cuadra', async (log) => {
    const { createHash } = await import('node:crypto');
    const { createD1Shim, createKvShim } = await import('../helpers/d1-shim.mjs');
    const { createR2Shim } = await import('../helpers/r2-shim.mjs');
    const { pollEncargoOnce } = await import('../../bot/client-lib.mjs');
    const { R2ObjectStore } = await import('../../src/adapters/storage/r2-object-store.js');
    const aud = 'aud-bot-aceptacion';
    const signer = createAccessSigner();
    const key = await cryptoKeyFromPublic(signer.publicKey);
    workerMod.setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', key]]) });
    const r2 = createR2Shim();
    const env = {
      DB: createD1Shim(join(ROOT, 'migrations')), MEDIA: createKvShim(), MEDIA_R2: r2,
      BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef', APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
      PUBLISHER_MODE: 'mock', PUBLISHER_PROVIDER: 'youtube',
      ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: aud,
      RATE_LIMIT_USER_PER_MINUTE: '600',
    };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = (email) => signer.sign({ aud, exp, email });
    const service = signer.sign({ aud, exp, common_name: 'bot-aceptacion', type: 'app' });
    const call = async (method, path, jwt, { json, raw, headers } = {}) => {
      const res = await workerMod.default.fetch(new Request(`https://local.test${path}`, {
        method,
        headers: {
          'cf-access-jwt-assertion': jwt,
          ...(json ? { 'content-type': 'application/json' } : {}),
          ...(raw ? { 'content-length': String(raw.byteLength) } : {}),
          ...(headers ?? {}),
        },
        body: json ? JSON.stringify(json) : raw,
      }), env);
      const payload = await res.json();
      return { status: res.status, ...payload };
    };
    const bot = new OrchestratorClient({
      baseUrl: 'https://local.test', botSecret: env.BOT_HMAC_SECRET, approverSecret: env.APPROVER_HMAC_SECRET,
      accessHeaders: { 'cf-access-jwt-assertion': service },
      transport: (url, init) => workerMod.default.fetch(new Request(url, init), env),
    });
    const ana = await call('POST', '/v1/me', token('ana@example.com'), { json: { display_name: 'Ana', time_zone: 'Europe/Madrid' } });
    assert(ana.ok, JSON.stringify(ana.error));
    async function editWith(bytes) {
      const created = await call('POST', '/v1/me/encargos', token('ana@example.com'), {
        json: { account_id: ana.data.accounts[0].account_id, kind: 'edit', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }] },
      });
      assert(created.ok, JSON.stringify(created.error));
      const digest = createHash('sha256').update(bytes).digest('hex');
      const opened = await call('POST', '/v1/me/uploads', token('ana@example.com'), {
        json: { encargo_id: created.data.encargo_id, size_bytes: bytes.byteLength, mime: 'video/mp4', sha256: digest },
      });
      assert(opened.status === 201, JSON.stringify(opened.error));
      const put = await call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, token('ana@example.com'), {
        raw: bytes, headers: { 'content-type': 'video/mp4', 'x-content-sha256': digest },
      });
      assert(put.ok, JSON.stringify(put.error));
      const done = await call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, token('ana@example.com'), { json: { sha256: digest } });
      assert(done.data.status === 'queued', JSON.stringify(done.error));
      return { encargoId: created.data.encargo_id, digest };
    }
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const encargo = await editWith(bytes);
    const bad = await bot.call('GET', '/v1/encargos?status=queued', {
      signOverride: sign({ secret: 'x'.repeat(40), keyId: 'bot', method: 'GET', pathAndQuery: '/v1/encargos?status=queued' }),
    });
    eq(bad.status, 401, 'firma inválida');
    eq(bad.error.code, 'UNAUTHENTICATED', 'código de firma');
    const claim = await bot.claimEncargo(encargo.encargoId);
    assert(claim.ok, JSON.stringify(claim.error));
    const secondClaim = await bot.claimEncargo(encargo.encargoId);
    eq(secondClaim.status, 409, 'reclamo doble');
    eq(secondClaim.error.code, 'CONFLICT', 'código de reclamo');
    const mismatch = await bot.submitEncargoResult(encargo.encargoId, {
      synthetic: false, content_hash: 'ab'.repeat(32), file_sha256: 'cd'.repeat(32),
    });
    eq(mismatch.status, 409, 'hash que no cuadra');
    eq(mismatch.error.code, 'INTEGRITY_FILE_MISMATCH', 'código de huella');
    const viewed = await call('GET', `/v1/me/encargos/${encargo.encargoId}`, token('ana@example.com'));
    eq(viewed.data.status, 'failed', 'estado failed');

    const otherBytes = new Uint8Array([9, 8, 7, 6]);
    const other = await editWith(otherBytes);
    let generated = 0;
    const store = new R2ObjectStore(r2);
    const polled = await pollEncargoOnce(bot, {
      head: (key) => store.head(key),
      get: async () => new Uint8Array([1, 1, 1, 1]),
      generate: async () => { generated += 1; return { content_hash: 'ab'.repeat(32) }; },
    });
    assert(polled.ok === false, 'el bucle no da por bueno un hash distinto');
    eq(polled.phase, 'integrity', 'fase de integridad');
    eq(generated, 0, 'no hay Imagine');
    const polledView = await call('GET', `/v1/me/encargos/${other.encargoId}`, token('ana@example.com'));
    eq(polledView.data.status, 'failed', 'el bucle deja el encargo en failed');
    const empty = await pollEncargoOnce(bot, { generate: async () => ({ content_hash: 'ab'.repeat(32) }) });
    eq(empty.generated, false, 'cola vacía');
    eq(empty.ok, true, 'vuelta vacía');
    log.push('firma inválida=401; reclamo doble=409; file_sha256 distinto=409 y status failed; el bucle no genera si los bytes no cuadran; cola vacía sin Imagine');
  });

  await T('EXTRA H2', 'MCP con Access y bearer, sin aprobar, y el webhook no bloquea la cola', async (log) => {
    const { createD1Shim, createKvShim } = await import('../helpers/d1-shim.mjs');
    const { setEncargoWebhookTransport } = await import('../../src/adapters/http/encargo-webhook.js');
    const aud = 'aud-h2-aceptacion';
    const mcpAud = 'aud-mcp-aceptacion';
    const mcpClientId = 'mcp-aceptacion.access';
    const signer = createAccessSigner();
    const key = await cryptoKeyFromPublic(signer.publicKey);
    workerMod.setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', key]]) });
    const tokenMcp = 'local-test-mcp-bearer-aceptacion-0123456789';
    const baseEnv = {
      DB: createD1Shim(join(ROOT, 'migrations')), MEDIA: createKvShim(),
      BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef', APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
      PUBLISHER_MODE: 'mock', PUBLISHER_PROVIDER: 'youtube',
      ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: aud,
      ACCESS_MCP_AUD: mcpAud, MCP_SERVICE_TOKEN_CLIENT_ID: mcpClientId,
      MCP_BEARER_TOKEN: tokenMcp,
    };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const now = Math.floor(Date.now() / 1000);
    const jwt = signer.sign({ aud, exp, email: 'ana@example.com' });
    const serviceJwt = signer.sign({
      aud: mcpAud, exp, iss: 'https://team.example.com', common_name: mcpClientId, sub: '', type: 'app',
    });
    const uiJwt = signer.sign({ aud, exp, nbf: now - 30, iss: 'https://team.example.com', email: 'ana@example.com' });
    const otherName = signer.sign({
      aud: mcpAud, exp, iss: 'https://team.example.com', common_name: 'cli-aceptacion.access', sub: '', type: 'app',
    });
    const mcp = async (dbEnv, bearer, method, accessJwt = serviceJwt) => {
      const res = await workerMod.default.fetch(new Request('https://local.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(accessJwt ? { 'cf-access-jwt-assertion': accessJwt } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method,
          params: method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aceptacion', version: '0' } } : {},
        }),
      }), dbEnv, { waitUntil() {} });
      const text = await res.text();
      return { status: res.status, text };
    };
    const noJwt = await mcp(baseEnv, tokenMcp, 'initialize', null);
    eq(noJwt.status, 401, 'MCP sin JWT');
    assert(noJwt.text.includes('UNAUTHENTICATED'), 'código sin JWT');
    const uiOnly = await mcp(baseEnv, tokenMcp, 'initialize', uiJwt);
    eq(uiOnly.status, 401, 'JWT con aud de la UI');
    const wrongName = await mcp(baseEnv, tokenMcp, 'initialize', otherName);
    eq(wrongName.status, 401, 'common_name distinto');
    const anon = await mcp(baseEnv, null, 'initialize');
    eq(anon.status, 401, 'MCP sin bearer');
    assert(anon.text.includes('UNAUTHENTICATED'), 'código MCP');
    const wrong = await mcp(baseEnv, 'bearer-distinto-de-prueba-0001', 'tools/list');
    eq(wrong.status, 401, 'bearer incorrecto');
    const closed = await mcp({ ...baseEnv, ACCESS_MCP_AUD: '' }, tokenMcp, 'initialize');
    eq(closed.status, 503, 'sin config de Access para /mcp');
    assert(closed.text.includes('SERVER_MISCONFIGURED'), 'código de config');
    assert(!closed.text.includes('tools'), 'no ejecuta el conector');
    const listed = await mcp(baseEnv, tokenMcp, 'tools/list');
    eq(listed.status, 200, 'tools/list');
    for (const name of ['reclamar_encargo', 'leer_origen', 'preparar_subida', 'subir_resultado', 'revisar_estado']) {
      assert(listed.text.includes(`"name":"${name}"`), name);
    }
    for (const name of ['aprobar', 'publicar', 'approve', 'publish']) {
      assert(!listed.text.includes(`"name":"${name}`), `no debe existir ${name}`);
    }

    const calls = [];
    setEncargoWebhookTransport(async () => { calls.push('hit'); throw new Error('caído'); });
    try {
      const callPerson = async (dbEnv, path, body) => {
        const res = await workerMod.default.fetch(new Request(`https://local.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt },
          body: JSON.stringify(body),
        }), dbEnv);
        return { status: res.status, ...(await res.json()) };
      };
      const guide = await callPerson(baseEnv, '/v1/me', { display_name: 'Ana', time_zone: 'Europe/Madrid' });
      assert(guide.ok, JSON.stringify(guide.error));
      const absent = await callPerson(baseEnv, '/v1/me/encargos', {
        account_id: guide.data.accounts[0].account_id, kind: 'from_scratch', note: 'sin aviso', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }],
      });
      eq(absent.status, 200, 'creación sin webhook');
      eq(absent.data.status, 'queued', 'sigue en cola');
      eq(calls.length, 0, 'no se llamó al webhook');

      const failingEnv = {
        ...baseEnv,
        DB: createD1Shim(join(ROOT, 'migrations')),
        INFLU_WEBHOOK_URL: 'https://influ-webhook.test/rutina',
        INFLU_WEBHOOK_SECRET: 'clave-de-rutina-aceptacion-012345',
      };
      const guide2 = await callPerson(failingEnv, '/v1/me', { display_name: 'Ana', time_zone: 'Europe/Madrid' });
      const failed = await callPerson(failingEnv, '/v1/me/encargos', {
        account_id: guide2.data.accounts[0].account_id, kind: 'from_scratch', note: 'aviso caído', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }],
      });
      eq(failed.status, 200, 'creación con webhook caído');
      eq(failed.data.status, 'queued', 'la cola no se pierde');
      eq(calls.length, 1, 'se intentó el aviso');
    } finally {
      setEncargoWebhookTransport(null);
    }
    log.push('sin JWT, aud de la UI, common_name distinto o sin bearer=401; sin config de /mcp=503 y no hay herramientas; tools/list no tiene aprobar ni publicar; sin URL no hay POST; un POST que falla deja el encargo en cola');
  });
}

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
    base_url: process.env.INFLU_BASE_URL ?? file.base_url,
    bot_secret: process.env.INFLU_BOT_HMAC_SECRET ?? file.bot_secret,
    approver_secret: process.env.INFLU_APPROVER_HMAC_SECRET ?? file.approver_secret,
  };
}
